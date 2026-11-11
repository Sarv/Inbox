import { MAX_MESSAGE_BYTES, redactSecrets } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every log line of the main process, from every component, passes its extra
// args through summarizeArgs on the way to a Sentry breadcrumb. Breaks if: an
// argument whose size a stranger chose (an email record, a server's answer) is
// JSON.stringify'd whole — in Electron 44 a large enough one ends the app,
// uncatchably — or a huge argument is scanned in full by the redactor on every
// log call (a main-thread stall) only for 500 characters of it to be kept.

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '1.2.3', getLocale: () => 'en-US', isPackaged: true },
}));
vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  setTag: vi.fn(),
  setContext: vi.fn(),
  setUser: vi.fn(),
  makeElectronTransport: () => ({ send: vi.fn(), flush: vi.fn() }),
  makeElectronOfflineTransport: (base: unknown) => base,
}));
vi.mock('@sarvinbox/storage-node', () => ({ setSlowQueryReporter: vi.fn() }));
// The real redactor, watched: what it is handed is what the summary costs.
vi.mock('@sarvinbox/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sarvinbox/core')>();
  return { ...real, redactSecrets: vi.fn(real.redactSecrets) };
});

const { summarizeArgs } = await import('../../../electron/sentry');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('summarizeArgs (log args into a breadcrumb)', () => {
  // Breaks: ordinary diagnostic objects stop reaching the breadcrumb trail.
  it('still summarises an ordinary object, error and scalar', () => {
    const summary = summarizeArgs([{ uid: 7, folder: 'INBOX' }, new Error('boom'), 42]);
    expect(summary).toBe('{"uid":7,"folder":"INBOX"} Error: boom 42');
  });

  // Breaks: a huge email record logged as an argument is stringified whole — the
  // uncatchable crash this guards against.
  it('refuses to stringify an object too large to summarise', () => {
    const stringify = vi.spyOn(JSON, 'stringify');

    const summary = summarizeArgs(['fetched', { id: 'e1', rawBody: 'x'.repeat(MAX_MESSAGE_BYTES + 1) }]);

    expect(stringify).not.toHaveBeenCalled();
    expect(summary).toBe('fetched [too large to summarize]');
  });

  // Breaks: a merely large object (well under the crash size) is stringified in
  // full on every log call just to keep 500 characters of it.
  it('does not stringify an object past the breadcrumb budget either', () => {
    const stringify = vi.spyOn(JSON, 'stringify');

    expect(summarizeArgs([{ body: 'y'.repeat(200_000) }])).toBe('[too large to summarize]');
    expect(stringify).not.toHaveBeenCalled();
  });

  // Breaks: a huge string argument is joined and redacted whole on every log
  // call, and the breadcrumb is no longer capped at 500 characters.
  it('cuts a huge string argument before redacting it', () => {
    const summary = summarizeArgs(['z'.repeat(10_000_000)]);

    expect(summary).toBe(`${'z'.repeat(500)}…`);
    expect(vi.mocked(redactSecrets).mock.calls.at(-1)![0].length).toBeLessThanOrEqual(4 * 1024);
  });

  // Breaks: a secret in a summarised argument leaves the machine (pre-existing rule,
  // re-pinned because the parts are now cut before they are redacted).
  it('still redacts secrets in what it keeps', () => {
    const summary = summarizeArgs([{ password: 'hunter2' }]);
    expect(summary).not.toContain('hunter2');
  });
});
