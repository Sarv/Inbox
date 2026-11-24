import { beforeEach, describe, expect, it, vi } from 'vitest';

// `app:openExternal` is the one choke point for handing a URL to the OS; the
// URL is typically a link clicked in a message. Its refusal line is warn, which
// a release app.log keeps. What breaks if this file fails: a refused link's
// address (its host, path and query, from the mail) reaches app.log, or a safe
// link stops opening.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  warn: vi.fn(),
  openExternal: vi.fn(async (_url: string) => {}),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, fn: (...a: any[]) => any) => h.handlers.set(n, fn) },
  shell: { openExternal: (url: string) => h.openExternal(url) },
}));
// app-handlers reads the bundled package.json for the version at load time.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, readFileSync: (p: string, ...rest: unknown[]) =>
    (String(p).endsWith('package.json') ? '{"version":"0.0.0"}' : (actual.readFileSync as any)(p, ...rest)) };
});
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: () => {}, warn: h.warn, error: () => {}, debug: () => {} }),
}));
vi.mock('../../../../electron/sentry', () => ({ crashReportChoice: () => 'unasked', setCrashReportsEnabled: () => {} }));

import { registerAppHandlers } from '../../../../electron/ipc/app-handlers';

const open = (url: unknown) => h.handlers.get('app:openExternal')!(null, url);

beforeEach(() => {
  h.handlers.clear();
  h.warn.mockReset();
  h.openExternal.mockReset().mockResolvedValue(undefined);
  registerAppHandlers();
});

describe('app:openExternal — what reaches the log', () => {
  // Breaks: '[App] Blocked openExternal for unsafe URL scheme: <url>' writes
  // the whole link.
  it('logs a refused link by its scheme only', async () => {
    await expect(open('file:///Users/SENTINEL-user/Payslip-SENTINEL.pdf')).resolves.toEqual({ success: false, error: 'Unsupported URL scheme' });
    await expect(open('ms-word:ofe|u|https://SENTINEL.example/doc.docx')).resolves.toMatchObject({ success: false });

    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.warn.mock.calls).toEqual([
      ['[App] Blocked openExternal for unsafe URL scheme:', 'file:'],
      ['[App] Blocked openExternal for unsafe URL scheme:', 'ms-word:'],
    ]);
  });

  // Breaks: a value that is not a URL string (a broken renderer) is written as
  // it came.
  it('logs a non-URL or non-string value by kind', async () => {
    await open('SENTINEL words, no scheme');
    await open({ href: 'SENTINEL' });

    expect(h.warn.mock.calls).toEqual([
      ['[App] Blocked openExternal for unsafe URL scheme:', 'unparseable'],
      ['[App] Blocked openExternal for unsafe URL scheme:', 'not-a-string:object'],
    ]);
  });

  // Breaks: the change to the log line stops safe links opening, or makes an
  // allowed open write a line.
  it('opens a safe link and logs nothing', async () => {
    await expect(open('https://example.com/SENTINEL')).resolves.toEqual({ success: true });

    expect(h.openExternal).toHaveBeenCalledWith('https://example.com/SENTINEL');
    expect(h.warn).not.toHaveBeenCalled();
  });
});
