/**
 * Pure helpers that turn a detected code into the card the app shows.
 *
 * Kept apart from `index.ts` so the decisions that matter — is this mail fresh
 * enough to interrupt someone for, what does the card say, when does it die —
 * are plain functions over plain data and can be unit tested without an
 * extension host, a window, or a clock.
 */

import type { EmailRecord, ExtensionUINotification } from '@sarvinbox/core';

import type { OtpDetection } from './otp-detect';

/**
 * How recently the mail must have arrived for a card to be worth showing.
 *
 * A code is only useful while the login attempt that triggered it is still on
 * screen. Without this bound, a first sync of a 40,000-message mailbox, an
 * account re-add, or a folder re-scan would fire a burst of cards for codes
 * that expired months ago. The tag is still applied in those cases — it is the
 * interruption that is gated, not the detection.
 */
export const MAX_NOTIFY_AGE_MS = 15 * 60 * 1000;

/** Tag applied to every mail a code was found in, so codes stay searchable. */
export const OTP_TAG = 'otp';

/** Id prefix; the host namespaces it again with the extension id. */
const CARD_PREFIX = 'code';

/**
 * UTC epoch milliseconds the mail arrived, preferring the time WE received it
 * over the sender's `Date:` header — a sender with a wrong clock must not be
 * able to make an old code look fresh (or a fresh one look old).
 */
export function receivedAtMs(email: Pick<EmailRecord, 'date' | 'receivedDate'>): number | null {
  const seconds = email.receivedDate ?? email.date;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * True when the mail is recent enough to interrupt the user for.
 *
 * Mail dated in the future is treated as fresh rather than rejected: a skewed
 * sender clock is common and a real code should still surface.
 */
export function isFreshEnoughToNotify(
  email: Pick<EmailRecord, 'date' | 'receivedDate'>,
  now: number = Date.now(),
  maxAgeMs: number = MAX_NOTIFY_AGE_MS
): boolean {
  const arrived = receivedAtMs(email);
  if (arrived === null) return false;
  return now - arrived <= maxAgeMs;
}

/** Who the code came from, for the supporting line on the card. */
export function senderLabel(email: Pick<EmailRecord, 'fromName' | 'fromAddress'>): string {
  const name = email.fromName?.trim();
  if (name) return name;
  const address = email.fromAddress?.trim();
  return address || 'Unknown sender';
}

/** Stable card id — one card per email, so a re-run replaces rather than stacks. */
export function notificationId(emailId: string): string {
  return `${CARD_PREFIX}:${emailId}`;
}

/**
 * Build the card. `expiresAt` is absolute UTC epoch ms so the renderer can run
 * its countdown without knowing when detection happened.
 */
export function buildOtpNotification(
  email: Pick<EmailRecord, 'id' | 'accountId' | 'fromName' | 'fromAddress'>,
  detection: OtpDetection,
  now: number = Date.now()
): ExtensionUINotification {
  return {
    id: notificationId(email.id),
    title: 'Verification code',
    body: senderLabel(email),
    fields: [{ label: 'Code', value: detection.code, copyable: true, emphasis: true }],
    expiresAt: now + detection.expiresInMs,
    emailId: email.id,
    ...(email.accountId ? { accountId: email.accountId } : {}),
  };
}
