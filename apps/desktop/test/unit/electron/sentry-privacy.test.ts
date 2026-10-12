import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Crash reports leave the device. Breaks if: sender addresses or secrets reach
// Sentry in breadcrumbs, error texts, contexts, tags or the request (a
// privacy-policy breach and a Google Limited Use violation for Gmail
// accounts); or ANYTHING is sent before the user said yes (CASA L-8: opt-in) —
// events, session pings, renderer-forwarded envelopes, or a native crash
// dump, which is process memory no scrubber can see into.

const h = vi.hoisted(() => ({
  userData: '',
  init: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn(),
  baseSend: vi.fn(async () => ({ statusCode: 200 })),
  baseFlush: vi.fn(async () => true),
  offlineWrapped: [] as unknown[],
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    getVersion: () => '1.2.3',
    getLocale: () => 'en-US',
    isPackaged: true,
  },
}));
vi.mock('@sentry/electron/main', () => ({
  init: h.init,
  addBreadcrumb: h.addBreadcrumb,
  captureMessage: h.captureMessage,
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  setTag: vi.fn(),
  setContext: vi.fn(),
  setUser: vi.fn(),
  // The real base transport posts over the network: a recorder stands in.
  makeElectronTransport: () => ({ send: h.baseSend, flush: h.baseFlush }),
  // The real offline wrapper queues on disk around the base it is given; this
  // one records that base and hands it back, so what the SDK would call is the
  // (gated) base itself.
  makeElectronOfflineTransport: (base: unknown) => {
    h.offlineWrapped.push(base);
    return base;
  },
}));
vi.mock('@sarvinbox/storage-node', () => ({ setSlowQueryReporter: vi.fn() }));

const dir = mkdtempSync(join(tmpdir(), 'sentry-privacy-'));
h.userData = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PREF = join(dir, 'crash-reports.json');

type SentryModule = typeof import('../../../electron/sentry');
let sentry: SentryModule;

async function freshInit(dsn: string | null = 'https://public@example.ingest.sentry.io/1'): Promise<SentryModule> {
  vi.resetModules();
  h.init.mockReset();
  if (dsn) process.env.SARVINBOX_SENTRY_DSN = dsn;
  else delete process.env.SARVINBOX_SENTRY_DSN;
  const mod = await import('../../../electron/sentry');
  mod.initSentryMain();
  return mod;
}

/** The transport the SDK was configured with, instantiated. */
const configuredTransport = () =>
  h.init.mock.calls[0][0].transport({ url: 'https://example.ingest.sentry.io' }) as {
    send: (envelope: unknown) => Promise<unknown>;
    flush: (timeout?: number) => Promise<boolean>;
  };

beforeEach(async () => {
  rmSync(PREF, { recursive: true, force: true });
  h.baseSend.mockClear();
  h.baseFlush.mockClear();
  h.offlineWrapped.length = 0;
  sentry = await freshInit();
});

describe('Sentry privacy filters (main)', () => {
  // Every outgoing breadcrumb and event goes through the scrubbers.
  // Changed deliberately (CASA L-8: opt-in): a fresh profile now sends
  // nothing, so the user says yes first — before, the scrubbers ran by default.
  it('wires beforeBreadcrumb/beforeSend and disables default PII', () => {
    sentry.setCrashReportsEnabled(true);
    const opts = h.init.mock.calls[0][0];
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.beforeBreadcrumb({ message: 'spam from a@b.com' })).toEqual({ message: 'spam from [email]' });
    const ev = opts.beforeSend({ message: 'x@y.com failed', user: { id: 'h', email: 'me@gmail.com' } }, {});
    expect(ev).toEqual({ message: '[email] failed', user: { id: 'h' } });
  });

  // Breaks if the extended scrubber is not the one main uses: contexts, tags
  // and secrets in an event that has already been allowed.
  it('scrubs secrets, contexts and tags in what it does send', () => {
    sentry.setCrashReportsEnabled(true);
    const ev = sentry.filterEvent({
      message: 'login {"password":"hunter2"}',
      contexts: { imap: { account: 'me@gmail.com', host: 'imap.gmail.com' } },
      tags: { account: 'me@gmail.com' },
    } as never);
    expect(ev).toEqual({
      message: 'login {"password":"[REDACTED]"}',
      contexts: { imap: { account: '[email]', host: 'imap.gmail.com' } },
      tags: { account: '[email]' },
    });
  });

  // Transient network blips stay out of the issue stream (pre-existing rule).
  // Changed deliberately (CASA L-8: opt-in): the user says yes first, or the
  // event is dropped for lack of consent and this would pass without testing
  // the transient rule at all.
  it('still drops transient connection errors', () => {
    sentry.setCrashReportsEnabled(true);
    expect(sentry.filterEvent({ message: 'x' } as never, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBeNull();
  });

  // Opt-out applies immediately and persists for the next launch.
  // Changed deliberately (CASA L-8): the file now records the answer as
  // `{"choice":"no"}` instead of `{"enabled":false}`.
  it('drops everything once turned off, and remembers it across a restart', async () => {
    sentry.setCrashReportsEnabled(false);
    expect(sentry.filterBreadcrumb({ message: 'm' })).toBeNull();
    expect(sentry.filterEvent({ message: 'm' } as never)).toBeNull();
    expect(JSON.parse(readFileSync(PREF, 'utf8'))).toEqual({ choice: 'no' });

    const restarted = await freshInit();
    expect(restarted.crashReportChoice()).toBe('no');
    expect(restarted.crashReportsEnabled()).toBe(false);
    expect(restarted.filterEvent({ message: 'after restart' } as never)).toBeNull();

    restarted.setCrashReportsEnabled(true);
    expect(JSON.parse(readFileSync(PREF, 'utf8'))).toEqual({ choice: 'yes' });
    expect(restarted.filterEvent({ message: 'ok' } as never)).toEqual({ message: 'ok' });
    expect((await freshInit()).crashReportChoice()).toBe('yes');
  });

  // Changed deliberately (CASA L-8: opt-in): this used to read a corrupt or
  // missing file as ENABLED. Neither is consent: both are "not yet asked",
  // which sends nothing and makes the consent dialog ask.
  it('reads a corrupt or missing preference file as not yet asked — nothing sent', async () => {
    expect(sentry.crashReportChoice()).toBe('unasked'); // missing (beforeEach)
    expect(sentry.filterEvent({ message: 'm' } as never)).toBeNull();
    expect(sentry.filterBreadcrumb({ message: 'm' })).toBeNull();

    writeFileSync(PREF, '{not json');
    const corrupt = await freshInit();
    expect(corrupt.crashReportChoice()).toBe('unasked');
    expect(corrupt.crashReportsEnabled()).toBe(false);
  });

  // Breaks if an install from before opt-in keeps sending without having
  // been asked: its `{"enabled":true}` was written for everyone who never
  // turned reporting off. A real opt-out (`false`) must survive the upgrade.
  it.each([
    ['{"enabled":true}', 'unasked'],
    ['{"enabled":false}', 'no'],
    ['{"choice":"yes"}', 'yes'],
    ['{"choice":"no"}', 'no'],
    ['{"choice":"YES"}', 'unasked'],
    ['{"choice":true}', 'unasked'],
    ['{"enabled":"false"}', 'unasked'],
    ['null', 'unasked'],
    ['[]', 'unasked'],
  ])('reads %s as %s', async (text, expected) => {
    writeFileSync(PREF, text);
    expect((await freshInit()).crashReportChoice()).toBe(expected);
  });

  // Breaks if a failed save still flips the running state: the window would
  // show (and Sentry act on) a choice the next launch does not have.
  it('changes nothing in memory when the answer cannot be saved', async () => {
    mkdirSync(PREF); // a directory where the file goes: every write fails
    const mod = await freshInit();
    expect(() => mod.setCrashReportsEnabled(true)).toThrow();
    expect(mod.crashReportChoice()).toBe('unasked');
    expect(mod.filterEvent({ message: 'm' } as never)).toBeNull();
  });

  // Breaks if Settings / the consent dialog show "not asked" for a user who
  // answered, just because this build has no DSN.
  it('reads the answer even without a DSN, and stays inert', async () => {
    writeFileSync(PREF, '{"choice":"no"}');
    const mod = await freshInit(null);
    expect(mod.crashReportChoice()).toBe('no');
    expect(h.init).not.toHaveBeenCalled();
  });

  // Slow-query telemetry: folder paths (user-named, often people) never leave.
  it('keeps only numeric/boolean slow-query meta', async () => {
    const { setSlowQueryReporter } = await import('@sarvinbox/storage-node');
    const report = vi.mocked(setSlowQueryReporter).mock.calls.at(-1)![0]!;
    report({ label: 'getByFolder', ms: 900, rows: 3, totalEmails: 10, meta: { folder: 'Clients/Jane Doe', n: 2, scoped: true } });
    expect(h.captureMessage.mock.calls.at(-1)![1].extra).toEqual({ ms: 900, rows: 3, totalEmails: 10, n: 2, scoped: true });
  });
});

describe('no native crash dumps (CASA L-8)', () => {
  // Breaks if a minidump integration runs: a minidump is raw process memory
  // (message text, tokens) that beforeSend cannot scrub — and ElectronMinidump
  // uploads from Crashpad without passing beforeSend at all.
  it('removes both minidump integrations from the SDK defaults', () => {
    const opts = h.init.mock.calls[0][0];
    expect(typeof opts.integrations).toBe('function');
    const defaults = [{ name: 'SentryMinidump' }, { name: 'ElectronBreadcrumbs' }, { name: 'ElectronMinidump' }, { name: 'MainProcessSession' }];
    expect(opts.integrations(defaults).map((i: { name: string }) => i.name)).toEqual(['ElectronBreadcrumbs', 'MainProcessSession']);
  });
});

describe('the scope snapshot older versions left behind (CASA L-8)', () => {
  // The native-crash integration no longer runs, so nothing rewrites or
  // removes userData/sentry/scope_v3.json: breadcrumbs, tags and the hashed
  // user, readable by other local users. Breaks: it stays on disk for good.
  it('is deleted at startup, with or without a DSN, leaving the rest of the folder alone', async () => {
    const sentryDir = join(dir, 'sentry');
    mkdirSync(join(sentryDir, 'queue'), { recursive: true });
    writeFileSync(join(sentryDir, 'scope_v3.json'), '{"breadcrumbs":[]}');
    writeFileSync(join(sentryDir, 'session.json'), '{}');
    await freshInit(null);
    expect(() => readFileSync(join(sentryDir, 'scope_v3.json'))).toThrow();
    expect(readFileSync(join(sentryDir, 'session.json'), 'utf8')).toBe('{}');

    writeFileSync(join(sentryDir, 'scope_v3.json'), '{}');
    await freshInit();
    expect(() => readFileSync(join(sentryDir, 'scope_v3.json'))).toThrow();
  });

  // Best-effort: a missing folder or a failing delete never stops startup.
  it('is a no-op when there is nothing to delete', () => {
    expect(() => sentry.removeStaleSentryScope(join(dir, 'does-not-exist'))).not.toThrow();
  });
});

describe('the transport sends nothing without a yes (CASA L-8)', () => {
  const ENVELOPES = [
    [{ event_id: '1' }, [[{ type: 'event' }, {}]]],
    [{}, [[{ type: 'session' }, { status: 'ok' }]]], // session pings never pass beforeSend
    [{}, [[{ type: 'client_report' }, {}]]],
  ];

  // Breaks if anything that bypasses beforeSend — session pings, renderer
  // envelopes forwarded by the IPC bridge, client reports — still goes out
  // before (or without) consent.
  it('drops every envelope while unasked or after a no, and reports it as handled', async () => {
    const transport = configuredTransport();
    for (const envelope of ENVELOPES) await expect(transport.send(envelope)).resolves.toEqual({});
    sentry.setCrashReportsEnabled(false);
    for (const envelope of ENVELOPES) await expect(transport.send(envelope)).resolves.toEqual({});
    expect(h.baseSend).not.toHaveBeenCalled();
  });

  // Breaks if a yes does not take effect without a restart, or a later no
  // does not stop it at once.
  it('sends once the user says yes, and stops again on a no', async () => {
    const transport = configuredTransport();
    sentry.setCrashReportsEnabled(true);
    await expect(transport.send(ENVELOPES[0])).resolves.toEqual({ statusCode: 200 });
    expect(h.baseSend).toHaveBeenCalledTimes(1);
    sentry.setCrashReportsEnabled(false);
    await transport.send(ENVELOPES[1]);
    expect(h.baseSend).toHaveBeenCalledTimes(1);
    await expect(transport.flush(500)).resolves.toBe(true);
    expect(h.baseFlush).toHaveBeenCalledWith(500);
  });

  // Breaks if the gate sits OUTSIDE the offline queue: envelopes queued on
  // disk by an earlier version (sent under its opt-out default) would be
  // retried through the ungated base and delivered without consent.
  it('gates the base transport inside the offline queue', () => {
    expect(h.offlineWrapped).toHaveLength(1);
    const base = h.offlineWrapped[0] as (o: object) => { send: (e: unknown) => Promise<unknown> };
    void base({}).send(ENVELOPES[0]);
    expect(h.baseSend).not.toHaveBeenCalled();
  });
});
