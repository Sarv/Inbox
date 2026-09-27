/**
 * The lookup key form of a Message-ID.
 *
 * Bracket-stripped and lower-cased, so `<Abc@host>`, `abc@host` and
 * ` <ABC@host> ` all land on the same key. Message-IDs are case-insensitive in
 * practice and servers, clients and our own storage disagree about the angle
 * brackets, so a raw string comparison misses a match that is really there.
 *
 * Shared deliberately: `fetchMessageIdToUidMap` BUILDS its map with this and
 * every caller LOOKS UP with it. Two copies that drift apart do not fail
 * loudly — every lookup simply misses, and the message the caller was trying
 * to find (to dedupe, or to delete on the server) looks like it is not there.
 *
 * This is not the threading form: `generateThreadId` normalizes the other way,
 * TO `<id>`, because a thread hash must match what other clients put in
 * References. Keep the two apart.
 */
export function messageIdKey(id: string | null | undefined): string {
  if (!id) return '';
  return id.replace(/[<>]/g, '').trim().toLowerCase();
}
