/**
 * The addresses a recipient field will actually send to: the committed chips
 * plus whatever is still typed in the box, when it looks like an address.
 * Deduplicated, order kept.
 *
 * The one copy of this rule — the composers send with it, and the OpenPGP
 * toggles resolve keys for exactly the same list, so the lock never promises
 * encryption to a set of recipients that differs from the one the mail goes to.
 */
export const mergeRecipientEmails = (committed: string, pending: string): string[] => {
  const rawCommitted = committed.split(',').map((entry) => entry.trim()).filter(Boolean);
  const rawPending = pending.split(',').map((entry) => entry.trim()).filter((entry) => entry.includes('@'));
  return [...new Set([...rawCommitted, ...rawPending])];
};
