import type { AgentDecision, PipelineEventLog, SenderDailyMetrics, UserActionLog } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRepository } from '../../../src/repositories/agent-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';



// AgentRepository owns the WRITE side of every learning table (user_action_log,
// agent_decisions, sender_daily_metrics, pipeline_event_log, contact_notes).
// These rows are the only training data the agent ever has: a dropped field, a
// duplicated upsert or a batch that half-committed silently corrupts the
// behaviour model, and nothing in the UI ever surfaces it. This file pins the
// round-trips, the transactional guarantees and the incremental counters.
//
// Time is frozen everywhere: the repository stamps `resolved_at` / `updated_at`
// from Date.now() and derives day buckets + rolling windows from it, so a real
// clock would make these assertions flaky at day boundaries.
const FIXED_NOW_SEC = 1780315200; // 2026-06-15T12:00:00Z
const DAY = 86400;
const dayStart = (ts: number): number => Math.floor(ts / DAY) * DAY;

function newRepo(): { db: Database.Database; repo: AgentRepository } {
  const db = newMigratedDb();
  return { db, repo: new AgentRepository(() => db) };
}

/** Hour-of-day exactly as the repository's SQL computes it (TZ-independent). */
function localHour(db: Database.Database, ts: number): number {
  return (
    db
      .prepare("SELECT CAST(strftime('%H', ?, 'unixepoch', 'localtime') AS INTEGER) AS h")
      .get(ts) as { h: number }
  ).h;
}

function action(overrides: Partial<UserActionLog> & { id: string }): UserActionLog {
  return {
    emailId: `email-${overrides.id}`,
    threadId: null,
    actionType: 'read',
    actionValue: null,
    source: 'user',
    senderAddress: null,
    timestamp: FIXED_NOW_SEC,
    createdAt: FIXED_NOW_SEC,
    ...overrides,
  } as UserActionLog;
}

function decision(overrides: Partial<AgentDecision> & { id: string }): AgentDecision {
  return {
    emailId: `email-${overrides.id}`,
    threadId: null,
    senderAddress: null,
    proposedAction: 'archive',
    proposedValue: null,
    confidence: 0.5,
    reasoning: '',
    status: 'pending',
    actualAction: null,
    userFeedback: null,
    proposedAt: FIXED_NOW_SEC,
    resolvedAt: null,
    createdAt: FIXED_NOW_SEC,
    ...overrides,
  } as AgentDecision;
}

function event(overrides: Partial<PipelineEventLog> & { id: string }): PipelineEventLog {
  return {
    eventType: 'pipeline1.done',
    emailId: null,
    threadId: null,
    data: null,
    timestamp: FIXED_NOW_SEC,
    createdAt: FIXED_NOW_SEC,
    ...overrides,
  } as PipelineEventLog;
}

const countRows = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

/**
 * user_action_log.email_id and agent_decisions.email_id are real foreign keys
 * and production runs with `foreign_keys = ON`, so the parent email (and its
 * folder/thread parents) must exist. Seeding it is what proves the writes are
 * legal against the REAL schema, not just against the columns we happen to name.
 */
function seedEmail(db: Database.Database, emailId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO folders (id, name, path) VALUES ('f-inbox', 'INBOX', 'INBOX')`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES ('t-seed', 's', '<a>', '<a>', ?)`,
  ).run(FIXED_NOW_SEC);
  db.prepare(
    `INSERT OR IGNORE INTO emails (
       id, message_id, thread_id, folder_id, tags, subject, from_address,
       date, clean_body, raw_body, content_type, content_hash
     ) VALUES (?, ?, 't-seed', 'f-inbox', '|INBOX|', 'subject', 'someone@x.example', ?, 'body', 'body', 'text', ?)`,
  ).run(emailId, `<${emailId}>`, FIXED_NOW_SEC, `hash-${emailId}`);
}

/** logAction with its parent email seeded first. */
async function logOne(db: Database.Database, repo: AgentRepository, entry: UserActionLog): Promise<void> {
  seedEmail(db, entry.emailId);
  await repo.logAction(entry);
}

/** logActionBatch with every parent email seeded first. */
async function logActions(
  db: Database.Database,
  repo: AgentRepository,
  entries: UserActionLog[],
): Promise<void> {
  for (const entry of entries) seedEmail(db, entry.emailId);
  await repo.logActionBatch(entries);
}

/** saveDecision with its parent email seeded first. */
async function saveDecision(
  db: Database.Database,
  repo: AgentRepository,
  entry: AgentDecision,
): Promise<void> {
  seedEmail(db, entry.emailId);
  await repo.saveDecision(entry);
}

describe('AgentRepository — user action log', () => {
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

  // Every column written must come back out. A silently dropped actionValue
  // (the JSON payload carrying snooze_until / label_name / folder_path) makes
  // the action unreplayable, and the agent then learns "user moved mail" with
  // no idea where to.
  it('round-trips every field of a fully populated action', async () => {
    await logOne(db, repo,       action({
        id: 'a1',
        emailId: 'e1',
        threadId: 't1',
        actionType: 'move',
        actionValue: JSON.stringify({ folder: 'Projects/Q3' }),
        source: 'agent_auto',
        senderAddress: 'boss@corp.example',
        timestamp: FIXED_NOW_SEC - 10,
      }),
    );

    const [row] = await repo.getActionsByEmail('e1');
    expect(row).toMatchObject({
      id: 'a1',
      emailId: 'e1',
      threadId: 't1',
      actionType: 'move',
      actionValue: '{"folder":"Projects/Q3"}',
      source: 'agent_auto',
      senderAddress: 'boss@corp.example',
      timestamp: FIXED_NOW_SEC - 10,
    });
  });

  // Nullable columns must come back as real null, not the string "null" and not
  // undefined — downstream code does `?? fallback` on them.
  it('stores optional fields as SQL NULL and defaults source to "user"', async () => {
    await logOne(db, repo, action({ id: 'a2', emailId: 'e2', source: undefined as never }));

    const [row] = await repo.getActionsByEmail('e2');
    expect(row.threadId).toBeNull();
    expect(row.actionValue).toBeNull();
    expect(row.senderAddress).toBeNull();
    expect(row.source).toBe('user');
    expect(typeof row.createdAt).toBe('number');
  });

  // The daily engagement rollup is maintained incrementally on every logged
  // action. If it were not, sender trends (read/reply/delete rates) would stay
  // flat forever and the tiering logic would never learn.
  it('increments the mapped sender_daily_metrics counter for the action day', async () => {
    const ts = FIXED_NOW_SEC;
    await logOne(db, repo, action({ id: 'm1', actionType: 'read', senderAddress: 'a@x.example', timestamp: ts }));
    await logOne(db, repo, action({ id: 'm2', actionType: 'read', senderAddress: 'a@x.example', timestamp: ts + 60 }));
    await logOne(db, repo, action({ id: 'm3', actionType: 'reply_all', senderAddress: 'a@x.example', timestamp: ts }));
    await logOne(db, repo, action({ id: 'm4', actionType: 'delete', senderAddress: 'a@x.example', timestamp: ts }));
    await logOne(db, repo, action({ id: 'm5', actionType: 'archive', senderAddress: 'a@x.example', timestamp: ts }));

    const rows = await repo.getSenderMetrics('a@x.example');
    expect(rows).toHaveLength(1); // one row per (sender, day) — merged, not duplicated
    expect(rows[0]).toMatchObject({
      senderEmail: 'a@x.example',
      date: dayStart(ts),
      readCount: 2,
      repliedCount: 1, // reply_all folds into replied_count
      deletedCount: 1,
      archivedCount: 1,
      receivedCount: 0,
    });
  });

  // Actions with no engagement meaning (star, open, label_add …) must NOT
  // create a metrics row, otherwise every sender looks "engaged".
  it('creates no metrics row for action types outside the column map', async () => {
    await logOne(db, repo, action({ id: 's1', actionType: 'star', senderAddress: 'a@x.example' }));
    await logOne(db, repo, action({ id: 's2', actionType: 'open', senderAddress: 'a@x.example' }));

    expect(countRows(db, 'sender_daily_metrics')).toBe(0);
  });

  // Actions on different UTC days must land in separate buckets — the whole
  // point of the table is a per-day time series.
  it('buckets metrics per day, not per action', async () => {
    await logOne(db, repo, action({ id: 'd1', actionType: 'read', senderAddress: 'a@x.example', timestamp: FIXED_NOW_SEC }));
    await logOne(db, repo, action({ id: 'd2', actionType: 'read', senderAddress: 'a@x.example', timestamp: FIXED_NOW_SEC - DAY }));

    const rows = await repo.getSenderMetrics('a@x.example');
    expect(rows.map((r) => r.date)).toEqual([dayStart(FIXED_NOW_SEC), dayStart(FIXED_NOW_SEC - DAY)]);
    expect(rows.every((r) => r.readCount === 1)).toBe(true);
  });

  // A metrics row keyed on a mixed-case sender must still merge: the id and the
  // sender_email are lower-cased on write, so 'A@X' and 'a@x' share one bucket.
  it('lower-cases the sender when maintaining the daily bucket', async () => {
    await logOne(db, repo, action({ id: 'c1', actionType: 'read', senderAddress: 'Mixed@Case.Example' }));
    await logOne(db, repo, action({ id: 'c2', actionType: 'read', senderAddress: 'mixed@case.example' }));

    const rows = await repo.getSenderMetrics('MIXED@CASE.EXAMPLE');
    expect(rows).toHaveLength(1);
    expect(rows[0].readCount).toBe(2);
  });

  // Documents CURRENT behaviour (see final report): the action row itself keeps
  // the sender's original casing while getActionsBySender lower-cases the
  // lookup, so a mixed-case sender is unreachable by that accessor.
  it('stores sender_address verbatim, so a mixed-case lookup finds nothing', async () => {
    await logOne(db, repo, action({ id: 'v1', senderAddress: 'Mixed@Case.Example' }));

    expect(await repo.getActionsBySender('mixed@case.example')).toHaveLength(0);
    expect(await repo.getActionsBySender('Mixed@Case.Example')).toHaveLength(0);
    expect(
      (db.prepare('SELECT sender_address AS s FROM user_action_log').get() as { s: string }).s,
    ).toBe('Mixed@Case.Example');
  });
});

describe('AgentRepository — action batch writes', () => {
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

  // Bulk triage (select-all → archive) goes through the batch path. Every item
  // must be written AND must maintain the same sender metrics as logAction,
  // else bulk actions silently undercount engagement.
  it('writes every item of the batch and maintains sender metrics', async () => {
    await logActions(db, repo, [
      action({ id: 'b1', emailId: 'e1', actionType: 'archive', senderAddress: 'news@x.example' }),
      action({ id: 'b2', emailId: 'e2', actionType: 'archive', senderAddress: 'news@x.example' }),
      action({ id: 'b3', emailId: 'e3', actionType: 'archive', senderAddress: null }),
      // Source omitted: the batch path must apply the same 'user' default as
      // logAction, else bulk actions look like the agent acted on its own.
      action({ id: 'b4', emailId: 'e4', actionType: 'archive', source: undefined as never }),
    ]);

    expect(countRows(db, 'user_action_log')).toBe(4);
    const [metrics] = await repo.getSenderMetrics('news@x.example');
    expect(metrics.archivedCount).toBe(2); // the null-sender items contribute nothing
    expect((await repo.getActionsByEmail('e4'))[0].source).toBe('user');
  });

  // A batch is one transaction: if item 2 violates the PK, item 1 must NOT
  // survive. A partial write here would leave the action log and the daily
  // metrics permanently inconsistent with each other.
  it('rolls the whole batch back (actions AND metrics) when one item fails', async () => {
    await expect(
      logActions(db, repo, [
        action({ id: 'dup', emailId: 'e1', actionType: 'read', senderAddress: 'a@x.example' }),
        action({ id: 'dup', emailId: 'e2', actionType: 'read', senderAddress: 'a@x.example' }),
      ]),
    ).rejects.toThrow();

    expect(countRows(db, 'user_action_log')).toBe(0);
    expect(countRows(db, 'sender_daily_metrics')).toBe(0);
  });

  // An empty batch must be a no-op — callers hand it whatever the selection
  // produced, and opening a transaction for nothing is pure overhead.
  it('treats an empty batch as a no-op', async () => {
    await expect(logActions(db, repo, [])).resolves.toBeUndefined();
    expect(countRows(db, 'user_action_log')).toBe(0);
  });
});

describe('AgentRepository — action log accessors', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
    await logActions(db, repo, [
      action({ id: 'r1', emailId: 'e1', actionType: 'read', senderAddress: 'a@x.example', timestamp: FIXED_NOW_SEC - 300 }),
      action({ id: 'r2', emailId: 'e1', actionType: 'archive', senderAddress: 'a@x.example', timestamp: FIXED_NOW_SEC - 200 }),
      action({ id: 'r3', emailId: 'e2', actionType: 'read', senderAddress: 'b@x.example', timestamp: FIXED_NOW_SEC - 100 }),
      action({ id: 'r4', emailId: 'e3', actionType: 'read', senderAddress: 'a@x.example', timestamp: FIXED_NOW_SEC - 50 }),
    ]);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // Newest-first is what the UI and the "recent behaviour" prompt rely on.
  it('returns an email\'s actions newest-first', async () => {
    expect((await repo.getActionsByEmail('e1')).map((a) => a.id)).toEqual(['r2', 'r1']);
  });

  // Unknown ids must yield an empty list, never throw — callers render it.
  it('returns an empty list for an unknown email', async () => {
    expect(await repo.getActionsByEmail('nope')).toEqual([]);
  });

  // Type filter + paging: pages must be ordered and non-overlapping, otherwise
  // a "learn from the last N reads" pass double-counts some rows and skips
  // others.
  it('filters by action type and pages without overlap', async () => {
    expect((await repo.getActionsByType('read')).map((a) => a.id)).toEqual(['r4', 'r3', 'r1']);

    const page1 = await repo.getActionsByType('read', 2, 0);
    const page2 = await repo.getActionsByType('read', 2, 2);
    expect(page1.map((a) => a.id)).toEqual(['r4', 'r3']);
    expect(page2.map((a) => a.id)).toEqual(['r1']);
    expect(page1.some((a) => page2.some((b) => b.id === a.id))).toBe(false);
  });

  it('filters by sender (case-insensitively for lower-cased stored senders) and honours the limit', async () => {
    expect((await repo.getActionsBySender('A@X.EXAMPLE')).map((a) => a.id)).toEqual(['r4', 'r2', 'r1']);
    expect((await repo.getActionsBySender('a@x.example', 2)).map((a) => a.id)).toEqual(['r4', 'r2']);
    expect(await repo.getActionsBySender('unknown@x.example')).toEqual([]);
  });

  // `since` is an inclusive lower bound: the row exactly ON the boundary is
  // part of the window, the one a second earlier is not.
  it('applies the "since" boundary inclusively and falls back to the unfiltered query', async () => {
    const boundary = FIXED_NOW_SEC - 200;
    expect((await repo.getRecentActions(100, boundary)).map((a) => a.id)).toEqual(['r4', 'r3', 'r2']);
    expect((await repo.getRecentActions(100, boundary + 1)).map((a) => a.id)).toEqual(['r4', 'r3']);
    expect((await repo.getRecentActions()).map((a) => a.id)).toEqual(['r4', 'r3', 'r2', 'r1']);
    expect((await repo.getRecentActions(1)).map((a) => a.id)).toEqual(['r4']);
  });
});

describe('AgentRepository — getActionStats', () => {
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

  // The dashboard renders these numbers directly. An empty log must produce
  // zeros and the documented 9am default — not NaN or undefined, which would
  // blank the whole panel.
  it('returns safe zeros (and the 9am default hour) with no actions logged', async () => {
    expect(await repo.getActionStats()).toEqual({
      totalActions: 0,
      actionCounts: {},
      topSenders: [],
      avgActionsPerDay: 0,
      mostActiveHour: 9,
    });
  });

  // Every aggregate must agree with the rows actually seeded — the expectations
  // below are derived from the seed, so a wrong GROUP BY / filter shows up as a
  // mismatch instead of hiding behind a hardcoded number.
  it('agrees with the per-row truth for counts, top senders and averages', async () => {
    const base = dayStart(FIXED_NOW_SEC) + 9 * 3600; // fixed offset in the day
    const seeded: UserActionLog[] = [
      action({ id: 'p1', actionType: 'read', senderAddress: 'a@x.example', timestamp: base }),
      action({ id: 'p2', actionType: 'read', senderAddress: 'a@x.example', timestamp: base + DAY }),
      action({ id: 'p3', actionType: 'read', senderAddress: 'a@x.example', timestamp: base + 2 * DAY }),
      action({ id: 'p4', actionType: 'delete', senderAddress: 'b@x.example', timestamp: base + 2 * DAY }),
      action({ id: 'p5', actionType: 'delete', senderAddress: null, timestamp: base + 2 * DAY + 3600 }),
    ];
    await logActions(db, repo, seeded);

    const stats = await repo.getActionStats();

    const expectedCounts = seeded.reduce<Record<string, number>>((acc, a) => {
      acc[a.actionType] = (acc[a.actionType] || 0) + 1;
      return acc;
    }, {});
    const expectedSenders = Object.entries(
      seeded
        .filter((a) => a.senderAddress)
        .reduce<Record<string, number>>((acc, a) => {
          acc[a.senderAddress as string] = (acc[a.senderAddress as string] || 0) + 1;
          return acc;
        }, {}),
    )
      .map(([email, actionCount]) => ({ email, actionCount }))
      .sort((x, y) => y.actionCount - x.actionCount);
    const spanDays = Math.max(1, (2 * DAY + 3600) / DAY);

    expect(stats.totalActions).toBe(seeded.length);
    expect(stats.actionCounts).toEqual(expectedCounts);
    expect(stats.topSenders).toEqual(expectedSenders); // NULL senders excluded
    expect(stats.avgActionsPerDay).toBe(Math.round((seeded.length / spanDays) * 10) / 10);
    // 4 of 5 actions share one local hour; the odd one is an hour later.
    expect(stats.mostActiveHour).toBe(localHour(db, base));
  });

  // With a `since` window the totals, the per-type counts AND the top-sender
  // list must all shrink together; an unfiltered sub-query here would report
  // "top sender" rows that are not in the reported total.
  it('applies "since" to every sub-aggregate consistently', async () => {
    const base = dayStart(FIXED_NOW_SEC) + 9 * 3600;
    await logActions(db, repo, [
      action({ id: 'q1', actionType: 'read', senderAddress: 'old@x.example', timestamp: base - 5 * DAY }),
      action({ id: 'q2', actionType: 'read', senderAddress: 'new@x.example', timestamp: base }),
      action({ id: 'q3', actionType: 'delete', senderAddress: 'new@x.example', timestamp: base + 60 }),
    ]);

    const stats = await repo.getActionStats(base);
    expect(stats.totalActions).toBe(2);
    expect(stats.actionCounts).toEqual({ read: 1, delete: 1 });
    expect(stats.topSenders).toEqual([{ email: 'new@x.example', actionCount: 2 }]);
    expect(stats.avgActionsPerDay).toBe(2); // 2 actions inside a sub-day span → clamped to 1 day
  });
});

describe('AgentRepository — agent decisions', () => {
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

  // A decision row is the audit trail of "what the agent wanted to do". The
  // draft columns carry the generated reply the user is about to send — losing
  // any of them means the approval UI shows an empty draft.
  it('round-trips a fully populated decision, drafts included', async () => {
    await saveDecision(db, repo,       decision({
        id: 'd1',
        emailId: 'e1',
        threadId: 't1',
        senderAddress: 'boss@corp.example',
        proposedAction: 'reply',
        proposedValue: '{"tone":"brief"}',
        confidence: 0.91,
        reasoning: 'sender always gets a reply',
        status: 'pending',
        proposedAt: FIXED_NOW_SEC - 5,
        draftBody: 'On it — sending today.',
        draftSubject: 'Re: Q3',
        draftReasoning: 'mirrors previous replies',
      }),
    );

    const [row] = await repo.getPendingDecisions();
    expect(row).toMatchObject({
      id: 'd1',
      emailId: 'e1',
      threadId: 't1',
      senderAddress: 'boss@corp.example',
      proposedAction: 'reply',
      proposedValue: '{"tone":"brief"}',
      confidence: 0.91,
      reasoning: 'sender always gets a reply',
      status: 'pending',
      proposedAt: FIXED_NOW_SEC - 5,
      draftBody: 'On it — sending today.',
      draftSubject: 'Re: Q3',
      draftReasoning: 'mirrors previous replies',
    });
    expect(row.actualAction).toBeNull();
    expect(row.userFeedback).toBeNull();
    expect(row.resolvedAt).toBeNull();
  });

  // Empty-string optionals must normalise to NULL and the draft fields must be
  // absent (undefined) rather than empty strings, because the UI branches on
  // "is there a draft at all".
  it('stores absent optionals as NULL / undefined', async () => {
    await saveDecision(db, repo, decision({ id: 'd2', reasoning: '' }));

    const [row] = await repo.getPendingDecisions();
    expect(row.reasoning).toBeNull();
    expect(row.proposedValue).toBeNull();
    expect(row.threadId).toBeNull();
    expect(row.draftBody).toBeUndefined();
    expect(row.draftSubject).toBeUndefined();
    expect(row.draftReasoning).toBeUndefined();
  });

  // The draft is generated after the decision is proposed, so it lands via a
  // second UPDATE. Pinning it prevents a regression where the draft is written
  // to a new row and the approval UI never sees it.
  it('attaches a draft to an existing decision, with optional parts nulled', async () => {
    await saveDecision(db, repo, decision({ id: 'd3', proposedAction: 'reply' }));

    repo.updateDecisionDraft('d3', { body: 'Sure, Friday works.' });
    let [row] = await repo.getPendingDecisions();
    expect(row.draftBody).toBe('Sure, Friday works.');
    expect(row.draftSubject).toBeUndefined();

    repo.updateDecisionDraft('d3', { body: 'v2', subject: 'Re: sync', reasoning: 'shortened' });
    [row] = await repo.getPendingDecisions();
    expect(row).toMatchObject({ draftBody: 'v2', draftSubject: 'Re: sync', draftReasoning: 'shortened' });
  });

  // Resolving a decision must stamp resolved_at and must NOT wipe an already
  // recorded actualAction/userFeedback when the caller omits them (COALESCE) —
  // that is the learning signal for "agent proposed X, user did Y".
  it('resolves a decision, stamping resolved_at and preserving prior fields', async () => {
    await saveDecision(db, repo, decision({ id: 'd4' }));

    await repo.updateDecisionStatus('d4', 'overridden', 'delete', 'wrong folder');
    await repo.updateDecisionStatus('d4', 'rejected'); // omits both → must preserve

    const [row] = await repo.getDecisionHistory();
    expect(row).toMatchObject({
      status: 'rejected',
      actualAction: 'delete',
      userFeedback: 'wrong folder',
      resolvedAt: FIXED_NOW_SEC,
    });
    expect(await repo.getPendingDecisions()).toEqual([]);
  });

  // Updating an id that does not exist must be a silent no-op, not a throw:
  // decisions expire and get pruned while the UI still holds their ids.
  it('ignores status/draft updates for an unknown decision id', async () => {
    await expect(repo.updateDecisionStatus('ghost', 'approved')).resolves.toBeUndefined();
    expect(() => repo.updateDecisionDraft('ghost', { body: 'x' })).not.toThrow();
    expect(countRows(db, 'agent_decisions')).toBe(0);
  });

  it('lists only pending decisions, newest-first, and pages history without overlap', async () => {
    await saveDecision(db, repo, decision({ id: 'h1', proposedAt: FIXED_NOW_SEC - 300 }));
    await saveDecision(db, repo, decision({ id: 'h2', proposedAt: FIXED_NOW_SEC - 200 }));
    await saveDecision(db, repo, decision({ id: 'h3', status: 'approved', proposedAt: FIXED_NOW_SEC - 100 }));

    expect((await repo.getPendingDecisions()).map((d) => d.id)).toEqual(['h2', 'h1']);
    expect((await repo.getDecisionHistory()).map((d) => d.id)).toEqual(['h3', 'h2', 'h1']);
    expect((await repo.getDecisionHistory(2, 0)).map((d) => d.id)).toEqual(['h3', 'h2']);
    expect((await repo.getDecisionHistory(2, 2)).map((d) => d.id)).toEqual(['h1']);
  });

  // Accuracy drives whether the agent is allowed to act autonomously. Counting
  // an unresolved (pending) or expired proposal as a rejection would freeze
  // autonomy forever, so the denominator must exclude both.
  it('computes accuracy from resolved decisions only, agreeing with the seeded rows', async () => {
    const statuses: Array<AgentDecision['status']> = [
      'approved', 'auto', 'auto', 'rejected', 'overridden', 'pending', 'expired',
    ];
    for (const [index, status] of statuses.entries()) {
      await saveDecision(db, repo, decision({ id: `acc${index}`, status, proposedAt: FIXED_NOW_SEC - 10 }));
    }

    const resolved = statuses.filter((s) => s !== 'pending' && s !== 'expired');
    const approved = resolved.filter((s) => s === 'approved' || s === 'auto').length;
    const rejected = resolved.filter((s) => s === 'rejected' || s === 'overridden').length;

    expect(await repo.getDecisionAccuracy()).toEqual({
      total: resolved.length,
      approved,
      rejected,
      accuracy: approved / resolved.length,
    });
  });

  it('returns zeroed accuracy (no division by zero) when nothing is resolved', async () => {
    await saveDecision(db, repo, decision({ id: 'only-pending' }));
    expect(await repo.getDecisionAccuracy()).toEqual({ total: 0, approved: 0, rejected: 0, accuracy: 0 });
  });

  // The `since` window must be inclusive on the boundary so a caller asking
  // for "the last 7 days" gets the decision made exactly 7 days ago.
  it('applies the "since" boundary inclusively to accuracy', async () => {
    await saveDecision(db, repo, decision({ id: 'old', status: 'rejected', proposedAt: FIXED_NOW_SEC - 2 * DAY }));
    await saveDecision(db, repo, decision({ id: 'edge', status: 'approved', proposedAt: FIXED_NOW_SEC - DAY }));

    const stats = await repo.getDecisionAccuracy(FIXED_NOW_SEC - DAY);
    expect(stats).toEqual({ total: 1, approved: 1, rejected: 0, accuracy: 1 });
  });
});

describe('AgentRepository — sender daily metrics', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  const metrics = (overrides: Partial<SenderDailyMetrics> & { id: string }): SenderDailyMetrics => ({
    senderEmail: 'a@x.example',
    date: dayStart(FIXED_NOW_SEC),
    receivedCount: 0,
    readCount: 0,
    repliedCount: 0,
    deletedCount: 0,
    archivedCount: 0,
    avgResponseTimeSec: null,
    createdAt: FIXED_NOW_SEC,
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('round-trips every metric field, with a NULL response time staying null', async () => {
    await repo.upsertSenderDailyMetrics(
      metrics({
        id: 'sdm-1',
        senderEmail: 'Sender@X.Example',
        receivedCount: 7,
        readCount: 5,
        repliedCount: 2,
        deletedCount: 1,
        archivedCount: 3,
        avgResponseTimeSec: null,
      }),
    );

    const [row] = await repo.getSenderMetrics('sender@x.example');
    expect(row).toMatchObject({
      id: 'sdm-1',
      senderEmail: 'sender@x.example', // normalised on write
      date: dayStart(FIXED_NOW_SEC),
      receivedCount: 7,
      readCount: 5,
      repliedCount: 2,
      deletedCount: 1,
      archivedCount: 3,
    });
    expect(row.avgResponseTimeSec).toBeNull();
  });

  // (sender_email, date) is UNIQUE: a re-upsert must MERGE into the existing
  // row. Duplicating instead would double every engagement rate.
  it('upserts by (sender, day) instead of inserting a duplicate row', async () => {
    await repo.upsertSenderDailyMetrics(metrics({ id: 'first', readCount: 1, avgResponseTimeSec: 60 }));
    await repo.upsertSenderDailyMetrics(metrics({ id: 'second', readCount: 9, avgResponseTimeSec: 30 }));

    const rows = await repo.getSenderMetrics('a@x.example');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('first'); // the conflicting row is updated, not replaced
    expect(rows[0].readCount).toBe(9);
    expect(rows[0].avgResponseTimeSec).toBe(30);
    expect(countRows(db, 'sender_daily_metrics')).toBe(1);
  });

  // The rolling window is `now - days*86400`, inclusive. A day exactly on the
  // edge must be inside the window, one second earlier outside — otherwise the
  // 30-day chart silently loses (or invents) its oldest column.
  it('bounds getSenderMetrics by an inclusive rolling window, newest day first', async () => {
    const edge = FIXED_NOW_SEC - 30 * DAY;
    await repo.upsertSenderDailyMetrics(metrics({ id: 'inside', date: edge, readCount: 1 }));
    await repo.upsertSenderDailyMetrics(metrics({ id: 'outside', date: edge - 1, readCount: 1 }));
    await repo.upsertSenderDailyMetrics(metrics({ id: 'today', date: dayStart(FIXED_NOW_SEC), readCount: 1 }));

    expect((await repo.getSenderMetrics('a@x.example', 30)).map((r) => r.id)).toEqual(['today', 'inside']);
    expect(await repo.getSenderMetrics('other@x.example', 30)).toEqual([]);
  });

  // Top-sender rollups feed the "senders you delete most" list. They must be
  // derived from the action log, exclude NULL senders and honour the window.
  it('rolls up top senders per action type, agreeing with the seeded actions', async () => {
    const base = FIXED_NOW_SEC - 10 * DAY;
    await logActions(db, repo, [
      action({ id: 't1', actionType: 'delete', senderAddress: 'spammy@x.example', timestamp: base }),
      action({ id: 't2', actionType: 'delete', senderAddress: 'spammy@x.example', timestamp: base + 1 }),
      action({ id: 't3', actionType: 'delete', senderAddress: 'spammy@x.example', timestamp: base + 2 }),
      action({ id: 't4', actionType: 'delete', senderAddress: 'meh@x.example', timestamp: base + 3 }),
      action({ id: 't5', actionType: 'delete', senderAddress: 'meh@x.example', timestamp: base + 4 }),
      action({ id: 't6', actionType: 'delete', senderAddress: null, timestamp: base + 5 }),
      action({ id: 't7', actionType: 'read', senderAddress: 'meh@x.example', timestamp: base + 6 }),
      action({ id: 't8', actionType: 'delete', senderAddress: 'recent@x.example', timestamp: FIXED_NOW_SEC }),
    ]);

    // Counts are distinct so the DESC ordering is unambiguous.
    expect(await repo.getTopSendersByAction('delete')).toEqual([
      { email: 'spammy@x.example', count: 3 },
      { email: 'meh@x.example', count: 2 },
      { email: 'recent@x.example', count: 1 },
    ]);
    expect(await repo.getTopSendersByAction('delete', 1)).toEqual([{ email: 'spammy@x.example', count: 3 }]);
    expect(await repo.getTopSendersByAction('delete', 20, FIXED_NOW_SEC)).toEqual([
      { email: 'recent@x.example', count: 1 },
    ]);
    expect(await repo.getTopSendersByAction('forward')).toEqual([]);
  });
});

describe('AgentRepository — pipeline event log', () => {
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

  it('round-trips a pipeline event, keeping the JSON payload verbatim', async () => {
    await repo.logPipelineEvent(
      event({
        id: 'p1',
        eventType: 'pipeline2.categorized',
        emailId: 'e1',
        threadId: 't1',
        data: JSON.stringify({ categories: ['needs_response'], ms: 42 }),
        timestamp: FIXED_NOW_SEC - 1,
      }),
    );

    const [row] = await repo.getPipelineEvents();
    expect(row).toMatchObject({
      id: 'p1',
      eventType: 'pipeline2.categorized',
      emailId: 'e1',
      threadId: 't1',
      data: '{"categories":["needs_response"],"ms":42}',
      timestamp: FIXED_NOW_SEC - 1,
    });
    expect(typeof row.createdAt).toBe('number');
  });

  it('stores absent email/thread/data as NULL', async () => {
    await repo.logPipelineEvent(event({ id: 'p2' }));
    const [row] = await repo.getPipelineEvents();
    expect(row.emailId).toBeNull();
    expect(row.threadId).toBeNull();
    expect(row.data).toBeNull();
  });

  // Batched events come from a per-sync flush. All of them must land, and a
  // failing item must not leave a half-written funnel that would make the
  // dashboard show more "started" than "finished".
  it('writes the full batch, rolls back entirely on failure, and no-ops when empty', async () => {
    await repo.logPipelineEventBatch([
      event({ id: 'b1', timestamp: FIXED_NOW_SEC - 2 }),
      event({ id: 'b2', timestamp: FIXED_NOW_SEC - 1 }),
    ]);
    expect(countRows(db, 'pipeline_event_log')).toBe(2);

    await expect(
      repo.logPipelineEventBatch([event({ id: 'b3' }), event({ id: 'b3' })]),
    ).rejects.toThrow();
    expect(countRows(db, 'pipeline_event_log')).toBe(2); // b3 fully rolled back

    await expect(repo.logPipelineEventBatch([])).resolves.toBeUndefined();
    expect(countRows(db, 'pipeline_event_log')).toBe(2);
  });

  // Optional-filter builder: type alone, since alone, both together and
  // neither. A filter that leaks (or is dropped) silently changes what the
  // funnel reports.
  it('applies the eventType and since filters independently and together', async () => {
    await repo.logPipelineEventBatch([
      event({ id: 'f1', eventType: 'start', timestamp: FIXED_NOW_SEC - 300 }),
      event({ id: 'f2', eventType: 'done', timestamp: FIXED_NOW_SEC - 200 }),
      event({ id: 'f3', eventType: 'start', timestamp: FIXED_NOW_SEC - 100 }),
      event({ id: 'f4', eventType: 'done', timestamp: FIXED_NOW_SEC }),
    ]);

    expect((await repo.getPipelineEvents()).map((e) => e.id)).toEqual(['f4', 'f3', 'f2', 'f1']);
    expect((await repo.getPipelineEvents('start')).map((e) => e.id)).toEqual(['f3', 'f1']);
    expect((await repo.getPipelineEvents(undefined, 100, FIXED_NOW_SEC - 200)).map((e) => e.id)).toEqual([
      'f4', 'f3', 'f2',
    ]);
    expect((await repo.getPipelineEvents('start', 100, FIXED_NOW_SEC - 200)).map((e) => e.id)).toEqual(['f3']);
    expect((await repo.getPipelineEvents(undefined, 2)).map((e) => e.id)).toEqual(['f4', 'f3']);
    expect(await repo.getPipelineEvents('never-emitted')).toEqual([]);
  });

  // A free-text event type must be bound as a literal: no injection, and the
  // table still exists afterwards.
  it('treats a malicious eventType filter as literal text', async () => {
    await repo.logPipelineEvent(event({ id: 'safe', eventType: 'done' }));

    expect(await repo.getPipelineEvents("');DROP TABLE pipeline_event_log;--")).toEqual([]);
    expect(await repo.getPipelineEvents("done' OR '1'='1")).toEqual([]);
    expect(countRows(db, 'pipeline_event_log')).toBe(1);
  });

  // Retention prune: strictly older than the cutoff. Deleting the boundary row
  // too would silently shorten every retention window by one tick.
  it('prunes strictly older events and reports how many rows went', async () => {
    await repo.logPipelineEventBatch([
      event({ id: 'old', timestamp: FIXED_NOW_SEC - 2 * DAY }),
      event({ id: 'edge', timestamp: FIXED_NOW_SEC - DAY }),
      event({ id: 'new', timestamp: FIXED_NOW_SEC }),
    ]);

    expect(await repo.cleanupOldEvents(FIXED_NOW_SEC - DAY)).toBe(1);
    expect((await repo.getPipelineEvents()).map((e) => e.id)).toEqual(['new', 'edge']);
    expect(await repo.cleanupOldEvents(FIXED_NOW_SEC - 10 * DAY)).toBe(0);
  });
});

describe('AgentRepository — contact notes (knowledge base)', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  /** Notes default created_at to unixepoch(); pin it so ordering is exact. */
  const stampNote = (id: number, createdAt: number): void => {
    db.prepare('UPDATE contact_notes SET created_at = ? WHERE id = ?').run(createdAt, id);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_SEC * 1000);
    ({ db, repo } = newRepo());
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // Notes are injected verbatim into the LLM prompt, so every field must
  // survive the round-trip and the address must be normalised — otherwise the
  // same person accumulates two disjoint knowledge bases.
  it('round-trips a note and lower-cases the contact address', () => {
    const id = repo.addNote('Boss@Corp.Example', 'Runs the VAPT project', 'role', 'email-9', 0.42);

    expect(id).toBeGreaterThan(0);
    const [note] = repo.getNotes('boss@corp.example');
    expect(note).toMatchObject({
      id,
      note: 'Runs the VAPT project',
      category: 'role',
      sourceEmailId: 'email-9',
      confidence: 0.42,
    });
    expect(typeof note.createdAt).toBe('number');
    expect(typeof note.updatedAt).toBe('number');
  });

  it('defaults confidence to 0.8 and leaves an unknown source id NULL', () => {
    repo.addNote('a@x.example', 'Prefers Slack', 'preference');
    const [note] = repo.getNotes('a@x.example');
    expect(note.confidence).toBe(0.8);
    expect(note.sourceEmailId).toBeNull();
  });

  // Batch extraction re-runs over the same thread constantly. Without the
  // dedupe guard the same fact would be re-inserted on every pass and the
  // prompt would fill up with repeats.
  it('skips duplicate (email, note) pairs in a batch and reports only real inserts', () => {
    expect(
      repo.addNotesBatch([
        { email: 'A@x.example', note: 'Based in Pune', category: 'location' },
        { email: 'a@x.example', note: 'Based in Pune', category: 'location' }, // dup within the batch
        { email: 'a@x.example', note: 'Owns billing', category: 'role', confidence: 0.9 },
      ]),
    ).toBe(2);

    expect(repo.getNotesCount('a@x.example')).toBe(2);
    expect(repo.addNotesBatch([{ email: 'a@x.example', note: 'Based in Pune', category: 'location' }])).toBe(0);
    expect(repo.getNotesCount('a@x.example')).toBe(2);
  });

  it('treats an empty note batch as a no-op', () => {
    expect(repo.addNotesBatch([])).toBe(0);
    expect(countRows(db, 'contact_notes')).toBe(0);
  });

  // The batch is transactional: a bad item (NULL note violates NOT NULL) must
  // take the whole batch with it rather than leaving half the extracted facts.
  it('rolls the whole note batch back when one item is invalid', () => {
    expect(() =>
      repo.addNotesBatch([
        { email: 'a@x.example', note: 'good fact', category: 'general' },
        { email: 'a@x.example', note: null as unknown as string, category: 'general' },
      ]),
    ).toThrow();

    expect(countRows(db, 'contact_notes')).toBe(0);
  });

  it('lists notes newest-first, honours the limit, and hides deactivated ones', () => {
    const first = repo.addNote('a@x.example', 'oldest', 'general');
    const second = repo.addNote('a@x.example', 'middle', 'general');
    const third = repo.addNote('a@x.example', 'newest', 'general');
    stampNote(first, FIXED_NOW_SEC - 300);
    stampNote(second, FIXED_NOW_SEC - 200);
    stampNote(third, FIXED_NOW_SEC - 100);

    expect(repo.getNotes('a@x.example').map((n) => n.note)).toEqual(['newest', 'middle', 'oldest']);
    expect(repo.getNotes('a@x.example', 2).map((n) => n.note)).toEqual(['newest', 'middle']);

    repo.deactivateNote(third);
    expect(repo.getNotes('a@x.example').map((n) => n.note)).toEqual(['middle', 'oldest']);
    expect(repo.getNotesCount('a@x.example')).toBe(2);
    // Deactivation is a soft delete — the row (and its provenance) stays.
    expect(countRows(db, 'contact_notes')).toBe(3);
  });

  // A deactivated note must be re-addable through the batch path: the dedupe
  // guard only considers ACTIVE notes, so a fact the user retracted can come
  // back if it is observed again.
  it('lets a deactivated note be re-added by the batch', () => {
    const id = repo.addNote('a@x.example', 'Based in Pune', 'location');
    repo.deactivateNote(id);

    expect(repo.addNotesBatch([{ email: 'a@x.example', note: 'Based in Pune', category: 'location' }])).toBe(1);
    expect(repo.getNotesCount('a@x.example')).toBe(1);
  });

  it('edits a note in place and stamps updated_at', () => {
    const id = repo.addNote('a@x.example', 'Works at Acme', 'role');
    db.prepare('UPDATE contact_notes SET updated_at = 0 WHERE id = ?').run(id);

    repo.updateNote(id, 'Works at Globex');

    const [note] = repo.getNotes('a@x.example');
    expect(note.note).toBe('Works at Globex');
    expect(note.updatedAt).toBe(FIXED_NOW_SEC);
  });

  it('returns an empty knowledge base for an unknown contact', () => {
    expect(repo.getNotes('nobody@x.example')).toEqual([]);
    expect(repo.getNotesCount('nobody@x.example')).toBe(0);
    expect(repo.getNotesForPrompt('nobody@x.example')).toBe('');
  });

  // The prompt block is concatenated straight into the LLM request; its shape
  // (one "- fact" per line, newest first, bounded) is load-bearing.
  it('formats notes as a bounded bullet list for prompt injection', () => {
    const a = repo.addNote('a@x.example', 'Role: PM at Infosys', 'role');
    const b = repo.addNote('a@x.example', 'Working on VAPT', 'project');
    stampNote(a, FIXED_NOW_SEC - 200);
    stampNote(b, FIXED_NOW_SEC - 100);

    expect(repo.getNotesForPrompt('a@x.example')).toBe('- Working on VAPT\n- Role: PM at Infosys');
    expect(repo.getNotesForPrompt('a@x.example', 1)).toBe('- Working on VAPT');
  });

  // Free-text search must bind its term as a literal value: quotes and a
  // classic injection payload find nothing and leave the table intact.
  it('binds a hostile search term as literal text', () => {
    repo.addNote('a@x.example', "Quote's are fine", 'general');
    repo.addNote('b@x.example', 'nothing to see', 'general');

    expect(repo.searchNotes("Quote's").map((n) => n.email)).toEqual(['a@x.example']);
    expect(repo.searchNotes("');DROP TABLE contact_notes;--")).toEqual([]);
    expect(repo.searchNotes("' OR 1=1 --")).toEqual([]);
    expect(countRows(db, 'contact_notes')).toBe(2);
  });

  it('returns email/note/category for matches, newest-first and bounded', () => {
    const a = repo.addNote('a@x.example', 'renewal in April', 'deadline');
    const b = repo.addNote('b@x.example', 'renewal in May', 'deadline');
    repo.addNote('c@x.example', 'unrelated', 'general');
    stampNote(a, FIXED_NOW_SEC - 200);
    stampNote(b, FIXED_NOW_SEC - 100);

    expect(repo.searchNotes('renewal')).toEqual([
      { email: 'b@x.example', note: 'renewal in May', category: 'deadline' },
      { email: 'a@x.example', note: 'renewal in April', category: 'deadline' },
    ]);
    expect(repo.searchNotes('renewal', 1).map((n) => n.email)).toEqual(['b@x.example']);
    expect(repo.searchNotes('nothing-matches-this')).toEqual([]);
  });

  // KNOWN LIMITATION, pinned so a future ESCAPE clause is a deliberate change:
  // the term is interpolated into a LIKE pattern without escaping, so `_` and
  // `%` inside a user's search act as SQL wildcards. It is safe (still bound as
  // a parameter) but over-matches.
  it('currently lets LIKE wildcards inside the search term match loosely', () => {
    repo.addNote('a@x.example', 'invoice-42 paid', 'billing');

    expect(repo.searchNotes('invoice_42')).toHaveLength(1); // '_' matched '-'
    expect(repo.searchNotes('invoice%paid')).toHaveLength(1); // '%' spanned the middle
    expect(repo.searchNotes('invoice[42')).toHaveLength(0); // ordinary chars stay literal
  });
});
