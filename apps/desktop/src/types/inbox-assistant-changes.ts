/**
 * Change sets: the mail changes the Inbox Agent asked for in one run, as the
 * user sees them on a card. Display data only; the host keeps the
 * authoritative snapshot of each message in main-process memory, and a card
 * restored from history after a restart can no longer be approved or undone.
 * See docs/INBOX_AGENT_HARNESS.md, "Harness guarantees".
 */

export type InboxAgentChangeAction =
  | 'mark_read' | 'mark_unread' | 'star' | 'unstar'
  | 'archive' | 'trash' | 'restore' | 'move'
  | 'add_category' | 'remove_category';

export type InboxAgentChangeItemStatus =
  /** Waiting for the user's approval. */
  | 'pending'
  /** Changed, and confirmed by the server or saved locally only (no server copy). */
  | 'applied'
  /** Changed here and saved for the server; it syncs when the account is online. */
  | 'queued'
  /** Already as requested: nothing was written. */
  | 'unchanged'
  | 'failed'
  /** Left out: the user did not select it, or it changed after it was staged. */
  | 'skipped'
  | 'undone';

export interface InboxAgentChangeItem {
  id: string;
  accountId: string;
  accountEmail: string;
  emailId: string;
  threadId: string;
  subject: string;
  from: string;
  date: number;
  /** Why the agent chose it (from its classification), when it said. */
  reason?: string;
  /**
   * Why the host left it out of the change (a security code, a bank record,
   * starred mail…). It is applied only if the user ticks it on the card, and
   * never automatically.
   */
  protectedReason?: string;
  status: InboxAgentChangeItemStatus;
  /** Why it failed or was skipped. */
  detail?: string;
}

export type InboxAgentChangeSetStatus =
  | 'pending' | 'applied' | 'partial' | 'cancelled' | 'expired' | 'undone';

export interface InboxAgentChangeSet {
  id: string;
  /** The id the agent used for it in this run (C1, C2…). */
  label: string;
  action: InboxAgentChangeAction;
  /** Destination folder path, for `move`. */
  folder?: string;
  /** Category slug, for `add_category` / `remove_category`. */
  category?: string;
  /** One line for the card title, e.g. "Mark 35 emails read". */
  summary: string;
  createdAt: number;
  /** After this, a pending set can no longer be approved. */
  approveBy: number;
  /** After this, an applied set can no longer be undone. */
  undoBy: number;
  status: InboxAgentChangeSetStatus;
  /** Applied by "Approve for me" without a card decision. */
  autoApplied?: boolean;
  items: InboxAgentChangeItem[];
}

export interface InboxAgentChangeSetRequest {
  requestId: string;
  chatId: string;
  exchangeId: string;
  changeSetId: string;
  decision: 'approve' | 'cancel' | 'undo';
  /** Rows to approve or undo. Approve: default every row not protected. Undo: default every changed row. */
  itemIds?: string[];
}
