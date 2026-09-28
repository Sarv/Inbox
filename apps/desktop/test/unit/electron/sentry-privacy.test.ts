import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Crash reports leave the device. Breaks if: sender addresses reach Sentry in
// breadcrumbs or error texts (a privacy-policy breach and a Google Limited Use
// violation for Gmail accounts), or "Send crash reports" off still sends —
// including the native crash uploaded on the next launch.

const h = vi.hoisted(() => ({ userData: '', init: vi.fn(), addBreadcrumb: vi.fn(), captureMessage: vi.fn() }));

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
}));
vi.mock('@sarvinbox/storage-node', () => ({ setSlowQueryReporter: vi.fn() }));

const dir = mkdtempSync(join(tmpdir(), 'sentry-privacy-'));
h.userData = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type SentryModule = typeof import('../../../electron/sentry');
let sentry: SentryModule;

async function freshInit(): Promise<SentryModule> {
  vi.resetModules();
  h.init.mockReset();
  process.env.SARVINBOX_SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
  const mod = await import('../../../electron/sentry');
  mod.initSentryMain();
  return mod;
}

beforeEach(async () => {
  rmSync(join(dir, 'crash-reports.json'), { force: true });
  sentry = await freshInit();
});

describe('Sentry privacy filters (main)', () => {
  // Every outgoing breadcrumb and event goes through the scrubbers.
  it('wires beforeBreadcrumb/beforeSend and disables default PII', () => {
    const opts = h.init.mock.calls[0][0];
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.beforeBreadcrumb({ message: 'spam from a@b.com' })).toEqual({ message: 'spam from [email]' });
    const ev = opts.beforeSend({ message: 'x@y.com failed', user: { id: 'h', email: 'me@gmail.com' } }, {});
    expect(ev).toEqual({ message: '[email] failed', user: { id: 'h' } });
  });

  // Transient network blips stay out of the issue stream (pre-existing rule).
  it('still drops transient connection errors', () => {
    expect(sentry.filterEvent({ message: 'x' } as never, Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBeNull();
  });

  // Opt-out applies immediately and persists for the next launch.
  it('drops everything once turned off, and remembers it across a restart', async () => {
    sentry.setCrashReportsEnabled(false);
    expect(sentry.filterBreadcrumb({ message: 'm' })).toBeNull();
    expect(sentry.filterEvent({ message: 'm' } as never)).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, 'crash-reports.json'), 'utf8'))).toEqual({ enabled: false });

    const restarted = await freshInit(); // native crash from last run uploads now
    expect(restarted.crashReportsEnabled()).toBe(false);
    expect(restarted.filterEvent({ message: 'minidump' } as never)).toBeNull();

    restarted.setCrashReportsEnabled(true);
    expect(restarted.filterEvent({ message: 'ok' } as never)).toEqual({ message: 'ok' });
  });

  // Unreadable/corrupt file must not silently opt a user out (or in): only an
  // explicit false opts out, matching the renderer.
  it('reads a corrupt or missing preference file as enabled', async () => {
    writeFileSync(join(dir, 'crash-reports.json'), '{not json');
    expect((await freshInit()).crashReportsEnabled()).toBe(true);
  });

  // Slow-query telemetry: folder paths (user-named, often people) never leave.
  it('keeps only numeric/boolean slow-query meta', async () => {
    const { setSlowQueryReporter } = await import('@sarvinbox/storage-node');
    const report = vi.mocked(setSlowQueryReporter).mock.calls.at(-1)![0]!;
    report({ label: 'getByFolder', ms: 900, rows: 3, totalEmails: 10, meta: { folder: 'Clients/Jane Doe', n: 2, scoped: true } });
    expect(h.captureMessage.mock.calls.at(-1)![1].extra).toEqual({ ms: 900, rows: 3, totalEmails: 10, n: 2, scoped: true });
  });
});
