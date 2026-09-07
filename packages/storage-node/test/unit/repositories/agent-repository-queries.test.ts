import type { ContactType, UserActionType } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { newMigratedDb } from '../../../src/test-support/test-db';

import {
  AgentRepository,
  mergeNewestFirst,
  SQL_LABEL_PENDING_EXPLICIT,
  SQL_LABEL_PENDING_LEGACY,
  SQL_LABEL_RECENT_CUTOFF,
} from '../../../src/repositories/agent-repository';


// The READ side of AgentRepository: the pipeline work-queues that decide which
// mail the LLM is allowed to touch, the behaviour analytics the agent learns
// from, and the contact classification the dashboard renders. These queries all
// run against the REAL migrated schema (tags string, extraction/agent/label
// status columns, FK-enforced emails) because a drifted predicate here does not
// crash — it silently stops categorizing mail, or spends tokens on the entire
// historical backlog.
//
// Everything is derived from explicitly seeded rows and time is frozen, so the
// windows (90 days, 7 days, 1 hour bursts, "recent N") assert exactly and never
// flake at midnight.
const FIXED_NOW_SEC = 1780315200; // 2026-06-15T12:00:00Z
const DAY = 86400;
const dayStart = (ts: number): number => Math.floor(ts / DAY) * DAY;

/** Hour-of-day exactly as the repository's SQL computes it (TZ-independent). */
function localHour(db: Database.Database, ts: number): number {
  return (
    db
      .prepare("SELECT CAST(strftime('%H', ?, 'unixepoch', 'localtime') AS INTEGER) AS h")
      .get(ts) as { h: number }
  ).h;
}

interface EmailSeed {
  id: string;
  threadId?: string;
  folderId?: string;
  folderPath?: string;
  specialUse?: string | null;
  /** Written with the leading/trailing pipes the schema expects. */
  tags?: string;
  subject?: string | null;
  from?: string;
  fromName?: string | null;
  to?: string | null;
  date?: number;
  uid?: number;
  cleanBody?: string;
  rawBody?: string;
  inReplyTo?: string | null;
  extractionStatus?: string | null;
  agentStatus?: string | null;
  labelStatus?: string | null;
  /** The AI's own verdict, `|a|b|` encoded. NULL = never recorded. */
  aiCategories?: string | null;
  priorityScore?: number | null;
  priorityTier?: string | null;
  priorityReasoning?: string | null;
  recommendedAction?: string | null;
}

function ensureFolder(db: Database.Database, id: string, path: string, specialUse: string | null): void {
  db.prepare(
    'INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)',
  ).run(id, path, path, specialUse);
}

let uidSeq = 0;

/** Insert an email plus the folder/thread parents its foreign keys require. */
function seedEmail(db: Database.Database, seed: EmailSeed): void {
  const folderId = seed.folderId ?? 'f-inbox';
  const folderPath = seed.folderPath ?? (folderId === 'f-inbox' ? 'INBOX' : folderId);
  const specialUse = seed.specialUse ?? (folderId === 'f-inbox' ? '\\Inbox' : null);
  ensureFolder(db, folderId, folderPath, specialUse);

  const threadId = seed.threadId ?? `t-${seed.id}`;
  const date = seed.date ?? FIXED_NOW_SEC;
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(threadId, seed.subject ?? 'subject', `<${seed.id}>`, `<${seed.id}>`, date);

  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, uid, tags, subject,
       from_address, from_name, to_address, date,
       clean_body, raw_body, clean_body_len, raw_body_len,
       content_type, content_hash, in_reply_to,
       extraction_status, agent_status, label_status, ai_categories,
       priority_score, priority_tier, priority_reasoning, recommended_action
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               LENGTH(TRIM(?)), LENGTH(TRIM(?)), 'text', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    `<${seed.id}>`,
    threadId,
    folderId,
    seed.uid ?? ++uidSeq,
    seed.tags ?? '|INBOX|',
    seed.subject === undefined ? 'subject' : seed.subject,
    seed.from ?? 'someone@x.example',
    seed.fromName ?? null,
    seed.to ?? null,
    date,
    seed.cleanBody ?? 'body text',
    seed.rawBody ?? 'body text',
    // The length columns are written from the bodies in SQL, exactly as every
    // production writer does — on a fully-migrated DB the eligibility clauses
    // read them instead of the bodies, so a NULL here makes the row look
    // body-less and the test assert nothing.
    seed.cleanBody ?? 'body text',
    seed.rawBody ?? 'body text',
    `hash-${seed.id}`,
    seed.inReplyTo ?? null,
    seed.extractionStatus === undefined ? 'pending' : seed.extractionStatus,
    seed.agentStatus === undefined ? 'pending' : seed.agentStatus,
    seed.labelStatus ?? null,
    seed.aiCategories ?? null,
    seed.priorityScore ?? null,
    seed.priorityTier ?? null,
    seed.priorityReasoning ?? null,
    seed.recommendedAction ?? null,
  );
}

interface ActionSeed {
  id: string;
  emailId?: string;
  threadId?: string | null;
  actionType: UserActionType;
  sender?: string | null;
  timestamp: number;
  source?: string;
}

/**
 * Insert an action row directly (and its parent email when the test did not
 * seed one) so the analytics assertions are derived from a known per-row truth
 * rather than from the write path's own side effects.
 */
function seedAction(db: Database.Database, seed: ActionSeed): void {
  const emailId = seed.emailId ?? `e-${seed.id}`;
  const exists = db.prepare('SELECT 1 AS x FROM emails WHERE id = ?').get(emailId);
  if (!exists) seedEmail(db, { id: emailId, date: seed.timestamp });

  db.prepare(
    `INSERT INTO user_action_log (id, email_id, thread_id, action_type, action_value, source, sender_address, timestamp)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    seed.id,
    emailId,
    seed.threadId ?? null,
    seed.actionType,
    seed.source ?? 'user',
    seed.sender ?? null,
    seed.timestamp,
  );
}

function seedContact(
  db: Database.Database,
  contact: {
    email: string;
    name?: string | null;
    company?: string | null;
    contactType?: ContactType;
    receivedCount?: number;
    sentCount?: number;
    lastSeen?: number;
    lastInboundAt?: number | null;
    needsResponse?: 0 | 1;
    isFavorite?: 0 | 1;
    threadCount?: number;
    confidence?: number;
    source?: string;
  },
): void {
  db.prepare(
    `INSERT INTO contacts (
       id, email, name, company, first_seen, last_seen, received_count, sent_count,
       contact_type, contact_type_confidence, contact_type_source,
       last_inbound_at, needs_response, is_favorite, thread_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `c-${contact.email}`,
    contact.email,
    contact.name ?? null,
    contact.company ?? null,
    FIXED_NOW_SEC - 100 * DAY,
    contact.lastSeen ?? FIXED_NOW_SEC,
    contact.receivedCount ?? 0,
    contact.sentCount ?? 0,
    contact.contactType ?? 'unknown',
    contact.confidence ?? 0,
    contact.source ?? 'unset',
    contact.lastInboundAt ?? null,
    contact.needsResponse ?? 0,
    contact.isFavorite ?? 0,
    contact.threadCount ?? 0,
  );
}

function seedSenderStats(
  db: Database.Database,
  stats: { email: string; sentToCount?: number; repliedCount?: number; keyContext?: string | null },
): void {
  db.prepare(
    `INSERT INTO sender_stats (id, email, domain, first_seen, sent_to_count, replied_count, key_context)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `ss-${stats.email}`,
    stats.email,
    stats.email.split('@')[1] ?? 'x.example',
    FIXED_NOW_SEC - 100 * DAY,
    stats.sentToCount ?? 0,
    stats.repliedCount ?? 0,
    stats.keyContext ?? null,
  );
}

function seedCategory(
  db: Database.Database,
  cat: { slug: string; name?: string; enabled?: 0 | 1 },
): void {
  db.prepare(
    `INSERT INTO ai_category_definitions (slug, name, prompt, is_enabled) VALUES (?, ?, ?, ?)`,
  ).run(cat.slug, cat.name ?? cat.slug, 'p', cat.enabled ?? 1);
}

function newRepo(): { db: Database.Database; repo: AgentRepository } {
  const db = newMigratedDb();
  return { db, repo: new AgentRepository(() => db) };
}

// ============================================================================

describe('AgentRepository — pipeline work queues', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // Pipeline 1 must only pick up mail that actually has content and is still
  // pending, newest-first. A body-less mail selected here becomes a permanent
  // 'pending' row that the poll retries forever.
  it('selects pending extraction candidates newest-first, skipping done and body-less mail', () => {
    seedEmail(db, { id: 'x1', date: FIXED_NOW_SEC - 30 });
    seedEmail(db, { id: 'x2', date: FIXED_NOW_SEC - 20 });
    seedEmail(db, { id: 'x3', date: FIXED_NOW_SEC - 10, extractionStatus: 'done' });
    seedEmail(db, { id: 'x4', date: FIXED_NOW_SEC, cleanBody: '', rawBody: '' });
    seedEmail(db, { id: 'x5', date: FIXED_NOW_SEC - 5, cleanBody: '', rawBody: '<html>promo</html>' });

    const pending = repo.getEmailsPendingExtraction();
    expect(pending.map((e) => e.id)).toEqual(['x5', 'x2', 'x1']); // html-only mail included
    expect(pending[0]).toMatchObject({ id: 'x5', threadId: 't-x5', date: FIXED_NOW_SEC - 5 });
    expect(repo.getEmailsPendingExtraction(1).map((e) => e.id)).toEqual(['x5']);
  });

  // recentWindow caps eligibility to the N newest emails in the mailbox so a
  // first sync never drags the whole historical backlog through the pipeline.
  it('bounds extraction candidates to the N most recent emails when recentWindow is set', () => {
    for (let index = 0; index < 5; index += 1) {
      seedEmail(db, { id: `w${index}`, date: FIXED_NOW_SEC - index * DAY });
    }

    expect(repo.getEmailsPendingExtraction(10, 2).map((e) => e.id)).toEqual(['w0', 'w1']);
    expect(repo.getEmailsPendingExtraction(10, 0)).toHaveLength(5); // window disabled
  });

  it('marks extraction done per email and per whole thread', () => {
    seedEmail(db, { id: 'm1', threadId: 't-shared' });
    seedEmail(db, { id: 'm2', threadId: 't-shared' });
    seedEmail(db, { id: 'm3', threadId: 't-other' });

    repo.markExtractionDone('m3');
    expect(repo.getEmailsPendingExtraction().map((e) => e.id).sort()).toEqual(['m1', 'm2']);

    repo.markExtractionDoneByThread('t-shared');
    expect(repo.getEmailsPendingExtraction()).toEqual([]);
    const stamped = db
      .prepare('SELECT extraction_at AS at FROM emails WHERE id = ?')
      .get('m1') as { at: number };
    expect(stamped.at).toBe(FIXED_NOW_SEC);
  });

  // Pipeline 2's gate is the expensive one: every row it returns costs LLM
  // tokens. It must require finished extraction, real content in EITHER body,
  // and must skip anything the user already triaged (read) or that lives in
  // spam/trash.
  it('gates agent candidates on extraction, body content, unread and folder tags', () => {
    const done = { extractionStatus: 'done' } as const;
    seedEmail(db, { id: 'ok', date: FIXED_NOW_SEC, from: 'a@x.example', ...done });
    seedEmail(db, { id: 'html-only', date: FIXED_NOW_SEC - 1, cleanBody: '   ', rawBody: '<b>hi</b>', ...done });
    seedEmail(db, { id: 'short', date: FIXED_NOW_SEC - 2, cleanBody: 'Call me', rawBody: '', ...done });
    seedEmail(db, { id: 'no-extraction', date: FIXED_NOW_SEC - 3 });
    seedEmail(db, { id: 'empty', date: FIXED_NOW_SEC - 4, cleanBody: ' ', rawBody: '', ...done });
    seedEmail(db, { id: 'read', date: FIXED_NOW_SEC - 5, tags: '|INBOX|read|', ...done });
    seedEmail(db, { id: 'spam', date: FIXED_NOW_SEC - 6, tags: '|Spam|', ...done });
    seedEmail(db, { id: 'trash', date: FIXED_NOW_SEC - 7, tags: '|Trash|', ...done });
    seedEmail(db, { id: 'gspam', date: FIXED_NOW_SEC - 8, tags: '|[Gmail]/Spam|', ...done });
    seedEmail(db, { id: 'gtrash', date: FIXED_NOW_SEC - 9, tags: '|[Gmail]/Trash|', ...done });
    seedEmail(db, { id: 'already', date: FIXED_NOW_SEC - 10, agentStatus: 'done', ...done });

    const candidates = repo.getEmailsPendingAgent(50);
    expect(candidates.map((e) => e.id)).toEqual(['ok', 'html-only', 'short']);
    expect(candidates[0]).toMatchObject({ id: 'ok', threadId: 't-ok', fromAddress: 'a@x.example' });
  });

  it('bounds agent candidates to the recent window and honours the limit', () => {
    for (let index = 0; index < 4; index += 1) {
      seedEmail(db, { id: `a${index}`, date: FIXED_NOW_SEC - index * DAY, extractionStatus: 'done' });
    }

    expect(repo.getEmailsPendingAgent(10, 2).map((e) => e.id)).toEqual(['a0', 'a1']);
    expect(repo.getEmailsPendingAgent(1).map((e) => e.id)).toEqual(['a0']);
  });

  // Enabling AI Assist must re-queue mail that was marked 'done' with no
  // categories while it was off — otherwise existing inbox mail is never
  // categorized, since the poll only ever revisits 'pending'.
  it('re-queues only recent unread INBOX mail with a body, newest-first', () => {
    seedEmail(db, { id: 'r-new', date: FIXED_NOW_SEC, agentStatus: 'done' });
    seedEmail(db, { id: 'r-old', date: FIXED_NOW_SEC - 10 * DAY, agentStatus: 'done' });
    seedEmail(db, { id: 'r-html', date: FIXED_NOW_SEC - 1, agentStatus: 'done', cleanBody: '', rawBody: '<p>x</p>' });
    seedEmail(db, { id: 'r-read', date: FIXED_NOW_SEC, agentStatus: 'done', tags: '|INBOX|read|' });
    seedEmail(db, { id: 'r-trash', date: FIXED_NOW_SEC, agentStatus: 'done', tags: '|Trash|' });
    seedEmail(db, { id: 'r-archive', date: FIXED_NOW_SEC, agentStatus: 'done', tags: '|Archive|' });
    seedEmail(db, { id: 'r-empty', date: FIXED_NOW_SEC, agentStatus: 'done', cleanBody: '', rawBody: '' });
    seedEmail(db, { id: 'r-pending', date: FIXED_NOW_SEC, agentStatus: 'pending' });

    expect(repo.requeueRecentInboxForAgent(2)).toBe(2); // bounded, newest first
    const requeued = db
      .prepare("SELECT id FROM emails WHERE agent_status = 'pending' ORDER BY id")
      .all() as { id: string }[];
    expect(requeued.map((r) => r.id)).toEqual(['r-html', 'r-new', 'r-pending']);

    expect(repo.requeueRecentInboxForAgent(500)).toBe(1); // only r-old is left
    expect(repo.requeueRecentInboxForAgent(500)).toBe(0); // idempotent afterwards
  });

  // markAgentDone must not blank fields the caller omitted (COALESCE): a
  // re-run that only produced a tier must keep the earlier score/reasoning.
  it('stamps agent completion and preserves omitted result fields', () => {
    seedEmail(db, { id: 'p1', extractionStatus: 'done' });

    repo.markAgentDone('p1', {
      priorityScore: 80,
      priorityTier: 'high',
      priorityReasoning: 'boss asked',
      recommendedAction: 'reply',
    });
    repo.markAgentDone('p1', { priorityTier: 'critical' });
    repo.markAgentDone('p1', { priorityScore: 80 }); // tier omitted → kept

    const row = db
      .prepare(
        `SELECT agent_status AS status, agent_at AS at, priority_score AS score,
                priority_tier AS tier, priority_reasoning AS reasoning,
                recommended_action AS action FROM emails WHERE id = 'p1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      status: 'done',
      at: FIXED_NOW_SEC,
      score: 80,
      tier: 'critical',
      reasoning: 'boss asked',
      action: 'reply',
    });
    expect(repo.getEmailsPendingAgent()).toEqual([]);
  });

  // The label-mirror drain is what makes the AI category show up in Gmail. A
  // 'pending' row must drain from ANY folder (the intent survives a disconnect),
  // while the pre-tracking NULL backlog is caught up gradually and only from
  // the inbox.
  it('drains label-pending mail from any folder and NULL-status mail only from the inbox window', () => {
    seedEmail(db, {
      id: 'l-pending-elsewhere',
      folderId: 'f-arch',
      folderPath: 'Archive',
      tags: '|Archive|',
      date: FIXED_NOW_SEC,
      agentStatus: 'done',
      labelStatus: 'pending',
      uid: 11,
    });
    seedEmail(db, { id: 'l-null-inbox', date: FIXED_NOW_SEC - 1, agentStatus: 'done', uid: 12 });
    seedEmail(db, {
      id: 'l-null-elsewhere',
      folderId: 'f-arch2',
      folderPath: 'Later',
      tags: '|Later|',
      date: FIXED_NOW_SEC - 2,
      agentStatus: 'done',
      uid: 13,
    });
    seedEmail(db, { id: 'l-applied', date: FIXED_NOW_SEC - 3, agentStatus: 'done', labelStatus: 'done', uid: 14 });
    seedEmail(db, { id: 'l-not-categorized', date: FIXED_NOW_SEC - 4, uid: 15 });
    seedEmail(db, {
      id: 'l-spam',
      date: FIXED_NOW_SEC - 5,
      tags: '|[Gmail]/Spam|',
      agentStatus: 'done',
      labelStatus: 'pending',
      uid: 16,
    });

    const pending = repo.getEmailsPendingLabel();
    expect(pending.map((e) => e.id)).toEqual(['l-pending-elsewhere', 'l-null-inbox']);
    expect(pending[0]).toMatchObject({ id: 'l-pending-elsewhere', uid: 11, folderId: 'f-arch', tags: '|Archive|' });

    // The NULL-status backlog is additionally bounded by the recent window…
    expect(repo.getEmailsPendingLabel(12, 1).map((e) => e.id)).toEqual(['l-pending-elsewhere']);
    // …but an explicitly pending row is never dropped by the limit ordering.
    expect(repo.getEmailsPendingLabel(1).map((e) => e.id)).toEqual(['l-pending-elsewhere']);
  });

  // The drain mirrors the AI's VERDICT, so the verdict has to reach it. Before
  // this column the drain read categories out of the tag string, where Gmail's
  // `\Important` label also lands — and mirrored our own `Sarv Inbox/Important`
  // label onto mail no AI had ever called important. The three states must stay
  // distinguishable all the way through the query.
  it('hands the drain each row\'s recorded AI verdict, not its tags', () => {
    seedEmail(db, {
      id: 'v-verdict', agentStatus: 'done', labelStatus: 'pending', uid: 21,
      // The tag string claims `important`; the verdict says only `invoice`.
      tags: '|INBOX|important|invoice|', aiCategories: '|invoice|',
    });
    seedEmail(db, {
      id: 'v-cleared', agentStatus: 'done', labelStatus: 'pending', uid: 22,
      date: FIXED_NOW_SEC - 1, tags: '|INBOX|important|', aiCategories: '||',
    });
    seedEmail(db, {
      id: 'v-legacy', agentStatus: 'done', labelStatus: 'pending', uid: 23,
      date: FIXED_NOW_SEC - 2, tags: '|INBOX|important|',
    });

    const byId = new Map(repo.getEmailsPendingLabel().map((e) => [e.id, e]));

    // A real verdict travels verbatim — and does NOT pick up the tag's `important`.
    expect(byId.get('v-verdict')?.aiCategories).toBe('|invoice|');
    // "The AI ran and chose nothing" is the empty sentinel, NOT null: the drain
    // must still reconcile it so a cleared mail loses its stale label.
    expect(byId.get('v-cleared')?.aiCategories).toBe('||');
    // "No verdict recorded" stays null, so the drain can tell it apart from the
    // line above and skip it rather than stripping labels off pre-existing mail.
    expect(byId.get('v-legacy')?.aiCategories).toBeNull();
  });

  describe('recordAiCategories', () => {
    // The ONLY writer of the column. If it silently failed, every newly
    // categorized mail would look legacy and stop being labelled at all.
    it('stores the verdict against the email', () => {
      seedEmail(db, { id: 'r1', agentStatus: 'done', labelStatus: 'pending', uid: 31 });

      repo.recordAiCategories('r1', '|invoice|finance|');

      expect(repo.getEmailsPendingLabel()[0].aiCategories).toBe('|invoice|finance|');
    });

    // A re-categorization REPLACES the verdict; a dropped category has to
    // actually disappear or its label would never be stripped from the server.
    it('overwrites a previous verdict rather than merging', () => {
      seedEmail(db, { id: 'r2', agentStatus: 'done', labelStatus: 'pending', uid: 32 });

      repo.recordAiCategories('r2', '|invoice|finance|');
      repo.recordAiCategories('r2', '|finance|');

      expect(repo.getEmailsPendingLabel()[0].aiCategories).toBe('|finance|');
    });

    // Clearing every category is a real verdict and must be storable as one.
    it('can record an empty verdict without falling back to null', () => {
      seedEmail(db, { id: 'r3', agentStatus: 'done', labelStatus: 'pending', uid: 33 });

      repo.recordAiCategories('r3', '||');

      expect(repo.getEmailsPendingLabel()[0].aiCategories).toBe('||');
    });

    // Writing to an id that no longer exists (mail deleted mid-pipeline) is a
    // no-op, not a throw — the pipeline's finalize step must not die on it.
    it('is a no-op for an unknown email id', () => {
      expect(() => repo.recordAiCategories('gone', '|invoice|')).not.toThrow();
    });
  });

  // THE performance guard for the label drain, and it is a correctness issue in
  // disguise: `label_status` and `agent_status` are late-ALTER columns that sit
  // past the inline bodies, so a row that has to be *visited* costs a walk of
  // its overflow chain. This query used to be a single `OR`, which let SQLite
  // use neither the pending partial index nor the recent-window bound — the V8
  // profiler measured 82.9% of all main-thread JS time in it, on every poll
  // tick, forever, even with nothing to drain. If either branch flips back to a
  // full scan the app freezes again on a large mailbox.
  it('answers both drain branches with an index seek, never a scan of emails', () => {
    const planOf = (sql: string, ...params: Array<number | string>): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');

    // Deferred applies: seeks the partial index, so "nothing pending" — the
    // steady state — costs one empty seek rather than 26k record reads.
    const explicitPlan = planOf(SQL_LABEL_PENDING_EXPLICIT, 12);
    expect(explicitPlan).toContain('idx_emails_label_status');
    expect(explicitPlan).not.toMatch(/SCAN emails/);
    // v72 widened that partial index to (label_status, agent_status, date) so it
    // keeps winning against the new, much wider idx_emails_agent_pipeline —
    // which does not carry label_status and would therefore have to open every
    // categorized record to test it. The free date order is the tie-breaker the
    // planner was choosing the wide index for, so pin it.
    expect(explicitPlan).not.toMatch(/TEMP B-TREE/);

    // Legacy backlog: the date bound must be a RANGE, which is what caps the
    // walk at the newest `recentCount` rows. Which index supplies it is the
    // planner's business — v72 added idx_emails_agent_pipeline(agent_status,
    // date, …), so the bound now arrives as `agent_status=? AND date>?`: the
    // same date range, pre-filtered by status, and still ordered by the index.
    // What must never regress is the SHAPE: a range on date, and no sort.
    const legacyPlan = planOf(SQL_LABEL_PENDING_LEGACY, 0, 12);
    expect(legacyPlan).toMatch(/date[>≥]/); // a range bound, not a post-filter
    expect(legacyPlan).toMatch(/SEARCH e /); // `e` is the emails alias — SEARCH, not SCAN
    expect(legacyPlan).not.toMatch(/SCAN emails/);
    // No TEMP B-TREE: the index supplies date order, so the query stops at the
    // LIMIT instead of materializing and sorting every categorized email. This
    // is the assertion that catches a column-order change in that index.
    expect(legacyPlan).not.toMatch(/TEMP B-TREE/);

    // The window floor itself must stay off the records too: it reads the date
    // index only. A correlated form of this was why the bound never pushed down.
    // COVERING is the load-bearing word: it walks date-index entries (stopping
    // at the LIMIT) and never opens a record, so the bodies stay untouched.
    const cutoffPlan = planOf(SQL_LABEL_RECENT_CUTOFF, 500);
    expect(cutoffPlan).toContain('COVERING INDEX idx_emails_date');
  });

  // Splitting the OR into two queries is only safe if the merge preserves
  // newest-first and the cap: the drain applies labels in this order and is
  // rate-bounded per tick, so a mis-merge either re-labels the wrong mail first
  // or blows the Gmail-safe batch size.
  it('merges the two branches newest-first and honours the limit', () => {
    const left = [{ date: 30 }, { date: 10 }];
    const right = [{ date: 20 }, { date: 5 }];

    expect(mergeNewestFirst(left, right, 3).map((r) => r.date)).toEqual([30, 20, 10]);
    expect(mergeNewestFirst(left, right, 99).map((r) => r.date)).toEqual([30, 20, 10, 5]);
    // A zero/negative cap yields nothing rather than the whole backlog.
    expect(mergeNewestFirst(left, right, 0)).toEqual([]);
    expect(mergeNewestFirst([], [], 5)).toEqual([]);
  });

  // Multi-account safety: each account has its own DB and its own backlog. The
  // drain must never mix them, and one account having nothing pending must not
  // suppress the other's work (the two queries run per-storage).
  it('keeps each account’s drain independent', () => {
    const other = newMigratedDb();
    try {
      const otherRepo = new AgentRepository(() => other);
      seedEmail(db, { id: 'a-pending', agentStatus: 'done', labelStatus: 'pending', uid: 1 });
      seedEmail(other, { id: 'b-pending', agentStatus: 'done', labelStatus: 'pending', uid: 2 });

      expect(repo.getEmailsPendingLabel().map((e) => e.id)).toEqual(['a-pending']);
      expect(otherRepo.getEmailsPendingLabel().map((e) => e.id)).toEqual(['b-pending']);

      repo.markLabelDone('a-pending');
      expect(repo.getEmailsPendingLabel()).toEqual([]);
      expect(otherRepo.getEmailsPendingLabel().map((e) => e.id)).toEqual(['b-pending']);
    } finally {
      other.close();
    }
  });

  it('flips label status pending → done through the public markers', () => {
    seedEmail(db, { id: 'lb1', agentStatus: 'done', labelStatus: 'done' });

    repo.markLabelPending('lb1');
    expect(repo.getEmailsPendingLabel().map((e) => e.id)).toEqual(['lb1']);

    repo.markLabelDone('lb1');
    expect(repo.getEmailsPendingLabel()).toEqual([]);
  });

  // The dashboard funnel must agree with the rows: a mismatch here is what
  // makes "0 pending" show while mail is actually stuck.
  //
  // The pending figures are now ELIGIBLE counts — what each phase can actually
  // select — not raw status counts. f1 is awaiting extraction, so it is phase-1
  // work and appears in extractionPending ONLY; it used to be counted as
  // agentPending as well, double-counting one email across both phases and
  // leaving the funnel showing agent work that no agent pass could pick up.
  it('reports pipeline funnel counts that agree with the seeded rows', () => {
    seedEmail(db, { id: 'f1' });
    seedEmail(db, { id: 'f2', extractionStatus: 'done' });
    seedEmail(db, { id: 'f3', extractionStatus: 'done', agentStatus: 'done' });
    seedEmail(db, { id: 'f4', extractionStatus: 'done', agentStatus: 'done' });
    seedEmail(db, { id: 'f-nobody', cleanBody: '', rawBody: '' }); // excluded entirely

    expect(repo.getPipelineStats()).toEqual({
      totalEmails: 4,
      extractionPending: 1,
      extractionDone: 3,
      agentPending: 1, // f2 only — f1 is still phase-1's
      agentDone: 2,
    });
  });

  it('reports zeroed funnel counts on an empty mailbox', () => {
    expect(repo.getPipelineStats()).toEqual({
      totalEmails: 0,
      extractionPending: 0,
      extractionDone: 0,
      agentPending: 0,
      agentDone: 0,
    });
  });

  // The boot path uses getPipelineStatsLite, NOT getPipelineStats: the latter's
  // hasBodyClause forces a full multi-GB body scan that stalled window creation
  // ~13s. The lite variant must count purely off the indexed status columns and
  // read no body content — so it must, unlike getPipelineStats, still count rows
  // that have no body (they carry a status, and the boot line is a raw sanity
  // count). If this ever starts excluding body-less rows, the body scan is back.
  it('lite stats: raw status counts that INCLUDE body-less rows (no body scan)', () => {
    seedEmail(db, { id: 'l1' });                                         // ext pending + agent pending (defaults)
    seedEmail(db, { id: 'l2', extractionStatus: 'done' });              // agent pending
    seedEmail(db, { id: 'l3', extractionStatus: 'done', agentStatus: 'done' });
    seedEmail(db, { id: 'l-nobody', cleanBody: '', rawBody: '' });      // body-less, still 'pending' both phases

    // Raw status counts, no cross-phase gate: agent_status='pending' matches
    // l1, l2 AND l-nobody — the "extraction must be done first" eligibility gate
    // that getPipelineStats applies is deliberately absent here.
    expect(repo.getPipelineStatsLite()).toEqual({
      totalEmails: 4,               // includes the body-less row getPipelineStats drops
      extractionStatusPending: 2,   // l1 AND l-nobody
      agentStatusPending: 3,        // l1, l2 AND l-nobody
    });
  });

  it('lite stats: zeroed on an empty mailbox', () => {
    expect(repo.getPipelineStatsLite()).toEqual({
      totalEmails: 0,
      extractionStatusPending: 0,
      agentStatusPending: 0,
    });
  });

  // Priority list: score DESC then date DESC, unread only, spam/trash never.
  // Showing a trashed or already-read mail in the priority pane is the visible
  // bug this pins.
  it('orders by priority then recency, excluding read and spam/trash copies', () => {
    seedEmail(db, {
      id: 'pr1',
      priorityScore: 90,
      priorityTier: 'high',
      priorityReasoning: 'r1',
      recommendedAction: 'reply',
      subject: 'top',
      from: 'a@x.example',
      fromName: 'A',
      date: FIXED_NOW_SEC - 100,
    });
    seedEmail(db, { id: 'pr2', priorityScore: 90, priorityTier: 'high', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr3', priorityScore: 40, priorityTier: 'low', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr-none', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr-read', priorityScore: 99, tags: '|INBOX|read|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr-trash', priorityScore: 99, tags: '|Trash|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr-gtrash', priorityScore: 99, tags: '|[Gmail]/Trash|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr-spam', priorityScore: 99, tags: '|Spam|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'pr-gspam', priorityScore: 99, tags: '|[Gmail]/Spam|', date: FIXED_NOW_SEC });

    const rows = repo.getEmailsByPriority();
    expect(rows.map((r) => r.id)).toEqual(['pr2', 'pr1', 'pr3']);
    expect(rows[1]).toMatchObject({
      id: 'pr1',
      subject: 'top',
      fromAddress: 'a@x.example',
      fromName: 'A',
      priorityScore: 90,
      priorityTier: 'high',
      priorityReasoning: 'r1',
      recommendedAction: 'reply',
      tags: '|INBOX|',
    });

    expect(repo.getEmailsByPriority(50, 90).map((r) => r.id)).toEqual(['pr2', 'pr1']);
    expect(repo.getEmailsByPriority(1).map((r) => r.id)).toEqual(['pr2']);
    // minScore = 0 is falsy, so the filter is skipped (documented behaviour).
    expect(repo.getEmailsByPriority(50, 0)).toHaveLength(3);
  });
});

describe('AgentRepository — behaviour analysis', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // The per-sender rates are the core learning signal. They must be derived
  // from the action log (reply_all counts as a reply), capped at 1, and the
  // average response time must ignore implausible gaps (> 7 days) and actions
  // logged BEFORE the mail arrived.
  it('derives read/reply/delete/archive rates and the average response time', () => {
    const sender = 'boss@corp.example';
    seedEmail(db, { id: 'b1', from: sender, date: FIXED_NOW_SEC - 1000 });
    seedEmail(db, { id: 'b2', from: sender, date: FIXED_NOW_SEC - 1000 });
    seedEmail(db, { id: 'b3', from: sender, date: FIXED_NOW_SEC - 1000 });
    seedEmail(db, { id: 'b4', from: sender, date: FIXED_NOW_SEC - 10 * DAY });

    seedAction(db, { id: 'g1', emailId: 'b1', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 900 });
    seedAction(db, { id: 'g2', emailId: 'b2', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 800 });
    seedAction(db, { id: 'g3', emailId: 'b3', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 700 });
    seedAction(db, { id: 'g4', emailId: 'b4', actionType: 'read', sender, timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'g5', emailId: 'b1', actionType: 'reply', sender, timestamp: FIXED_NOW_SEC - 890 });
    seedAction(db, { id: 'g6', emailId: 'b2', actionType: 'reply_all', sender, timestamp: FIXED_NOW_SEC - 790 });
    seedAction(db, { id: 'g7', emailId: 'b3', actionType: 'delete', sender, timestamp: FIXED_NOW_SEC - 690 });
    seedAction(db, { id: 'g8', emailId: 'b3', actionType: 'archive', sender, timestamp: FIXED_NOW_SEC - 680 });

    const pattern = repo.getSenderResponsePattern('BOSS@CORP.EXAMPLE');
    expect(pattern.totalReceived).toBe(4); // 4 read actions
    expect(pattern.readRate).toBe(1);
    expect(pattern.replyRate).toBe(0.5); // reply + reply_all over 4
    expect(pattern.deleteRate).toBe(0.25);
    expect(pattern.archiveRate).toBe(0.25);
    // Only the 6 in-window read/reply gaps count (b4's 10-day gap is dropped):
    // reads 100/200/300 and replies 110/210 over their mails' dates.
    const gaps = [100, 200, 300, 110, 210];
    expect(pattern.avgResponseTimeSec).toBe(
      Math.round(gaps.reduce((sum, g) => sum + g, 0) / gaps.length),
    );
  });

  // An unknown sender must not divide by zero or report NaN rates — the
  // dashboard renders these straight into percentages.
  it('returns a safe zeroed pattern for a sender with no history', () => {
    expect(repo.getSenderResponsePattern('nobody@x.example')).toEqual({
      totalReceived: 1,
      readRate: 0,
      replyRate: 0,
      deleteRate: 0,
      archiveRate: 0,
      avgResponseTimeSec: null,
    });
  });

  // Rates are capped at 1: more archives than reads (mail archived without ever
  // being opened) must not report a 300% archive rate.
  it('caps a rate at 1 when an action outnumbers the reads', () => {
    const sender = 'news@x.example';
    seedAction(db, { id: 'c1', actionType: 'read', sender, timestamp: FIXED_NOW_SEC });
    for (let index = 0; index < 3; index += 1) {
      seedAction(db, { id: `c-a${index}`, actionType: 'archive', sender, timestamp: FIXED_NOW_SEC });
    }
    expect(repo.getSenderResponsePattern(sender).archiveRate).toBe(1);
  });

  // Peak hours drive when the agent is allowed to act. Ordering must be by
  // volume and the list capped at five buckets.
  it('ranks activity hours by volume and caps the list at five', () => {
    const base = dayStart(FIXED_NOW_SEC);
    const busy = base + 9 * 3600;
    for (let index = 0; index < 4; index += 1) {
      seedAction(db, { id: `h-busy${index}`, actionType: 'read', timestamp: busy + index });
    }
    for (const [index, offset] of [1, 3, 5, 7, 11, 13].entries()) {
      seedAction(db, { id: `h-o${index}`, actionType: 'read', timestamp: base + offset * 3600 });
    }

    const hours = repo.getPeakActivityHours();
    expect(hours[0]).toBe(localHour(db, busy)); // dominant bucket first
    expect(hours).toHaveLength(5); // 7 distinct hours seeded, top 5 returned
    expect(new Set(hours).size).toBe(5); // no duplicate buckets
    expect(repo.getPeakActivityHours().every((h) => h >= 0 && h <= 23)).toBe(true);
  });

  it('returns no peak hours when nothing has been logged', () => {
    expect(repo.getPeakActivityHours()).toEqual([]);
  });

  // Tiering is what mutes noise and protects VIPs. A sender the user has ever
  // replied to must NEVER be classified as noise, no matter how much of their
  // mail gets deleted.
  it('classifies VIPs by reply volume and noise by deletes-without-any-reply', () => {
    for (let index = 0; index < 3; index += 1) {
      seedAction(db, { id: `v${index}`, actionType: 'reply', sender: 'vip@x.example', timestamp: FIXED_NOW_SEC });
    }
    seedAction(db, { id: 'v-thin', actionType: 'reply', sender: 'sometimes@x.example', timestamp: FIXED_NOW_SEC });
    for (let index = 0; index < 5; index += 1) {
      seedAction(db, { id: `n${index}`, actionType: 'delete', sender: 'noise@x.example', timestamp: FIXED_NOW_SEC });
    }
    for (let index = 0; index < 5; index += 1) {
      seedAction(db, { id: `nr${index}`, actionType: 'spam', sender: 'sometimes@x.example', timestamp: FIXED_NOW_SEC });
    }
    for (let index = 0; index < 4; index += 1) {
      seedAction(db, { id: `t${index}`, actionType: 'archive', sender: 'thin@x.example', timestamp: FIXED_NOW_SEC });
    }

    expect(repo.getSenderTiers()).toEqual({
      vip: ['vip@x.example'],
      noise: ['noise@x.example'], // 'sometimes@' is spared: they got a reply once
      regular: [],
    });
  });

  // predictAction gates auto-actions. Too little data → no prediction at all;
  // with enough data the confidence must scale with volume so 3 samples never
  // look as certain as 20.
  it('predicts nothing below the sample floor and scales confidence with volume', () => {
    const sender = 'rep@x.example';
    for (let index = 0; index < 2; index += 1) {
      seedAction(db, { id: `pa-r${index}`, actionType: 'read', sender, timestamp: FIXED_NOW_SEC });
    }
    expect(repo.predictAction(sender)).toBeNull(); // 2 reads < 3

    for (let index = 2; index < 6; index += 1) {
      seedAction(db, { id: `pa-r${index}`, actionType: 'read', sender, timestamp: FIXED_NOW_SEC });
    }
    for (let index = 0; index < 6; index += 1) {
      seedAction(db, { id: `pa-p${index}`, actionType: 'reply', sender, timestamp: FIXED_NOW_SEC });
    }

    const prediction = repo.predictAction(sender);
    const pattern = repo.getSenderResponsePattern(sender);
    expect(prediction).toEqual({
      action: 'reply',
      confidence: Math.round(pattern.replyRate * Math.min(1, pattern.totalReceived / 20) * 100) / 100,
    });
    expect(repo.predictAction('unknown@x.example')).toBeNull();
  });

  // With reads only, the weighted read rate wins — the agent should propose
  // "just read it", not a destructive action.
  it('falls back to the read action when there is no stronger signal', () => {
    for (let index = 0; index < 4; index += 1) {
      seedAction(db, { id: `ro${index}`, actionType: 'read', sender: 'ro@x.example', timestamp: FIXED_NOW_SEC });
    }
    expect(repo.predictAction('ro@x.example')).toEqual({ action: 'read', confidence: 0.1 });
  });
});

describe('AgentRepository — behaviour intelligence signals', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // "Curiosity noise" = opened then binned within seconds. The gap window must
  // be inclusive at both ends, must ignore a delete that happened BEFORE the
  // read, and must count each email once however many deletes it collected.
  it('counts read-then-deleted-fast per email with an inclusive gap window', () => {
    const sender = 'promo@x.example';
    const base = FIXED_NOW_SEC - DAY;
    seedEmail(db, { id: 'f1' });
    seedEmail(db, { id: 'f2' });
    seedEmail(db, { id: 'f3' });
    seedEmail(db, { id: 'f4' });

    seedAction(db, { id: 'k1', emailId: 'f1', actionType: 'read', sender, timestamp: base });
    seedAction(db, { id: 'k2', emailId: 'f1', actionType: 'delete', sender, timestamp: base + 10 });
    seedAction(db, { id: 'k3', emailId: 'f1', actionType: 'spam', sender, timestamp: base + 5 }); // same email
    seedAction(db, { id: 'k4', emailId: 'f2', actionType: 'read', sender, timestamp: base });
    seedAction(db, { id: 'k5', emailId: 'f2', actionType: 'delete', sender, timestamp: base + 11 }); // too slow
    seedAction(db, { id: 'k6', emailId: 'f3', actionType: 'read', sender, timestamp: base + 100 });
    seedAction(db, { id: 'k7', emailId: 'f3', actionType: 'delete', sender, timestamp: base + 50 }); // before the read
    seedAction(db, { id: 'k8', emailId: 'f4', actionType: 'read', sender, timestamp: base });
    seedAction(db, { id: 'k9', emailId: 'f4', actionType: 'archive', sender, timestamp: base + 1 }); // not a delete

    expect(repo.getReadThenDeletedFast(sender, 10)).toBe(1);
    expect(repo.getReadThenDeletedFast(sender, 11)).toBe(2); // f2 now inside the window
    // `since` filters on the READ timestamp and is inclusive.
    expect(repo.getReadThenDeletedFast(sender, 11, base)).toBe(2);
    expect(repo.getReadThenDeletedFast(sender, 11, base + 1)).toBe(0);
    expect(repo.getReadThenDeletedFast('nobody@x.example')).toBe(0);
  });

  // "Read and kept" = the user opened it and deliberately left it in the inbox.
  // Age is a strict > comparison and any later delete/archive/spam disqualifies
  // the mail, else the signal would call archived mail "kept".
  it('counts read-and-kept inbox mail past a strict age threshold', () => {
    const sender = 'keep@x.example';
    seedEmail(db, { id: 'g1', tags: '|INBOX|' });
    seedEmail(db, { id: 'g2', tags: '|INBOX|' });
    seedEmail(db, { id: 'g3', tags: '|Archive|' });
    seedEmail(db, { id: 'g4', tags: '|INBOX|' });

    seedAction(db, { id: 'q1', emailId: 'g1', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 4 * DAY });
    seedAction(db, { id: 'q2', emailId: 'g2', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 3 * DAY }); // exactly the threshold
    seedAction(db, { id: 'q3', emailId: 'g3', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 4 * DAY }); // not in inbox
    seedAction(db, { id: 'q4', emailId: 'g4', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 4 * DAY });
    seedAction(db, { id: 'q5', emailId: 'g4', actionType: 'archive', sender, timestamp: FIXED_NOW_SEC - DAY });

    expect(repo.getReadAndKeptCount(sender)).toBe(1); // only g1 (g2 sits exactly ON 3 days)
    expect(repo.getReadAndKeptCount(sender, 3 * DAY - 1)).toBe(2);
    expect(repo.getReadAndKeptCount(sender, 3 * DAY - 1, FIXED_NOW_SEC - 3 * DAY)).toBe(1); // since window
    expect(repo.getReadAndKeptCount('nobody@x.example')).toBe(0);
  });

  // Directionality answers "who initiates". Mail must only count when the
  // counterpart is actually on the To line, so unrelated mail from the same
  // sender to someone else never inflates the relationship.
  it('splits inbound vs outbound mail and averages the user\'s reply time', () => {
    const sender = 'client@corp.example';
    const user = 'me@mine.example';
    seedEmail(db, { id: 'd1', from: sender, to: user, date: FIXED_NOW_SEC - 500 });
    seedEmail(db, { id: 'd2', from: sender, to: `Team <${user}>`, date: FIXED_NOW_SEC - 400 });
    seedEmail(db, { id: 'd3', from: user, to: sender, date: FIXED_NOW_SEC - 300 });
    seedEmail(db, { id: 'd4', from: sender, to: 'someone-else@x.example', date: FIXED_NOW_SEC - 200 });
    seedEmail(db, { id: 'd5', from: 'other@x.example', to: user, date: FIXED_NOW_SEC - 100 });

    seedAction(db, { id: 'dr1', emailId: 'd1', actionType: 'reply', sender, timestamp: FIXED_NOW_SEC - 400 });
    seedAction(db, { id: 'dr2', emailId: 'd2', actionType: 'reply_all', sender, timestamp: FIXED_NOW_SEC - 200 });

    expect(repo.getSenderDirectionality(sender, user)).toEqual({
      inbound: 2,
      outbound: 1,
      avgInboundReplyTimeSec: Math.round((100 + 200) / 2),
    });
  });

  it('reports zeroed directionality for a stranger', () => {
    expect(repo.getSenderDirectionality('nobody@x.example', 'me@mine.example')).toEqual({
      inbound: 0,
      outbound: 0,
      avgInboundReplyTimeSec: null,
    });
  });

  // Thread participation decides whether a reply is expected from the user.
  // userStarted must be exact (it flips "waiting on them" vs "waiting on us").
  it('summarises the user\'s role in a thread', () => {
    const user = 'me@mine.example';
    seedEmail(db, { id: 'tp1', threadId: 'th1', from: 'Them@corp.example', date: FIXED_NOW_SEC - 300 });
    seedEmail(db, { id: 'tp2', threadId: 'th1', from: user, date: FIXED_NOW_SEC - 200 });
    seedEmail(db, { id: 'tp3', threadId: 'th1', from: 'third@corp.example', date: FIXED_NOW_SEC - 100 });
    seedEmail(db, { id: 'tp4', threadId: 'th2', from: user, date: FIXED_NOW_SEC - 50 });

    expect(repo.getThreadParticipation('th1', 'ME@MINE.EXAMPLE')).toEqual({
      participantCount: 3,
      userMessageCount: 1,
      totalMessages: 3,
      userStarted: false,
      lastActivityAt: FIXED_NOW_SEC - 100,
    });
    expect(repo.getThreadParticipation('th2', user).userStarted).toBe(true);
  });

  it('returns an empty participation summary for an unknown thread', () => {
    expect(repo.getThreadParticipation('ghost', 'me@mine.example')).toEqual({
      participantCount: 0,
      userMessageCount: 0,
      totalMessages: 0,
      userStarted: false,
      lastActivityAt: 0,
    });
  });

  // Burst detection escalates a sender who mails 3+ times in an hour. The
  // window is inclusive on both ends and must never count future-dated mail.
  it('counts a sender burst inside an inclusive window and ignores future mail', () => {
    const sender = 'urgent@corp.example';
    seedEmail(db, { id: 'br1', from: sender, date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'br2', from: 'URGENT@CORP.EXAMPLE', date: FIXED_NOW_SEC - 1800 });
    seedEmail(db, { id: 'br3', from: sender, date: FIXED_NOW_SEC - 3600 }); // exactly on the edge
    seedEmail(db, { id: 'br4', from: sender, date: FIXED_NOW_SEC - 3601 }); // just outside
    seedEmail(db, { id: 'br5', from: sender, date: FIXED_NOW_SEC + 10 }); // clock-skewed future mail

    expect(repo.getSenderBurstCount(sender)).toBe(3);
    expect(repo.getSenderBurstCount(sender, 3601)).toBe(4);
    expect(repo.getSenderBurstCount('quiet@x.example')).toBe(0);
  });

  // A routine sender (nightly report) must be recognised so it never triggers
  // "unusual activity". Under 5 samples there is not enough evidence to claim
  // a routine at all.
  it('detects a routine send hour and refuses to guess below five samples', () => {
    const sender = 'reports@corp.example';
    const slot = dayStart(FIXED_NOW_SEC) + 6 * 3600;
    for (let index = 0; index < 4; index += 1) {
      seedEmail(db, { id: `rt${index}`, from: sender, date: slot - index * DAY });
    }
    expect(repo.getSenderRoutinePattern(sender)).toEqual({ isRoutine: false, avgHour: null });

    for (let index = 4; index < 7; index += 1) {
      seedEmail(db, { id: `rt${index}`, from: sender, date: slot - index * DAY });
    }
    expect(repo.getSenderRoutinePattern('REPORTS@CORP.EXAMPLE')).toEqual({
      isRoutine: true,
      avgHour: localHour(db, slot),
    });
  });

  it('reports a scattered sender as not routine', () => {
    const sender = 'human@corp.example';
    const base = dayStart(FIXED_NOW_SEC);
    const offsets = [0, 6, 12, 18, 23, 9];
    offsets.forEach((offset, index) => {
      seedEmail(db, { id: `sc${index}`, from: sender, date: base - index * DAY + offset * 3600 });
    });

    const hours = offsets.map((offset, index) => localHour(db, base - index * DAY + offset * 3600));
    const expectedAvg = Math.round(hours.reduce((sum, h) => sum + h, 0) / hours.length);
    expect(repo.getSenderRoutinePattern(sender)).toEqual({ isRoutine: false, avgHour: expectedAvg });
  });

  // Mail older than the 30-day window must not feed the routine model at all —
  // a sender who used to be nightly and stopped should read as "no data".
  it('ignores mail older than the 30-day routine window', () => {
    const sender = 'stale@corp.example';
    const slot = dayStart(FIXED_NOW_SEC) - 40 * DAY + 6 * 3600;
    for (let index = 0; index < 6; index += 1) {
      seedEmail(db, { id: `st${index}`, from: sender, date: slot - index * DAY });
    }
    expect(repo.getSenderRoutinePattern(sender)).toEqual({ isRoutine: false, avgHour: null });
  });

  // getSenderSignalData is the batched call the pipeline actually uses. Every
  // field must equal what the individual query returns, otherwise the batched
  // path and the dashboard disagree about the same sender.
  it('batches every sender signal consistently with the individual queries', () => {
    const sender = 'signal@corp.example';
    const user = 'me@mine.example';
    seedEmail(db, { id: 's1', from: sender, to: user, tags: '|INBOX|', date: FIXED_NOW_SEC - 10 * DAY });
    seedEmail(db, { id: 's2', from: sender, to: user, tags: '|INBOX|', date: FIXED_NOW_SEC - 9 * DAY });
    seedEmail(db, { id: 's3', from: user, to: sender, tags: '|Sent|', date: FIXED_NOW_SEC - 8 * DAY });
    seedEmail(db, { id: 's-old', from: sender, to: user, date: FIXED_NOW_SEC - 200 * DAY });

    seedAction(db, { id: 'sa1', emailId: 's1', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 10 * DAY + 60 });
    seedAction(db, { id: 'sa2', emailId: 's1', actionType: 'reply', sender, timestamp: FIXED_NOW_SEC - 10 * DAY + 120 });
    seedAction(db, { id: 'sa3', emailId: 's2', actionType: 'read', sender, timestamp: FIXED_NOW_SEC - 9 * DAY + 30 });
    seedAction(db, { id: 'sa4', emailId: 's2', actionType: 'archive', sender, timestamp: FIXED_NOW_SEC - DAY });
    seedAction(db, { id: 'sa5', emailId: 's2', actionType: 'reply_all', sender, timestamp: FIXED_NOW_SEC - 8 * DAY });

    const ninetyDaysAgo = FIXED_NOW_SEC - 90 * DAY;
    const signals = repo.getSenderSignalData(sender, user);
    const directionality = repo.getSenderDirectionality(sender, user);

    expect(signals).toEqual({
      readThenDeletedFast: repo.getReadThenDeletedFast(sender, 10, ninetyDaysAgo),
      readThenReplied: 2, // reply + reply_all inside the window
      readAndKept: repo.getReadAndKeptCount(sender, 259200, ninetyDaysAgo),
      readAndArchived: 1,
      unreadOld: 0,
      totalFromSender: 2, // s-old is outside the 90-day window
      replyCount: 2,
      avgReplyTimeSec: directionality.avgInboundReplyTimeSec,
      inbound: directionality.inbound,
      outbound: directionality.outbound,
      isRoutine: repo.getSenderRoutinePattern(sender).isRoutine,
      burstCount: repo.getSenderBurstCount(sender, 3600),
      lastInteractionAt: FIXED_NOW_SEC - DAY,
    });
  });

  it('returns null lastInteractionAt for a sender with no logged actions', () => {
    expect(repo.getSenderSignalData('nobody@x.example', 'me@mine.example')).toMatchObject({
      readThenDeletedFast: 0,
      readThenReplied: 0,
      readAndKept: 0,
      totalFromSender: 0,
      lastInteractionAt: null,
    });
  });
});

describe('AgentRepository — sender memory (writing style)', () => {
  let db: Database.Database;
  let repo: AgentRepository;
  const user = 'me@mine.example';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // The drafted reply copies the user's own greeting/closing/tone for THAT
  // person. Reading it from the wrong mail (inbound instead of sent) would make
  // the agent imitate the counterpart instead of the user.
  it('extracts greeting, closing and tone from the user\'s own sent mail', () => {
    seedEmail(db, {
      id: 'sm1',
      from: user,
      to: `Bob <bob@corp.example>`,
      tags: '|Sent|',
      date: FIXED_NOW_SEC,
      cleanBody: '<p>Dear Bob,</p>\nCould you sign the SOW?\nSincerely,\nMe',
    });

    expect(repo.buildSenderMemory('bob@corp.example', user)).toEqual({
      greeting: 'Dear Bob,', // HTML stripped before the first line is read
      closing: 'Sincerely,',
      tone: 'formal',
    });
  });

  // Mixed registers cancel out to 'brief' — pinned because a "Hi <name>," open
  // with a "Best regards," close counts as BOTH, and the drafter must then fall
  // back rather than guess.
  it('reports a mixed-register mail as brief', () => {
    seedEmail(db, {
      id: 'sm1b',
      from: user,
      to: 'bob@corp.example',
      tags: '|Sent|',
      date: FIXED_NOW_SEC,
      cleanBody: 'Hi Bob,\nCould you sign the SOW?\nBest regards,\nMe',
    });

    expect(repo.buildSenderMemory('bob@corp.example', user)).toEqual({
      greeting: 'Hi Bob,',
      closing: 'Best regards,',
      tone: 'brief',
    });
  });

  it('reads casual tone and tolerates mail with no greeting or closing', () => {
    seedEmail(db, {
      id: 'sm2',
      from: user,
      to: 'pal@corp.example',
      tags: '|[Gmail]/Sent Mail|',
      date: FIXED_NOW_SEC,
      cleanBody: 'yo, lol that demo!\nhaha',
    });

    expect(repo.buildSenderMemory('pal@corp.example', user)).toEqual({
      greeting: null,
      closing: null,
      tone: 'casual',
    });
  });

  it('falls back to a "brief" tone when neither register dominates', () => {
    seedEmail(db, {
      id: 'sm3',
      from: user,
      to: 'terse@corp.example',
      tags: '|Sent Items|',
      date: FIXED_NOW_SEC,
      cleanBody: 'Done.',
    });

    expect(repo.buildSenderMemory('terse@corp.example', user)).toEqual({
      greeting: null,
      closing: null,
      tone: 'brief',
    });
  });

  // No sent history → all-null memory, so the drafter falls back to defaults
  // instead of inventing a style. Blank bodies must not crash the extractor.
  it('returns an empty memory when there is no sent history (and skips blank bodies)', () => {
    expect(repo.buildSenderMemory('stranger@corp.example', user)).toEqual({
      greeting: null,
      closing: null,
      tone: null,
    });

    seedEmail(db, {
      id: 'sm4',
      from: user,
      to: 'blank@corp.example',
      tags: '|Sent|',
      date: FIXED_NOW_SEC,
      cleanBody: '   ',
    });
    seedEmail(db, {
      id: 'sm5',
      from: user,
      to: 'blank@corp.example',
      tags: '|Sent|',
      date: FIXED_NOW_SEC - 10,
      cleanBody: '<div></div>',
    });
    expect(repo.buildSenderMemory('blank@corp.example', user)).toEqual({
      greeting: null,
      closing: null,
      tone: 'brief',
    });
  });

  // Inbound mail from the same person must be ignored: only |Sent|-tagged mail
  // is the user's own writing.
  it('ignores inbound mail when building memory', () => {
    seedEmail(db, {
      id: 'sm6',
      from: 'bob@corp.example',
      to: user,
      tags: '|INBOX|',
      date: FIXED_NOW_SEC,
      cleanBody: 'Dear Me,\nPlease advise.\nSincerely,\nBob',
    });

    expect(repo.buildSenderMemory('bob@corp.example', user)).toEqual({
      greeting: null,
      closing: null,
      tone: null,
    });
  });

  // Memory is persisted onto sender_stats. key_context must survive a later
  // memory refresh that does not carry one (COALESCE), else the user's manual
  // context note is wiped by the next automatic pass.
  it('persists memory onto sender_stats and preserves an existing key_context', () => {
    seedSenderStats(db, { email: 'bob@corp.example', keyContext: 'signed 3-year deal' });

    repo.saveSenderMemory('BOB@CORP.EXAMPLE', { greeting: 'Hi Bob,', closing: 'Best,', tone: 'formal' });

    const row = db
      .prepare(
        `SELECT greeting, closing, tone, key_context AS keyContext, memory_updated_at AS updatedAt
         FROM sender_stats WHERE email = 'bob@corp.example'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      greeting: 'Hi Bob,',
      closing: 'Best,',
      tone: 'formal',
      keyContext: 'signed 3-year deal',
      updatedAt: FIXED_NOW_SEC,
    });

    repo.saveSenderMemory('bob@corp.example', {
      greeting: null,
      closing: null,
      tone: 'casual',
      keyContext: 'renewal due',
    });
    expect(
      (db.prepare("SELECT key_context AS k FROM sender_stats WHERE email = 'bob@corp.example'").get() as { k: string }).k,
    ).toBe('renewal due');
  });

  // saveSenderMemory is UPDATE-only: with no sender_stats row it writes nothing
  // (pinned so a future INSERT-or-update is a deliberate change).
  it('writes nothing when the sender has no sender_stats row', () => {
    expect(() =>
      repo.saveSenderMemory('ghost@corp.example', { greeting: 'Hi', closing: null, tone: 'brief' }),
    ).not.toThrow();
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM sender_stats').get() as { c: number }).c,
    ).toBe(0);
  });

  // The bulk build only visits contacts the user has actually written to or
  // replied to; anyone else is not worth an LLM-facing style profile.
  it('builds memories only for contacts with sent/replied history', () => {
    seedSenderStats(db, { email: 'bob@corp.example', sentToCount: 4 });
    seedSenderStats(db, { email: 'carol@corp.example', repliedCount: 2 });
    seedSenderStats(db, { email: 'dave@corp.example' }); // never written to
    // Written to, but no sent mail survives in the DB → no memory to save, so
    // the contact must be skipped instead of stamped with an empty style.
    seedSenderStats(db, { email: 'erin@corp.example', sentToCount: 2 });

    seedEmail(db, {
      id: 'bm1',
      from: user,
      to: 'bob@corp.example',
      tags: '|Sent|',
      date: FIXED_NOW_SEC,
      cleanBody: 'Hi Bob,\nThanks,\nMe',
    });
    seedEmail(db, {
      id: 'bm2',
      from: user,
      to: 'carol@corp.example',
      tags: '|Sent|',
      date: FIXED_NOW_SEC,
      cleanBody: 'Hey Carol,\nCheers,\nMe',
    });

    expect(repo.buildAllSenderMemories(user)).toBe(2);
    const stored = db
      .prepare('SELECT email, greeting FROM sender_stats WHERE greeting IS NOT NULL ORDER BY email')
      .all() as { email: string; greeting: string }[];
    expect(stored).toEqual([
      { email: 'bob@corp.example', greeting: 'Hi Bob,' },
      { email: 'carol@corp.example', greeting: 'Hey Carol,' },
    ]);
  });

  it('builds nothing when no contact has sent history', () => {
    seedSenderStats(db, { email: 'dave@corp.example' });
    expect(repo.buildAllSenderMemories(user)).toBe(0);
  });
});

describe('AgentRepository — category/action correlation', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
    // The migrations SEED the built-in AI categories. Clearing them keeps these
    // assertions about exactly the categories the test defines.
    db.prepare('DELETE FROM ai_category_definitions').run();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // "80% of needs_response mail gets a reply" is what unlocks auto-actions.
  // Passive actions (open/unread/unstar/unimportant) must be excluded from the
  // learned actions — they are not decisions — while the denominator stays the
  // full action count for that category.
  it('rates each real action against all actions on the category', () => {
    seedCategory(db, { slug: 'needs_response', name: 'Needs response' });
    seedEmail(db, { id: 'cc1', tags: '|INBOX|needs_response|' });
    seedEmail(db, { id: 'cc2', tags: '|INBOX|needs_response|' });
    seedEmail(db, { id: 'cc3', tags: '|INBOX|newsletter|' });

    seedAction(db, { id: 'ca1', emailId: 'cc1', actionType: 'reply', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'ca2', emailId: 'cc2', actionType: 'reply', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'ca3', emailId: 'cc2', actionType: 'archive', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'ca4', emailId: 'cc2', actionType: 'open', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'ca5', emailId: 'cc3', actionType: 'delete', timestamp: FIXED_NOW_SEC });

    // 4 actions carry the tag; 'open' is not reported but still counts in the rate.
    expect(repo.getCategoryActionCorrelation('needs_response')).toEqual([
      { action: 'reply', count: 2, rate: 0.5 },
      { action: 'archive', count: 1, rate: 0.25 },
    ]);
    expect(repo.getCategoryActionCorrelation('unknown_category')).toEqual([]);
  });

  // The tag match is an exact |slug| substring, so a slug that is a prefix of
  // another must not borrow its actions.
  it('matches the category tag exactly, not as a prefix', () => {
    seedEmail(db, { id: 'cx1', tags: '|INBOX|newsletter_promo|' });
    seedAction(db, { id: 'cy1', emailId: 'cx1', actionType: 'delete', timestamp: FIXED_NOW_SEC });

    expect(repo.getCategoryActionCorrelation('newsletter')).toEqual([]);
    expect(repo.getCategoryActionCorrelation('newsletter_promo')).toEqual([
      { action: 'delete', count: 1, rate: 1 },
    ]);
  });

  // A hostile category slug is bound as a parameter and concatenated inside
  // instr(), so it can never break out into SQL.
  it('treats a hostile category slug as literal text', () => {
    seedEmail(db, { id: 'cz1', tags: '|INBOX|promo|' });
    seedAction(db, { id: 'cz-a', emailId: 'cz1', actionType: 'delete', timestamp: FIXED_NOW_SEC });

    expect(repo.getCategoryActionCorrelation("');DROP TABLE user_action_log;--")).toEqual([]);
    expect(repo.getCategoryActionCorrelation('%')).toEqual([]); // no wildcard semantics in instr()
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM user_action_log').get() as { c: number }).c,
    ).toBe(1);
  });

  // Only enabled categories with a strong enough dominant action are surfaced;
  // a weak signal must not be promoted into an auto-action hint.
  it('surfaces only enabled categories whose dominant action clears 0.3', () => {
    seedCategory(db, { slug: 'strong' });
    seedCategory(db, { slug: 'weak' });
    seedCategory(db, { slug: 'disabled', enabled: 0 });

    seedEmail(db, { id: 'gc1', tags: '|INBOX|strong|' });
    seedAction(db, { id: 'gs1', emailId: 'gc1', actionType: 'reply', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'gs2', emailId: 'gc1', actionType: 'reply', timestamp: FIXED_NOW_SEC + 1 });

    seedEmail(db, { id: 'gc2', tags: '|INBOX|weak|' });
    seedAction(db, { id: 'gw1', emailId: 'gc2', actionType: 'archive', timestamp: FIXED_NOW_SEC });
    for (let index = 0; index < 4; index += 1) {
      seedAction(db, { id: `gw-o${index}`, emailId: 'gc2', actionType: 'open', timestamp: FIXED_NOW_SEC });
    }

    seedEmail(db, { id: 'gc3', tags: '|INBOX|disabled|' });
    seedAction(db, { id: 'gd1', emailId: 'gc3', actionType: 'delete', timestamp: FIXED_NOW_SEC });

    expect(repo.getAllCategoryCorrelations()).toEqual({
      strong: { action: 'reply', rate: 1 },
    });
  });

  it('returns no correlations when no categories are defined', () => {
    expect(repo.getAllCategoryCorrelations()).toEqual({});
  });

  // Readiness is what the UI explains to the user ("Newsletters: 3 actions, too
  // few to lock in"). A category must NOT be ready on a tiny sample even at a
  // perfect rate, and the reported totals must match the seeded actions.
  it('reports per-category readiness with the minimum-sample guard', () => {
    seedCategory(db, { slug: 'ready', name: 'Ready' });
    seedCategory(db, { slug: 'tiny', name: '' });
    seedCategory(db, { slug: 'quiet', name: 'Quiet' });
    seedCategory(db, { slug: 'off', enabled: 0 });

    seedEmail(db, { id: 'rc1', tags: '|INBOX|ready|' });
    for (let index = 0; index < 5; index += 1) {
      seedAction(db, { id: `rr${index}`, emailId: 'rc1', actionType: 'archive', timestamp: FIXED_NOW_SEC + index });
    }
    seedEmail(db, { id: 'rc2', tags: '|INBOX|tiny|' });
    for (let index = 0; index < 3; index += 1) {
      seedAction(db, { id: `rt${index}`, emailId: 'rc2', actionType: 'delete', timestamp: FIXED_NOW_SEC + index });
    }

    expect(repo.getCategoryReadiness()).toEqual([
      { slug: 'quiet', name: 'Quiet', totalActions: 0, dominantAction: null, rate: 0, ready: false },
      { slug: 'ready', name: 'Ready', totalActions: 5, dominantAction: 'archive', rate: 1, ready: true },
      // Empty names fall back to the slug so the UI never renders a blank row.
      { slug: 'tiny', name: 'tiny', totalActions: 3, dominantAction: 'delete', rate: 1, ready: false },
    ]);

    // A stricter threshold than the observed rate keeps the category unready.
    expect(repo.getCategoryReadiness(1.01).every((c) => !c.ready)).toBe(true);
  });
});

describe('AgentRepository — historical backfill', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // Bootstrapping the behaviour model from existing mail is what makes the
  // agent useful on day one. Each state (read / starred / trashed / spam /
  // sent-reply / archived) must map to exactly one action, and re-running must
  // add only NEW history — a second run that duplicated every row would double
  // every learned rate.
  it('derives one action per observed email state and is idempotent', () => {
    seedEmail(db, { id: 'h-read', tags: '|INBOX|read|', from: 'A@corp.example', date: FIXED_NOW_SEC - 10 });
    seedEmail(db, { id: 'h-star', tags: '|INBOX|starred|', from: 'b@corp.example', date: FIXED_NOW_SEC - 9 });
    seedEmail(db, { id: 'h-trash', tags: '|Trash|', from: 'c@corp.example', date: FIXED_NOW_SEC - 8 });
    seedEmail(db, { id: 'h-deleted-items', tags: '|Deleted Items|', from: 'c@corp.example', date: FIXED_NOW_SEC - 7 });
    seedEmail(db, { id: 'h-spam', tags: '|Junk Email|', from: 'd@corp.example', date: FIXED_NOW_SEC - 6 });
    seedEmail(db, {
      id: 'h-sent',
      tags: '|Sent|',
      from: 'me@mine.example',
      to: 'Bob <BOB@corp.example>, other@corp.example',
      inReplyTo: '<parent>',
      date: FIXED_NOW_SEC - 5,
    });
    seedEmail(db, { id: 'h-archive', tags: '|Archive|', from: 'e@corp.example', date: FIXED_NOW_SEC - 4 });
    seedEmail(db, { id: 'h-sent-no-reply', tags: '|Sent|', from: 'me@mine.example', to: 'x@corp.example', date: FIXED_NOW_SEC - 3 });

    const result = repo.backfillFromHistory();
    expect(result.totalEmails).toBe(8);
    expect(result.actionsCreated).toBe(7); // the non-reply sent mail contributes nothing
    expect(result.sendersProcessed).toBe(6); // a@, b@, c@ (twice), d@, bob@, e@

    const rows = db
      .prepare("SELECT id, action_type AS type, sender_address AS sender FROM user_action_log ORDER BY id")
      .all() as { id: string; type: string; sender: string }[];
    expect(rows).toEqual([
      { id: 'hist-a-h-archive', type: 'archive', sender: 'e@corp.example' },
      { id: 'hist-d-h-deleted-items', type: 'delete', sender: 'c@corp.example' },
      { id: 'hist-d-h-trash', type: 'delete', sender: 'c@corp.example' },
      { id: 'hist-r-h-read', type: 'read', sender: 'a@corp.example' }, // lower-cased
      { id: 'hist-rp-h-sent', type: 'reply', sender: 'bob@corp.example' }, // first recipient
      { id: 'hist-s-h-star', type: 'star', sender: 'b@corp.example' },
      { id: 'hist-sp-h-spam', type: 'spam', sender: 'd@corp.example' },
    ]);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM user_action_log WHERE source = 'history'").get() as { c: number }).c,
    ).toBe(7);

    // Second pass: nothing new, no duplicates (deterministic ids + OR IGNORE).
    const again = repo.backfillFromHistory();
    expect(again.actionsCreated).toBe(0);
    expect(again.sendersProcessed).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM user_action_log').get() as { c: number }).c,
    ).toBe(7);
  });

  // Re-running after MORE folders have synced must backfill the newly visible
  // history — the bug this guards is an early-exit that left INBOX-only users
  // with an all-'read', zero-reply training set forever.
  it('backfills newly synced folders on a later run', () => {
    seedEmail(db, { id: 'i-read', tags: '|INBOX|read|', from: 'a@corp.example', date: FIXED_NOW_SEC });
    expect(repo.backfillFromHistory().actionsCreated).toBe(1);
    expect(repo.isBackfilled()).toBe(true);

    seedEmail(db, { id: 'i-trash', tags: '|Trash|', from: 'z@corp.example', date: FIXED_NOW_SEC });
    expect(repo.backfillFromHistory().actionsCreated).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM user_action_log').get() as { c: number }).c,
    ).toBe(2);
  });

  // Archive detection must not steal mail that is still in the inbox, in
  // spam/trash, or in Sent — otherwise "archive" becomes the dominant learned
  // action for every sender in Gmail's All Mail.
  it('only counts archived mail that left the inbox and is not spam/trash/sent', () => {
    seedEmail(db, { id: 'j1', tags: '|[Gmail]/All Mail|INBOX|', from: 'a@corp.example', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'j2', tags: '|[Gmail]/All Mail|[Gmail]/Trash|', from: 'b@corp.example', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'j3', tags: '|[Gmail]/All Mail|[Gmail]/Sent Mail|', from: 'c@corp.example', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'j4', tags: '|[Gmail]/All Mail|', from: 'd@corp.example', date: FIXED_NOW_SEC });

    repo.backfillFromHistory();
    const archived = db
      .prepare("SELECT email_id AS id FROM user_action_log WHERE action_type = 'archive'")
      .all() as { id: string }[];
    expect(archived.map((r) => r.id)).toEqual(['j4']);
  });

  it('reports not-backfilled on a fresh database', () => {
    expect(repo.isBackfilled()).toBe(false);
    expect(repo.backfillFromHistory()).toEqual({ totalEmails: 0, actionsCreated: 0, sendersProcessed: 0 });
    expect(repo.isBackfilled()).toBe(false);
  });

  // The learning summary is the "how much does it know" panel; history and live
  // counts must split exactly, since a wrong split hides that nothing live has
  // been recorded yet.
  it('splits the learning summary into history vs live and ranks top actions', () => {
    seedEmail(db, { id: 'k-read', tags: '|INBOX|read|', from: 'a@corp.example', date: FIXED_NOW_SEC });
    repo.backfillFromHistory();
    seedAction(db, { id: 'live1', actionType: 'read', sender: 'a@corp.example', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'live2', actionType: 'delete', sender: 'b@corp.example', timestamp: FIXED_NOW_SEC });
    seedAction(db, { id: 'live3', actionType: 'read', sender: null, timestamp: FIXED_NOW_SEC });

    expect(repo.getLearningSummary()).toEqual({
      totalActions: 4,
      fromHistory: 1,
      fromLive: 3,
      uniqueSenders: 2, // NULL senders excluded
      topActions: [
        { action: 'read', count: 3 },
        { action: 'delete', count: 1 },
      ],
    });
  });

  it('reports an empty learning summary before anything is logged', () => {
    expect(repo.getLearningSummary()).toEqual({
      totalActions: 0,
      fromHistory: 0,
      fromLive: 0,
      uniqueSenders: 0,
      topActions: [],
    });
  });
});

describe('AgentRepository — contact classification', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // A manual classification must land on BOTH contacts and sender_stats — the
  // two are read by different screens, and a one-sided write makes the type
  // appear to revert.
  it('writes an explicit contact type to contacts and sender_stats', () => {
    seedContact(db, { email: 'bob@corp.example' });
    seedSenderStats(db, { email: 'bob@corp.example' });

    repo.setContactType('BOB@CORP.EXAMPLE', 'vendor', 0.77, 'user');

    expect(
      db.prepare("SELECT contact_type AS t, contact_type_confidence AS c, contact_type_source AS s FROM contacts WHERE email = 'bob@corp.example'").get(),
    ).toEqual({ t: 'vendor', c: 0.77, s: 'user' });
    expect(
      db.prepare("SELECT contact_type AS t FROM sender_stats WHERE email = 'bob@corp.example'").get(),
    ).toEqual({ t: 'vendor' });
  });

  it('silently ignores a contact type set on an unknown address', () => {
    expect(() => repo.setContactType('ghost@corp.example', 'vendor', 1, 'user')).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }).c).toBe(0);
  });

  // The rule pass is ordered, and the order is the behaviour: same-domain →
  // colleague, no-reply → automated, then the volume-based behaviour rules.
  // Only 'unknown' contacts are ever touched, so a user's manual choice is
  // never overwritten.
  it('classifies contacts by rule and never overwrites an explicit type', () => {
    seedContact(db, { email: 'teammate@mine.example', receivedCount: 3, sentCount: 3 });
    seedContact(db, { email: 'noreply@bank.example', receivedCount: 20 });
    seedContact(db, { email: 'no-reply@shop.example' });
    seedContact(db, { email: 'notifications@social.example' });
    seedContact(db, { email: 'news@letters.example', receivedCount: 12, sentCount: 0 });
    seedContact(db, { email: 'lead@prospect.example', receivedCount: 2, sentCount: 1 });
    seedContact(db, { email: 'customer@client.example', receivedCount: 9, sentCount: 4 });
    seedContact(db, { email: 'boundary@client.example', receivedCount: 5, sentCount: 3 });
    seedContact(db, { email: 'friend@gmail.example', contactType: 'personal', receivedCount: 30 });
    seedSenderStats(db, { email: 'news@letters.example' });

    const classified = repo.autoClassifyContacts('me@mine.example');

    const byEmail = Object.fromEntries(
      (db.prepare('SELECT email, contact_type AS type FROM contacts').all() as { email: string; type: string }[])
        .map((r) => [r.email, r.type]),
    );
    expect(byEmail).toEqual({
      'teammate@mine.example': 'colleague',
      'noreply@bank.example': 'automated',
      'no-reply@shop.example': 'automated',
      'notifications@social.example': 'automated',
      'news@letters.example': 'newsletter',
      'lead@prospect.example': 'potential_customer',
      'customer@client.example': 'existing_customer',
      // received_count 5 satisfies the potential_customer range first — the
      // rules are applied in order, so this one never reaches rule 5.
      'boundary@client.example': 'potential_customer',
      'friend@gmail.example': 'personal', // untouched: not 'unknown'
    });
    expect(classified).toBe(8);
    // The classification is mirrored onto sender_stats for the sender screens.
    expect(
      db.prepare("SELECT contact_type AS t FROM sender_stats WHERE email = 'news@letters.example'").get(),
    ).toEqual({ t: 'newsletter' });
  });

  // A user on a public domain must NOT have every gmail.com sender classified
  // as a "colleague" — that would silently mark strangers as internal.
  it('skips the same-domain colleague rule for public mail domains', () => {
    seedContact(db, { email: 'stranger@gmail.com', receivedCount: 1, sentCount: 0 });
    seedContact(db, { email: 'work@corp.example', receivedCount: 12, sentCount: 0 });

    repo.autoClassifyContacts('me@gmail.com');

    const byEmail = Object.fromEntries(
      (db.prepare('SELECT email, contact_type AS type FROM contacts').all() as { email: string; type: string }[])
        .map((r) => [r.email, r.type]),
    );
    expect(byEmail['stranger@gmail.com']).toBe('unknown'); // excluded from every rule
    expect(byEmail['work@corp.example']).toBe('newsletter');
  });

  // A malformed user address (no domain) must not throw or classify everyone.
  it('survives a user address with no domain', () => {
    seedContact(db, { email: 'someone@corp.example', receivedCount: 12 });
    expect(repo.autoClassifyContacts('not-an-email')).toBe(1);
    expect(
      db.prepare("SELECT contact_type AS t FROM contacts WHERE email = 'someone@corp.example'").get(),
    ).toEqual({ t: 'newsletter' });
  });

  // A legacy row with a NULL contact_type must be reported as 'unknown' and
  // folded into the same bucket — a `null` key would render as a blank segment.
  it('counts contacts per type, folding NULL types into unknown', () => {
    seedContact(db, { email: 'a@x.example', contactType: 'colleague' });
    seedContact(db, { email: 'b@x.example', contactType: 'colleague' });
    seedContact(db, { email: 'c@x.example', contactType: 'newsletter' });
    // Legacy row written before the contact_type column had a default.
    db.prepare(
      `INSERT INTO contacts (id, email, first_seen, last_seen, contact_type)
       VALUES ('c-null', 'legacy@x.example', ?, ?, NULL)`,
    ).run(FIXED_NOW_SEC, FIXED_NOW_SEC);

    expect(repo.getContactTypeCounts()).toEqual({ colleague: 2, newsletter: 1, unknown: 1 });
    expect(Object.keys(repo.getContactTypeCounts())).toHaveLength(3);
  });

  it('returns no type counts for an empty contact list', () => {
    expect(repo.getContactTypeCounts()).toEqual({});
  });

  // The contacts list is paged and searchable. Every option alone, all
  // combined, and none at all — a leaking filter shows the wrong segment, and
  // overlapping pages duplicate rows in the UI.
  it('filters by type with optional search, and pages without overlap', () => {
    seedContact(db, {
      email: 'anna@client.example',
      name: 'Anna Smith',
      company: 'Client Co',
      contactType: 'existing_customer',
      lastSeen: FIXED_NOW_SEC,
      receivedCount: 5,
      sentCount: 2,
      threadCount: 3,
      isFavorite: 1,
      confidence: 0.65,
      source: 'behavior',
      lastInboundAt: FIXED_NOW_SEC - 60,
    });
    seedContact(db, {
      email: 'ben@client.example',
      name: 'Ben Jones',
      company: 'Client Co',
      contactType: 'existing_customer',
      lastSeen: FIXED_NOW_SEC - 100,
    });
    seedContact(db, {
      email: 'carl@other.example',
      name: 'Carl',
      company: 'Other Ltd',
      contactType: 'existing_customer',
      lastSeen: FIXED_NOW_SEC - 200,
    });
    seedContact(db, { email: 'dee@x.example', contactType: 'vendor', lastSeen: FIXED_NOW_SEC });

    // No options: type filter only, newest-seen first.
    expect(repo.getContactsByType('existing_customer').map((c) => c.email)).toEqual([
      'anna@client.example', 'ben@client.example', 'carl@other.example',
    ]);
    // Search matches the address…
    expect(repo.getContactsByType('existing_customer', { search: 'ben@' }).map((c) => c.email)).toEqual([
      'ben@client.example',
    ]);
    // …the name…
    expect(repo.getContactsByType('existing_customer', { search: 'Smith' }).map((c) => c.email)).toEqual([
      'anna@client.example',
    ]);
    // …and the company.
    expect(repo.getContactsByType('existing_customer', { search: 'Client Co' }).map((c) => c.email)).toEqual([
      'anna@client.example', 'ben@client.example',
    ]);
    // All options combined.
    const page1 = repo.getContactsByType('existing_customer', { search: 'Client Co', limit: 1, offset: 0 });
    const page2 = repo.getContactsByType('existing_customer', { search: 'Client Co', limit: 1, offset: 1 });
    expect(page1.map((c) => c.email)).toEqual(['anna@client.example']);
    expect(page2.map((c) => c.email)).toEqual(['ben@client.example']);
    expect(repo.getContactsByType('recruiter')).toEqual([]);

    // Full row mapping, including the boolean coercions the UI depends on.
    expect(page1[0]).toEqual({
      email: 'anna@client.example',
      name: 'Anna Smith',
      company: 'Client Co',
      contactType: 'existing_customer',
      contactTypeConfidence: 0.65,
      contactTypeSource: 'behavior',
      receivedCount: 5,
      sentCount: 2,
      lastInboundAt: FIXED_NOW_SEC - 60,
      lastOutboundAt: null,
      avgResponseTimeSec: null,
      threadCount: 3,
      needsResponse: false,
      isFavorite: true,
    });
  });

  // Defaults must fill in for a sparsely populated contact row, so the list
  // never renders "undefined" or NaN.
  it('defaults missing contact fields instead of leaking NULLs', () => {
    db.prepare(
      `INSERT INTO contacts (id, email, first_seen, last_seen, contact_type, contact_type_confidence,
         contact_type_source, received_count, sent_count, thread_count, needs_response, is_favorite)
       VALUES ('c-bare', 'bare@x.example', ?, ?, 'vendor', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    ).run(FIXED_NOW_SEC, FIXED_NOW_SEC);

    expect(repo.getContactsByType('vendor')[0]).toEqual({
      email: 'bare@x.example',
      name: null,
      company: null,
      contactType: 'vendor',
      contactTypeConfidence: 0,
      contactTypeSource: 'unset',
      receivedCount: 0,
      sentCount: 0,
      lastInboundAt: null,
      lastOutboundAt: null,
      avgResponseTimeSec: null,
      threadCount: 0,
      needsResponse: false,
      isFavorite: false,
    });
  });

  // The contact search term is user input: it must be bound as a literal so an
  // injection payload finds nothing and the table survives.
  it('binds a hostile contact search term as literal text', () => {
    seedContact(db, { email: 'anna@client.example', name: "O'Brien", contactType: 'vendor' });

    expect(repo.getContactsByType('vendor', { search: "O'Brien" }).map((c) => c.email)).toEqual([
      'anna@client.example',
    ]);
    expect(repo.getContactsByType('vendor', { search: "');DROP TABLE contacts;--" })).toEqual([]);
    expect(repo.getContactsByType('vendor', { search: "' OR 1=1 --" })).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }).c).toBe(1);
  });

  it('lists contacts awaiting a response, most recent inbound first', () => {
    seedContact(db, { email: 'a@x.example', needsResponse: 1, lastInboundAt: FIXED_NOW_SEC - 100, contactType: 'colleague' });
    seedContact(db, { email: 'b@x.example', needsResponse: 1, lastInboundAt: FIXED_NOW_SEC, contactType: 'colleague' });
    seedContact(db, { email: 'c@x.example', needsResponse: 0, lastInboundAt: FIXED_NOW_SEC, contactType: 'colleague' });

    // Legacy NULL type: the mapper must report 'unknown' rather than null, so
    // the row still renders in the waiting list.
    db.prepare(
      `INSERT INTO contacts (id, email, first_seen, last_seen, contact_type, needs_response, last_inbound_at)
       VALUES ('c-legacy', 'legacy@x.example', ?, ?, NULL, 1, ?)`,
    ).run(FIXED_NOW_SEC, FIXED_NOW_SEC, FIXED_NOW_SEC - 200);

    expect(repo.getContactsNeedingResponse().map((c) => c.email)).toEqual([
      'b@x.example', 'a@x.example', 'legacy@x.example',
    ]);
    expect(repo.getContactsNeedingResponse(1).map((c) => c.email)).toEqual(['b@x.example']);
    expect(repo.getContactsNeedingResponse().every((c) => c.needsResponse)).toBe(true);
    expect(repo.getContactsNeedingResponse().at(-1)?.contactType).toBe('unknown');
  });

  // Waiting-on-you list: unread, recent, not in a junk/sent folder, and NOT an
  // automated sender. Priority ordering puts customers above strangers so the
  // most costly-to-ignore mail is on top.
  it('ranks waiting user actions by contact importance then recency', () => {
    const contacts: Array<[string, ContactType]> = [
      ['cust@client.example', 'existing_customer'],
      ['lead@prospect.example', 'potential_customer'],
      ['mate@mine.example', 'colleague'],
      ['vendor@supply.example', 'vendor'],
      ['friend@home.example', 'personal'],
      ['robot@service.example', 'automated'],
      ['promo@shop.example', 'newsletter'],
    ];
    for (const [email, contactType] of contacts) seedContact(db, { email, contactType });

    seedEmail(db, { id: 'w-cust', from: 'cust@client.example', subject: 'Renewal', date: FIXED_NOW_SEC - 600 });
    seedEmail(db, { id: 'w-lead', from: 'lead@prospect.example', date: FIXED_NOW_SEC - 500 });
    seedEmail(db, { id: 'w-mate', from: 'mate@mine.example', date: FIXED_NOW_SEC - 400 });
    seedEmail(db, { id: 'w-vendor', from: 'vendor@supply.example', date: FIXED_NOW_SEC - 300 });
    seedEmail(db, { id: 'w-friend', from: 'friend@home.example', date: FIXED_NOW_SEC - 200 });
    seedEmail(db, { id: 'w-unknown-new', from: 'stranger@x.example', subject: null, date: FIXED_NOW_SEC - 100 });
    seedEmail(db, { id: 'w-unknown-old', from: 'stranger@x.example', date: FIXED_NOW_SEC - 150 });
    seedEmail(db, { id: 'w-robot', from: 'robot@service.example', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-promo', from: 'promo@shop.example', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-read', from: 'cust@client.example', tags: '|INBOX|read|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-trash', from: 'cust@client.example', tags: '|Trash|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-spam', from: 'cust@client.example', tags: '|Spam|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-gtrash', from: 'cust@client.example', tags: '|[Gmail]/Trash|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-gspam', from: 'cust@client.example', tags: '|[Gmail]/Spam|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-draft', from: 'cust@client.example', tags: '|Drafts|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-sent', from: 'cust@client.example', tags: '|Sent|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-gsent', from: 'cust@client.example', tags: '|[Gmail]/Sent Mail|', date: FIXED_NOW_SEC });
    seedEmail(db, { id: 'w-stale', from: 'cust@client.example', date: FIXED_NOW_SEC - 8 * DAY });

    const waiting = repo.getWaitingUserActions();
    expect(waiting.map((w) => w.emailId)).toEqual([
      'w-cust', 'w-lead', 'w-mate', 'w-vendor', 'w-friend', 'w-unknown-new', 'w-unknown-old',
    ]);
    expect(waiting[0]).toEqual({
      emailId: 'w-cust',
      subject: 'Renewal',
      fromAddress: 'cust@client.example',
      fromName: null,
      contactType: 'existing_customer',
      receivedAt: FIXED_NOW_SEC - 600,
      waitingSeconds: 600,
    });
    // Unknown senders fall back to 'unknown' and a missing subject is labelled.
    expect(waiting[5]).toMatchObject({ contactType: 'unknown', subject: '(No subject)' });
    expect(repo.getWaitingUserActions(2).map((w) => w.emailId)).toEqual(['w-cust', 'w-lead']);
  });
});

describe('AgentRepository — refreshNeedsResponse (SQL wall-clock window)', () => {
  let db: Database.Database;
  let repo: AgentRepository;
  // This is the one query whose window comes from SQLite's own strftime('now'),
  // which fake timers cannot move — so it runs on the real clock with RELATIVE
  // offsets (still deterministic: nothing depends on the absolute date).
  const nowSec = (): number => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
  });

  // "Needs response" is the badge the user acts on. A contact read recently and
  // not yet replied to must be flagged; one we have since replied to must be
  // cleared; and automated/newsletter senders must never be flagged at all.
  it('flags unanswered recent senders and clears the ones already replied to', () => {
    const now = nowSec();
    seedContact(db, { email: 'unanswered@client.example', contactType: 'existing_customer' });
    seedContact(db, { email: 'answered@client.example', contactType: 'colleague', needsResponse: 1 });
    seedContact(db, { email: 'robot@service.example', contactType: 'automated' });
    seedContact(db, { email: 'promo@shop.example', contactType: 'newsletter' });
    seedContact(db, { email: 'stale@client.example', contactType: 'colleague' });

    seedAction(db, { id: 'n1', actionType: 'read', sender: 'unanswered@client.example', timestamp: now - 3600 });
    seedAction(db, { id: 'n2', actionType: 'read', sender: 'answered@client.example', timestamp: now - 7200 });
    seedAction(db, { id: 'n3', actionType: 'reply', sender: 'answered@client.example', timestamp: now - 60 });
    seedAction(db, { id: 'n4', actionType: 'read', sender: 'robot@service.example', timestamp: now - 3600 });
    seedAction(db, { id: 'n5', actionType: 'read', sender: 'promo@shop.example', timestamp: now - 3600 });
    seedAction(db, { id: 'n6', actionType: 'read', sender: 'stale@client.example', timestamp: now - 30 * DAY });

    const flagged = repo.refreshNeedsResponse();
    expect(flagged).toBe(1); // only the unanswered contact matched

    const state = Object.fromEntries(
      (db.prepare('SELECT email, needs_response AS flag, last_inbound_at AS inbound FROM contacts').all() as {
        email: string; flag: number; inbound: number | null;
      }[]).map((r) => [r.email, r]),
    );
    expect(state['unanswered@client.example']).toMatchObject({ flag: 1, inbound: now - 3600 });
    expect(state['answered@client.example'].flag).toBe(0); // cleared by the reply
    expect(state['robot@service.example'].flag).toBe(0);
    expect(state['promo@shop.example'].flag).toBe(0);
    expect(state['stale@client.example'].flag).toBe(0); // outside the 7-day window
  });

  it('changes nothing when there are no contacts or actions', () => {
    expect(repo.refreshNeedsResponse()).toBe(0);
  });
});
