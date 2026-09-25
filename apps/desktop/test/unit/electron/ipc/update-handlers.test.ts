import { readFileSync } from 'fs';
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auto-update IPC edge.
 *
 * Two things can break here that nothing else catches. A channel name that
 * disagrees between preload.ts and update-handlers.ts type-checks perfectly and
 * fails only at runtime, as a button that does nothing. And a handler that
 * reports success for an action that did not happen leaves the renderer
 * spinning on a download or a restart that was never started.
 */

const service = vi.hoisted(() => ({
  getUpdateState: vi.fn(() => ({ phase: 'idle' })),
  checkForUpdates: vi.fn(async () => ({ phase: 'up-to-date' })),
  downloadUpdate: vi.fn(() => true),
  setAutoUpdateEnabled: vi.fn((enabled: boolean) => ({ phase: 'idle', autoUpdate: enabled })),
  installUpdateAndRestart: vi.fn(() => true),
  skipCurrentVersion: vi.fn(() => ({ phase: 'idle' })),
  remindAboutUpdateLater: vi.fn(() => ({ phase: 'idle' })),
  dismissUpdateDialog: vi.fn(() => ({ phase: 'idle', prompt: false })),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));

vi.mock('../../../../electron/services/update-service', () => service);

const invoke = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, ...args);
};

const register = async () => {
  handlers.clear();
  vi.resetModules();
  const mod = await import('../../../../electron/ipc/update-handlers');
  mod.registerUpdateHandlers();
};

beforeEach(async () => {
  Object.values(service).forEach((fn) => fn.mockClear());
  await register();
});

describe('registerUpdateHandlers', () => {
  /**
   * The parity check. `ipcRenderer.invoke('updater:setAutoupdate')` against a
   * handler named 'updater:setAutoUpdate' is a silent no-op: TypeScript sees
   * two strings, the renderer's promise rejects into a catch, and the toggle
   * simply stops working. Read from the sources so a rename in either file has
   * to be a rename in both.
   */
  it('registers every updater channel the preload bridge invokes', () => {
    const preload = readFileSync(join(__dirname, '../../../../electron/preload.ts'), 'utf8');
    const invoked = new Set(
      [...preload.matchAll(/invoke\(\s*'(updater:[A-Za-z]+)'/g)].map((match) => match[1]!),
    );

    expect(invoked.size).toBeGreaterThan(0);
    for (const channel of invoked) {
      expect(handlers.has(channel), `preload invokes ${channel} with no handler`).toBe(true);
    }
  });

  // Every reply carries the full state so the renderer renders from it directly
  // rather than keeping a second copy that can drift from the main process.
  it('answers with the current state', async () => {
    await expect(invoke('updater:state')).resolves.toEqual({
      success: true,
      data: { phase: 'idle' },
    });
  });

  // A menu press is a MANUAL check: the trigger is what decides whether the
  // outcome is shown at all. Passing 'scheduled' here would make the menu item
  // silent on "you're up to date" — the original complaint.
  it('checks as a manual trigger so the outcome is always reported', async () => {
    await expect(invoke('updater:check')).resolves.toEqual({
      success: true,
      data: { phase: 'up-to-date' },
    });
    expect(service.checkForUpdates).toHaveBeenCalledWith('manual');
  });

  // Reporting success for a download that never started leaves the dialog on a
  // progress bar that can never move.
  it('reports a download that could not start', async () => {
    service.downloadUpdate.mockReturnValueOnce(false);

    const result = (await invoke('updater:download')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No update is waiting/);
  });

  it('reports a download that did start, with the new state', async () => {
    await expect(invoke('updater:download')).resolves.toEqual({
      success: true,
      data: { phase: 'idle' },
    });
    expect(service.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  // Same for the restart: quitAndInstall with nothing staged would take the app
  // away and install nothing, so the renderer has to be told it failed.
  it('reports a restart that could not start', async () => {
    service.installUpdateAndRestart.mockReturnValueOnce(false);

    const result = (await invoke('updater:install')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No update is ready/);
  });

  /**
   * IPC arguments come from the renderer and are not trust-worthy types: a
   * truthy-but-not-true value ('false', {}, 1) must not be able to switch
   * automatic downloading on. Only an explicit `true` enables it.
   */
  it('only accepts a literal true for the automatic-updates toggle', async () => {
    for (const value of ['false', 1, {}, undefined, null]) {
      await invoke('updater:setAutoUpdate', value);
      expect(service.setAutoUpdateEnabled, String(value)).toHaveBeenLastCalledWith(false);
    }

    await invoke('updater:setAutoUpdate', true);
    expect(service.setAutoUpdateEnabled).toHaveBeenLastCalledWith(true);
  });

  // The three dialog answers each return the state they produced, so the
  // renderer closes on the reply instead of waiting for a push that may race it.
  it('returns the resulting state for skip, later and dismiss', async () => {
    await expect(invoke('updater:skip')).resolves.toMatchObject({ success: true });
    await expect(invoke('updater:remindLater')).resolves.toMatchObject({ success: true });
    await expect(invoke('updater:dismiss')).resolves.toEqual({
      success: true,
      data: { phase: 'idle', prompt: false },
    });
    expect(service.skipCurrentVersion).toHaveBeenCalledTimes(1);
    expect(service.remindAboutUpdateLater).toHaveBeenCalledTimes(1);
    expect(service.dismissUpdateDialog).toHaveBeenCalledTimes(1);
  });
});
