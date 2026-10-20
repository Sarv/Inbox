import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { crashReportsAllowed, initSentryRenderer } from '../../../src/sentry';
import { useCrashReportChoiceStore } from '../../../src/services/crash-report-choice';

// The renderer gates its own Sentry capture on the MAIN process's answer
// (CASA L-8: off until the user says yes). Breaks if renderer errors or
// breadcrumbs are captured before main has said yes — at boot, when the answer
// can't be read, or after a "no" — or if a yes does not take effect at once.

const h = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('@sentry/electron/renderer', () => ({ init: h.init }));

const getCrashReports = vi.fn();

beforeEach(() => {
  useCrashReportChoiceStore.setState({ choice: null });
  h.init.mockReset();
  getCrashReports.mockReset();
  vi.stubGlobal('window', { electronAPI: { diagnostics: { getCrashReports, setCrashReports: vi.fn() } } });
  process.env.SARVINBOX_SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SARVINBOX_SENTRY_DSN;
});

describe('crashReportsAllowed', () => {
  // Changed deliberately (CASA L-8: opt-in, and main owns the answer): this
  // used to read the renderer's settings blob and allow everything but an
  // explicit `crashReports: false` — including a missing or corrupt blob.
  // Only main's explicit yes allows now.
  it('is true only once main has reported a yes', () => {
    expect(crashReportsAllowed()).toBe(false); // not read yet
    for (const choice of ['unasked', 'no'] as const) {
      useCrashReportChoiceStore.setState({ choice });
      expect(crashReportsAllowed()).toBe(false);
    }
    useCrashReportChoiceStore.setState({ choice: 'yes' });
    expect(crashReportsAllowed()).toBe(true);
  });
});

describe('initSentryRenderer', () => {
  const options = () => h.init.mock.calls[0][0] as {
    sendDefaultPii: boolean;
    beforeSend: (e: object) => object | null;
    beforeBreadcrumb: (c: object) => object | null;
  };

  // Breaks if the renderer captures during boot, before main's answer has
  // arrived, or keeps capturing after main reports anything but yes.
  it('captures nothing until main says yes, then scrubs what it captures', async () => {
    let answer!: (v: unknown) => void;
    getCrashReports.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    initSentryRenderer();
    expect(getCrashReports).toHaveBeenCalledTimes(1);
    expect(options().sendDefaultPii).toBe(false);
    expect(options().beforeSend({ message: 'boot error a@b.com' })).toBeNull();
    expect(options().beforeBreadcrumb({ message: 'click' })).toBeNull();

    answer({ success: true, data: 'yes' });
    await vi.waitFor(() => expect(crashReportsAllowed()).toBe(true));
    expect(options().beforeSend({ message: 'error a@b.com {"token":"t"}' }))
      .toEqual({ message: 'error [email] {"token":"[REDACTED]"}' });
    expect(options().beforeBreadcrumb({ message: 'from c@d.com' })).toEqual({ message: 'from [email]' });

    useCrashReportChoiceStore.setState({ choice: 'no' }); // e.g. turned off in Settings
    expect(options().beforeSend({ message: 'later' })).toBeNull();
  });

  // Breaks if a failed or malformed read is taken as consent.
  it.each([
    ['a failed read', { success: false, error: 'boom' }],
    ['a non-answer', { success: true, data: true }],
    ['unasked', { success: true, data: 'unasked' }],
  ])('keeps capturing nothing after %s', async (_label, reply) => {
    getCrashReports.mockResolvedValue(reply);
    initSentryRenderer();
    await vi.waitFor(() => expect(getCrashReports).toHaveBeenCalled());
    await Promise.resolve();
    expect(options().beforeSend({ message: 'x' })).toBeNull();
  });

  // Without a DSN the SDK must stay inert — and not ask main for anything.
  it('does nothing without a DSN', () => {
    delete process.env.SARVINBOX_SENTRY_DSN;
    initSentryRenderer();
    expect(h.init).not.toHaveBeenCalled();
    expect(getCrashReports).not.toHaveBeenCalled();
  });
});
