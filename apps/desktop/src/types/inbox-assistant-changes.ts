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
  | 'add_category' | 'remove_category'
  | 'add_label' | 'remove_label'
  | 'snooze' | 'unsnooze'
  /** The user's spam verdict: these also teach the spam filter, so they always ask. */
  | 'spam' | 'not_spam';

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
  /** Label name, for `add_label` / `remove_label`. */
  labelName?: string;
  /** Accounts where applying this set first creates the label (it does not exist there yet). */
  createsLabelIn?: string[];
  /** When snoozed mail comes back (unix seconds), for `snooze`. */
  snoozeUntil?: number;
  /**
   * The set changes more than these emails (a spam verdict also teaches the
   * filter; a new label stays). It always waits for the user's approval, even
   * when the chat may apply changes without asking.
   */
  standing?: boolean;
  /** One line under the title saying what else approving does. */
  note?: string;
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

/**
 * The agent's undo_change of an earlier change, shown under its answer as
 * that change's own card with only its Undo button. Nothing is held for it in
 * main: the user's click is the earlier card's own Undo, sent with the
 * earlier exchange's id, and the earlier card's Undo window governs.
 */
export interface InboxAgentUndoRequest {
  kind: 'change_set' | 'setting';
  /** The change set's or setting change's id. */
  id: string;
  /** The exchange whose card it is. */
  exchangeId: string;
  /** C1, R1… */
  label: string;
  summary: string;
  /** waiting: nothing changes until the user clicks Undo. undone: the agent undid it for the user ("Approve for me"). */
  outcome: 'waiting' | 'undone';
}

export interface InboxAgentChangeSetRequest {
  requestId: string;
  chatId: string;
  exchangeId: string;
  changeSetId: string;
  decision: 'approve' | 'cancel' | 'undo';
  /** Rows to approve or undo. Approve: default every row not protected. Undo: default every changed row. */
  itemIds?: string[];
  /** For a standing change: also apply it to the existing mail it offers (approve only). */
  includeExisting?: boolean;
}

/**
 * Standing changes: settings the Inbox Agent asks to change, which keep acting
 * after the chat (a filter, a sender block). They always wait for the user's
 * approval, in every mode, and can be undone like a change set.
 */
export type InboxAgentSettingKind =
  | 'create_filter' | 'update_filter' | 'delete_filter'
  | 'block_sender' | 'unblock_sender' | 'add_vip' | 'remove_vip' | 'trust_sender' | 'untrust_sender';

export type InboxAgentSettingStatus = 'pending' | 'applied' | 'cancelled' | 'expired' | 'undone';

export interface InboxAgentSettingChange {
  id: string;
  /** The id the agent used for it in this chat (R1, R2…). */
  label: string;
  kind: InboxAgentSettingKind;
  accountId: string;
  accountEmail: string;
  /** One line for the card title, e.g. 'Create filter "Newsletters"'. */
  summary: string;
  /** What it does, in plain words (the filter's conditions and actions, what blocking means). */
  details: string[];
  /**
   * Existing mail it can also change now, offered unticked: a filter's
   * actions on the mail it matches, or a blocked sender's mail moved to Spam.
   */
  existing?: {
    /** "Also apply it to the 37 emails it matches now". */
    text: string;
    count: number;
    /** Protected emails among them, left as they are even when ticked. */
    protectedCount: number;
    /** What happened to them, once applied. */
    result?: string;
  };
  createdAt: number;
  approveBy: number;
  undoBy: number;
  status: InboxAgentSettingStatus;
  /** The user ticked "also apply to existing mail" when approving. */
  existingApplied?: boolean;
  /** Why the last decision did not go through, or what Undo left. */
  detail?: string;
}
