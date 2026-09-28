import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings → General → Send crash reports reaches main through these handlers.
// Breaks if the toggle silently does nothing, a non-boolean from a broken
// renderer flips the preference, or a disk error is reported as saved.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  enabled: true,
  writeThrows: false,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, fn: (...a: any[]) => any) => h.handlers.set(n, fn), on: () => {} },
  shell: { openExternal: vi.fn() },
}));
// app-handlers reads the bundled package.json for the version at load time.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, readFileSync: (p: string, ...rest: unknown[]) =>
    (String(p).endsWith('package.json') ? '{"version":"0.0.0"}' : (actual.readFileSync as any)(p, ...rest)) };
});
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../../../electron/sentry', () => ({
  crashReportsEnabled: () => h.enabled,
  setCrashReportsEnabled: (v: boolean) => {
    if (h.writeThrows) throw new Error('EACCES');
    h.enabled = v;
  },
}));

import { registerAppHandlers } from '../../../../electron/ipc/app-handlers';

const call = (name: string, ...args: unknown[]) => h.handlers.get(name)!(null, ...args);

beforeEach(() => {
  h.handlers.clear();
  h.enabled = true;
  h.writeThrows = false;
  registerAppHandlers();
});

describe('diagnostics IPC', () => {
  it('reads and sets the crash-report preference', () => {
    expect(call('diagnostics:getCrashReports')).toEqual({ success: true, data: true });
    expect(call('diagnostics:setCrashReports', false)).toEqual({ success: true });
    expect(call('diagnostics:getCrashReports')).toEqual({ success: true, data: false });
  });

  it('rejects a non-boolean without changing anything', () => {
    expect(call('diagnostics:setCrashReports', 'no')).toMatchObject({ success: false });
    expect(h.enabled).toBe(true);
  });

  it('reports a failed save instead of claiming success', () => {
    h.writeThrows = true;
    expect(call('diagnostics:setCrashReports', false)).toEqual({ success: false, error: 'EACCES' });
  });
});
