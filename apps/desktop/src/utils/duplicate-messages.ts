import type { EmailRecord } from '@sarvinbox/core';

import { parseAttachments } from '../components/email-detail/utils';

/**
 * Collapsing copies of ONE message — same Message-ID — inside a conversation.
 *
 * WHY THIS EXISTS. The same message can reach one conversation more than once:
 * a unified thread draws from several account DBs, so a mail addressed to two
 * of the reader's accounts arrives as two rows carrying the SAME Message-ID.
 * Rendering both makes the reader scroll past the same paragraph twice.
 *
 * WHAT IT MUST NEVER DO — the rule that outranks everything below. A DIFFERENT
 * Message-ID is a DIFFERENT message, even when sender, subject, body and
 * attachments are byte-identical. Four identical OTP mails ARE four mails: the
 * sender really did send four, each got its own Message-ID, and folding them
 * into one row told the reader something untrue. Identity therefore STARTS at
 * the Message-ID; the content comparison below only confirms it, and can never
 * substitute for it.
 *
 * Within a single account `emails.message_id` is UNIQUE (see `schema.sql`), so
 * the collapse cannot fire there at all — that is the intended, safe resting
 * state, not a sign the helper is dead code.
 *
 * This is deliberately a READ-TIME, RENDER-ONLY collapse:
 *
 *   * Nothing is deleted. Every copy is a genuine message on the server; a
 *     delete would either propagate to the server or be restored by the next
 *     sync, and either way we would be destroying mail to fix a display bug.
 *   * Nothing is written. The stored `content_hash` predates the fix that made
 *     it body-derived, so it cannot be trusted on existing rows — identity is
 *     recomputed here from the body we actually hold.
 *   * The hidden copies stay in the caller's full list for flag work (marking
 *     the thread read must still reach them, or the unread badge never clears).
 */
export interface MessageGroup {
  /** The copy that gets rendered — the earliest, unless one is pinned. */
  email: EmailRecord;
  /** Identical copies folded behind it, earliest first. Empty for a normal message. */
  duplicates: EmailRecord[];
}

/**
 * The body to compare, or null when we cannot prove identity from it.
 *
 * `rawBody` ONLY, and this is the load-bearing part of the whole helper. LIST
 * rows carry a bounded SNIPPET in `cleanBody` and no `rawBody` at all (see
 * `EmailRecord`), so two unrelated messages whose first 100 characters happen to
 * agree would look identical. Requiring the full original means a message whose
 * body has not downloaded yet is simply never collapsed — it shows as its own
 * copy until the body lands, which is the safe direction to be wrong in.
 */
function comparableBody(email: EmailRecord): string | null {
  const raw = (email.rawBody ?? '').trim();
  return raw ? raw : null;
}

/** FNV-1a. Only a bucket key — an exact `===` on the body confirms every match. */
function cheapHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The Message-ID to compare on, or null when there is none we can trust.
 *
 * A blank Message-ID proves nothing about identity, so a row carrying one is
 * never a collapse candidate — it renders as its own message. Wrong in the
 * direction that only ever shows too much, never too little.
 */
function comparableMessageId(email: EmailRecord): string | null {
  const messageId = (email.messageId ?? '').trim();
  return messageId ? messageId : null;
}

/**
 * Everything about a message that must match for a second row to be the same
 * mail. The Message-ID leads: without it two distinct mails that happen to be
 * byte-identical (an OTP resend, a retried notification) would collapse into
 * one and the reader would never learn the later ones arrived.
 *
 * Deliberately EXCLUDES the date and the UID: the two copies are the same mail
 * seen by two accounts and land seconds or minutes apart, so keying on arrival
 * time would never group them.
 */
function identityKey(email: EmailRecord, messageId: string, body: string): string {
  const attachments = parseAttachments(email.attachmentNames, email.attachmentSizes)
    .map((a) => `${a.name}:${a.size ?? '?'}`)
    .sort()
    .join(';');

  return [
    messageId,
    (email.fromAddress || '').trim().toLowerCase(),
    (email.subject || '').trim(),
    email.attachmentCount ?? 0,
    attachments,
    body.length,
    cheapHash(body),
  ].join('\u0000');
}

/**
 * Group a conversation's messages, folding byte-identical copies behind the one
 * that gets shown. Returns earliest-first; input is not mutated.
 *
 * @param pinnedId an email that MUST stay visible even if it is a later copy —
 *   pass the currently selected email, or opening a duplicate from search would
 *   render an empty detail pane.
 */
export function collapseDuplicateMessages(
  emails: EmailRecord[],
  pinnedId?: string | null,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const buckets = new Map<string, { body: string; group: MessageGroup }[]>();

  const earliestFirst = [...emails].sort(
    (a, b) => (a.date - b.date) || (a.uid - b.uid) || a.id.localeCompare(b.id),
  );

  for (const email of earliestFirst) {
    const body = comparableBody(email);
    const messageId = comparableMessageId(email);
    if (!body || !messageId) {
      groups.push({ email, duplicates: [] });
      continue;
    }

    const key = identityKey(email, messageId, body);
    const bucket = buckets.get(key);
    // The `===` is what makes a hash collision harmless: same bucket still has
    // to mean the same bytes.
    const hit = bucket?.find((candidate) => candidate.body === body);

    if (!hit) {
      const group: MessageGroup = { email, duplicates: [] };
      groups.push(group);
      if (bucket) bucket.push({ body, group });
      else buckets.set(key, [{ body, group }]);
      continue;
    }

    if (pinnedId && email.id === pinnedId) {
      // The selected copy takes the visible slot; the one it displaces joins
      // the hidden copies in its original (earlier) position.
      hit.group.duplicates.push(hit.group.email);
      hit.group.email = email;
    } else {
      hit.group.duplicates.push(email);
    }
  }

  return groups;
}

/** Ids of every copy this group hides — never includes the visible one. */
export function hiddenDuplicateIds(groups: MessageGroup[]): Set<string> {
  return new Set(groups.flatMap((g) => g.duplicates.map((d) => d.id)));
}
