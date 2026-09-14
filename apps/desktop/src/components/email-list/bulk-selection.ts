/**
 * Which emails a bulk action in the list should act on.
 *
 * Extracted from EmailList so the rule is unit-testable: it decides what
 * "Delete" does to a multi-message conversation, and getting it wrong destroys
 * mail the user never selected.
 *
 * The rule is thread-wide everywhere EXCEPT Drafts. Acting on only a thread's
 * representative left siblings untouched — "mark read" marked the latest while
 * the row stayed bold because an older message was still unread — so a
 * selection means the whole conversation.
 *
 * Drafts is the exception, and the reason is asymmetric: there, a row IS the
 * draft. Its thread siblings are the received mail the draft replies to —
 * messages the user did not select and, in the Drafts view, cannot even see.
 * Taking the thread there sent an incoming email to Trash because an unsent
 * reply to it was deleted. Losing received mail is unrecoverable in a way that
 * a stale unread badge is not, so Drafts narrows to the drafts themselves.
 */

import type { EmailRecord } from '@sarvinbox/core';

import type { EmailThread } from '../../utils/thread-utils';
import { isDraftEmail } from '../../utils/thread-utils';

export type BulkSelectionInput = {
  /** Threads currently rendered; only these can be selected. */
  visibleThreads: Pick<EmailThread, 'threadId' | 'emails'>[];
  selectedThreadIds: ReadonlySet<string>;
  /** True when the list is showing a Drafts folder. */
  viewIsDrafts: boolean;
  /** Every Drafts path across the account(s) — provider paths included. */
  draftFolderPaths?: Set<string>;
};

/**
 * The actionable emails within ONE thread, for the current view.
 *
 * The single place the Drafts narrowing is decided, so the row actions (the
 * hover trash/archive icons) and the bulk toolbar cannot disagree. They did:
 * the bulk path was fixed for Drafts while the row path still expanded to the
 * whole conversation, which is the same data loss one click at a time.
 */
export function actionableEmailIds(
  emails: readonly EmailRecord[],
  viewIsDrafts: boolean,
  draftFolderPaths?: Set<string>,
): string[] {
  // `isDraftEmail` is the shared definition — it also rejects a sent copy or a
  // trashed draft still carrying a stale `|draft|` tag — so this cannot drift
  // from what the rest of the app treats as a draft.
  const rows = viewIsDrafts ? emails.filter((e) => isDraftEmail(e, draftFolderPaths)) : emails;
  return rows.map((e) => e.id);
}

/**
 * Email ids a bulk action should target for the current selection.
 *
 * @returns ids in thread order; empty when nothing is selected.
 */
export function selectedEmailIdsFor({
  visibleThreads,
  selectedThreadIds,
  viewIsDrafts,
  draftFolderPaths,
}: BulkSelectionInput): string[] {
  return visibleThreads
    .filter((t) => selectedThreadIds.has(t.threadId))
    .flatMap((t) => actionableEmailIds(t.emails as EmailRecord[], viewIsDrafts, draftFolderPaths));
}
