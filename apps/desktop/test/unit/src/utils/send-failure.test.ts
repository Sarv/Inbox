import { describe, it, expect, afterEach, vi } from 'vitest';

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
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { alertSpy, logSpy };
  };

  it('alerts the user with the error message and logs the error', () => {
    const { alertSpy, logSpy } = stub();
    const error = new Error('535 auth failed');
    reportSendFailure(error);
    expect(alertSpy).toHaveBeenCalledWith('Failed to send email: 535 auth failed');
    expect(logSpy).toHaveBeenCalledWith('Failed to send email:', error);
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
