import type { EmailRecord } from '@sarvinbox/core';

import { parseAttachments } from '../components/email-detail/utils';

/**
 * Collapsing byte-identical copies of one message inside a conversation.
 *
 * WHY THIS EXISTS. Sarv ran dual delivery for a period — mail landing in Sarv
 * was also delivered to the Gmail account — and a later migration merged the
 * Gmail side back into the Sarv mailbox. The result is real, distinct server
 * messages (each with its own Message-ID and UID, so `emails.message_id UNIQUE`
 * cannot and must not stop them) that are the SAME mail. The user opens a thread
 * and reads the same paragraph seven times.
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
 * Everything about a message that must match for a second copy to be the same
 * mail. Deliberately EXCLUDES the date and the UID: the copies arrive days or
 * weeks apart (that is what dual delivery plus a migration looks like), so
 * keying on arrival time would never group them.
 */
function identityKey(email: EmailRecord, body: string): string {
  const attachments = parseAttachments(email.attachmentNames, email.attachmentSizes)
    .map((a) => `${a.name}:${a.size ?? '?'}`)
    .sort()
    .join(';');

  return [
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
    if (!body) {
      groups.push({ email, duplicates: [] });
      continue;
    }

    const key = identityKey(email, body);
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
