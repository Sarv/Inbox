import { beforeEach, describe, expect, it, vi } from 'vitest';

// The crash-report consent dialog and Settings → General → Send crash reports
// reach main through these handlers. Breaks if the toggle silently does
// nothing, a non-boolean from a broken renderer flips the preference, a disk
// error is reported as saved, or the window can't tell "not yet asked" from
// "no" (CASA L-8).

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  choice: 'unasked' as 'yes' | 'no' | 'unasked',
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
  crashReportChoice: () => h.choice,
  setCrashReportsEnabled: (v: boolean) => {
    if (h.writeThrows) throw new Error('EACCES');
    h.choice = v ? 'yes' : 'no';
  },
}));

import { registerAppHandlers } from '../../../../electron/ipc/app-handlers';

const call = (name: string, ...args: unknown[]) => h.handlers.get(name)!(null, ...args);

beforeEach(() => {
  h.handlers.clear();
  h.choice = 'unasked';
  h.writeThrows = false;
  registerAppHandlers();
});

describe('diagnostics IPC', () => {
  // Changed deliberately (CASA L-8: opt-in, asked on first launch): the read
  // used to return a boolean (true by default). It returns main's tri-state
  // answer now, so the consent dialog can tell "not yet asked" from "no".
  it('reads and sets the crash-report preference', () => {
    expect(call('diagnostics:getCrashReports')).toEqual({ success: true, data: 'unasked' });
    expect(call('diagnostics:setCrashReports', false)).toEqual({ success: true });
    expect(call('diagnostics:getCrashReports')).toEqual({ success: true, data: 'no' });
    expect(call('diagnostics:setCrashReports', true)).toEqual({ success: true });
    expect(call('diagnostics:getCrashReports')).toEqual({ success: true, data: 'yes' });
  });

  // Changed deliberately (CASA L-8): asserts the tri-state stays unanswered
  // rather than the old boolean staying true.
  it('rejects a non-boolean without changing anything', () => {
    for (const bad of ['no', 'yes', 1, null, undefined, {}]) {
      expect(call('diagnostics:setCrashReports', bad)).toMatchObject({ success: false });
    }
    expect(h.choice).toBe('unasked');
  });

  // Changed deliberately (CASA L-8): also asserts the answer stays unanswered
  // after the failed save (write-then-flip), not just the error reply.
  it('reports a failed save instead of claiming success', () => {
    h.writeThrows = true;
    expect(call('diagnostics:setCrashReports', false)).toEqual({ success: false, error: 'EACCES' });
    expect(call('diagnostics:getCrashReports')).toEqual({ success: true, data: 'unasked' });
  });
});
