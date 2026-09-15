// AI Repository - Tags-based (v2)
// All category queries use instr(tags, '|slug|') — zero JOINs, no junction tables

import type { EmailRecord } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';

import type {
  EmailAICategory,
  AICategoryCounts,
  SpammerRecord,
  ThreadSummaryRecord,
  ConversationExtractionRecord,
  CategoryDefinition,
  DynamicCategoryCounts,
} from '../sqlite-storage';

import { hasBodyClause, notExcludedByTagsClause, notInExcludedFolderClause } from './agent-eligibility';
import { BaseRepository, type DatabaseAccessor } from './base-repository';
import { addTag, removeTag, parseTags, hasTag } from './email-repository';
const logger = createLogger('ai-repository');

/**
 * Repository for AI-related operations — tags-based
 */
export class AIRepository extends BaseRepository {
  constructor(
    getDb: DatabaseAccessor,
    private rowToEmailRecord: (row: any) => EmailRecord
  ) {
    super(getDb);
  }

  /**
   * SQL fragment excluding the never-categorized folders, as a run of `AND`
   * terms ready to drop into an existing WHERE.
   *
   * Built from the SHARED list rather than a second hand-written copy: this one
   * decides what the category chips and views SHOW, while the pipeline's
   * selector decides what the AI SPENDS A CALL ON. When the two lists drifted,
   * the AI categorised drafts and sent mail that these queries then filtered
   * straight back out — work paid for and never seen.
   */
  private get excludeSpecialFolders(): string {
    return `AND ${notInExcludedFolderClause().split(' AND ').join('\n      AND ')}`;
  }

  // ========== AI Categories (via tags) ==========

  /**
   * Save email categories by updating tags on the emails table
   */
  saveEmailCategories(
    emailId: string,
    categories: { slug: string; confidence: number }[],
    isSpam: boolean,
    reasoning: string,
    processedAt: number,
    confidence: number,
  ): void {
    const txn = this.db.transaction(() => {
      // Get current tags
      const row = this.db.prepare('SELECT tags FROM emails WHERE id = ?').get(emailId) as any;
      if (!row) return;

      let tags = row.tags || '||';

      // Get all known category slugs to remove old ones first
      const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
      for (const cat of allCats) {
        tags = removeTag(tags, cat.slug);
      }
      tags = removeTag(tags, 'spam');

      // Add new category tags
      for (const cat of categories) {
        tags = addTag(tags, cat.slug);
      }
      if (isSpam) {
        tags = addTag(tags, 'spam');
      }

      // Update email: tags + AI metadata
      this.db.prepare(`
        UPDATE emails SET
          tags = ?,
          ai_reasoning = ?,
          ai_confidence = ?,
          ai_processed_at = ?
        WHERE id = ?
      `).run(tags, reasoning || null, confidence, processedAt, emailId);
    });
    txn();
  }

  /**
   * Batch version of saveEmailCategories
   */
  saveEmailCategoriesBatch(batch: Array<{
    emailId: string;
    categories: { slug: string; confidence: number }[];
    isSpam: boolean;
    reasoning: string;
    processedAt: number;
    confidence: number;
  }>): number {
    const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
    const catSlugs = allCats.map(c => c.slug);

    const txn = this.db.transaction((items: typeof batch) => {
      const selectStmt = this.db.prepare('SELECT tags FROM emails WHERE id = ?');
      // Also stamp agent_status='done' + agent_at (mirroring markAgentDone) so
      // the unified pipeline's poll — which selects agent_status='pending' —
      // treats bulk/propagated categorization as complete and does NOT re-send
      // these emails to the LLM within 30s (double cost).
      // label_status='pending' so the category-label drain mirrors these to the
      // connected account. Bulk + propagation categorization flow through here and
      // previously never set it, so those mails were only ever labeled if they
      // happened to fall in the legacy INBOX+recent NULL window — the coverage gap.
      const updateStmt = this.db.prepare(`
        UPDATE emails SET tags = ?, ai_reasoning = ?, ai_confidence = ?, ai_processed_at = ?,
          agent_status = 'done', agent_at = ?, label_status = 'pending' WHERE id = ?
      `);

      let updated = 0;
      for (const item of items) {
        const row = selectStmt.get(item.emailId) as any;
        if (!row) continue;

        let tags = row.tags || '||';

        // Remove all existing category tags
        for (const slug of catSlugs) {
          tags = removeTag(tags, slug);
        }
        tags = removeTag(tags, 'spam');

        // Add new
        for (const cat of item.categories) {
          tags = addTag(tags, cat.slug);
        }
        if (item.isSpam) {
          tags = addTag(tags, 'spam');
        }

        const result = updateStmt.run(tags, item.reasoning || null, item.confidence, item.processedAt, item.processedAt, item.emailId);
        updated += result.changes;
      }
      return updated;
    });
    return txn(batch);
  }

  /**
   * Upsert email AI category (legacy compat — converts to tags)
   */
  async upsertCategory(category: EmailAICategory): Promise<void> {
    const slugMap: Record<string, boolean> = {
      important: category.isImportant,
      spam: category.isSpam,
      reminders: category.isReminder,
      waiting_reply: category.isWaitingReply,
      needs_response: category.isNeedsResponse,
      meeting: category.isMeetingRelated,
      invoice: category.isInvoiceBilling,
    };

    const cats = Object.entries(slugMap)
      .filter(([, v]) => v)
      .map(([slug]) => ({ slug, confidence: category.confidence }));

    this.saveEmailCategories(
      category.emailId,
      cats,
      category.isSpam,
      category.reasoning || '',
      category.processedAt,
      category.confidence,
    );
  }

  /**
   * Get AI category for an email (reconstructed from tags)
   */
  async getCategory(emailId: string): Promise<EmailAICategory | null> {
    const row = this.db
      .prepare('SELECT id, thread_id, tags, ai_reasoning, ai_confidence, ai_processed_at FROM emails WHERE id = ?')
      .get(emailId) as any;

    if (!row || !row.ai_processed_at) return null;

    const tags = row.tags || '||';
    return {
      id: `ai-cat-${row.id}`,
      emailId: row.id,
      threadId: row.thread_id,
      isImportant: hasTag(tags, 'important'),
      isSpam: hasTag(tags, 'spam'),
      isReminder: hasTag(tags, 'reminders'),
      isWaitingReply: hasTag(tags, 'waiting_reply'),
      isNeedsResponse: hasTag(tags, 'needs_response'),
      isMeetingRelated: hasTag(tags, 'meeting'),
      isInvoiceBilling: hasTag(tags, 'invoice'),
      reasoning: row.ai_reasoning,
      confidence: row.ai_confidence,
      processedAt: row.ai_processed_at,
    };
  }

  /**
   * Remove AI category tags from email
   */
  async removeCategory(emailId: string): Promise<void> {
    const row = this.db.prepare('SELECT tags FROM emails WHERE id = ?').get(emailId) as any;
    if (!row) return;

    let tags = row.tags || '||';
    const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
    for (const cat of allCats) {
      tags = removeTag(tags, cat.slug);
    }
    tags = removeTag(tags, 'spam');

    // label_status='pending' so the drain reconciles the account labels — i.e.
    // strips the category label(s) we just removed. Without this, removing a
    // category in the app left the Gmail/IMAP label behind forever.
    this.db.prepare('UPDATE emails SET tags = ?, ai_reasoning = NULL, ai_confidence = 0, ai_processed_at = NULL, label_status = \'pending\' WHERE id = ?')
      .run(tags, emailId);
  }

  /**
   * Get emails by AI category (via tags)
   */
  async getEmailsByCategory(
    categorySlug: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<EmailRecord[]> {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const rows = this.db
      .prepare(`
        SELECT ${this.emailSelect()} FROM emails
        WHERE instr(tags, '|' || ? || '|') > 0
          ${this.excludeSpecialFolders}
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `)
      .all(categorySlug, limit, offset) as any[];

    return rows.map(row => this.rowToEmailRecord(row));
  }

  /**
   * Get AI category counts (unread emails only) — tags-based
   */
  async getCategoryCounts(): Promise<AICategoryCounts> {
    const row = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN instr(tags, '|important|') > 0 AND instr(tags, '|read|') = 0 THEN 1 ELSE 0 END) as important,
          SUM(CASE WHEN instr(tags, '|reminders|') > 0 AND instr(tags, '|read|') = 0 THEN 1 ELSE 0 END) as reminders,
          SUM(CASE WHEN instr(tags, '|waiting_reply|') > 0 AND instr(tags, '|read|') = 0 THEN 1 ELSE 0 END) as waiting_reply,
          SUM(CASE WHEN instr(tags, '|needs_response|') > 0 AND instr(tags, '|read|') = 0 THEN 1 ELSE 0 END) as needs_response,
          SUM(CASE WHEN instr(tags, '|meeting|') > 0 AND instr(tags, '|read|') = 0 THEN 1 ELSE 0 END) as meeting,
          SUM(CASE WHEN instr(tags, '|invoice|') > 0 AND instr(tags, '|read|') = 0 THEN 1 ELSE 0 END) as invoice
        FROM emails
        WHERE 1=1
          ${this.excludeSpecialFolders}
      `)
      .get() as any;

    return {
      important: row?.important || 0,
      reminders: row?.reminders || 0,
      waitingReply: row?.waiting_reply || 0,
      needsResponse: row?.needs_response || 0,
      meeting: row?.meeting || 0,
      invoice: row?.invoice || 0,
    };
  }

  /**
   * Get emails without AI processing
   */
  async getEmailsWithoutCategory(limit: number = 100): Promise<EmailRecord[]> {
    const rows = this.db
      // `clean_body != '' OR raw_body != ''` used to be spelled out here. After
      // migration 73 those inline columns are NULL on a relocated row and `NULL != ''`
      // is NULL, not true — so this query would have returned NOTHING and the AI
      // pipeline would have gone quietly idle on a fully-synced mailbox. The shared
      // clause reads the lengths (or the relocated body) instead.
      .prepare(`
        SELECT ${this.emailSelect()} FROM emails
        WHERE ai_processed_at IS NULL
          AND ${hasBodyClause('', this.bodyLengthsReady())}
        ORDER BY date DESC LIMIT ?
      `)
      .all(limit) as any[];
    return rows.map(row => this.rowToEmailRecord(row));
  }

  /**
   * Update email importance score
   */
  async updateImportance(emailId: string, score: number, source: 'rule' | 'ai' | 'user'): Promise<void> {
    this.db.prepare('UPDATE emails SET importance_score = ?, importance_source = ? WHERE id = ?')
      .run(score, source, emailId);
  }

  /**
   * Update email auth status
   */
  async updateAuthStatus(emailId: string, authStatus: string): Promise<void> {
    this.db.prepare('UPDATE emails SET auth_status = ? WHERE id = ?').run(authStatus, emailId);
  }

  /**
   * Get emails needing processing
   */
  async getEmailsNeedingProcessing(limit: number = 100): Promise<EmailRecord[]> {
    const rows = this.db
      // Same NULL-comparison trap as getEmailsWithoutCategory — see the note there.
      .prepare(`
        SELECT ${this.emailSelect()} FROM emails
        WHERE (importance_source = 'none' OR importance_source IS NULL)
          AND ${hasBodyClause('', this.bodyLengthsReady())}
        ORDER BY date DESC LIMIT ?
      `)
      .all(limit) as any[];
    return rows.map(row => this.rowToEmailRecord(row));
  }

  // ========== Dynamic Category Definitions ==========

  getCategoryDefinitions(): CategoryDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM ai_category_definitions ORDER BY sort_order ASC, slug ASC')
      .all() as any[];
    return rows.map(row => this.rowToCategoryDefinition(row));
  }

  getEnabledCategoryDefinitions(): CategoryDefinition[] {
    const rows = this.db
      .prepare('SELECT * FROM ai_category_definitions WHERE is_enabled = 1 ORDER BY sort_order ASC, slug ASC')
      .all() as any[];
    return rows.map(row => this.rowToCategoryDefinition(row));
  }

  upsertCategoryDefinition(def: Partial<CategoryDefinition> & { slug: string }): void {
    this.db.prepare(`
      INSERT INTO ai_category_definitions (slug, name, description, prompt, icon, color, sort_order, is_system, is_enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        prompt = excluded.prompt,
        icon = excluded.icon,
        color = excluded.color,
        sort_order = excluded.sort_order,
        is_enabled = excluded.is_enabled,
        updated_at = strftime('%s', 'now')
    `).run(
      def.slug,
      def.name || def.slug,
      def.description || null,
      def.prompt || '',
      def.icon || 'Tag',
      def.color || 'blue',
      def.sortOrder ?? 0,
      def.isSystem ? 1 : 0,
      def.isEnabled !== false ? 1 : 0,
    );
  }

  deleteCategoryDefinition(slug: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM ai_category_definitions WHERE slug = ? AND is_system = 0'
    ).run(slug);
    return result.changes > 0;
  }

  toggleCategoryDefinition(slug: string, enabled: boolean): void {
    this.db.prepare(
      'UPDATE ai_category_definitions SET is_enabled = ?, updated_at = strftime(\'%s\', \'now\') WHERE slug = ?'
    ).run(enabled ? 1 : 0, slug);
  }

  /**
   * Get emails by dynamic category slug (via tags — zero JOINs)
   */
  async getEmailsByDynamicCategory(
    categorySlug: string,
    options: { limit?: number; offset?: number; folderId?: string } = {}
  ): Promise<EmailRecord[]> {
    const limit = options.limit || 50;
    const offset = options.offset || 0;
    logger.info(`[AIRepo] getEmailsByDynamicCategory(category=${categorySlug}, limit=${limit}, offset=${offset}, folderId=${options.folderId || 'all'})`);

    if (categorySlug === 'uncategorized') {
      // Get all category slugs to exclude
      const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
      const excludeConditions = allCats
        .map(() => `AND instr(tags, '|' || ? || '|') = 0`)
        .join('\n        ');
      const params: any[] = [...allCats.map(c => c.slug)];

      let folderCondition = '';
      if (options.folderId) {
        const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(options.folderId) as any;
        if (!folder) return [];
        folderCondition = `AND instr(tags, '|' || ? || '|') > 0`;
        params.push(folder.path);
      }

      params.push(limit, offset);

      const rows = this.db.prepare(`
        SELECT ${this.emailSelect()} FROM emails
        WHERE ai_processed_at IS NOT NULL
          AND instr(tags, '|spam|') = 0
          ${this.excludeSpecialFolders}
          ${excludeConditions}
          ${folderCondition}
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `).all(...params) as any[];

      return rows.map(row => this.rowToEmailRecord(row));
    }

    const params: any[] = [categorySlug];
    let folderCondition = '';

    if (options.folderId) {
      const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(options.folderId) as any;
      if (!folder) return [];
      folderCondition = `AND instr(tags, '|' || ? || '|') > 0`;
      params.push(folder.path);
    }

    params.push(limit, offset);

    const rows = this.db.prepare(`
      SELECT ${this.emailSelect()} FROM emails
      WHERE instr(tags, '|' || ? || '|') > 0
        ${this.excludeSpecialFolders}
        ${folderCondition}
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `).all(...params) as any[];

    return rows.map(row => this.rowToEmailRecord(row));
  }

  /**
   * Per-category message counts — tags-based, zero JOINs. TWO deliberately
   * different numbers share this one query, selected by `mode`:
   *   - `'unread'` (DEFAULT): the CHIP badge — how many UNREAD mails are in the
   *     category (message-level, so "25 mails, 4 unread" → 4). Matches how the
   *     user reads the badge and drops as unread mail is read/deleted.
   *   - `'total'`: the category VIEW's "1–N of total" pagination denominator —
   *     ALL mails (read + unread), the same set getEmailsByDynamicCategory pages
   *     over, so the pager can't point past the end.
   * Both share the SAME category-set, excludeSpecialFolders and folder scope, so
   * the only difference is the unread filter. Chip (unread) and pager (total) are
   * INTENTIONALLY distinct — do not "reconcile" them.
   */
  getDynamicCategoryCounts(folderId?: string, mode: 'unread' | 'total' = 'unread'): DynamicCategoryCounts {
    const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions WHERE is_enabled = 1').all() as { slug: string }[];
    const counts: DynamicCategoryCounts = {};
    const unreadClause = mode === 'unread' ? "AND instr(tags, '|read|') = 0" : '';

    let folderCondition = '';
    const folderParams: any[] = [];
    if (folderId) {
      const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
      if (folder) {
        folderCondition = `AND instr(tags, '|' || ? || '|') > 0`;
        folderParams.push(folder.path);
      }
    }

    // COUNT(*) is message-level, matching the message-based list (LIMIT/OFFSET over
    // messages). In 'total' mode this equals the list length (chip pager parity); in
    // 'unread' mode it's the unread-mail badge.
    for (const cat of allCats) {
      const row = this.db.prepare(`
        SELECT COUNT(*) as count FROM emails
        WHERE instr(tags, '|' || ? || '|') > 0
          ${unreadClause}
          ${this.excludeSpecialFolders}
          ${folderCondition}
      `).get(cat.slug, ...folderParams) as { count: number };
      counts[cat.slug] = row.count;
    }

    // Uncategorized — exclude EVERY defined category slug (enabled or not), matching
    // getEmailsByDynamicCategory's uncategorized list exactly (it queries all
    // definitions). Using only enabled slugs would count a disabled category's mail
    // as uncategorized in the chip but not in the list.
    const allDefsForExclude = this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
    const excludeConditions = allDefsForExclude
      .map(() => `AND instr(tags, '|' || ? || '|') = 0`)
      .join('\n      ');
    const excludeParams = allDefsForExclude.map(c => c.slug);

    const uncategorized = this.db.prepare(`
      SELECT COUNT(*) as count FROM emails
      WHERE ai_processed_at IS NOT NULL
        AND instr(tags, '|spam|') = 0
        ${unreadClause}
        ${this.excludeSpecialFolders}
        ${excludeConditions}
        ${folderCondition}
    `).get(...excludeParams, ...folderParams) as { count: number };
    counts['uncategorized'] = uncategorized?.count || 0;

    return counts;
  }

  /**
   * Get category tags for a batch of email IDs (from tags column — no junction table)
   */
  getEmailCategoriesBatch(emailIds: string[]): Record<string, string[]> {
    if (emailIds.length === 0) return {};

    const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[];
    const catSlugs = new Set(allCats.map(c => c.slug));

    const placeholders = emailIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id, tags FROM emails WHERE id IN (${placeholders})`)
      .all(...emailIds) as { id: string; tags: string }[];

    const result: Record<string, string[]> = {};
    for (const row of rows) {
      const tagList = parseTags(row.tags);
      result[row.id] = tagList.filter(t => catSlugs.has(t));
    }
    return result;
  }

  private rowToCategoryDefinition(row: any): CategoryDefinition {
    return {
      slug: row.slug,
      name: row.name,
      description: row.description,
      prompt: row.prompt,
      icon: row.icon,
      color: row.color,
      sortOrder: row.sort_order,
      isSystem: row.is_system === 1,
      isEnabled: row.is_enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ========== Spammers Management ==========

  /**
   * Add spammer
   */
  async addSpammer(spammer: SpammerRecord): Promise<void> {
    const id = spammer.id || `spam-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const domain = spammer.email.split('@')[1] || null;

    this.db
      .prepare(`
        INSERT INTO spammers (id, email, domain, name, reason, reported_count, first_reported_at, last_reported_at)
        VALUES (?, ?, ?, ?, ?, 1, strftime('%s', 'now'), strftime('%s', 'now'))
        ON CONFLICT(email) DO UPDATE SET
          reported_count = reported_count + 1,
          last_reported_at = strftime('%s', 'now'),
          reason = COALESCE(excluded.reason, reason)
      `)
      .run(id, this.normalizeEmailKey(spammer.email), domain, spammer.name || null, spammer.reason || 'Marked as spam by user');
  }

  /**
   * Remove spammer
   */
  async removeSpammer(email: string): Promise<void> {
    this.db.prepare('DELETE FROM spammers WHERE email = ?').run(this.normalizeEmailKey(email));
  }

  /**
   * Check if email is a spammer
   */
  async isSpammer(email: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM spammers WHERE email = ?').get(this.normalizeEmailKey(email));
    return !!row;
  }

  /**
   * Check if domain is mostly spammers
   */
  async isSpammerDomain(domain: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM spammers WHERE domain = ?')
      .get(domain.toLowerCase()) as { count: number };
    return row.count >= 3;
  }

  /**
   * Get all spammers
   */
  async getSpammers(options: { limit?: number; offset?: number; search?: string } = {}): Promise<SpammerRecord[]> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;
    const search = options.search?.trim();

    const rows = search
      ? this.db.prepare(`
          SELECT * FROM spammers
          WHERE email LIKE ? OR name LIKE ? OR domain LIKE ?
          ORDER BY last_reported_at DESC
          LIMIT ? OFFSET ?
        `).all(`%${search}%`, `%${search}%`, `%${search}%`, limit, offset) as any[]
      : this.db.prepare(`
          SELECT * FROM spammers
          ORDER BY last_reported_at DESC
          LIMIT ? OFFSET ?
        `).all(limit, offset) as any[];

    return rows.map(row => ({
      id: row.id,
      email: row.email,
      domain: row.domain,
      name: row.name,
      reason: row.reason,
      reportedCount: row.reported_count,
      firstReportedAt: row.first_reported_at,
      lastReportedAt: row.last_reported_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get spammer count, honoring the same search filter as getSpammers so
   * paginated totals stay correct while searching.
   */
  async getSpammerCount(search?: string): Promise<number> {
    const s = search?.trim();
    const row = s
      ? this.db.prepare('SELECT COUNT(*) as count FROM spammers WHERE email LIKE ? OR name LIKE ? OR domain LIKE ?').get(`%${s}%`, `%${s}%`, `%${s}%`) as { count: number }
      : this.db.prepare('SELECT COUNT(*) as count FROM spammers').get() as { count: number };
    return row.count;
  }

  // ========== Thread Summaries ==========

  /**
   * Upsert thread summary
   */
  async upsertSummary(summary: ThreadSummaryRecord): Promise<void> {
    const id = summary.id || `sum-${summary.threadId}`;
    this.db
      .prepare(`
        INSERT OR REPLACE INTO thread_summaries (
          id, thread_id, summary, key_points, participants,
          last_email_date, email_count, processed_at, model_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        summary.threadId,
        summary.summary,
        JSON.stringify(summary.keyPoints || []),
        JSON.stringify(summary.participants || []),
        summary.lastEmailDate,
        summary.emailCount,
        summary.processedAt || this.now(),
        summary.modelUsed || null
      );
  }

  /**
   * Get thread summary
   */
  async getSummary(threadId: string): Promise<ThreadSummaryRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM thread_summaries WHERE thread_id = ?')
      .get(threadId) as any;

    return row ? this.rowToThreadSummary(row) : null;
  }

  /**
   * Delete thread summary
   */
  async deleteSummary(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM thread_summaries WHERE thread_id = ?').run(threadId);
  }

  // ========== Conversation Extractions ==========

  /**
   * Upsert conversation extraction
   */
  async upsertConversation(record: ConversationExtractionRecord): Promise<void> {
    const id = record.id || `conv-${record.threadId}`;
    this.db
      .prepare(`
        INSERT OR REPLACE INTO conversation_extractions (
          id, thread_id, messages, email_count,
          processed_email_ids, processed_at, model_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        record.threadId,
        record.messages,
        record.emailCount,
        record.processedEmailIds,
        record.processedAt || this.now(),
        record.modelUsed || null
      );
  }

  /**
   * Get conversation extraction by thread ID
   */
  async getConversation(threadId: string): Promise<ConversationExtractionRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM conversation_extractions WHERE thread_id = ?')
      .get(threadId) as any;

    if (!row) return null;

    return {
      id: row.id,
      threadId: row.thread_id,
      messages: row.messages,
      emailCount: row.email_count,
      processedEmailIds: row.processed_email_ids,
      processedAt: row.processed_at,
      modelUsed: row.model_used,
    };
  }

  /**
   * Read the chat-view-parsed body for a single email.
   *
   * The chat-view extractor (renderer-side) already separated each
   * email's own content from the quoted/forwarded history it pasted
   * in. That parsed content is cached in `conversation_extractions`
   * keyed by thread_id, with each ConversationMessage carrying its
   * `sourceEmailId` and an `isExtracted` flag (false = the email's
   * own body, true = a message extracted from quoted content).
   *
   * For consumers that want JUST the sender's new content (no quoted
   * history) — like AI categorization — this is the cheap way to get
   * it without re-running quote stripping on every request.
   *
   * Returns the body string if the chat-view has parsed this email
   * AND its body is non-empty; otherwise null. Caller falls back to
   * email.cleanBody / rawBody on null.
   */
  getChatViewBodyForEmail(threadId: string, emailId: string): string | null {
    const row = this.db
      .prepare('SELECT messages FROM conversation_extractions WHERE thread_id = ?')
      .get(threadId) as { messages: string } | undefined;
    if (!row?.messages) return null;
    let messages: any[];
    try {
      messages = JSON.parse(row.messages);
      if (!Array.isArray(messages)) return null;
    } catch {
      return null;
    }
    // The email's OWN content — the message where sourceEmailId
    // matches and isExtracted is false (i.e. not pulled out of a
    // quoted block). Multiple messages may share sourceEmailId when
    // a single email contained nested forwards; we want the one
    // attributed to the actual email, not the historical voices.
    const own = messages.find(m => m && m.sourceEmailId === emailId && m.isExtracted === false);
    const body = own?.body;
    if (typeof body !== 'string') return null;
    const stripped = body.replace(/<[^>]*>/g, '').trim();
    if (stripped.length === 0) return null;
    return body;
  }

  /**
   * Delete conversation extraction by thread ID
   */
  async deleteConversation(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM conversation_extractions WHERE thread_id = ?').run(threadId);
  }

  /**
   * Clear all conversation extractions
   */
  async clearAllConversations(): Promise<number> {
    const result = this.db.prepare('DELETE FROM conversation_extractions').run();
    return result.changes;
  }

  // ========== Bulk Processing Methods ==========

  /**
   * Get count of unprocessed emails — must match the filter
   * `getEligibleEmailsForAI` uses, otherwise UI counts ("X pending") drift
   * from what the processor actually consumes. Specifically:
   *   • Excludes Spam / Junk / Trash (the processor never picks these up).
   *   • Always excludes read emails (matches the policy comment in
   *     getEligibleEmailsForAI — the skipRead flag is preserved for API
   *     compat but the processor ignores it).
   *   • Drops the LIMIT so the count reports the real backlog, not the
   *     batch cap. Caller passes a `limit` param historically; we accept
   *     it for compat but don't apply it (a count capped at 10k was
   *     causing "10000 pending" forever for big mailboxes).
   */
  async getUnprocessedEmailCount(_limit: number = 10000, _skipRead: boolean = true): Promise<number> {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) as count FROM emails
        WHERE ai_processed_at IS NULL
          -- Cheap tag test first, body test last — see agent-eligibility.ts.
          AND ${notExcludedByTagsClause()}
          AND ${hasBodyClause('', this.bodyLengthsReady())}
      `)
      .get() as { count: number };
    return row.count;
  }

  /**
   * Transactional batch upsert of AI categories (legacy compat — converts to tags)
   */
  upsertCategoryBatch(categories: Array<{
    emailId: string;
    isImportant: boolean | number;
    isSpam: boolean | number;
    isReminder: boolean | number;
    isWaitingReply: boolean | number;
    isNeedsResponse: boolean | number;
    isMeetingRelated: boolean | number;
    isInvoiceBilling: boolean | number;
    reasoning?: string | null;
    confidence: number;
    processedAt: number;
  }>): number {
    const batch = categories.map(cat => {
      const slugMap: Record<string, boolean> = {
        important: !!cat.isImportant,
        reminders: !!cat.isReminder,
        waiting_reply: !!cat.isWaitingReply,
        needs_response: !!cat.isNeedsResponse,
        meeting: !!cat.isMeetingRelated,
        invoice: !!cat.isInvoiceBilling,
      };
      return {
        emailId: cat.emailId,
        categories: Object.entries(slugMap).filter(([, v]) => v).map(([slug]) => ({ slug, confidence: cat.confidence })),
        isSpam: !!cat.isSpam,
        reasoning: cat.reasoning || '',
        processedAt: cat.processedAt,
        confidence: cat.confidence,
      };
    });
    return this.saveEmailCategoriesBatch(batch);
  }

  /**
   * Increment the per-email parse-failure counter and return the new
   * value. Used by the AI categorization service when the LLM dropped
   * the email from its response or returned malformed JSON for it.
   * Persisting this in the DB (rather than in-memory) means the retry
   * decision survives app restarts — without it, a problematic email
   * would loop forever because the counter would reset every restart.
   */
  incrementParseFailureCount(emailId: string): number {
    const row = this.db
      .prepare(`
        UPDATE emails
        SET ai_parse_failure_count = ai_parse_failure_count + 1
        WHERE id = ?
        RETURNING ai_parse_failure_count
      `)
      .get(emailId) as { ai_parse_failure_count: number } | undefined;
    return row?.ai_parse_failure_count ?? 0;
  }

  /** Reset the parse-failure counter — call after a successful save. */
  resetParseFailureCount(emailId: string): void {
    this.db.prepare(`UPDATE emails SET ai_parse_failure_count = 0 WHERE id = ?`).run(emailId);
  }

  /**
   * Increment the per-email ATTEMPTED-categorization failure counter and return
   * the new value. Counts only passes where the call was actually made and
   * threw — never a pass that was skipped because AI was off or not ready yet.
   * That distinction is the whole point: a skip is a global state with its own
   * banner and must not burn an individual email's retry budget, whereas a call
   * that keeps throwing on the same message is a defect in that message.
   *
   * Without this counter the transient-failure branch had no give-up at all, so
   * such an email stayed 'pending' for the life of the mailbox.
   */
  incrementAgentFailureCount(emailId: string): number {
    const row = this.db
      .prepare(`
        UPDATE emails
        SET ai_agent_failure_count = ai_agent_failure_count + 1
        WHERE id = ?
        RETURNING ai_agent_failure_count
      `)
      .get(emailId) as { ai_agent_failure_count: number } | undefined;
    return row?.ai_agent_failure_count ?? 0;
  }

  /** Reset the attempted-categorization failure counter — call on success. */
  resetAgentFailureCount(emailId: string): void {
    this.db.prepare(`UPDATE emails SET ai_agent_failure_count = 0 WHERE id = ?`).run(emailId);
  }

  /**
   * Counts of emails the categorization pipeline failed on:
   *   • pendingRetry — unprocessed AND ai_parse_failure_count > 0.
   *     These will be retried on the next bulk run.
   *   • givenUp — processed (ai_processed_at NOT NULL) AND
   *     ai_parse_failure_count >= MAX. We hit the retry limit and
   *     marked them processed-with-no-categories. They won't retry.
   */
  getParseFailureCounts(maxRetries: number): { pendingRetry: number; givenUp: number } {
    const pendingRow = this.db
      .prepare(`
        SELECT COUNT(*) as n FROM emails
        WHERE ai_processed_at IS NULL
          AND ai_parse_failure_count > 0
      `)
      .get() as { n: number };
    const givenUpRow = this.db
      .prepare(`
        SELECT COUNT(*) as n FROM emails
        WHERE ai_processed_at IS NOT NULL
          AND ai_parse_failure_count >= ?
      `)
      .get(maxRetries) as { n: number };
    return { pendingRetry: pendingRow.n, givenUp: givenUpRow.n };
  }

  /**
   * Get emails eligible for AI categorization — direct query, no queue
   */
  getEligibleEmailsForAI(limit: number = 100, _skipRead: boolean = true): EmailRecord[] {
    // Policy: ALWAYS skip read emails — regardless of the caller's flag.
    // The user has already triaged read mail, so spending AI tokens on it is
    // waste. The skipRead parameter is preserved for API compatibility but
    // intentionally ignored here. (Prior versions allowed skipRead=false,
    // which let legacy code paths sneak read emails through the pipeline.)
    const rows = this.db.prepare(`
      SELECT ${this.emailSelect()} FROM emails
      WHERE ai_processed_at IS NULL
        -- Tag test BEFORE the body test: the tags column is header-only, the
        -- body test reads the inline body. Term order is a performance
        -- contract, not style — see agent-eligibility.ts.
        AND ${notExcludedByTagsClause()}
        AND ${hasBodyClause('', this.bodyLengthsReady())}
      ORDER BY date DESC LIMIT ?
    `).all(limit) as any[];
    return rows.map(row => this.rowToEmailRecord(row));
  }

  // ========== Helper Methods ==========

  private rowToThreadSummary(row: any): ThreadSummaryRecord {
    return {
      id: row.id,
      threadId: row.thread_id,
      summary: row.summary,
      keyPoints: this.parseJsonField(row.key_points, []),
      participants: this.parseJsonField(row.participants, []),
      lastEmailDate: row.last_email_date,
      emailCount: row.email_count,
      processedAt: row.processed_at,
      modelUsed: row.model_used,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
