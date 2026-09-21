/**
 * Turning one synced message into the observations it justifies.
 *
 * Pure on purpose: this is the step that decides what the extension believes
 * about you, and believing the wrong thing here is invisible — it shows up
 * weeks later as the wrong mail being marked important.
 */

import { hasTag, isOwnMailFolder, type EmailRecord } from '@sarvinbox/core/extension-sdk';

import type { SenderObservation } from './relationship';
import {
  creditableRecipients,
  isUnreachableSender,
  normalizeSenderKey,
  recipientCount,
} from './sender-key';

/** One sender key plus what this message says about them. */
export interface KeyedObservation {
  key: string;
  observation: SenderObservation;
}

/**
 * True when the folder holds the user's own outgoing mail.
 *
 * Uses the app's own classifier rather than a local name test: `Sent`,
 * `Sent Items`, `INBOX.Sent` and `[Gmail]/Sent Mail` are all the same folder,
 * and `Consent Forms` is not. A second implementation of that would drift.
 *
 * Drafts count as outgoing on purpose — addressing a draft to someone is a
 * statement of intent, and the Sent copy that follows adds at most one extra
 * credit to a relationship that plainly exists.
 */
export function isOutgoingFolder(folderPath: string): boolean {
  return isOwnMailFolder({ path: folderPath, name: folderPath, specialUse: null });
}

/**
 * UTC epoch ms for a message, preferring the time we received it over the
 * sender's `Date:` header — a wrong clock on the far end must not be able to
 * rewrite when a relationship happened.
 */
export function messageTimeMs(
  email: Pick<EmailRecord, 'date' | 'receivedDate'>,
  fallback: number
): number {
  const seconds = email.receivedDate ?? email.date;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return fallback;
  return seconds * 1000;
}

/**
 * What this message tells us, as zero or more per-sender observations.
 *
 * An inbound message produces at most one (about its sender). An outbound one
 * produces one per recipient — writing to someone is the clearest statement
 * that they matter, and it is the only signal that keeps working after the
 * first sync, when every newly arrived message is by definition unanswered.
 */
export function observationsFor(
  email: Pick<EmailRecord, 'fromAddress' | 'toAddress' | 'tags' | 'date' | 'receivedDate'>,
  folderPath: string,
  fallbackTime: number
): KeyedObservation[] {
  const at = messageTimeMs(email, fallbackTime);

  if (isOutgoingFolder(folderPath)) {
    return creditableRecipients(email.toAddress).map((key) => ({
      key,
      observation: { inbound: false, answered: false, starred: false, direct: false, at },
    }));
  }

  const key = normalizeSenderKey(email.fromAddress);
  if (!key || isUnreachableSender(key)) return [];

  const tags = email.tags || '';
  return [
    {
      key,
      observation: {
        inbound: true,
        answered: hasTag(tags, 'answered'),
        starred: hasTag(tags, 'starred'),
        direct: recipientCount(email.toAddress) === 1,
        at,
      },
    },
  ];
}
