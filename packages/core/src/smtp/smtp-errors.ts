// Centralized SMTP send-error classification — the single signal the outbox
// (SendQueue) keys off to decide "retry later" vs "dead-letter now". Mirrors the
// role imap-errors.ts plays for the IMAP operation queue, and reuses its shared
// network/rate-limit classifiers so the two queues agree on what "transient"
// means at the socket level.

import { isConnectionError, isRateLimited } from '../imap/imap-errors';

type NodemailerErr = Error & {
  code?: string;
  responseCode?: number;
  command?: string;
};

/**
 * True when a send failure is worth retrying (offline, dropped socket, timeout,
 * greylisting, transient 4xx) rather than permanent (auth failure, invalid
 * recipient, any 5xx). Deliberately conservative: an ambiguous/unknown failure
 * is treated as permanent so a genuinely bad message isn't retried forever — the
 * outbox also caps retries, so this is belt-and-suspenders.
 */
export function isTransientSendError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as NodemailerErr;

  // A numeric SMTP reply code is authoritative: 4xx = transient (greylist /
  // try-later / mailbox busy), 5xx = permanent (rejected). EAUTH (535) and bad
  // recipient (550/553) are 5xx and correctly fall through as permanent.
  if (typeof e.responseCode === 'number') {
    return e.responseCode >= 400 && e.responseCode < 500;
  }

  // nodemailer transport-level codes with no server reply attached.
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET' || e.code === 'EDNS') {
    return true;
  }

  // Fall back to the shared network-code classifier (ECONNRESET, ENOTFOUND,
  // "not connected", …) and rate-limit classifier (throttle / try again later).
  return isConnectionError(error) || isRateLimited(error);
}

/**
 * True when a send/auth failure is specifically an authentication / expired-token
 * error — the signal the OAuth send path uses to force a token refresh + reconnect
 * + retry (an OAuth access token expires ~hourly while the transporter caches the
 * one it connected with). Matches the SMTP EAUTH code (535), a `code: 'EAUTH'`,
 * and the common server phrasings (Sarv answers "500 invalid or expired token";
 * Gmail/others use "Invalid login" / "authentication failed" / "invalid
 * credentials"). Accepts an Error or a raw message string (the outbox carries the
 * failure as a string).
 */
export function isAuthTokenError(error: unknown): boolean {
  const e = error as NodemailerErr | undefined;
  if (e?.responseCode === 535 || e?.code === 'EAUTH') return true;
  const message = typeof error === 'string' ? error : e?.message;
  if (!message) return false;
  return /invalid or expired token|invalid login|authentication failed|authenticationfailed|invalid credentials|auth(?:entication)? (?:failed|error)|expired token|token (?:has )?expired/i.test(
    message,
  );
}
