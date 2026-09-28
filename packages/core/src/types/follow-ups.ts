/**
 * Follow-up reminders — "remind me if nobody replies in N days".
 *
 * All times are unix epoch seconds (UTC), like every other timestamp in the
 * per-account database.
 */

/**
 * `pending` — waiting for its due time; `due` — the time passed with no reply
 * and the user has been told; `replied` / `dismissed` — ended.
 */
export type FollowUpStatus = 'pending' | 'due' | 'replied' | 'dismissed';

export interface FollowUp {
  id: string;
  /** RFC 5322 Message-ID of the sent message, as stored in emails.message_id. */
  messageId: string;
  subject: string;
  /** Display string of the To recipients, for the list and the notification. */
  recipients: string;
  /** Lowercased sender address — its own mail never counts as a reply. */
  fromAddress: string;
  sentAt: number;
  dueAt: number;
  status: FollowUpStatus;
  resolvedAt: number | null;
  /** The sent message's local row and thread, when it is in the DB. */
  emailId: string | null;
  threadId: string | null;
}

export interface FollowUpInput {
  messageId: string;
  subject?: string;
  recipients?: string;
  fromAddress?: string;
  sentAt: number;
  dueAt: number;
}

/** A reminder tagged with the account it belongs to — for views that span accounts. */
export interface AccountFollowUp extends FollowUp {
  accountId: string;
}
