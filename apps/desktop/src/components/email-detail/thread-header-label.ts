/**
 * The "Alice .. Bob (3)" line above an opened conversation.
 *
 * Pure and separate from `EmailDetail` because the COUNT in it is a correctness
 * question, not a layout one: the list row's "(N)" is a `COUNT(*)` of the
 * thread's rows in SQLite, while the detail pane renders the
 * duplicate-COLLAPSED list (see `collapseDuplicateMessages`). Building the label
 * from the rows it renders made the two disagree — the list promised (3), the
 * opened thread said (2) — which reads as mail that quietly went missing. The
 * fold is render-only, so the label counts every real copy and the `N copies`
 * badge on the folded row accounts for the shorter card list.
 */
export interface ThreadHeaderSender {
  date: number;
  fromName?: string | null;
  fromAddress?: string | null;
}

/** The sender's display name, falling back to the local part of their address. */
function senderLabel(email: ThreadHeaderSender | undefined): string {
  return email?.fromName || email?.fromAddress?.split('@')[0] || '';
}

/**
 * @param visibleEmails the messages actually rendered as cards — the collapsed
 *   list, which is what names the first and last participant on screen.
 * @param totalMessageCount every real message in the conversation, copies
 *   included. This is the number shown, so it matches the list row.
 */
export function threadHeaderLabel(
  visibleEmails: ThreadHeaderSender[],
  totalMessageCount: number,
): string {
  const sorted = [...visibleEmails].sort((a, b) => a.date - b.date);
  const first = senderLabel(sorted[0]);
  const last = senderLabel(sorted[sorted.length - 1]);

  // One visible card can only mean the single-email case the header exists for:
  // a forwarded/looped-in chain whose conversation lives inside one body.
  if (visibleEmails.length === 1) return `${first} forwarded a conversation`;

  return `${first === last ? first : `${first} .. ${last}`} (${totalMessageCount})`;
}
