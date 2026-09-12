// Agent Repository — behavior tracking, decisions, sender metrics, pipeline events

import type {
  IAgentStorage,
  UserActionLog,
  UserActionType,
  AgentDecision,
  AgentDecisionStatus,
  SenderDailyMetrics,
  PipelineEventLog,
  ActionStats,
  ContactType,
  ContactTypeSource,
  ClassifiedContact,
} from '@sarvinbox/core';
import { parseAddresses } from '@sarvinbox/core';

import { SHARED } from '../shared-contacts';

import {
  agentEligibleClause,
  agentStuckClause,
  excludedByTagsClause,
  extractionEligibleClause,
  extractionStuckClause,
  hasBodyClause,
  missingBodyClause,
  notExcludedByTagsClause,
  recentWindowClause,
} from './agent-eligibility';
import { BaseRepository } from './base-repository';
import { cleanBodyExpression } from './body-storage';

/*
 * Contacts and their notes live in the SHARED directory (see shared-contacts.ts),
 * reached through the ATTACHed `shared` schema. Naming the schema is not
 * optional: an unqualified `contacts` resolves against `main` first, so a stray
 * local table would silently shadow the directory and every classification
 * below would write to a table nothing reads. `sender_stats`, `emails` and the
 * agent tables stay unqualified -- they are genuinely per-account.
 */
const CONTACTS = SHARED('contacts');
const CONTACT_NOTES = SHARED('contact_notes');

/**
 * One candidate for category-label mirroring; `date` is the merge key only.
 *
 * `aiCategories` is the AI's OWN verdict and is what the mirror acts on. `tags`
 * still comes along because the caller needs it for the Spam/Trash and folder
 * checks — it must never be read back as a category list again (a Gmail
 * `\Important` label in there is not something the AI said).
 */
type PendingLabelRow = {
  id: string; uid: number; folderId: string; tags: string;
  aiCategories: string | null; date: number;
};

/**
 * A copy of an email that must never be re-labelled: labelling the Spam or
 * Trash copy is what made categories reappear on deleted mail.
 */
const LABEL_EXCLUDED_TAGS = `instr(e.tags, '|Spam|') = 0
        AND instr(e.tags, '|Trash|') = 0
        AND instr(e.tags, '|[Gmail]/Spam|') = 0
        AND instr(e.tags, '|[Gmail]/Trash|') = 0`;

const PENDING_LABEL_COLUMNS =
  `e.id, e.uid, e.folder_id AS folderId, e.tags, e.ai_categories AS aiCategories, e.date`;

/**
 * The recent-window floor, as a value rather than a correlated subquery — the
 * legacy branch needs it as a plain bound on `date` so the planner can turn it
 * into a range seek. Reads only the date index, never a record.
 */
export const SQL_LABEL_RECENT_CUTOFF = `
  SELECT MIN(date) AS cutoff FROM (SELECT date FROM emails ORDER BY date DESC LIMIT ?)
`;

/** Deferred applies: seeks idx_emails_label_status, which is empty once drained. */
export const SQL_LABEL_PENDING_EXPLICIT = `
  SELECT ${PENDING_LABEL_COLUMNS}
  FROM emails e
  WHERE e.label_status = 'pending'
    AND e.agent_status = 'done'
    AND ${LABEL_EXCLUDED_TAGS}
  ORDER BY e.date DESC
  LIMIT ?
`;

/**
 * The pre-tracking backlog. Driven by idx_emails_date DESC and stopped by the
 * cutoff, so it visits the newest `recentCount` rows at most — never the whole
 * table. A cutoff of 0 means "no window" (the default-argument path).
 */
export const SQL_LABEL_PENDING_LEGACY = `
  SELECT ${PENDING_LABEL_COLUMNS}
  FROM emails e
  WHERE e.date >= ?
    AND e.label_status IS NULL
    AND e.agent_status = 'done'
    AND ${LABEL_EXCLUDED_TAGS}
    AND EXISTS (
      SELECT 1 FROM folders f
      WHERE f.id = e.folder_id
        AND (f.special_use = '\\Inbox' OR LOWER(f.path) = 'inbox')
    )
  ORDER BY e.date DESC
  LIMIT ?
`;

/**
 * Newest-first merge of two already-sorted branches, capped at `limit`. Pure so
 * the ordering contract is unit-testable: the drain relies on newest-first, and
 * the same email can appear in only one branch (the predicates are disjoint).
 */
export function mergeNewestFirst<T extends { date: number }>(left: T[], right: T[], limit: number): T[] {
  return [...left, ...right].sort((a, b) => b.date - a.date).slice(0, Math.max(0, limit));
}

/**
 * Repository for all email agent operations
 * Implements IAgentStorage for behavior tracking and learning
 */
export class AgentRepository extends BaseRepository implements IAgentStorage {

  // ========== User Action Log ==========

  async logAction(action: UserActionLog): Promise<void> {
    this.db.prepare(`
      INSERT INTO user_action_log (id, email_id, thread_id, action_type, action_value, source, sender_address, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action.id,
      action.emailId,
      action.threadId || null,
      action.actionType,
      action.actionValue || null,
      action.source || 'user',
      action.senderAddress || null,
      action.timestamp,
    );

    // Update sender daily metrics incrementally
    if (action.senderAddress) {
      this.incrementSenderMetric(action.senderAddress, action.actionType, action.timestamp);
    }
  }

  async logActionBatch(actions: UserActionLog[]): Promise<void> {
    if (actions.length === 0) return;

    const txn = this.db.transaction((items: UserActionLog[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO user_action_log (id, email_id, thread_id, action_type, action_value, source, sender_address, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const action of items) {
        stmt.run(
          action.id,
          action.emailId,
          action.threadId || null,
          action.actionType,
          action.actionValue || null,
          action.source || 'user',
          action.senderAddress || null,
          action.timestamp,
        );

        // Update sender daily metrics incrementally (same as logAction —
        // without this, bulk actions undercount engagement trends)
        if (action.senderAddress) {
          this.incrementSenderMetric(action.senderAddress, action.actionType, action.timestamp);
        }
      }
    });
    txn(actions);
  }

  async getActionsByEmail(emailId: string): Promise<UserActionLog[]> {
    const rows = this.db.prepare(
      'SELECT * FROM user_action_log WHERE email_id = ? ORDER BY timestamp DESC'
    ).all(emailId) as any[];
    return rows.map(row => this.rowToActionLog(row));
  }

  async getActionsByType(actionType: UserActionType, limit = 100, offset = 0): Promise<UserActionLog[]> {
    const rows = this.db.prepare(
      'SELECT * FROM user_action_log WHERE action_type = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(actionType, limit, offset) as any[];
    return rows.map(row => this.rowToActionLog(row));
  }

  async getActionsBySender(senderAddress: string, limit = 100): Promise<UserActionLog[]> {
    const rows = this.db.prepare(
      'SELECT * FROM user_action_log WHERE sender_address = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(this.normalizeEmailKey(senderAddress), limit) as any[];
    return rows.map(row => this.rowToActionLog(row));
  }

  async getRecentActions(limit = 100, since?: number): Promise<UserActionLog[]> {
    if (since) {
      const rows = this.db.prepare(
        'SELECT * FROM user_action_log WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?'
      ).all(since, limit) as any[];
      return rows.map(row => this.rowToActionLog(row));
    }
    const rows = this.db.prepare(
      'SELECT * FROM user_action_log ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as any[];
    return rows.map(row => this.rowToActionLog(row));
  }

  async getActionStats(since?: number): Promise<ActionStats> {
    const timeFilter = since ? 'WHERE timestamp >= ?' : '';
    const params = since ? [since] : [];

    // Total actions
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as count FROM user_action_log ${timeFilter}`
    ).get(...params) as { count: number };

    // Action counts by type
    const countRows = this.db.prepare(
      `SELECT action_type, COUNT(*) as count FROM user_action_log ${timeFilter} GROUP BY action_type`
    ).all(...params) as { action_type: string; count: number }[];

    const actionCounts: Record<string, number> = {};
    for (const row of countRows) {
      actionCounts[row.action_type] = row.count;
    }

    // Top senders
    const senderRows = this.db.prepare(
      `SELECT sender_address as email, COUNT(*) as action_count
       FROM user_action_log
       ${timeFilter ? timeFilter + ' AND' : 'WHERE'} sender_address IS NOT NULL
       GROUP BY sender_address ORDER BY action_count DESC LIMIT 20`
    ).all(...params) as { email: string; action_count: number }[];

    // Most active hour
    const hourRow = this.db.prepare(
      `SELECT CAST(strftime('%H', timestamp, 'unixepoch', 'localtime') AS INTEGER) as hour, COUNT(*) as count
       FROM user_action_log ${timeFilter}
       GROUP BY hour ORDER BY count DESC LIMIT 1`
    ).get(...params) as { hour: number; count: number } | undefined;

    // Avg actions per day
    const dayRange = this.db.prepare(
      `SELECT MIN(timestamp) as min_ts, MAX(timestamp) as max_ts FROM user_action_log ${timeFilter}`
    ).get(...params) as { min_ts: number | null; max_ts: number | null };

    let avgActionsPerDay = 0;
    if (dayRange.min_ts && dayRange.max_ts) {
      const days = Math.max(1, (dayRange.max_ts - dayRange.min_ts) / 86400);
      avgActionsPerDay = Math.round(totalRow.count / days * 10) / 10;
    }

    return {
      totalActions: totalRow.count,
      actionCounts: actionCounts as Record<UserActionType, number>,
      topSenders: senderRows.map(r => ({ email: r.email, actionCount: r.action_count })),
      avgActionsPerDay,
      mostActiveHour: hourRow?.hour ?? 9,
    };
  }

  // ========== Agent Decisions ==========

  async saveDecision(decision: AgentDecision): Promise<void> {
    this.db.prepare(`
      INSERT INTO agent_decisions (
        id, email_id, thread_id, sender_address,
        proposed_action, proposed_value, confidence, reasoning,
        status, actual_action, user_feedback,
        proposed_at, resolved_at,
        draft_body, draft_subject, draft_reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.emailId,
      decision.threadId || null,
      decision.senderAddress || null,
      decision.proposedAction,
      decision.proposedValue || null,
      decision.confidence,
      decision.reasoning || null,
      decision.status,
      decision.actualAction || null,
      decision.userFeedback || null,
      decision.proposedAt,
      decision.resolvedAt || null,
      (decision as any).draftBody || null,
      (decision as any).draftSubject || null,
      (decision as any).draftReasoning || null,
    );
  }

  /** Save auto-drafted reply body to an existing decision */
  updateDecisionDraft(decisionId: string, draft: { body: string; subject?: string; reasoning?: string }): void {
    this.db.prepare(`
      UPDATE agent_decisions SET draft_body = ?, draft_subject = ?, draft_reasoning = ? WHERE id = ?
    `).run(draft.body, draft.subject || null, draft.reasoning || null, decisionId);
  }

  async updateDecisionStatus(
    id: string,
    status: AgentDecisionStatus,
    actualAction?: UserActionType | null,
    userFeedback?: string | null,
  ): Promise<void> {
    this.db.prepare(`
      UPDATE agent_decisions
      SET status = ?, actual_action = COALESCE(?, actual_action), user_feedback = COALESCE(?, user_feedback), resolved_at = ?
      WHERE id = ?
    `).run(status, actualAction ?? null, userFeedback ?? null, this.now(), id);
  }

  async getPendingDecisions(): Promise<AgentDecision[]> {
    const rows = this.db.prepare(
      "SELECT * FROM agent_decisions WHERE status = 'pending' ORDER BY proposed_at DESC"
    ).all() as any[];
    return rows.map(row => this.rowToDecision(row));
  }

  async getDecisionHistory(limit = 100, offset = 0): Promise<AgentDecision[]> {
    const rows = this.db.prepare(
      'SELECT * FROM agent_decisions ORDER BY proposed_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as any[];
    return rows.map(row => this.rowToDecision(row));
  }

  async getDecisionAccuracy(since?: number): Promise<{ total: number; approved: number; rejected: number; accuracy: number }> {
    const timeFilter = since ? 'AND proposed_at >= ?' : '';
    const params = since ? [since] : [];

    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'approved' OR status = 'auto' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' OR status = 'overridden' THEN 1 ELSE 0 END) as rejected
      FROM agent_decisions
      WHERE status != 'pending' AND status != 'expired' ${timeFilter}
    `).get(...params) as { total: number; approved: number; rejected: number };

    return {
      total: row.total || 0,
      approved: row.approved || 0,
      rejected: row.rejected || 0,
      accuracy: row.total > 0 ? (row.approved / row.total) : 0,
    };
  }

  // ========== Sender Daily Metrics ==========

  async upsertSenderDailyMetrics(metrics: SenderDailyMetrics): Promise<void> {
    this.db.prepare(`
      INSERT INTO sender_daily_metrics (id, sender_email, date, received_count, read_count, replied_count, deleted_count, archived_count, avg_response_time_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sender_email, date) DO UPDATE SET
        received_count = excluded.received_count,
        read_count = excluded.read_count,
        replied_count = excluded.replied_count,
        deleted_count = excluded.deleted_count,
        archived_count = excluded.archived_count,
        avg_response_time_sec = excluded.avg_response_time_sec
    `).run(
      metrics.id,
      this.normalizeEmailKey(metrics.senderEmail),
      metrics.date,
      metrics.receivedCount,
      metrics.readCount,
      metrics.repliedCount,
      metrics.deletedCount,
      metrics.archivedCount,
      metrics.avgResponseTimeSec ?? null,
    );
  }

  async getSenderMetrics(senderEmail: string, days = 30): Promise<SenderDailyMetrics[]> {
    const since = this.now() - (days * 86400);
    const rows = this.db.prepare(
      'SELECT * FROM sender_daily_metrics WHERE sender_email = ? AND date >= ? ORDER BY date DESC'
    ).all(this.normalizeEmailKey(senderEmail), since) as any[];
    return rows.map(row => this.rowToSenderMetrics(row));
  }

  async getTopSendersByAction(actionType: UserActionType, limit = 20, since?: number): Promise<{ email: string; count: number }[]> {
    const timeFilter = since ? 'AND timestamp >= ?' : '';
    const params: any[] = [actionType];
    if (since) params.push(since);
    params.push(limit);

    return this.db.prepare(`
      SELECT sender_address as email, COUNT(*) as count
      FROM user_action_log
      WHERE action_type = ? AND sender_address IS NOT NULL ${timeFilter}
      GROUP BY sender_address
      ORDER BY count DESC
      LIMIT ?
    `).all(...params) as { email: string; count: number }[];
  }

  // ========== Pipeline Event Persistence ==========

  async logPipelineEvent(event: PipelineEventLog): Promise<void> {
    this.db.prepare(`
      INSERT INTO pipeline_event_log (id, event_type, email_id, thread_id, data, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.eventType,
      event.emailId || null,
      event.threadId || null,
      event.data || null,
      event.timestamp,
    );
  }

  async logPipelineEventBatch(events: PipelineEventLog[]): Promise<void> {
    if (events.length === 0) return;

    const txn = this.db.transaction((items: PipelineEventLog[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO pipeline_event_log (id, event_type, email_id, thread_id, data, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const event of items) {
        stmt.run(event.id, event.eventType, event.emailId || null, event.threadId || null, event.data || null, event.timestamp);
      }
    });
    txn(events);
  }

  async getPipelineEvents(eventType?: string, limit = 100, since?: number): Promise<PipelineEventLog[]> {
    let sql = 'SELECT * FROM pipeline_event_log WHERE 1=1';
    const params: any[] = [];

    if (eventType) {
      sql += ' AND event_type = ?';
      params.push(eventType);
    }
    if (since) {
      sql += ' AND timestamp >= ?';
      params.push(since);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToPipelineEvent(row));
  }

  async cleanupOldEvents(olderThan: number): Promise<number> {
    const result = this.db.prepare(
      'DELETE FROM pipeline_event_log WHERE timestamp < ?'
    ).run(olderThan);
    return result.changes;
  }

  // ========== Behavior Analysis Queries ==========

  /**
   * Get user's response pattern for a specific sender
   */
  getSenderResponsePattern(senderEmail: string): {
    totalReceived: number;
    readRate: number;
    replyRate: number;
    deleteRate: number;
    archiveRate: number;
    avgResponseTimeSec: number | null;
  } {
    const received = this.db.prepare(
      "SELECT COUNT(*) as count FROM user_action_log WHERE sender_address = ? AND action_type = 'read'"
    ).get(this.normalizeEmailKey(senderEmail)) as { count: number };

    const actions = this.db.prepare(`
      SELECT action_type, COUNT(*) as count
      FROM user_action_log
      WHERE sender_address = ?
      GROUP BY action_type
    `).all(this.normalizeEmailKey(senderEmail)) as { action_type: string; count: number }[];

    const actionMap: Record<string, number> = {};
    for (const a of actions) {
      actionMap[a.action_type] = a.count;
    }

    // Calculate avg response time (time between email received and first user action)
    const avgTime = this.db.prepare(`
      SELECT AVG(a.timestamp - e.date) as avg_time
      FROM user_action_log a
      JOIN emails e ON a.email_id = e.id
      WHERE a.sender_address = ?
        AND a.action_type IN ('read', 'reply', 'reply_all')
        AND a.timestamp > e.date
        AND (a.timestamp - e.date) < 604800
    `).get(this.normalizeEmailKey(senderEmail)) as { avg_time: number | null };

    const totalReceived = actionMap['read'] || received.count || 1;
    return {
      totalReceived,
      readRate: Math.min(1, (actionMap['read'] || 0) / Math.max(1, totalReceived)),
      replyRate: Math.min(1, ((actionMap['reply'] || 0) + (actionMap['reply_all'] || 0)) / Math.max(1, totalReceived)),
      deleteRate: Math.min(1, (actionMap['delete'] || 0) / Math.max(1, totalReceived)),
      archiveRate: Math.min(1, (actionMap['archive'] || 0) / Math.max(1, totalReceived)),
      avgResponseTimeSec: avgTime.avg_time ? Math.round(avgTime.avg_time) : null,
    };
  }

  /**
   * Get user's peak activity hours (top 5)
   */
  getPeakActivityHours(): number[] {
    const rows = this.db.prepare(`
      SELECT CAST(strftime('%H', timestamp, 'unixepoch', 'localtime') AS INTEGER) as hour,
             COUNT(*) as count
      FROM user_action_log
      GROUP BY hour
      ORDER BY count DESC
      LIMIT 5
    `).all() as { hour: number; count: number }[];
    return rows.map(r => r.hour);
  }

  /**
   * Get sender tiers based on interaction patterns
   */
  getSenderTiers(): { vip: string[]; noise: string[]; regular: string[] } {
    // VIP: High reply rate, fast response
    const vip = this.db.prepare(`
      SELECT sender_address
      FROM user_action_log
      WHERE sender_address IS NOT NULL AND action_type IN ('reply', 'reply_all')
      GROUP BY sender_address
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC
      LIMIT 50
    `).all() as { sender_address: string }[];

    // Noise: High delete/archive rate, never replied
    const noise = this.db.prepare(`
      SELECT sender_address
      FROM user_action_log
      WHERE sender_address IS NOT NULL AND action_type IN ('delete', 'archive', 'spam')
      GROUP BY sender_address
      HAVING COUNT(*) >= 5
        AND sender_address NOT IN (
          SELECT sender_address FROM user_action_log
          WHERE action_type IN ('reply', 'reply_all') AND sender_address IS NOT NULL
        )
      ORDER BY COUNT(*) DESC
      LIMIT 100
    `).all() as { sender_address: string }[];

    return {
      vip: vip.map(r => r.sender_address),
      noise: noise.map(r => r.sender_address),
      regular: [], // Everything else
    };
  }

  /**
   * Predict likely action for an email based on sender history
   */
  predictAction(senderAddress: string): { action: UserActionType; confidence: number } | null {
    const pattern = this.getSenderResponsePattern(senderAddress);
    if (pattern.totalReceived < 3) return null; // Not enough data

    // Find dominant action
    const rates: { action: UserActionType; rate: number }[] = [
      { action: 'reply', rate: pattern.replyRate },
      { action: 'archive', rate: pattern.archiveRate },
      { action: 'delete', rate: pattern.deleteRate },
      { action: 'read', rate: pattern.readRate * 0.5 }, // Lower weight for just reading
    ];

    rates.sort((a, b) => b.rate - a.rate);
    const top = rates[0];

    if (top.rate < 0.3) return null; // No strong pattern

    // Confidence scales with data volume and pattern strength
    const volumeFactor = Math.min(1, pattern.totalReceived / 20);
    const confidence = top.rate * volumeFactor;

    return { action: top.action, confidence: Math.round(confidence * 100) / 100 };
  }

  // ========== Pipeline Status Tracking ==========

  /**
   * Get emails pending Pipeline 1 (conversation extraction).
   */
  getEmailsPendingExtraction(limit: number = 20, recentWindow = 0): Array<{ id: string; threadId: string; date: number }> {
    // `recentWindow` (>0) bounds eligibility to the N most-recent emails by
    // date, so auto-processing never reaches deep into historical backlog —
    // see getEmailsPendingAgent for the rationale. It is passed INTO the clause
    // rather than appended after it so the cheap date bound is evaluated before
    // the expensive body test; see agent-eligibility.ts.
    const params = recentWindow > 0 ? [recentWindow, limit] : [limit];
    return this.db.prepare(`
      SELECT id, thread_id as threadId, date FROM emails
      WHERE ${extractionEligibleClause('', { recentWindow: recentWindow > 0, bodyLengthsReady: this.bodyLengthsReady() })}
      ORDER BY date DESC LIMIT ?
    `).all(...params) as any[];
  }

  /**
   * How many emails phase 1 can actually pick up right now — the extraction
   * twin of {@link countAgentEligible}, built from the same clause the phase-1
   * selector uses. The poll used to count a bare `extraction_status='pending'`
   * here, which included every body-less row phase 1 skips, so the extraction
   * backlog shown to the user could never reach zero.
   */
  countExtractionEligible(recentWindow = 0): number {
    const params = recentWindow > 0 ? [recentWindow] : [];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ${extractionEligibleClause('', { recentWindow: recentWindow > 0, bodyLengthsReady: this.bodyLengthsReady() })}
    `).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Mark email extraction done.
   */
  markExtractionDone(emailId: string): void {
    this.db.prepare(
      "UPDATE emails SET extraction_status = 'done', extraction_at = ? WHERE id = ?"
    ).run(Math.floor(Date.now() / 1000), emailId);
  }

  /**
   * Mark batch of emails extraction done (by thread).
   */
  markExtractionDoneByThread(threadId: string): void {
    this.db.prepare(
      "UPDATE emails SET extraction_status = 'done', extraction_at = ? WHERE thread_id = ?"
    ).run(Math.floor(Date.now() / 1000), threadId);
  }

  /**
   * Get emails pending Pipeline 2 (agent intelligence).
   * Only returns emails where extraction is already done.
   */
  getEmailsPendingAgent(limit: number = 10, recentWindow = 0): Array<{ id: string; threadId: string; fromAddress: string; date: number }> {
    // Only process emails that the user has NOT yet read. Read emails have
    // already been triaged by the user and don't need AI attention — this is
    // a per-email gate, not per-thread, so on first sync we never waste tokens
    // on backlog mail that arrived into the mailbox already marked \Seen.
    // If the user later marks an email unread, it becomes eligible again.
    //
    // `recentWindow` (>0) additionally caps auto-categorization to the N
    // most-recent emails by date. New mail is always within that window (so it
    // always gets categorized in real time), but a large historical backlog is
    // left for the manual, user-triggered bulk run — we never spend LLM calls
    // on more than the recent N in the background. Matches the manual bulk cap
    // (maxAIProcessingEmails, default 500).
    // The eligibility predicate itself lives in agent-eligibility.ts so this
    // selector, the poll's backlog counter and the dashboard tile can never
    // drift apart again — see that file's header for what the drift cost.
    const params = recentWindow > 0 ? [recentWindow, limit] : [limit];
    return this.db.prepare(`
      SELECT e.id, e.thread_id as threadId, e.from_address as fromAddress, e.date FROM emails e
      WHERE ${agentEligibleClause('e', { recentWindow: recentWindow > 0, bodyLengthsReady: this.bodyLengthsReady() })}
      ORDER BY e.date DESC LIMIT ?
    `).all(...params) as any[];
  }

  /**
   * How many emails the agent can actually pick up right now.
   *
   * This is THE number the progress UI must show. It is built from the same
   * clause as {@link getEmailsPendingAgent}, so "N pending" always means "N
   * rows the worker will process" — never a phantom the worker cannot see.
   */
  countAgentEligible(recentWindow = 0): number {
    const params = recentWindow > 0 ? [recentWindow] : [];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ${agentEligibleClause('', { recentWindow: recentWindow > 0, bodyLengthsReady: this.bodyLengthsReady() })}
    `).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Rows stuck in pipeline limbo: counted 'pending' by a phase but unselectable
   * by it, so nothing ever advances them. Covers BOTH phases — a row wedged in
   * extraction never reaches categorization, so leaving phase 1 out would just
   * move the stall one step earlier. Diagnostic only; {@link healStuckPipelineRows}
   * is what clears them. Returns the reason per row so the log can name it.
   */
  getStuckPipelineRows(limit = 20, recentWindow = 0): Array<{
    id: string;
    date: number;
    reason: 'disqualified' | 'no-body' | 'extraction-no-body';
  }> {
    // The window goes FIRST, not appended: both stuck clauses end in a body
    // test, and a term after them is a term evaluated after the expensive read.
    // It stays outside the OR so it still costs exactly one bound parameter.
    const windowClause = recentWindow > 0 ? `${recentWindowClause()} AND ` : '';
    const params = recentWindow > 0 ? [recentWindow, limit] : [limit];
    const opts = { bodyLengthsReady: this.bodyLengthsReady() };
    return this.db.prepare(`
      SELECT id, date,
        CASE
          WHEN ${agentStuckClause('', opts)} AND (${excludedByTagsClause()}) THEN 'disqualified'
          WHEN ${agentStuckClause('', opts)} THEN 'no-body'
          ELSE 'extraction-no-body'
        END AS reason
      FROM emails
      WHERE ${windowClause}((${agentStuckClause('', opts)}) OR (${extractionStuckClause('', opts)}))
      ORDER BY date DESC LIMIT ?
    `).all(...params) as any[];
  }

  /**
   * Self-heal the limbo, for both phases. Runs on the pipeline's maintenance
   * tick. This is the mechanism that makes the progress bar able to reach 100%
   * rather than parking on rows no phase will ever touch.
   *
   * `disqualified` rows (read/spam/junk/trash) are finalized at once — they
   * were never going to be categorized, and leaving them 'pending' is what
   * inflated the backlog forever.
   *
   * `abandoned` / `extractionAbandoned` rows are body-less ones older than
   * `maxAgeSeconds`, in phase 2 and phase 1 respectively. A recent body-less
   * mail is left alone on purpose: its body is probably still downloading, and
   * the phase will pick it up the moment it lands. Only once it is old enough
   * that the body is never coming do we finalize it.
   *
   * Extraction is finalized rather than skipped so the row can flow on to the
   * phase-2 gate, where the normal rules (and, if it is still body-less, the
   * phase-2 give-up) apply — a row is never left half-advanced.
   *
   * Every path is idempotent: a finalized row no longer matches, so re-running
   * on each tick is a no-op.
   */
  healStuckPipelineRows(maxAgeSeconds: number, nowSeconds: number = Math.floor(Date.now() / 1000)): {
    disqualified: number;
    abandoned: number;
    extractionAbandoned: number;
  } {
    const cutoff = nowSeconds - maxAgeSeconds;
    // `ai_processed_at` is stamped alongside `agent_status` for the same reason
    // as {@link markAgentGaveUp}: the dashboard's percentage counts rows with a
    // NULL `ai_processed_at` as outstanding work. Healing `agent_status` alone
    // would silence the poll's backlog count while leaving the user's progress
    // bar stuck at the same 98% — fixing the log and not the symptom.
    const finalizeAgent = (extraWhere: string, params: unknown[] = []) =>
      this.db.prepare(`
        UPDATE emails
        SET agent_status = 'done', agent_at = ?, ai_processed_at = COALESCE(ai_processed_at, ?)
        WHERE agent_status = 'pending' AND ${extraWhere}
      `).run(nowSeconds, nowSeconds, ...params).changes;

    const bodyLengthsReady = this.bodyLengthsReady();
    const disqualified = finalizeAgent(`(${excludedByTagsClause()})`);
    const abandoned = finalizeAgent(`${missingBodyClause('', bodyLengthsReady)} AND date < ?`, [cutoff]);
    const extractionAbandoned = this.db.prepare(`
      UPDATE emails SET extraction_status = 'done', extraction_at = ?
      WHERE ${extractionStuckClause('', { bodyLengthsReady })} AND date < ?
    `).run(nowSeconds, cutoff).changes;

    return { disqualified, abandoned, extractionAbandoned };
  }

  /**
   * Re-queue the recent Inbox window back to agent_status='pending' so the
   * auto-pipeline categorizes existing mail. Needed because mail "processed"
   * while AI Assist was OFF is marked 'done' with no categories, and the poll
   * only ever revisits 'pending' — so without this, enabling AI would never
   * touch existing mail. Bounded to the newest `limit` unread, non-spam/trash
   * Inbox emails with a real body (mirrors the getEmailsPendingAgent gate).
   * Returns how many rows were re-queued.
   */
  requeueRecentInboxForAgent(limit: number = 500): number {
    // Built from the shared clauses, so a re-queued row is guaranteed to be
    // one getEmailsPendingAgent can then select. The old hand-written copy here
    // omitted `|Junk|` (the non-Gmail spelling of spam), so re-enabling AI put
    // junk mail back to 'pending' that the worker's list then refused — counted
    // forever, categorized never. That is the drift this now cannot express.
    //
    // The failure counters are cleared too: a row that gave up under a broken
    // provider must get a genuine fresh set of attempts once AI is working
    // again, not resume at its old strike count and give up immediately.
    const res = this.db.prepare(`
      UPDATE emails
      SET agent_status = 'pending', ai_parse_failure_count = 0, ai_agent_failure_count = 0
      WHERE id IN (
        SELECT id FROM emails
        WHERE agent_status = 'done'
          AND instr(tags, '|INBOX|') > 0
          AND ${notExcludedByTagsClause()}
          AND ${hasBodyClause('', this.bodyLengthsReady())}
        ORDER BY date DESC
        LIMIT ?
      )
    `).run(limit);
    return res.changes;
  }

  /**
   * Mark email agent processing done with results.
   */
  markAgentDone(emailId: string, result: {
    priorityScore?: number;
    priorityTier?: string;
    priorityReasoning?: string;
    recommendedAction?: string;
  }): void {
    this.db.prepare(`
      UPDATE emails SET
        agent_status = 'done',
        agent_at = ?,
        priority_score = COALESCE(?, priority_score),
        priority_tier = COALESCE(?, priority_tier),
        priority_reasoning = COALESCE(?, priority_reasoning),
        recommended_action = COALESCE(?, recommended_action)
      WHERE id = ?
    `).run(
      Math.floor(Date.now() / 1000),
      result.priorityScore ?? null,
      result.priorityTier ?? null,
      result.priorityReasoning ?? null,
      result.recommendedAction ?? null,
      emailId,
    );
  }

  /**
   * Finalize an email the pipeline has GIVEN UP on: keep the local behaviour
   * score, record no categories, and stamp `ai_processed_at` so every "is this
   * finished?" reader agrees.
   *
   * That stamp is the fix for the progress bar parking just short of 100%. The
   * dashboard's percentage is `categorized / (categorized + unprocessed)`, and
   * `unprocessed` means `ai_processed_at IS NULL` — a different column from the
   * `agent_status` the background pipeline finalizes on. So a row we had
   * deliberately stopped retrying sat in the denominator forever while never
   * being able to reach the numerator: 98%, no error, nothing still running.
   * The bulk categorization path already stamped it on give-up; the background
   * pipeline did not, and that asymmetry is the bug.
   *
   * COALESCE rather than an overwrite: if the email was genuinely processed
   * earlier, keep that timestamp instead of back-dating the give-up over it.
   */
  markAgentGaveUp(emailId: string, result: {
    priorityScore?: number;
    priorityTier?: string;
    priorityReasoning?: string;
    recommendedAction?: string;
  }): void {
    // ONE statement, not markAgentDone() plus a second UPDATE. Both touched the
    // same row, and with bodies stored inline a row averages ~250 KB — SQLite
    // cannot update a field of a spilled record in place, so each UPDATE rewrote
    // the whole record and its overflow chain. Two statements meant paying that
    // twice for one logical event, on the AI pipeline's per-email hot path.
    this.db.prepare(`
      UPDATE emails SET
        agent_status = 'done',
        agent_at = ?,
        priority_score = COALESCE(?, priority_score),
        priority_tier = COALESCE(?, priority_tier),
        priority_reasoning = COALESCE(?, priority_reasoning),
        recommended_action = COALESCE(?, recommended_action),
        ai_processed_at = COALESCE(ai_processed_at, ?)
      WHERE id = ?
    `).run(
      Math.floor(Date.now() / 1000),
      result.priorityScore ?? null,
      result.priorityTier ?? null,
      result.priorityReasoning ?? null,
      result.recommendedAction ?? null,
      Math.floor(Date.now() / 1000),
      emailId,
    );
  }

  /**
   * Mark that an email's AI category still needs mirroring to the connected
   * account as a label. Set at categorization time so the intent survives a
   * disconnect / restart / burst — the poll's label drain (getEmailsPendingLabel)
   * picks it up until it's actually applied. Idempotent; a re-categorization
   * re-sets 'pending' so a changed category re-mirrors.
   */
  markLabelPending(emailId: string): void {
    this.db.prepare(`UPDATE emails SET label_status = 'pending' WHERE id = ?`).run(emailId);
  }

  /**
   * Record what the categorizer ACTUALLY decided, as the `|a|b|` encoding
   * (`'||'` when it chose nothing — see encodeAiCategories).
   *
   * This is the only writer of `ai_categories`, and nothing but the pipeline's
   * own result may reach it. In particular it must never be seeded from the tag
   * string: `important` is both an AI category and a tag that Gmail's
   * `\Important` label, the rule scorer and the user's manual mark all write, so
   * copying tags in here would relabel Gmail's guess as an AI verdict — the
   * exact laundering this column exists to stop.
   */
  recordAiCategories(emailId: string, encoded: string): void {
    this.db.prepare('UPDATE emails SET ai_categories = ? WHERE id = ?').run(encoded, emailId);
  }

  /** Mark the connected-account label as durably applied (op enqueued). */
  markLabelDone(emailId: string): void {
    this.db.prepare(`UPDATE emails SET label_status = 'done' WHERE id = ?`).run(emailId);
  }

  /**
   * Emails whose AI category has NOT yet been mirrored to the connected account.
   * Two sources, newest-first, bounded:
   *   - label_status = 'pending' (any folder): categorized but the label apply was
   *     deferred (engine disconnected) — always drained so bursts/restarts recover.
   *   - label_status IS NULL (legacy, INBOX + recent window only): the pre-tracking
   *     backlog, caught up GRADUALLY within the recent window so we never re-label
   *     the entire history at once (Gmail rate safety).
   * Spam/Trash copies are excluded. Returns just what mirrorCategoryLabels needs.
   *
   * TWO QUERIES, NOT ONE `OR` — this is a performance requirement, not a style
   * choice. `label_status` and `agent_status` were both added by late ALTERs, so
   * they sit AFTER `clean_body`/`raw_body` in the record; on a mailbox whose
   * bodies are stored inline (6.5 GB for 26k rows) reading either one means
   * traversing that row's overflow chain. Under a single `OR` SQLite could use
   * neither the `label_status = 'pending'` partial index nor the recent-window
   * date bound, so every poll tick — forever, even with nothing to do — walked
   * all 26,184 records to answer a question about the newest 500. Measured with
   * the V8 CPU profiler: 82.9% of ALL main-thread JS time in this one statement.
   * Split, each branch is index-driven and bounded: 'pending' seeks its partial
   * index (empty in steady state = instant), and the legacy branch walks
   * `idx_emails_date` DESC only as far as the recent-window cutoff.
   *
   * Splitting is result-identical: any row in the newest `limit` of the union is
   * necessarily in the newest `limit` of the branch it came from.
   */
  getEmailsPendingLabel(
    limit = 12,
    recentCount = 0,
  ): Array<{ id: string; uid: number; folderId: string; tags: string; aiCategories: string | null }> {
    // Index-only over idx_emails_date (LIMIT bounds it), so the window costs a
    // page-cache walk of the date index, never a record read.
    const cutoff = recentCount > 0
      ? ((this.db.prepare(SQL_LABEL_RECENT_CUTOFF).get(recentCount) as { cutoff: number | null }).cutoff ?? 0)
      : 0;

    const explicit = this.db.prepare(SQL_LABEL_PENDING_EXPLICIT).all(limit) as PendingLabelRow[];
    const legacy = this.db.prepare(SQL_LABEL_PENDING_LEGACY).all(cutoff, limit) as PendingLabelRow[];

    return mergeNewestFirst(explicit, legacy, limit)
      .map(({ id, uid, folderId, tags, aiCategories }) => ({ id, uid, folderId, tags, aiCategories }));
  }

  /**
   * Get pipeline processing counts for dashboard.
   */
  getPipelineStats(): {
    totalEmails: number;
    extractionPending: number;
    extractionDone: number;
    agentPending: number;
    agentDone: number;
  } {
    // The pending figures are the ELIGIBLE ones, not raw status counts. This
    // line is what the poll logs as `ext_pend=/agent_pend=`, and a bare
    // `agent_status='pending'` here is how a single disqualified row made the
    // log report work outstanding forever while the worker sat idle. The done
    // figures stay raw status counts — "finished" includes rows finalized by
    // the heal, which is exactly what the progress bar should treat as done.
    //
    // The old row filter was `clean_body != '' OR raw_body != ''`, which is not
    // NULL-safe: for a never-downloaded body both comparisons yield NULL and
    // the row silently vanished from `total`, so the denominator disagreed with
    // the mailbox. hasBodyClause is NULL- and whitespace-aware.
    //
    // This is the single most expensive statement in the app while the length
    // columns are unavailable — it aggregates over every row, so the WHERE and
    // both eligible clauses read every body (13s cold on a multi-GB mailbox).
    // Once the backfill has run, every column this touches (`extraction_status`,
    // `agent_status`, `date`, the two lengths, `tags`) lives in
    // `idx_emails_agent_pipeline`, so the aggregate is served by a covering
    // index and no row is visited at all.
    const bodyLengthsReady = this.bodyLengthsReady();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN ${extractionEligibleClause('', { bodyLengthsReady })} THEN 1 ELSE 0 END) as ext_pending,
        SUM(CASE WHEN extraction_status = 'done' THEN 1 ELSE 0 END) as ext_done,
        SUM(CASE WHEN ${agentEligibleClause('', { bodyLengthsReady })} THEN 1 ELSE 0 END) as agent_pending,
        SUM(CASE WHEN agent_status = 'done' THEN 1 ELSE 0 END) as agent_done
      FROM emails
      WHERE ${hasBodyClause('', bodyLengthsReady)}
    `).get() as any;

    return {
      totalEmails: row.total || 0,
      extractionPending: row.ext_pending || 0,
      extractionDone: row.ext_done || 0,
      agentPending: row.agent_pending || 0,
      agentDone: row.agent_done || 0,
    };
  }

  /**
   * Cheap, boot-safe counterpart to {@link getPipelineStats}.
   *
   * getPipelineStats filters `WHERE hasBodyClause()` — `LENGTH(TRIM(clean_body))`
   * / `LENGTH(TRIM(raw_body))` over EVERY row — which forces SQLite to read every
   * body (multi-GB on a large mailbox, ~13s of cold-cache disk I/O). That is fine
   * for the 2-min dashboard cadence but NOT on the synchronous startup path, where
   * it blocked window creation. This variant touches only the indexed status
   * columns: `COUNT(*)` (served by a covering index) plus the partial indexes on
   * `extraction_status='pending'` / `agent_status='pending'`. It reads no body
   * content, so it returns in milliseconds regardless of mailbox size.
   *
   * These are RAW status counts, deliberately not the body-eligible figures
   * getPipelineStats reports: they may include body-less rows the eligible clauses
   * skip. They exist to give startup a fast, honest sanity line; the precise
   * eligible/done counts follow a moment later from the first poll tick.
   */
  getPipelineStatsLite(): {
    totalEmails: number;
    extractionStatusPending: number;
    agentStatusPending: number;
  } {
    const total =
      (this.db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number } | undefined)?.n ?? 0;
    const extractionStatusPending =
      (this.db
        .prepare("SELECT COUNT(*) AS n FROM emails WHERE extraction_status = 'pending'")
        .get() as { n: number } | undefined)?.n ?? 0;
    const agentStatusPending =
      (this.db
        .prepare("SELECT COUNT(*) AS n FROM emails WHERE agent_status = 'pending'")
        .get() as { n: number } | undefined)?.n ?? 0;
    return { totalEmails: total, extractionStatusPending, agentStatusPending };
  }

  /**
   * Get emails sorted by priority score (for dashboard).
   */
  getEmailsByPriority(limit: number = 50, minScore?: number): Array<{
    id: string; subject: string; fromAddress: string; fromName: string | null;
    date: number; priorityScore: number; priorityTier: string;
    priorityReasoning: string; recommendedAction: string | null;
    tags: string;
  }> {
    const scoreFilter = minScore ? 'AND priority_score >= ?' : '';
    const params: any[] = [];
    if (minScore) params.push(minScore);
    params.push(limit);

    return this.db.prepare(`
      SELECT id, subject, from_address as fromAddress, from_name as fromName,
             date, priority_score as priorityScore, priority_tier as priorityTier,
             priority_reasoning as priorityReasoning, recommended_action as recommendedAction,
             tags
      FROM emails
      WHERE priority_score IS NOT NULL
        AND instr(tags, '|read|') = 0
        AND instr(tags, '|Trash|') = 0 AND instr(tags, '|Spam|') = 0
        AND instr(tags, '|[Gmail]/Trash|') = 0 AND instr(tags, '|[Gmail]/Spam|') = 0
        ${scoreFilter}
      ORDER BY priority_score DESC, date DESC
      LIMIT ?
    `).all(...params) as any[];
  }

  // ========== Behavior Intelligence Queries ==========

  /**
   * Count emails from sender that were read then deleted within N seconds.
   * High count = "curiosity noise" — user opens but doesn't care.
   */
  getReadThenDeletedFast(senderEmail: string, maxGapSec: number = 10, since?: number): number {
    const timeFilter = since ? 'AND a1.timestamp >= ?' : '';
    const params: any[] = [this.normalizeEmailKey(senderEmail), maxGapSec];
    if (since) params.push(since);

    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT a1.email_id) as count
      FROM user_action_log a1
      JOIN user_action_log a2 ON a1.email_id = a2.email_id
      WHERE a1.sender_address = ? AND a1.action_type = 'read'
        AND a2.action_type IN ('delete', 'spam')
        AND (a2.timestamp - a1.timestamp) BETWEEN 0 AND ?
        ${timeFilter}
    `).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Count emails from sender that were read and kept (no delete/archive).
   * Still in inbox after minAgeSec seconds.
   */
  getReadAndKeptCount(senderEmail: string, minAgeSec: number = 259200, since?: number): number {
    const now = Math.floor(Date.now() / 1000);
    const timeFilter = since ? 'AND a.timestamp >= ?' : '';
    const params: any[] = [this.normalizeEmailKey(senderEmail), now, minAgeSec];
    if (since) params.push(since);

    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT a.email_id) as count
      FROM user_action_log a
      JOIN emails e ON a.email_id = e.id
      WHERE a.sender_address = ? AND a.action_type = 'read'
        AND instr(e.tags, '|INBOX|') > 0
        AND NOT EXISTS (
          SELECT 1 FROM user_action_log a2
          WHERE a2.email_id = a.email_id AND a2.action_type IN ('delete', 'archive', 'spam')
        )
        AND (? - a.timestamp) > ?
        ${timeFilter}
    `).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Get sender directionality — who initiates more.
   * Returns inbound (they→us) and outbound (us→them) counts.
   */
  getSenderDirectionality(senderEmail: string, userEmail: string): {
    inbound: number; outbound: number;
    avgInboundReplyTimeSec: number | null;
  } {
    const sender = this.normalizeEmailKey(senderEmail);
    const user = this.normalizeEmailKey(userEmail);

    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN LOWER(from_address) = ? THEN 1 ELSE 0 END) as inbound,
        SUM(CASE WHEN LOWER(from_address) = ? THEN 1 ELSE 0 END) as outbound
      FROM emails
      WHERE LOWER(from_address) IN (?, ?)
        AND (LOWER(to_address) LIKE ? OR LOWER(to_address) LIKE ?)
    `).get(sender, user, sender, user, `%${sender}%`, `%${user}%`) as { inbound: number; outbound: number };

    // Average reply time (user replying to this sender)
    const replyTime = this.db.prepare(`
      SELECT AVG(a.timestamp - e.date) as avg_time
      FROM user_action_log a
      JOIN emails e ON a.email_id = e.id
      WHERE a.sender_address = ? AND a.action_type IN ('reply', 'reply_all')
        AND a.timestamp > e.date AND (a.timestamp - e.date) < 604800
    `).get(sender) as { avg_time: number | null };

    return {
      inbound: row?.inbound || 0,
      outbound: row?.outbound || 0,
      avgInboundReplyTimeSec: replyTime?.avg_time ? Math.round(replyTime.avg_time) : null,
    };
  }

  /**
   * Analyze thread participation — user's role in a thread.
   */
  getThreadParticipation(threadId: string, userEmail: string): {
    participantCount: number;
    userMessageCount: number;
    totalMessages: number;
    userStarted: boolean;
    lastActivityAt: number;
  } {
    const user = this.normalizeEmailKey(userEmail);

    const row = this.db.prepare(`
      SELECT
        COUNT(DISTINCT LOWER(from_address)) as participant_count,
        SUM(CASE WHEN LOWER(from_address) = ? THEN 1 ELSE 0 END) as user_message_count,
        COUNT(*) as total_messages,
        MAX(date) as last_activity
      FROM emails WHERE thread_id = ?
    `).get(user, threadId) as any;

    // Did user start the thread?
    const firstMsg = this.db.prepare(
      'SELECT LOWER(from_address) as sender FROM emails WHERE thread_id = ? ORDER BY date ASC LIMIT 1'
    ).get(threadId) as { sender: string } | undefined;

    return {
      participantCount: row?.participant_count || 0,
      userMessageCount: row?.user_message_count || 0,
      totalMessages: row?.total_messages || 0,
      userStarted: firstMsg?.sender === user,
      lastActivityAt: row?.last_activity || 0,
    };
  }

  /**
   * Count emails from sender in a time window (burst detection).
   * 3+ emails in 1 hour = escalation.
   */
  getSenderBurstCount(senderEmail: string, windowSec: number = 3600): number {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM emails
      WHERE LOWER(from_address) = ? AND date BETWEEN ? AND ?
    `).get(this.normalizeEmailKey(senderEmail), now - windowSec, now) as { count: number };
    return row.count;
  }

  /**
   * Detect if sender is a routine sender (daily reports at consistent times).
   * Returns true if standard deviation of send hour is < 2.
   */
  getSenderRoutinePattern(senderEmail: string): { isRoutine: boolean; avgHour: number | null } {
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 86400);
    const rows = this.db.prepare(`
      SELECT CAST(strftime('%H', date, 'unixepoch', 'localtime') AS INTEGER) as hour
      FROM emails WHERE LOWER(from_address) = ? AND date >= ?
    `).all(this.normalizeEmailKey(senderEmail), thirtyDaysAgo) as { hour: number }[];

    if (rows.length < 5) return { isRoutine: false, avgHour: null };

    const hours = rows.map(r => r.hour);
    const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
    const variance = hours.reduce((sum, h) => sum + (h - avg) ** 2, 0) / hours.length;
    const stdDev = Math.sqrt(variance);

    return {
      isRoutine: stdDev < 2,
      avgHour: Math.round(avg),
    };
  }

  /**
   * Build compact sender memory from user's sent emails to this person.
   * Extracts greeting, closing, tone — latest pattern wins.
   */
  buildSenderMemory(senderEmail: string, userEmail: string): {
    greeting: string | null;
    closing: string | null;
    tone: string | null;
  } {
    // Get user's last 10 sent emails to this person
    const sentEmails = this.db.prepare(`
      SELECT ${cleanBodyExpression()} AS clean_body FROM emails
      WHERE LOWER(from_address) = ? AND LOWER(to_address) LIKE ?
        AND (instr(tags, '|Sent|') > 0 OR instr(tags, '|[Gmail]/Sent Mail|') > 0 OR instr(tags, '|Sent Items|') > 0)
      ORDER BY date DESC LIMIT 10
    `).all(this.normalizeEmailKey(userEmail), `%${this.normalizeEmailKey(senderEmail)}%`) as { clean_body: string }[];

    if (sentEmails.length === 0) return { greeting: null, closing: null, tone: null };

    // Extract greeting from first line of most recent email
    let greeting: string | null = null;
    let closing: string | null = null;
    let formalCount = 0;
    let casualCount = 0;

    for (const email of sentEmails) {
      const body = (email.clean_body || '').replace(/<[^>]+>/g, '').trim();
      if (!body) continue;

      const lines = body.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;

      // Greeting: first line
      if (!greeting) {
        const first = lines[0].trim();
        const greetMatch = first.match(/^(Hi|Hey|Hello|Dear|Good morning|Good afternoon|Good evening)[,\s!]*.{0,30}/i);
        if (greetMatch) greeting = first.substring(0, 40);
      }

      // Closing: last few lines
      if (!closing) {
        for (const line of lines.slice(-3)) {
          const closeMatch = line.trim().match(/^(Best|Thanks|Regards|Cheers|Sincerely|Thank you|Kind regards|Best regards|Warm regards)[,\s!]*/i);
          if (closeMatch) { closing = line.trim().substring(0, 30); break; }
        }
      }

      // Tone detection
      const lower = body.toLowerCase();
      if (/dear\s|sincerely|regards|would you|could you/i.test(lower)) formalCount++;
      if (/hey|hi\s|!|lol|haha|gonna|wanna|cheers/i.test(lower)) casualCount++;
    }

    const tone = formalCount > casualCount ? 'formal' : casualCount > formalCount ? 'casual' : 'brief';

    return { greeting, closing, tone };
  }

  /**
   * Save sender memory to sender_stats table.
   */
  saveSenderMemory(senderEmail: string, memory: { greeting: string | null; closing: string | null; tone: string | null; keyContext?: string }): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE sender_stats
      SET greeting = ?, closing = ?, tone = ?, key_context = COALESCE(?, key_context), memory_updated_at = ?
      WHERE email = ?
    `).run(memory.greeting, memory.closing, memory.tone, memory.keyContext || null, now, this.normalizeEmailKey(senderEmail));
  }

  /**
   * Build memories for all contacts with sent email history.
   */
  buildAllSenderMemories(userEmail: string): number {
    const senders = this.db.prepare(`
      SELECT DISTINCT LOWER(s.email) as email FROM sender_stats s
      WHERE s.sent_to_count > 0 OR s.replied_count > 0
    `).all() as { email: string }[];

    let built = 0;
    for (const sender of senders) {
      const memory = this.buildSenderMemory(sender.email, userEmail);
      if (memory.greeting || memory.closing || memory.tone) {
        this.saveSenderMemory(sender.email, memory);
        built++;
      }
    }
    return built;
  }

  /**
   * Get all signal data for a sender in one call (batch-optimized).
   */
  getSenderSignalData(senderEmail: string, userEmail: string): {
    readThenDeletedFast: number;
    readThenReplied: number;
    readAndKept: number;
    readAndArchived: number;
    unreadOld: number;
    totalFromSender: number;
    replyCount: number;
    avgReplyTimeSec: number | null;
    inbound: number;
    outbound: number;
    isRoutine: boolean;
    burstCount: number;
    lastInteractionAt: number | null;
  } {
    const sender = this.normalizeEmailKey(senderEmail);
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - (90 * 86400);

    const readDeletedFast = this.getReadThenDeletedFast(sender, 10, ninetyDaysAgo);
    const readKept = this.getReadAndKeptCount(sender, 259200, ninetyDaysAgo);
    const dir = this.getSenderDirectionality(sender, userEmail);
    const routine = this.getSenderRoutinePattern(sender);
    const burst = this.getSenderBurstCount(sender, 3600);

    // Aggregate counts from action log
    const counts = this.db.prepare(`
      SELECT action_type, COUNT(*) as count FROM user_action_log
      WHERE sender_address = ? AND timestamp >= ?
      GROUP BY action_type
    `).all(sender, ninetyDaysAgo) as { action_type: string; count: number }[];

    const countMap: Record<string, number> = {};
    for (const c of counts) countMap[c.action_type] = c.count;

    const totalFromSender = this.db.prepare(
      'SELECT COUNT(*) as count FROM emails WHERE LOWER(from_address) = ? AND date >= ?'
    ).get(sender, ninetyDaysAgo) as { count: number };

    const lastInteraction = this.db.prepare(
      'SELECT MAX(timestamp) as ts FROM user_action_log WHERE sender_address = ?'
    ).get(sender) as { ts: number | null };

    return {
      readThenDeletedFast: readDeletedFast,
      readThenReplied: (countMap['reply'] || 0) + (countMap['reply_all'] || 0),
      readAndKept: readKept,
      readAndArchived: countMap['archive'] || 0,
      unreadOld: 0, // computed per-email, not per-sender
      totalFromSender: totalFromSender.count,
      replyCount: (countMap['reply'] || 0) + (countMap['reply_all'] || 0),
      avgReplyTimeSec: dir.avgInboundReplyTimeSec,
      inbound: dir.inbound,
      outbound: dir.outbound,
      isRoutine: routine.isRoutine,
      burstCount: burst,
      lastInteractionAt: lastInteraction.ts,
    };
  }

  // ========== Contact Notes (Knowledge Base) ==========

  addNote(email: string, note: string, category: string, sourceEmailId?: string, confidence?: number): number {
    const result = this.db.prepare(`
      INSERT INTO ${CONTACT_NOTES} (email, note, category, source_email_id, confidence)
      VALUES (?, ?, ?, ?, ?)
    `).run(this.normalizeEmailKey(email), note, category, sourceEmailId || null, confidence ?? 0.8);
    return result.lastInsertRowid as number;
  }

  addNotesBatch(notes: Array<{ email: string; note: string; category: string; sourceEmailId?: string; confidence?: number }>): number {
    if (notes.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT INTO ${CONTACT_NOTES} (email, note, category, source_email_id, confidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    const txn = this.db.transaction((items: typeof notes) => {
      let count = 0;
      for (const n of items) {
        // Skip duplicates: same email + same note text
        const existing = this.db.prepare(
          `SELECT 1 FROM ${CONTACT_NOTES} WHERE email = ? AND note = ? AND is_active = 1`
        ).get(this.normalizeEmailKey(n.email), n.note);
        if (existing) continue;

        stmt.run(this.normalizeEmailKey(n.email), n.note, n.category, n.sourceEmailId || null, n.confidence ?? 0.8);
        count++;
      }
      return count;
    });
    return txn(notes);
  }

  getNotes(email: string, limit: number = 50): Array<{ id: number; note: string; category: string; sourceEmailId: string | null; confidence: number; createdAt: number; updatedAt: number }> {
    return this.db.prepare(`
      SELECT id, note, category, source_email_id as sourceEmailId, confidence, created_at as createdAt, updated_at as updatedAt
      FROM ${CONTACT_NOTES} WHERE email = ? AND is_active = 1
      ORDER BY created_at DESC LIMIT ?
    `).all(this.normalizeEmailKey(email), limit) as any[];
  }

  /**
   * Get notes formatted as text for LLM prompt injection.
   * Returns compact string like:
   *   - Role: Project Manager, Infosys
   *   - Working on VAPT project
   *   - Deadline: report due end of April
   */
  getNotesForPrompt(email: string, limit: number = 15): string {
    const notes = this.getNotes(email, limit);
    if (notes.length === 0) return '';
    return notes.map(n => `- ${n.note}`).join('\n');
  }

  updateNote(id: number, note: string): void {
    this.db.prepare(
      `UPDATE ${CONTACT_NOTES} SET note = ?, updated_at = ? WHERE id = ?`
    ).run(note, Math.floor(Date.now() / 1000), id);
  }

  deactivateNote(id: number): void {
    this.db.prepare(
      `UPDATE ${CONTACT_NOTES} SET is_active = 0, updated_at = ? WHERE id = ?`
    ).run(Math.floor(Date.now() / 1000), id);
  }

  getNotesCount(email: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM ${CONTACT_NOTES} WHERE email = ? AND is_active = 1`
    ).get(this.normalizeEmailKey(email)) as { count: number };
    return row.count;
  }

  searchNotes(query: string, limit: number = 20): Array<{ email: string; note: string; category: string }> {
    return this.db.prepare(`
      SELECT email, note, category FROM ${CONTACT_NOTES}
      WHERE is_active = 1 AND note LIKE ?
      ORDER BY created_at DESC LIMIT ?
    `).all(`%${query}%`, limit) as any[];
  }

  // ========== Category-Action Correlations ==========

  /**
   * Learn which user actions correlate with which AI categories.
   * e.g., "80% of needs_response emails get a reply action"
   */
  getCategoryActionCorrelation(categorySlug: string): Array<{ action: string; count: number; rate: number }> {
    const total = this.db.prepare(`
      SELECT COUNT(*) as count FROM user_action_log a
      JOIN emails e ON a.email_id = e.id
      WHERE instr(e.tags, '|' || ? || '|') > 0
    `).get(categorySlug) as { count: number };

    if (!total || total.count === 0) return [];

    const rows = this.db.prepare(`
      SELECT a.action_type as action, COUNT(*) as count
      FROM user_action_log a
      JOIN emails e ON a.email_id = e.id
      WHERE instr(e.tags, '|' || ? || '|') > 0
        AND a.action_type NOT IN ('open', 'unread', 'unstar', 'unimportant')
      GROUP BY a.action_type
      ORDER BY count DESC
    `).all(categorySlug) as { action: string; count: number }[];

    return rows.map(r => ({
      action: r.action,
      count: r.count,
      rate: Math.round((r.count / total.count) * 100) / 100,
    }));
  }

  /**
   * Get all category-action correlations for enabled categories.
   * Returns a map: categorySlug → dominant action + confidence boost.
   */
  getAllCategoryCorrelations(): Record<string, { action: string; rate: number }> {
    const allCats = this.db.prepare('SELECT slug FROM ai_category_definitions WHERE is_enabled = 1').all() as { slug: string }[];
    const result: Record<string, { action: string; rate: number }> = {};

    for (const cat of allCats) {
      const corr = this.getCategoryActionCorrelation(cat.slug);
      if (corr.length > 0 && corr[0].rate >= 0.3) {
        result[cat.slug] = { action: corr[0].action, rate: corr[0].rate };
      }
    }

    return result;
  }

  /**
   * Per-category readiness for the Agent Dashboard.
   *
   * Reports, for every enabled category, the dominant action the user
   * takes on it, the strength of that pattern, and whether the pattern
   * is strong enough to auto-act given a threshold (default 0.85).
   *
   * The UI uses this to show the user why auto-actions haven't fired
   * yet ("Newsletters: 3 actions, too few to lock in") instead of just
   * a global "Learning (40/50)" badge.
   */
  getCategoryReadiness(autoActThreshold: number = 0.85): Array<{
    slug: string;
    name: string;
    totalActions: number;
    dominantAction: string | null;
    rate: number;
    ready: boolean;
  }> {
    const cats = this.db.prepare(
      'SELECT slug, name FROM ai_category_definitions WHERE is_enabled = 1 ORDER BY slug',
    ).all() as { slug: string; name: string }[];

    const out: Array<{
      slug: string;
      name: string;
      totalActions: number;
      dominantAction: string | null;
      rate: number;
      ready: boolean;
    }> = [];

    for (const cat of cats) {
      const corr = this.getCategoryActionCorrelation(cat.slug);
      const total = this.db.prepare(`
        SELECT COUNT(*) as count FROM user_action_log a
        JOIN emails e ON a.email_id = e.id
        WHERE instr(e.tags, '|' || ? || '|') > 0
      `).get(cat.slug) as { count: number };

      const top = corr[0];
      out.push({
        slug: cat.slug,
        name: cat.name || cat.slug,
        totalActions: total?.count || 0,
        dominantAction: top?.action ?? null,
        rate: top?.rate ?? 0,
        // Minimum sample threshold (5) prevents tiny-sample coincidences
        // from being reported as "ready".
        ready: !!top && total.count >= 5 && top.rate >= autoActThreshold,
      });
    }

    return out;
  }

  // ========== Historical Learning (Backfill from existing emails) ==========

  /**
   * Learn from ALL existing emails in the database.
   * Extracts real user behavior signals from email state:
   *   - read/unread → user read or ignored
   *   - starred → user explicitly flagged
   *   - Trash/Spam folder → user deleted/spammed
   *   - Sent folder + in_reply_to → user replied
   *   - Archive/All Mail → user archived
   *
   * This runs ONCE on agent enable to bootstrap the behavior model
   * from thousands of existing emails instead of waiting for new events.
   */
  backfillFromHistory(): {
    totalEmails: number;
    actionsCreated: number;
    sendersProcessed: number;
  } {
    // Idempotent by design — uses deterministic primary keys (prefix +
    // email.id) with INSERT OR IGNORE so re-running this after more
    // folders (Sent, Trash, Spam, All Mail) have synced backfills only
    // the new history. An early-exit guard that skipped when ANY history
    // row existed was previously here — that left users who only synced
    // INBOX initially with a skewed training set (all |read|, zero
    // replies/deletes/archives) forever.

    let actionsCreated = 0;
    const sendersSet = new Set<string>();

    const txn = this.db.transaction(() => {
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO user_action_log (id, email_id, thread_id, action_type, action_value, source, sender_address, timestamp)
        VALUES (?, ?, ?, ?, ?, 'history', ?, ?)
      `);

      const runInsert = (prefix: string, actionType: string, e: { id: string; thread_id: string; date: number }, sender: string) => {
        const info = insertStmt.run(`${prefix}-${e.id}`, e.id, e.thread_id, actionType, null, sender, e.date);
        if (info.changes > 0) {
          sendersSet.add(sender);
          actionsCreated++;
        }
      };

      // 1. Read emails → 'read' action
      const readEmails = this.db.prepare(`
        SELECT id, thread_id, from_address, date FROM emails
        WHERE instr(tags, '|read|') > 0
          AND from_address IS NOT NULL
      `).all() as { id: string; thread_id: string; from_address: string; date: number }[];

      for (const e of readEmails) {
        runInsert('hist-r', 'read', e, this.normalizeEmailKey(e.from_address));
      }

      // 2. Starred emails → 'star' action
      const starredEmails = this.db.prepare(`
        SELECT id, thread_id, from_address, date FROM emails
        WHERE instr(tags, '|starred|') > 0
          AND from_address IS NOT NULL
      `).all() as { id: string; thread_id: string; from_address: string; date: number }[];

      for (const e of starredEmails) {
        runInsert('hist-s', 'star', e, this.normalizeEmailKey(e.from_address));
      }

      // 3. Emails in Trash → 'delete' action
      const deletedEmails = this.db.prepare(`
        SELECT id, thread_id, from_address, date FROM emails
        WHERE (instr(tags, '|Trash|') > 0
           OR instr(tags, '|[Gmail]/Trash|') > 0
           OR instr(tags, '|Deleted Items|') > 0)
          AND from_address IS NOT NULL
      `).all() as { id: string; thread_id: string; from_address: string; date: number }[];

      for (const e of deletedEmails) {
        runInsert('hist-d', 'delete', e, this.normalizeEmailKey(e.from_address));
      }

      // 4. Emails in Spam → 'spam' action
      const spamEmails = this.db.prepare(`
        SELECT id, thread_id, from_address, date FROM emails
        WHERE (instr(tags, '|Spam|') > 0
           OR instr(tags, '|[Gmail]/Spam|') > 0
           OR instr(tags, '|Junk|') > 0
           OR instr(tags, '|Junk Email|') > 0)
          AND from_address IS NOT NULL
      `).all() as { id: string; thread_id: string; from_address: string; date: number }[];

      for (const e of spamEmails) {
        runInsert('hist-sp', 'spam', e, this.normalizeEmailKey(e.from_address));
      }

      // 5. Sent emails with in_reply_to → 'reply' action (user replied to someone)
      const sentReplies = this.db.prepare(`
        SELECT e.id, e.thread_id, e.to_address, e.date, e.in_reply_to FROM emails e
        WHERE (instr(e.tags, '|Sent|') > 0
           OR instr(e.tags, '|[Gmail]/Sent Mail|') > 0
           OR instr(e.tags, '|Sent Items|') > 0)
          AND e.in_reply_to IS NOT NULL
          AND e.to_address IS NOT NULL
      `).all() as { id: string; thread_id: string; to_address: string; date: number; in_reply_to: string }[];

      for (const e of sentReplies) {
        // The "sender" from the user's perspective is who they replied TO
        const recipient = parseAddresses(e.to_address)[0]?.toLowerCase();
        if (recipient) {
          runInsert('hist-rp', 'reply', e, recipient);
        }
      }

      // 6. Emails in Archive/All Mail (not in INBOX) → 'archive' action
      const archivedEmails = this.db.prepare(`
        SELECT id, thread_id, from_address, date FROM emails
        WHERE (instr(tags, '|[Gmail]/All Mail|') > 0 OR instr(tags, '|Archive|') > 0)
          AND instr(tags, '|INBOX|') = 0
          AND instr(tags, '|Trash|') = 0
          AND instr(tags, '|Spam|') = 0
          AND instr(tags, '|[Gmail]/Trash|') = 0
          AND instr(tags, '|[Gmail]/Spam|') = 0
          AND instr(tags, '|Sent|') = 0
          AND instr(tags, '|[Gmail]/Sent Mail|') = 0
          AND from_address IS NOT NULL
      `).all() as { id: string; thread_id: string; from_address: string; date: number }[];

      for (const e of archivedEmails) {
        runInsert('hist-a', 'archive', e, this.normalizeEmailKey(e.from_address));
      }
    });

    const totalEmails = (this.db.prepare('SELECT COUNT(*) as count FROM emails').get() as { count: number }).count;
    txn();

    return {
      totalEmails,
      actionsCreated,
      sendersProcessed: sendersSet.size,
    };
  }

  /**
   * Check if historical backfill has been done
   */
  isBackfilled(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM user_action_log WHERE source = 'history'").get() as { count: number };
    return row.count > 0;
  }

  /**
   * Get summary of learned behavior from history
   */
  getLearningSummary(): {
    totalActions: number;
    fromHistory: number;
    fromLive: number;
    uniqueSenders: number;
    topActions: Array<{ action: string; count: number }>;
  } {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM user_action_log').get() as { count: number };
    const history = this.db.prepare("SELECT COUNT(*) as count FROM user_action_log WHERE source = 'history'").get() as { count: number };
    const senders = this.db.prepare('SELECT COUNT(DISTINCT sender_address) as count FROM user_action_log WHERE sender_address IS NOT NULL').get() as { count: number };
    const topActions = this.db.prepare(`
      SELECT action_type as action, COUNT(*) as count
      FROM user_action_log
      GROUP BY action_type
      ORDER BY count DESC
      LIMIT 10
    `).all() as Array<{ action: string; count: number }>;

    return {
      totalActions: total.count,
      fromHistory: history.count,
      fromLive: total.count - history.count,
      uniqueSenders: senders.count,
      topActions,
    };
  }

  // ========== Contact Classification ==========

  /**
   * Set contact type for an email address
   */
  setContactType(
    email: string,
    contactType: ContactType,
    confidence: number,
    source: ContactTypeSource,
  ): void {
    this.db.prepare(`
      UPDATE ${CONTACTS}
      SET contact_type = ?, contact_type_confidence = ?, contact_type_source = ?
      WHERE email = ?
    `).run(contactType, confidence, source, this.normalizeEmailKey(email));

    // Also update sender_stats
    this.db.prepare(`
      UPDATE sender_stats SET contact_type = ? WHERE email = ?
    `).run(contactType, this.normalizeEmailKey(email));
  }

  /**
   * Batch classify contacts by rule-based heuristics
   */
  autoClassifyContacts(userEmail: string): number {
    const userDomain = userEmail.split('@')[1]?.toLowerCase();
    let classified = 0;

    const txn = this.db.transaction(() => {
      // 1. Colleagues: same domain (exclude public email domains)
      const publicDomains = ['gmail.com','yahoo.com','outlook.com','hotmail.com','live.com','aol.com','icloud.com','protonmail.com','mail.com','yandex.com','zoho.com','rediffmail.com'];
      if (userDomain && !publicDomains.includes(userDomain)) {
        const r = this.db.prepare(`
          UPDATE ${CONTACTS}
          SET contact_type = 'colleague', contact_type_confidence = 0.9, contact_type_source = 'rule'
          WHERE email LIKE ? AND contact_type = 'unknown'
        `).run(`%@${userDomain}`);
        classified += r.changes;
      }

      // 2. Automated: no-reply addresses
      const autoPatterns = ['noreply@', 'no-reply@', 'donotreply@', 'mailer-daemon@', 'postmaster@', 'notifications@'];
      for (const pattern of autoPatterns) {
        const r = this.db.prepare(`
          UPDATE ${CONTACTS}
          SET contact_type = 'automated', contact_type_confidence = 0.95, contact_type_source = 'rule'
          WHERE email LIKE ? AND contact_type = 'unknown'
        `).run(`${pattern}%`);
        classified += r.changes;
      }

      // 3. Newsletter: high volume, low reply rate, unsubscribe-likely
      const r3 = this.db.prepare(`
        UPDATE ${CONTACTS}
        SET contact_type = 'newsletter', contact_type_confidence = 0.8, contact_type_source = 'behavior'
        WHERE contact_type = 'unknown'
          AND received_count >= 10
          AND sent_count = 0
          AND email NOT LIKE ?
      `).run(`%@${userDomain || 'NOMATCH'}`);
      classified += r3.changes;

      // 4. Potential customer: they contacted us (inbound) and we replied but low volume
      const r4 = this.db.prepare(`
        UPDATE ${CONTACTS}
        SET contact_type = 'potential_customer', contact_type_confidence = 0.6, contact_type_source = 'behavior'
        WHERE contact_type = 'unknown'
          AND received_count >= 1 AND received_count <= 5
          AND sent_count >= 1
          AND email NOT LIKE ?
      `).run(`%@${userDomain || 'NOMATCH'}`);
      classified += r4.changes;

      // 5. Existing customer: sustained two-way communication
      const r5 = this.db.prepare(`
        UPDATE ${CONTACTS}
        SET contact_type = 'existing_customer', contact_type_confidence = 0.65, contact_type_source = 'behavior'
        WHERE contact_type = 'unknown'
          AND received_count >= 5
          AND sent_count >= 3
          AND email NOT LIKE ?
      `).run(`%@${userDomain || 'NOMATCH'}`);
      classified += r5.changes;

      // Sync to sender_stats
      this.db.prepare(`
        UPDATE sender_stats SET contact_type = (
          SELECT c.contact_type FROM ${CONTACTS} c WHERE c.email = sender_stats.email
        ) WHERE EXISTS (
          SELECT 1 FROM ${CONTACTS} c WHERE c.email = sender_stats.email AND c.contact_type != 'unknown'
        )
      `).run();
    });
    txn();

    return classified;
  }

  /**
   * Get contacts by classification type
   */
  getContactsByType(
    contactType: ContactType,
    options: { limit?: number; offset?: number; search?: string } = {},
  ): ClassifiedContact[] {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    let sql = `
      SELECT c.email, c.name, c.company, c.contact_type, c.contact_type_confidence,
             c.contact_type_source, c.received_count, c.sent_count,
             c.last_inbound_at, c.last_outbound_at, c.avg_response_time_sec,
             c.thread_count, c.needs_response, c.is_favorite
      FROM ${CONTACTS} c
      WHERE c.contact_type = ?
    `;
    const params: any[] = [contactType];

    if (options.search) {
      sql += ` AND (c.email LIKE ? OR c.name LIKE ? OR c.company LIKE ?)`;
      const s = `%${options.search}%`;
      params.push(s, s, s);
    }

    sql += ` ORDER BY c.last_seen DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.rowToClassifiedContact(r));
  }

  /**
   * Get contact type counts
   */
  getContactTypeCounts(): Record<ContactType, number> {
    const rows = this.db.prepare(`
      SELECT contact_type, COUNT(*) as count
      FROM ${CONTACTS}
      GROUP BY contact_type
    `).all() as { contact_type: string; count: number }[];

    const counts: Record<string, number> = {};
    for (const r of rows) {
      counts[r.contact_type || 'unknown'] = r.count;
    }
    return counts as Record<ContactType, number>;
  }

  /**
   * Get contacts awaiting user response
   */
  getContactsNeedingResponse(limit = 50): ClassifiedContact[] {
    const rows = this.db.prepare(`
      SELECT c.email, c.name, c.company, c.contact_type, c.contact_type_confidence,
             c.contact_type_source, c.received_count, c.sent_count,
             c.last_inbound_at, c.last_outbound_at, c.avg_response_time_sec,
             c.thread_count, c.needs_response, c.is_favorite
      FROM ${CONTACTS} c
      WHERE c.needs_response = 1
      ORDER BY c.last_inbound_at DESC
      LIMIT ?
    `).all(limit) as any[];
    return rows.map(r => this.rowToClassifiedContact(r));
  }

  /**
   * Update needs_response flag based on latest action log
   * A contact needs response if their last email to us has no reply from us after it
   */
  refreshNeedsResponse(): number {
    // Mark contacts as needing response where their latest inbound has no subsequent outbound
    const result = this.db.prepare(`
      UPDATE ${CONTACTS} SET needs_response = 1, last_inbound_at = (
        SELECT MAX(a.timestamp) FROM user_action_log a
        WHERE a.sender_address = contacts.email AND a.action_type = 'read'
      )
      WHERE email IN (
        SELECT DISTINCT a.sender_address FROM user_action_log a
        WHERE a.action_type = 'read' AND a.sender_address IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_action_log b
            WHERE b.sender_address = a.sender_address
              AND b.action_type IN ('reply', 'reply_all')
              AND b.timestamp > a.timestamp
          )
          AND a.timestamp > (CAST(strftime('%s', 'now') AS INTEGER) - 604800)
      ) AND contact_type NOT IN ('automated', 'newsletter')
    `).run();

    // Clear needs_response for contacts we've replied to
    this.db.prepare(`
      UPDATE ${CONTACTS} SET needs_response = 0
      WHERE needs_response = 1 AND email IN (
        SELECT DISTINCT sender_address FROM user_action_log
        WHERE action_type IN ('reply', 'reply_all')
          AND timestamp > (CAST(strftime('%s', 'now') AS INTEGER) - 604800)
      )
    `).run();

    return result.changes;
  }

  /**
   * Get waiting actions — emails where user was the last to receive and hasn't acted
   */
  getWaitingUserActions(limit = 50): Array<{
    emailId: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    contactType: ContactType;
    receivedAt: number;
    waitingSeconds: number;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db.prepare(`
      SELECT e.id as email_id, e.subject, e.from_address, e.from_name,
             COALESCE(c.contact_type, 'unknown') as contact_type,
             e.date as received_at,
             (? - e.date) as waiting_seconds
      FROM emails e
      LEFT JOIN ${CONTACTS} c ON LOWER(e.from_address) = c.email
      WHERE instr(e.tags, '|read|') = 0
        AND e.date > (? - 604800)
        AND instr(e.tags, '|Trash|') = 0
        AND instr(e.tags, '|Spam|') = 0
        AND instr(e.tags, '|[Gmail]/Trash|') = 0
        AND instr(e.tags, '|[Gmail]/Spam|') = 0
        AND instr(e.tags, '|Drafts|') = 0
        AND instr(e.tags, '|Sent|') = 0
        AND instr(e.tags, '|[Gmail]/Sent Mail|') = 0
        AND COALESCE(c.contact_type, 'unknown') NOT IN ('automated', 'newsletter')
      ORDER BY
        CASE COALESCE(c.contact_type, 'unknown')
          WHEN 'existing_customer' THEN 0
          WHEN 'potential_customer' THEN 1
          WHEN 'colleague' THEN 2
          WHEN 'vendor' THEN 3
          WHEN 'personal' THEN 4
          ELSE 5
        END,
        e.date DESC
      LIMIT ?
    `).all(now, now, limit) as any[];

    return rows.map(r => ({
      emailId: r.email_id,
      subject: r.subject || '(No subject)',
      fromAddress: r.from_address,
      fromName: r.from_name,
      contactType: r.contact_type as ContactType,
      receivedAt: r.received_at,
      waitingSeconds: r.waiting_seconds,
    }));
  }

  // ========== Private Helpers ==========

  private incrementSenderMetric(senderEmail: string, actionType: UserActionType, timestamp: number): void {
    const dayStart = Math.floor(timestamp / 86400) * 86400;
    const id = `sdm-${this.normalizeEmailKey(senderEmail)}-${dayStart}`;

    const columnMap: Record<string, string> = {
      read: 'read_count',
      reply: 'replied_count',
      reply_all: 'replied_count',
      delete: 'deleted_count',
      archive: 'archived_count',
    };

    const column = columnMap[actionType];
    if (!column) return;

    // Upsert with increment
    this.db.prepare(`
      INSERT INTO sender_daily_metrics (id, sender_email, date, ${column})
      VALUES (?, ?, ?, 1)
      ON CONFLICT(sender_email, date) DO UPDATE SET
        ${column} = ${column} + 1
    `).run(id, this.normalizeEmailKey(senderEmail), dayStart);
  }

  private rowToActionLog(row: any): UserActionLog {
    return {
      id: row.id,
      emailId: row.email_id,
      threadId: row.thread_id,
      actionType: row.action_type,
      actionValue: row.action_value,
      source: row.source,
      senderAddress: row.sender_address,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }

  private rowToDecision(row: any): AgentDecision {
    return {
      id: row.id,
      emailId: row.email_id,
      threadId: row.thread_id,
      senderAddress: row.sender_address,
      proposedAction: row.proposed_action,
      proposedValue: row.proposed_value,
      confidence: row.confidence,
      reasoning: row.reasoning,
      status: row.status,
      actualAction: row.actual_action,
      userFeedback: row.user_feedback,
      proposedAt: row.proposed_at,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      draftBody: row.draft_body || undefined,
      draftSubject: row.draft_subject || undefined,
      draftReasoning: row.draft_reasoning || undefined,
    };
  }

  private rowToSenderMetrics(row: any): SenderDailyMetrics {
    return {
      id: row.id,
      senderEmail: row.sender_email,
      date: row.date,
      receivedCount: row.received_count,
      readCount: row.read_count,
      repliedCount: row.replied_count,
      deletedCount: row.deleted_count,
      archivedCount: row.archived_count,
      avgResponseTimeSec: row.avg_response_time_sec,
      createdAt: row.created_at,
    };
  }

  private rowToPipelineEvent(row: any): PipelineEventLog {
    return {
      id: row.id,
      eventType: row.event_type,
      emailId: row.email_id,
      threadId: row.thread_id,
      data: row.data,
      timestamp: row.timestamp,
      createdAt: row.created_at,
    };
  }

  private rowToClassifiedContact(row: any): ClassifiedContact {
    return {
      email: row.email,
      name: row.name,
      company: row.company,
      contactType: row.contact_type || 'unknown',
      contactTypeConfidence: row.contact_type_confidence || 0,
      contactTypeSource: row.contact_type_source || 'unset',
      receivedCount: row.received_count || 0,
      sentCount: row.sent_count || 0,
      lastInboundAt: row.last_inbound_at,
      lastOutboundAt: row.last_outbound_at,
      avgResponseTimeSec: row.avg_response_time_sec,
      threadCount: row.thread_count || 0,
      needsResponse: row.needs_response === 1,
      isFavorite: row.is_favorite === 1,
    };
  }
}
