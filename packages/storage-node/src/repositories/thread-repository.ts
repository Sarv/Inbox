// Thread Repository - All thread-related database operations

import type { ThreadRecord, AttachmentRecord, PaginationOptions } from '@sarvinbox/core';
import { generateThreadId, normalizeSubject } from '@sarvinbox/core';

import { BaseRepository, type DatabaseAccessor } from './base-repository';

/** Columns callers may sort threads by */
const THREAD_SORT_COLUMNS = new Set([
  'last_message_date', 'subject', 'message_count', 'created_at', 'updated_at',
]);

/**
 * Repository for thread and attachment operations
 */
export class ThreadRepository extends BaseRepository {
  constructor(getDb: DatabaseAccessor) {
    super(getDb);
  }

  /**
   * Upsert a thread
   */
  async upsert(thread: ThreadRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO threads (
        id, subject,
        first_message_id, last_message_id, last_message_date, message_count,
        participants,
        has_unread, has_flagged, labels
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        subject = excluded.subject,
        last_message_id = excluded.last_message_id,
        last_message_date = excluded.last_message_date,
        message_count = excluded.message_count,
        participants = excluded.participants,
        has_unread = excluded.has_unread,
        has_flagged = excluded.has_flagged,
        labels = excluded.labels
    `).run(
      thread.id,
      thread.subject,
      thread.firstMessageId,
      thread.lastMessageId,
      thread.lastMessageDate,
      thread.messageCount,
      thread.participants,
      thread.hasUnread ? 1 : 0,
      thread.hasFlagged ? 1 : 0,
      JSON.stringify(thread.labels)
    );
  }

  /**
   * Get thread by ID
   */
  async get(id: string): Promise<ThreadRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE id = ?')
      .get(id) as any;

    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Get threads with pagination
   */
  async getAll(options: PaginationOptions): Promise<ThreadRecord[]> {
    // Whitelist sort inputs — they're interpolated into the SQL
    let sortCol = this.camelToSnake(options.sortBy || 'last_message_date');
    if (!THREAD_SORT_COLUMNS.has(sortCol)) sortCol = 'last_message_date';
    const sortDir = (options.sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const rows = this.db
      .prepare(`
        SELECT * FROM threads
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ? OFFSET ?
      `)
      .all(options.limit, options.offset) as any[];

    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Update thread
   */
  async update(id: string, updates: Partial<ThreadRecord>): Promise<void> {
    const { setClauses, params } = this.buildUpdateClauses(updates, {
      jsonFields: ['labels'],
      boolFields: ['hasUnread', 'hasFlagged'],
    });

    if (setClauses.length === 0) return;

    params.id = id;
    this.db.prepare(`
      UPDATE threads
      SET ${setClauses.join(', ')}
      WHERE id = @id
    `).run(params);
  }

  /**
   * Delete thread
   */
  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  /**
   * Rebuild all thread IDs based on references/inReplyTo headers.
   *
   * NEVER wholesale-delete threads while emails reference them —
   * emails.thread_id has ON DELETE CASCADE, so a `DELETE FROM threads`
   * would wipe the entire emails table. Instead: upsert the new thread
   * rows first, repoint the emails, then drop only unreferenced threads.
   */
  async rebuild(): Promise<{ emailsUpdated: number; threadsCreated: number }> {
    let emailCount = 0;
    let threadCount = 0;

    const tx = this.db.transaction(() => {
      // Get all emails
      const emails = this.db.prepare(
        'SELECT id, message_id, subject, in_reply_to, "references", date FROM emails ORDER BY date ASC'
      ).all() as any[];

      // Recalculate thread ID for each email
      const threadMap = new Map<string, { emails: any[]; subject: string }>();

      for (const email of emails) {
        const normalized = normalizeSubject(email.subject || '');
        const newThreadId = generateThreadId(
          normalized,
          email.message_id,
          email.in_reply_to,
          email.references
        );
        email.new_thread_id = newThreadId;

        // Track thread info
        if (!threadMap.has(newThreadId)) {
          threadMap.set(newThreadId, { emails: [], subject: email.subject || '(No Subject)' });
        }
        threadMap.get(newThreadId)!.emails.push(email);
      }

      // Upsert thread records FIRST so the emails' FK targets exist
      const upsertThread = this.db.prepare(`
        INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          subject = excluded.subject,
          first_message_id = excluded.first_message_id,
          last_message_id = excluded.last_message_id,
          last_message_date = excluded.last_message_date,
          message_count = excluded.message_count
      `);
      for (const [threadId, data] of threadMap) {
        const sorted = data.emails.sort((a: any, b: any) => a.date - b.date);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        upsertThread.run(threadId, data.subject, first.id, last.id, last.date, sorted.length);
      }

      // Repoint emails to their new threads
      const updateEmail = this.db.prepare('UPDATE emails SET thread_id = ? WHERE id = ?');
      for (const email of emails) {
        updateEmail.run(email.new_thread_id, email.id);
      }

      // Drop threads nothing references anymore
      this.db.prepare(
        'DELETE FROM threads WHERE id NOT IN (SELECT DISTINCT thread_id FROM emails WHERE thread_id IS NOT NULL)'
      ).run();

      emailCount = emails.length;
      threadCount = threadMap.size;
    });
    tx();

    return {
      emailsUpdated: emailCount,
      threadsCreated: threadCount,
    };
  }

  // ========== Chat Extraction Tracking ==========

  /**
   * Get threads that need conversation extraction (multi-email threads
   * where extraction hasn't been done or email count has changed).
   */
  async getPendingExtractionThreads(limit = 5): Promise<{ id: string; messageCount: number }[]> {
    const rows = this.db
      .prepare(`
        SELECT id, message_count
        FROM threads
        WHERE message_count >= 2
          AND (chat_extracted_at IS NULL OR chat_email_count < message_count)
          -- Only AUTO-process real conversations (>= 2 distinct senders). A
          -- thread where the same person emails repeatedly with no reply from
          -- anyone else has no back-and-forth to extract — skip it to save AI
          -- work; the user can still process it on demand from the thread view.
          AND (
            SELECT COUNT(DISTINCT LOWER(from_address))
            FROM emails
            WHERE emails.thread_id = threads.id
          ) >= 2
        ORDER BY last_message_date DESC
        LIMIT ?
      `)
      .all(limit) as any[];

    return rows.map(row => ({
      id: row.id,
      messageCount: row.message_count,
    }));
  }

  /**
   * Mark a thread as having been extracted for chat view.
   */
  async updateChatExtraction(threadId: string, emailCount: number): Promise<void> {
    this.db
      .prepare(`
        UPDATE threads
        SET chat_extracted_at = unixepoch(), chat_email_count = ?
        WHERE id = ?
      `)
      .run(emailCount, threadId);
  }

  // ========== Attachment Operations ==========

  /**
   * Insert attachment
   */
  async insertAttachment(attachment: AttachmentRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO attachments (id, email_id, filename, content_type, size, file_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      attachment.id,
      attachment.emailId,
      attachment.filename,
      attachment.contentType,
      attachment.size,
      attachment.filePath
    );
  }

  /**
   * Get attachments for an email
   */
  async getAttachments(emailId: string): Promise<AttachmentRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE email_id = ?')
      .all(emailId) as any[];

    return rows.map(row => this.rowToAttachmentRecord(row));
  }

  /**
   * Delete attachment
   */
  async deleteAttachment(id: string): Promise<void> {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  }

  /**
   * Convert database row to ThreadRecord
   */
  private rowToRecord(row: any): ThreadRecord {
    return {
      id: row.id,
      subject: row.subject,
      firstMessageId: row.first_message_id,
      lastMessageId: row.last_message_id,
      lastMessageDate: row.last_message_date,
      messageCount: row.message_count,
      participants: row.participants,
      hasUnread: row.has_unread === 1,
      hasFlagged: row.has_flagged === 1,
      labels: this.parseJsonField(row.labels, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Convert database row to AttachmentRecord
   */
  private rowToAttachmentRecord(row: any): AttachmentRecord {
    return {
      id: row.id,
      emailId: row.email_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      filePath: row.file_path,
      createdAt: row.created_at,
    };
  }
}
