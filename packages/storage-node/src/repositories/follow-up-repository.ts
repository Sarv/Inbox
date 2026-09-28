// Follow-up Repository — "remind me if nobody replies" (migration v94)

import { generateId, type FollowUp, type FollowUpInput, type FollowUpStatus } from '@sarvinbox/core';

import { BaseRepository } from './base-repository';

/** Statuses still waiting on the user: not yet due, or due and unanswered. */
const OPEN_STATUSES: FollowUpStatus[] = ['pending', 'due'];

export class FollowUpRepository extends BaseRepository {
  private mapRow(row: any): FollowUp {
    return {
      id: row.id,
      messageId: row.message_id,
      subject: row.subject,
      recipients: row.recipients,
      fromAddress: row.from_address,
      sentAt: row.sent_at,
      dueAt: row.due_at,
      status: row.status,
      resolvedAt: row.resolved_at ?? null,
      // The sent message as it stands NOW — the local mirror row is replaced by
      // the server's copy after the Sent sync, so these are looked up, not stored.
      emailId: row.email_id ?? null,
      threadId: row.thread_id ?? null,
    };
  }

  /**
   * Record a reminder for a message that just went out. Idempotent on the
   * Message-ID: an outbox retry of the same send returns the reminder that
   * already exists (in whatever state the user left it) instead of adding one.
   */
  create(input: FollowUpInput): FollowUp {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO follow_ups
           (id, message_id, subject, recipients, from_address, sent_at, due_at, status)
         VALUES (@id, @messageId, @subject, @recipients, @fromAddress, @sentAt, @dueAt, 'pending')`,
      )
      .run({
        id: generateId(),
        messageId: input.messageId,
        subject: input.subject ?? '',
        recipients: input.recipients ?? '',
        fromAddress: (input.fromAddress ?? '').toLowerCase(),
        sentAt: input.sentAt,
        dueAt: input.dueAt,
      });
    return this.getByMessageId(input.messageId)!;
  }

  private selectSql(where: string): string {
    // emails.message_id is UNIQUE, so the join finds at most one row: the
    // local Sent mirror at first, the server's copy once Sent has synced.
    return `
      SELECT f.*, e.id AS email_id, e.thread_id AS thread_id
      FROM follow_ups f
      LEFT JOIN emails e ON e.message_id = f.message_id
      ${where}`;
  }

  get(id: string): FollowUp | null {
    const row = this.db.prepare(this.selectSql('WHERE f.id = ?')).get(id);
    return row ? this.mapRow(row) : null;
  }

  getByMessageId(messageId: string): FollowUp | null {
    const row = this.db.prepare(this.selectSql('WHERE f.message_id = ?')).get(messageId);
    return row ? this.mapRow(row) : null;
  }

  /** Every open reminder, the ones already due first, then soonest due. */
  listOpen(limit = 500): FollowUp[] {
    const rows = this.db
      .prepare(
        this.selectSql(
          `WHERE f.status IN (${OPEN_STATUSES.map(() => '?').join(', ')})
           ORDER BY f.status = 'due' DESC, f.due_at ASC LIMIT ?`,
        ),
      )
      .all(...OPEN_STATUSES, limit);
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Has anyone other than the sender answered? A reply is a message that
   * names ours in In-Reply-To (definitive, whatever its Date header says), or
   * one in the same thread dated after we sent. The sender's own mail never
   * counts — nor does anything in Sent or Drafts, which covers an alias the
   * From address doesn't match.
   */
  hasReply(followUp: Pick<FollowUp, 'messageId' | 'fromAddress' | 'sentAt'>): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM emails r
         WHERE r.message_id <> @messageId
           AND lower(r.from_address) <> @fromAddress
           AND r.folder_id NOT IN (SELECT id FROM folders WHERE special_use IN ('\\Sent', '\\Drafts'))
           AND (
             r.in_reply_to = @messageId
             OR (r.date > @sentAt AND r.thread_id IN (SELECT thread_id FROM emails WHERE message_id = @messageId))
           )
         LIMIT 1`,
      )
      .get({ messageId: followUp.messageId, fromAddress: followUp.fromAddress.toLowerCase(), sentAt: followUp.sentAt });
    return !!row;
  }

  /**
   * Move an OPEN reminder to `status`. A reminder that already ended stays
   * ended: returns false rather than, say, flipping a dismissed one to due.
   */
  setStatus(id: string, status: FollowUpStatus): boolean {
    const resolvedAt = status === 'replied' || status === 'dismissed' ? this.now() : null;
    const result = this.db
      .prepare(
        `UPDATE follow_ups SET status = ?, resolved_at = ?
         WHERE id = ? AND status IN ('pending', 'due')`,
      )
      .run(status, resolvedAt, id);
    return result.changes > 0;
  }
}
