import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core/logger';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { captureLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { reportSendFailure } from '../../../../src/utils/send-failure';

/**
 * Shared by every compose surface (new compose, inline reply, inline forward).
 * The user-facing invariant is that a send failure is ALWAYS surfaced — a
 * swallowed error looks exactly like a successful send, and the mail is lost.
 */
describe('reportSendFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).alert;
  });

  const stub = () => {
    const alertSpy = vi.fn();
    (globalThis as any).alert = alertSpy;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { alertSpy };
  };

  // Changed (2026-11-23): the log line used to carry the whole error; it now
  // names the failure's kind (see the next test). The dialog is unchanged.
  it('alerts the user with the error message and logs the failure', () => {
    const { alertSpy } = stub();
    const logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
    try {
      reportSendFailure(new Error('535 auth failed'));
      expect(alertSpy).toHaveBeenCalledWith('Failed to send email: 535 auth failed');
      expect(logs.containing('Failed to send email (Error)')).toHaveLength(1);
    } finally {
      logs.stop();
    }
  });

  // Breaks: "Failed to send email: <error>" — a send's error text (the server's
  // 5xx reply, "No encryption key for <recipients>") quotes the recipients, and
  // the renderer's errors reach app.log, a release build included. The user
  // still reads the full text in the dialog; the log keeps only its kind.
  it('logs the kind of failure, never the recipients the error text names', () => {
    const SENTINEL = 'sentinel-rcpt';
    const { alertSpy } = stub();
    const logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
    try {
      reportSendFailure(Object.assign(new Error(`550 5.1.1 <${SENTINEL}@localhost>: no such user`), { code: 'EENVELOPE' }));
      reportSendFailure(`No encryption key for ${SENTINEL}@example.org`);
      expect(alertSpy).toHaveBeenCalledWith(`Failed to send email: 550 5.1.1 <${SENTINEL}@localhost>: no such user`);
      expect(logs.containing(SENTINEL)).toEqual([]);
      expect(logs.containing('Failed to send email (EENVELOPE)')).toHaveLength(1);
      expect(logs.containing('Failed to send email (')).toHaveLength(2);
    } finally {
      logs.stop();
    }
  });

  it('shows a string rejection verbatim instead of "undefined"', () => {
    // IPC rejections often surface as plain strings; the user must see the actual
    // reason, not the word "undefined" (which is what reading `.message` off a
    // string produced).
    const { alertSpy } = stub();
    expect(() => reportSendFailure('socket closed')).not.toThrow();
    expect(alertSpy).toHaveBeenCalledWith('Failed to send email: socket closed');
  });

  // The regression that mattered: `(null as Error).message` threw a TypeError
  // from inside this handler, which escaped the compose catch and showed the user
  // NO dialog at all — a send that silently looked fine. Every rejection value,
  // including null/undefined, must still produce exactly one dialog.
  it('still shows a dialog when the rejection value is null or undefined', () => {
    for (const value of [null, undefined]) {
      const { alertSpy } = stub();
      expect(() => reportSendFailure(value)).not.toThrow();
      expect(alertSpy).toHaveBeenCalledWith('Failed to send email: Unknown error');
    }
  });
});
