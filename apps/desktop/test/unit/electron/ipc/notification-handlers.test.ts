import { beforeEach, describe, expect, it, vi } from 'vitest';

// notifications:test must report macOS Focus alongside the toast. Without it the
// button said "Sent" while Focus quietly held every banner back.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  showTestNotification: vi.fn(),
  setNotificationConfig: vi.fn(),
  readFocusStatus: vi.fn(),
  focusDepsHome: [] as string[],
  logged: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  app: { getPath: (name: string) => (name === 'home' ? '/Users/someone' : '/tmp') },
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: (m: string) => h.logged.push(m), warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../../../electron/services/notification-service', () => ({
  showTestNotification: h.showTestNotification,
  setNotificationConfig: h.setNotificationConfig,
}));
vi.mock('../../../../electron/services/focus-status', () => ({
  readFocusStatus: h.readFocusStatus,
  systemFocusStatusDeps: (home: string) => { h.focusDepsHome.push(home); return { home }; },
}));

import { registerNotificationHandlers } from '../../../../electron/ipc/notification-handlers';

const test = () => h.handlers.get('notifications:test')!;
const setConfig = () => h.handlers.get('notifications:setConfig')!;

beforeEach(() => {
  h.handlers.clear();
  h.showTestNotification.mockReset().mockReturnValue({ supported: true });
  h.setNotificationConfig.mockReset();
  h.readFocusStatus.mockReset().mockResolvedValue('off');
  h.focusDepsHome.length = 0;
  h.logged.length = 0;
  registerNotificationHandlers();
});

describe('notifications:test', () => {
  // Breaks: the Settings line can never say "Focus is on".
  it('returns the Focus state read from the home directory', async () => {
    h.readFocusStatus.mockResolvedValue('on');

    await expect(test()()).resolves.toEqual({ success: true, supported: true, focus: 'on' });
    expect(h.focusDepsHome).toEqual(['/Users/someone']);
    expect(h.logged.some((m) => m.includes('focus=on'))).toBe(true);
  });

  // Breaks: the toast waits on a slow disk read, or is skipped when it fails.
  it('fires the toast before the Focus check', async () => {
    h.readFocusStatus.mockImplementation(async () => {
      expect(h.showTestNotification).toHaveBeenCalledTimes(1);
      return 'unknown';
    });

    await expect(test()()).resolves.toMatchObject({ focus: 'unknown' });
  });

  // Breaks: an Electron error rejects the IPC call and the button just hangs.
  it('turns a failure into success:false', async () => {
    h.showTestNotification.mockImplementation(() => { throw new Error('no Notification'); });

    await expect(test()()).resolves.toEqual({ success: false, error: 'no Notification' });
  });
});

describe('notifications:setConfig', () => {
  // Breaks: renderer settings stop reaching the main-process rule chain.
  it('forwards the config, defaulting to an empty patch', () => {
    expect(setConfig()(null, { mode: 'all' })).toEqual({ success: true });
    setConfig()(null, undefined);
    expect(h.setNotificationConfig.mock.calls).toEqual([[{ mode: 'all' }], [{}]]);
  });

  // Breaks: a throwing config push rejects in the renderer.
  it('turns a failure into success:false', () => {
    h.setNotificationConfig.mockImplementation(() => { throw new Error('bad'); });
    expect(setConfig()(null, {})).toEqual({ success: false, error: 'bad' });
  });
});
