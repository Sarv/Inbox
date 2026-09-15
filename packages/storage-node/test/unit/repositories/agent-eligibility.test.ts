import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';


import {
  agentEligibleClause,
  extractionEligibleClause,
} from '../../../src/repositories/agent-eligibility';
import { AgentRepository } from '../../../src/repositories/agent-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

// AI categorization silently stopping mid-run is the regression this file
// exists for. It never looked like a crash: the progress bar parked below 100%
// showing "N pending" while the worker had nothing to do, because the COUNT and
// the SELECT were two hand-written predicates that had drifted apart. A row
// that satisfied the counter but failed the selector was counted forever and
// picked up by nothing — no error, no retry, no log line.
//
// So the contract asserted here is: the number shown and the rows worked are
// derived from the same clause, and any row that can never be selected is
// actively healed instead of accumulating. Time is passed in explicitly so the
// age-based give-up asserts exactly and cannot flake.
const NOW = 1780315200; // 2026-06-15T12:00:00Z
const DAY = 86400;

interface EmailSeed {
  id: string;
  tags?: string;
  date?: number;
  cleanBody?: string;
  rawBody?: string;
  extractionStatus?: string;
  agentStatus?: string;
}

let uidSeq = 0;

function seedEmail(db: Database.Database, seed: EmailSeed): void {
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  const date = seed.date ?? NOW;
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(`t-${seed.id}`, 'subject', `<${seed.id}>`, `<${seed.id}>`, date);

  db.prepare(
    // clean_body_len/raw_body_len are written from the bodies in SQL, exactly as
    // every production writer does. On a fully-migrated DB the eligibility
    // clauses answer "has a body" from these columns, so seeding them NULL would
    // make every row here look body-less and test nothing.
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, uid, tags, subject,
       from_address, date, clean_body, raw_body, clean_body_len, raw_body_len,
       content_type, content_hash, extraction_status, agent_status
     ) VALUES (?, ?, ?, 'f-inbox', ?, ?, 'subject', 'someone@x.example', ?, ?, ?,
               LENGTH(TRIM(?)), LENGTH(TRIM(?)), 'text', ?, ?, ?)`,
  ).run(
    seed.id,
    `<${seed.id}>`,
    `t-${seed.id}`,
    ++uidSeq,
    seed.tags ?? '|INBOX|',
    date,
    seed.cleanBody ?? 'body text',
    seed.rawBody ?? 'body text',
    seed.cleanBody ?? 'body text',
    seed.rawBody ?? 'body text',
    `hash-${seed.id}`,
    seed.extractionStatus ?? 'done',
    seed.agentStatus ?? 'pending',
  );
}

const idsOf = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id).sort();

describe('agent eligibility — counter and selector agree', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  // THE regression. Seed one row of every shape that used to be counted but not
  // selectable; if the count ever exceeds what the worker can select again, the
  // progress bar starts lying and categorization "stops" with work outstanding.
  it('counts exactly the rows the worker can select', () => {
    seedEmail(db, { id: 'eligible' });
    seedEmail(db, { id: 'extraction-pending', extractionStatus: 'pending' });
    seedEmail(db, { id: 'no-body', cleanBody: '', rawBody: '' });
    seedEmail(db, { id: 'read', tags: '|INBOX|read|' });
    seedEmail(db, { id: 'spam', tags: '|Spam|' });
    seedEmail(db, { id: 'junk', tags: '|Junk|' });
    seedEmail(db, { id: 'done-already', agentStatus: 'done' });

    expect(idsOf(repo.getEmailsPendingAgent(50))).toEqual(['eligible']);
    expect(repo.countAgentEligible()).toBe(1);
  });

  // A space-only body is not a body. runPipeline2 refuses to categorize such a
  // row and resets it to 'pending', so counting it as work would loop forever.
  it('treats a space-only body as no body', () => {
    seedEmail(db, { id: 'blank', cleanBody: '   ', rawBody: '  ' });
    expect(repo.countAgentEligible()).toBe(0);
    expect(repo.getEmailsPendingAgent(50)).toHaveLength(0);
  });

  // KNOWN LIMITATION, deliberately pinned: SQLite's TRIM() strips spaces only,
  // so a body of just tabs/newlines still counts as a body. That is on purpose
  // — it matches runPipeline2's own untrimmed `length > 0` gate. Making the SQL
  // smarter here without changing that gate would re-open the exact split
  // between "counted" and "selectable" this module exists to close.
  it('still counts a tab/newline-only body as a body, matching the runtime gate', () => {
    seedEmail(db, { id: 'tabs', cleanBody: '\n\t', rawBody: '' });
    expect(repo.countAgentEligible()).toBe(1);
    expect(idsOf(repo.getEmailsPendingAgent(50))).toEqual(['tabs']);
  });

  // HTML-only marketing mail carries its content in raw_body with clean_body
  // empty. Gating on clean_body alone stranded exactly this mail.
  it('accepts mail whose content is only in raw_body', () => {
    seedEmail(db, { id: 'html-only', cleanBody: '', rawBody: '<p>hello</p>' });
    expect(idsOf(repo.getEmailsPendingAgent(50))).toEqual(['html-only']);
    expect(repo.countAgentEligible()).toBe(1);
  });

  // A short unread ("Call me") is legitimate work, not noise to skip.
  it('accepts a very short body', () => {
    seedEmail(db, { id: 'short', cleanBody: 'Hi', rawBody: '' });
    expect(repo.countAgentEligible()).toBe(1);
  });

  it.each([
    ['|INBOX|read|'],
    ['|Spam|'],
    ['|Junk|'],
    ['|Trash|'],
    ['|[Gmail]/Spam|'],
    ['|[Gmail]/Trash|'],
  ])('never selects or counts mail tagged %s', (tags) => {
    seedEmail(db, { id: 'skipped', tags });
    expect(repo.getEmailsPendingAgent(50)).toHaveLength(0);
    expect(repo.countAgentEligible()).toBe(0);
  });

  // The recent-N window keeps background processing off a huge historical
  // backlog. Counter and selector must apply it identically, or the bar shows
  // backlog the worker will never touch.
  it('applies the recent-window bound to both count and selection', () => {
    seedEmail(db, { id: 'newest', date: NOW });
    seedEmail(db, { id: 'older', date: NOW - DAY });
    seedEmail(db, { id: 'oldest', date: NOW - 2 * DAY });

    expect(idsOf(repo.getEmailsPendingAgent(50, 2))).toEqual(['newest', 'older']);
    expect(repo.countAgentEligible(2)).toBe(2);
  });
});

// Term ORDER is a performance contract, and it is invisible: every assertion in
// the rest of this file passes either way, because the rows returned are
// identical. Only the wall clock changes — SQLite evaluates AND terms in source
// order, and `LENGTH(TRIM(clean_body))` has to read the inline body plus its
// overflow chain while a status equality or a date bound is header-only.
// Measured 2026-08-26 on a 26,184-email mailbox: the extraction backlog count
// took 400.9ms with the body test first and 62.2ms with the recent-window bound
// ahead of it. That count runs on the 30-second pipeline poll, on the main
// thread, forever.
describe('eligibility clauses put the expensive body test last', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  /** Captures the SQL the repository actually prepares for one call. */
  const sqlOf = (call: () => unknown): string => {
    const realPrepare = db.prepare.bind(db);
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = (sql: string) => { seen.push(sql); return realPrepare(sql); };
    try { call(); } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).prepare = realPrepare;
    }
    // The repository also looks up this DB's body-length readiness (a one-row
    // key/value read, cached per connection) before building an eligibility
    // clause. It is not the query under test, and because it is cached it
    // appears only on the FIRST call of a suite — so filter it out rather than
    // counting it, which would make the assertion depend on test order.
    const queries = seen.filter((sql) => !sql.includes('email_body_metrics_state'));
    expect(queries).toHaveLength(1);
    return queries[0];
  };

  /** Only the WHERE clause decides evaluation order — a body test in the SELECT
   *  list (getStuckPipelineRows' CASE) is evaluated per surviving row, not per
   *  candidate, so it must not be mistaken for the filter's own term.
   *
   *  The statement's OWN `WHERE` is the one at paren depth 0. Since migration 73
   *  the body expressions are correlated subqueries that carry a `WHERE` of their
   *  own, and a naive `indexOf('WHERE')` landed on THAT — slicing the clause off
   *  before its cheap terms and reporting the body test as first. */
  const whereOf = (sql: string): string => {
    let depth = 0;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && sql.startsWith('WHERE', i)) return sql.slice(i);
    }
    return sql;
  };

  /** Position of the has-body term, in EITHER form the clause can emit: the
   *  stored-length test on a fully-backfilled DB, or the body-reading fallback
   *  while the backfill is still running. The ordering contract holds for both —
   *  the fast form is cheap, but a caller that appends its own term after it is
   *  still a caller whose next change puts an expensive term in the wrong place. */
  const bodyTestAt = (sql: string): number => {
    const where = whereOf(sql);
    const fast = where.indexOf('clean_body_len');
    return fast === -1 ? where.indexOf('LENGTH(TRIM(') : fast;
  };
  const windowAt = (sql: string): number => whereOf(sql).indexOf('ORDER BY date DESC LIMIT ?))');

  it.each([
    ['extractionEligibleClause', () => extractionEligibleClause('', { recentWindow: true })],
    ['agentEligibleClause', () => agentEligibleClause('', { recentWindow: true })],
  ])('%s emits the window bound before the body test', (_name, build) => {
    const sql = build();
    expect(windowAt(sql)).toBeGreaterThan(-1);
    expect(windowAt(sql)).toBeLessThan(bodyTestAt(sql));
  });

  it.each([
    ['extractionEligibleClause', () => extractionEligibleClause()],
    ['agentEligibleClause', () => agentEligibleClause()],
  ])('%s keeps the body test after every cheap term even with no window', (_name, build) => {
    const sql = build();
    expect(windowAt(sql)).toBe(-1); // no window requested → no extra bound param
    // Status equality and the tag scan are both header-only; the body test is
    // the one that reads the record, so nothing may be ordered after it.
    expect(bodyTestAt(sql)).toBeGreaterThan(sql.indexOf("_status = '"));
    if (sql.includes('instr(')) expect(bodyTestAt(sql)).toBeGreaterThan(sql.indexOf('instr('));
  });

  // The regression this replaces: every caller used to build the clause and then
  // append `AND <window>` after it, which put the cheap bound BEHIND the body
  // test and made it worthless. Asserted on the prepared statement, so a future
  // caller that appends its own term is caught here rather than in a profile.
  it.each([
    ['countExtractionEligible', () => repo.countExtractionEligible(2)],
    ['countAgentEligible', () => repo.countAgentEligible(2)],
    ['getEmailsPendingExtraction', () => repo.getEmailsPendingExtraction(10, 2)],
    ['getEmailsPendingAgent', () => repo.getEmailsPendingAgent(10, 2)],
    ['getStuckPipelineRows', () => repo.getStuckPipelineRows(10, 2)],
  ])('%s binds the window ahead of the body test', (_name, call) => {
    const sql = sqlOf(call);
    expect(windowAt(sql)).toBeGreaterThan(-1);
    expect(windowAt(sql)).toBeLessThan(bodyTestAt(sql));
  });

  // Order changed, results must not: the window's `?` still has to be bound
  // before the LIMIT's, or the two silently swap and the query returns the wrong
  // slice of the mailbox without erroring.
  it('still returns the same rows, with the bind order intact', () => {
    seedEmail(db, { id: 'newest', extractionStatus: 'pending' });
    seedEmail(db, { id: 'older', extractionStatus: 'pending', date: NOW - DAY });
    seedEmail(db, { id: 'oldest', extractionStatus: 'pending', date: NOW - 2 * DAY });
    seedEmail(db, { id: 'bodyless', extractionStatus: 'pending', cleanBody: '', rawBody: '' });

    // window=3 admits the three newest dates (NOW, NOW, NOW-DAY), so 'bodyless'
    // is INSIDE the window and dropped by the body test alone — both terms have
    // to survive the reorder, not just the cheap one.
    expect(idsOf(repo.getEmailsPendingExtraction(50, 3))).toEqual(['newest', 'older']);
    expect(repo.countExtractionEligible(3)).toBe(2);
    // A limit smaller than the window must still cut by the limit: if the two
    // `?` ever swap, this silently returns a different slice of the mailbox.
    expect(repo.getEmailsPendingExtraction(1, 3).map((e) => e.id)).toEqual(['newest']);
  });

  // The has-body term has two forms now — the stored-length test, and the
  // body-reading fallback used until this database's background backfill proves
  // no NULL length remains. Which one is emitted is a performance decision and
  // must never be a correctness one: the counters, the selectors and the heal
  // have to agree on exactly the same rows either way. If they don't, the
  // symptom is the original bug wearing a new hat — mail counted as pending that
  // the worker cannot see, or worse, mail with a body that the worker skips
  // because a NULL length was read as "no body".
  describe('the two has-body forms are interchangeable', () => {
    const makeUnbackfilled = (): void => {
      db.exec('UPDATE emails SET clean_body_len = NULL, raw_body_len = NULL');
      db.prepare(
        "UPDATE email_body_metrics_state SET value = '0' WHERE key = 'lengths_backfilled'",
      ).run();
    };

    beforeEach(() => {
      seedEmail(db, { id: 'with-body', extractionStatus: 'pending', agentStatus: 'pending' });
      // HTML-only mail: no plain-text body, content lives in raw_body. Gating on
      // clean_body alone strands every marketing send.
      seedEmail(db, {
        id: 'html-only', extractionStatus: 'pending', agentStatus: 'pending',
        cleanBody: '', rawBody: '<p>hi</p>',
      });
      seedEmail(db, {
        id: 'bodyless', extractionStatus: 'pending', agentStatus: 'pending',
        cleanBody: '', rawBody: '',
      });
    });

    it('selects the same rows and the same counts with the columns populated', () => {
      expect(idsOf(repo.getEmailsPendingExtraction(50))).toEqual(['html-only', 'with-body']);
      expect(repo.countExtractionEligible()).toBe(2);
    });

    it('selects the same rows and counts while the backfill has not run', () => {
      makeUnbackfilled();
      expect(idsOf(repo.getEmailsPendingExtraction(50))).toEqual(['html-only', 'with-body']);
      expect(repo.countExtractionEligible()).toBe(2);
    });

    // The interim must not be paved over by treating unknown as absent: a row
    // with a real body and a NULL length is a row the pipeline would abandon.
    it('emits the body-reading form (not the stored-length one) until the DB is ready', () => {
      makeUnbackfilled();
      const sql = sqlOf(() => repo.countExtractionEligible());
      expect(sql).toContain('LENGTH(TRIM(');
      expect(sql).not.toContain('clean_body_len');
    });

    it('emits the stored-length form, naming no body column, once the DB is ready', () => {
      const sql = sqlOf(() => repo.countExtractionEligible());
      expect(sql).toContain('clean_body_len');
      expect(sql).not.toContain('LENGTH(TRIM(');
    });
  });
});

describe('agent eligibility — self-heal of stuck rows', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  // Read/spam/trash mail left 'pending' is what inflated the backlog forever.
  // It is never going to be categorized, so it must be finalized on sight.
  it('finalizes disqualified mail immediately', () => {
    seedEmail(db, { id: 'read', tags: '|INBOX|read|' });
    seedEmail(db, { id: 'junk', tags: '|Junk|' });
    seedEmail(db, { id: 'keep' });

    const healed = repo.healStuckPipelineRows(7 * DAY, NOW);

    expect(healed.disqualified).toBe(2);
    const status = (id: string) =>
      (db.prepare('SELECT agent_status AS s FROM emails WHERE id = ?').get(id) as { s: string }).s;
    expect(status('read')).toBe('done');
    expect(status('junk')).toBe('done');
    expect(status('keep')).toBe('pending'); // still real work — must survive
  });

  // A body-less mail that just arrived is NOT stuck: the download is likely
  // still queued, and phase 1 picks it up the moment it lands. Finalizing it
  // here would silently un-categorize mail that was about to be processed.
  it('leaves a recently-arrived body-less mail alone', () => {
    seedEmail(db, { id: 'fresh', cleanBody: '', rawBody: '', date: NOW - DAY });

    const healed = repo.healStuckPipelineRows(7 * DAY, NOW);

    expect(healed.abandoned).toBe(0);
    expect(repo.getStuckPipelineRows(10)).toEqual([
      expect.objectContaining({ id: 'fresh', reason: 'no-body' }),
    ]);
  });

  // Past the age limit the body is never coming (see the known body-fetch
  // failure modes). Finalize it so it cannot park the progress bar below 100%.
  it('gives up on a body-less mail older than the age limit', () => {
    seedEmail(db, { id: 'ancient', cleanBody: '', rawBody: '', date: NOW - 8 * DAY });

    const healed = repo.healStuckPipelineRows(7 * DAY, NOW);

    expect(healed.abandoned).toBe(1);
    expect(repo.getStuckPipelineRows(10)).toHaveLength(0);
    expect(repo.countAgentEligible()).toBe(0);
  });

  // Re-running the heal must not double-apply or churn rows — the poll calls it
  // on every maintenance tick, forever.
  it('is idempotent across repeated runs', () => {
    seedEmail(db, { id: 'read', tags: '|INBOX|read|' });
    // extraction still pending as well, so all three heal buckets fire on the
    // first pass and all three must report zero on the second.
    seedEmail(db, {
      id: 'ancient', cleanBody: '', rawBody: '', date: NOW - 8 * DAY, extractionStatus: 'pending',
    });

    const first = repo.healStuckPipelineRows(7 * DAY, NOW);
    const second = repo.healStuckPipelineRows(7 * DAY, NOW);

    expect(first).toEqual({ disqualified: 1, abandoned: 1, extractionAbandoned: 1 });
    expect(second).toEqual({ disqualified: 0, abandoned: 0, extractionAbandoned: 0 });
  });

  // A row awaiting extraction but WITH a body is phase 1's job, not limbo.
  // Reporting it as stuck would make the heal finalize real work.
  it('does not treat body-having, extraction-pending mail as stuck', () => {
    seedEmail(db, { id: 'awaiting-extraction', extractionStatus: 'pending' });

    expect(repo.getStuckPipelineRows(10)).toHaveLength(0);
    expect(repo.healStuckPipelineRows(7 * DAY, NOW))
      .toEqual({ disqualified: 0, abandoned: 0, extractionAbandoned: 0 });
    // Phase 1 must still see it, so it can advance to phase 2.
    expect(idsOf(repo.getEmailsPendingExtraction(50))).toEqual(['awaiting-extraction']);
  });

  // Each account has its own database. Healing one must never reach into
  // another — a shared-state bug here would finalize a second account's mail.
  it('heals only the account it is called on', () => {
    const otherDb = newMigratedDb();
    const otherRepo = new AgentRepository(() => otherDb);
    seedEmail(db, { id: 'read', tags: '|INBOX|read|' });
    seedEmail(otherDb, { id: 'read', tags: '|INBOX|read|' });

    repo.healStuckPipelineRows(7 * DAY, NOW);

    expect(otherRepo.getStuckPipelineRows(10)).toHaveLength(1);
  });
});

// Phase 1 is the gate in front of phase 2, so the same counted-vs-selectable
// split here is worse: a row wedged in extraction never even reaches the
// categorizer. The poll's extraction counter was a bare
// `extraction_status='pending'` while the selector required a body.
describe('extraction eligibility — counter and selector agree', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  it('counts exactly the rows phase 1 can select', () => {
    seedEmail(db, { id: 'ready', extractionStatus: 'pending' });
    seedEmail(db, { id: 'no-body', extractionStatus: 'pending', cleanBody: '', rawBody: '' });
    seedEmail(db, { id: 'extracted', extractionStatus: 'done' });

    expect(idsOf(repo.getEmailsPendingExtraction(50))).toEqual(['ready']);
    expect(repo.countExtractionEligible()).toBe(1);
  });

  // Extraction is tag-blind by design — the read/spam/trash gate belongs to
  // phase 2. If the counter excluded tags but the selector did not, we would
  // have re-created the drift pointing the other way: rows worked but never
  // counted, so the bar would report done while work was still running.
  it('counts read and spam mail that phase 1 still selects', () => {
    seedEmail(db, { id: 'read', tags: '|INBOX|read|', extractionStatus: 'pending' });
    seedEmail(db, { id: 'spam', tags: '|Spam|', extractionStatus: 'pending' });

    expect(idsOf(repo.getEmailsPendingExtraction(50))).toEqual(['read', 'spam']);
    expect(repo.countExtractionEligible()).toBe(2);
  });

  it('applies the recent-window bound to both count and selection', () => {
    seedEmail(db, { id: 'newest', extractionStatus: 'pending' });
    seedEmail(db, { id: 'older', extractionStatus: 'pending', date: NOW - DAY });
    seedEmail(db, { id: 'oldest', extractionStatus: 'pending', date: NOW - 2 * DAY });

    expect(idsOf(repo.getEmailsPendingExtraction(50, 2))).toEqual(['newest', 'older']);
    expect(repo.countExtractionEligible(2)).toBe(2);
  });

  // A body-less row is phase-1 limbo, healed on the same age rule as phase 2:
  // untouched while the download might still land, finalized once it cannot.
  it('reports a body-less pending-extraction row as stuck and heals it by age', () => {
    seedEmail(db, { id: 'fresh', extractionStatus: 'pending', cleanBody: '', rawBody: '', date: NOW - DAY });
    seedEmail(db, { id: 'ancient', extractionStatus: 'pending', cleanBody: '', rawBody: '', date: NOW - 8 * DAY });

    expect(repo.getStuckPipelineRows(10).map((r) => r.id).sort()).toEqual(['ancient', 'fresh']);

    const healed = repo.healStuckPipelineRows(7 * DAY, NOW);

    expect(healed.extractionAbandoned).toBe(1);
    const extraction = (id: string) => (db
      .prepare('SELECT extraction_status AS s FROM emails WHERE id = ?')
      .get(id) as { s: string }).s;
    expect(extraction('ancient')).toBe('done');
    expect(extraction('fresh')).toBe('pending'); // body may still arrive
  });
});

// The user-visible symptom was never the log line — it was the progress bar
// parked at 98% with nothing running. That bar is
// `categorized / (categorized + unprocessed)`, and "unprocessed" is
// `ai_processed_at IS NULL` — a DIFFERENT column from the `agent_status` the
// pipeline finalizes on. Every give-up path must move both, or the row sits in
// the denominator forever and the percentage can never reach 100.
describe('give-up finalization reaches the progress bar', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  const unprocessed = (): number => (db.prepare(`
    SELECT COUNT(*) AS n FROM emails
    WHERE ai_processed_at IS NULL
      AND ((clean_body IS NOT NULL AND LENGTH(TRIM(clean_body)) > 0)
        OR (raw_body IS NOT NULL AND LENGTH(TRIM(raw_body)) > 0))
      AND instr(tags, '|read|') = 0
      AND instr(tags, '|Spam|') = 0
      AND instr(tags, '|Junk|') = 0
      AND instr(tags, '|Trash|') = 0
  `).get() as { n: number }).n;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  it('markAgentGaveUp clears the row from the progress denominator', () => {
    seedEmail(db, { id: 'doomed' });
    expect(unprocessed()).toBe(1);

    repo.markAgentGaveUp('doomed', { priorityScore: 42, priorityTier: 'low' });

    expect(unprocessed()).toBe(0); // the bar can now reach 100%
    const row = db.prepare('SELECT agent_status AS s, priority_score AS p FROM emails WHERE id = ?')
      .get('doomed') as { s: string; p: number };
    expect(row.s).toBe('done');
    expect(row.p).toBe(42); // local behaviour score survives — Important-sort keeps working
  });

  // Back-dating a real categorization's timestamp with a later give-up would
  // corrupt "when was this processed" for a row that WAS processed.
  it('never overwrites an existing ai_processed_at', () => {
    seedEmail(db, { id: 'already' });
    db.prepare('UPDATE emails SET ai_processed_at = 111 WHERE id = ?').run('already');

    repo.markAgentGaveUp('already', {});

    const at = (db.prepare('SELECT ai_processed_at AS a FROM emails WHERE id = ?')
      .get('already') as { a: number }).a;
    expect(at).toBe(111);
  });

  // Regression (perf, measured): this used to be markAgentDone() followed by a
  // second UPDATE for ai_processed_at. Bodies are stored INLINE in `emails`, so a
  // row averages ~250 KB and SQLite cannot update a field of a spilled record in
  // place — it rewrites the whole record and its overflow chain. Two statements
  // paid that twice for ONE logical event, on the AI pipeline's per-email hot
  // path. If a future edit splits it again, nothing breaks functionally and the
  // cost is invisible in a test-sized DB; only this assertion catches it.
  it('writes the row ONCE, not twice', () => {
    seedEmail(db, { id: 'once' });
    const realPrepare = db.prepare.bind(db);
    const writes: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = (sql: string) => {
      if (/^\s*UPDATE\s+emails/i.test(sql)) writes.push(sql);
      return realPrepare(sql);
    };

    try {
      repo.markAgentGaveUp('once', { priorityScore: 7, priorityTier: 'low' });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).prepare = realPrepare;
    }

    expect(writes).toHaveLength(1);
    // …and that one statement carries BOTH halves of the give-up.
    expect(writes[0]).toMatch(/agent_status\s*=\s*'done'/);
    expect(writes[0]).toMatch(/ai_processed_at\s*=\s*COALESCE\(ai_processed_at,/);
  });

  // Every field the caller passes must land, and every field it omits must be
  // preserved (COALESCE). A give-up that blanked priority_tier or
  // recommended_action would erase a real earlier categorization's result, so the
  // Important sort and the action chip would silently empty out.
  it('stores what the caller passed and preserves what it omitted', () => {
    seedEmail(db, { id: 'partial' });

    repo.markAgentGaveUp('partial', {
      priorityScore: 91,
      priorityTier: 'critical',
      priorityReasoning: 'sender is a known customer',
      recommendedAction: 'reply',
    });
    repo.markAgentGaveUp('partial', { priorityScore: 55 }); // the rest omitted

    const row = db.prepare(`
      SELECT priority_score AS score, priority_tier AS tier,
             priority_reasoning AS reasoning, recommended_action AS action,
             agent_at AS agentAt
        FROM emails WHERE id = ?
    `).get('partial') as {
      score: number; tier: string; reasoning: string; action: string; agentAt: number;
    };

    expect(row.score).toBe(55);                              // overwritten
    expect(row.tier).toBe('critical');                       // preserved
    expect(row.reasoning).toBe('sender is a known customer'); // preserved
    expect(row.action).toBe('reply');                        // preserved
    expect(row.agentAt).toBeGreaterThan(0);                  // give-up is timestamped
  });

  // Healing agent_status alone would silence the poll's log while leaving the
  // user staring at the same stuck percentage — fixing the symptom we can see
  // and not the one they can.
  it('the heal also clears healed rows from the progress denominator', () => {
    seedEmail(db, { id: 'junk-pending', tags: '|Junk|' });
    seedEmail(db, { id: 'ancient', cleanBody: '', rawBody: '', date: NOW - 8 * DAY });
    seedEmail(db, { id: 'real-work' });

    repo.healStuckPipelineRows(7 * DAY, NOW);

    // 'junk-pending' was already outside the denominator (tag-excluded);
    // 'real-work' is legitimately still pending. Neither healed row may leave
    // an ai_processed_at IS NULL row behind that nothing will ever revisit.
    expect(unprocessed()).toBe(1);
    const stampedAncient = (db.prepare('SELECT ai_processed_at AS a FROM emails WHERE id = ?')
      .get('ancient') as { a: number | null }).a;
    expect(stampedAncient).toBe(NOW);
  });
});

describe('re-queue on AI re-enable cannot create a stuck row', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  // The requeue used to carry its own copy of the tag list, and that copy was
  // missing '|Junk|'. So re-enabling AI put junk mail back to 'pending' that
  // getEmailsPendingAgent then refused to select — manufacturing exactly the
  // limbo the heal exists to clear, on a user action, every time.
  it('re-queues only rows the worker can then select', () => {
    seedEmail(db, { id: 'inbox', tags: '|INBOX|', agentStatus: 'done' });
    seedEmail(db, { id: 'junk', tags: '|INBOX|Junk|', agentStatus: 'done' });
    seedEmail(db, { id: 'read', tags: '|INBOX|read|', agentStatus: 'done' });
    seedEmail(db, { id: 'bodyless', tags: '|INBOX|', agentStatus: 'done', cleanBody: '', rawBody: '' });

    expect(repo.requeueRecentInboxForAgent(500)).toBe(1);

    expect(idsOf(repo.getEmailsPendingAgent(50))).toEqual(['inbox']);
    expect(repo.countAgentEligible()).toBe(1);
    expect(repo.getStuckPipelineRows(10)).toHaveLength(0);
  });

  // A row that gave up under a broken provider must get a genuine fresh set of
  // attempts once AI works again. Resuming at its old strike count would make
  // it give up on the very first pass and stay uncategorized forever.
  it('clears both failure counters on the rows it re-queues', () => {
    seedEmail(db, { id: 'burned', tags: '|INBOX|', agentStatus: 'done' });
    db.prepare('UPDATE emails SET ai_parse_failure_count = 3, ai_agent_failure_count = 10 WHERE id = ?')
      .run('burned');

    repo.requeueRecentInboxForAgent(500);

    const row = db.prepare(
      'SELECT ai_parse_failure_count AS p, ai_agent_failure_count AS a FROM emails WHERE id = ?',
    ).get('burned') as { p: number; a: number };
    expect(row).toEqual({ p: 0, a: 0 });
  });
});

// The whole-system invariant, asserted over every combination of the shapes
// that reach the pipeline rather than one example at a time: whatever the
// mailbox looks like, the numbers shown must equal the work available, and one
// heal pass must leave nothing that is counted but unworkable. If a future
// change adds a shape that breaks that, this fails without anyone having
// thought to write a case for it.
describe('convergence — the backlog always drains to zero', () => {
  let db: Database.Database;
  let repo: AgentRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new AgentRepository(() => db);
    uidSeq = 0;
  });

  const TAG_SHAPES = ['|INBOX|', '|INBOX|read|', '|Spam|', '|Junk|', '|Trash|', '|[Gmail]/Spam|'];
  const BODY_SHAPES: Array<[string, string]> = [
    ['body text', 'body text'],
    ['', '<p>html only</p>'],
    ['', ''],
    ['   ', '   '],
  ];
  const AGES = [0, 8 * DAY];

  const seedEveryShape = (): void => {
    let n = 0;
    for (const tags of TAG_SHAPES) {
      for (const [cleanBody, rawBody] of BODY_SHAPES) {
        for (const age of AGES) {
          for (const extractionStatus of ['pending', 'done']) {
            seedEmail(db, {
              id: `shape-${n++}`, tags, cleanBody, rawBody,
              date: NOW - age, extractionStatus,
            });
          }
        }
      }
    }
  };

  it('every counter equals what its phase can actually select', () => {
    seedEveryShape();

    expect(repo.countAgentEligible()).toBe(repo.getEmailsPendingAgent(10_000).length);
    expect(repo.countExtractionEligible()).toBe(repo.getEmailsPendingExtraction(10_000).length);

    // And the log line's figures must agree with those same predicates, or the
    // log tells one story while the worker lives another.
    const stats = repo.getPipelineStats();
    expect(stats.agentPending).toBe(repo.countAgentEligible());
    expect(stats.extractionPending).toBe(repo.countExtractionEligible());
  });

  /** One poll tick at `clock`: heal, then finish everything each phase offers.
   *  Returns how many rows the two phases handed out. */
  const runTick = (clock: number): number => {
    repo.healStuckPipelineRows(7 * DAY, clock);
    const extraction = repo.getEmailsPendingExtraction(10_000);
    extraction.forEach((e) => repo.markExtractionDone(e.id));
    const agent = repo.getEmailsPendingAgent(10_000);
    agent.forEach((e) => repo.markAgentDone(e.id, { priorityScore: 1 }));
    return extraction.length + agent.length;
  };

  // Drains everything selectable, then asserts the bar is ALREADY at 100% even
  // though some rows are still 'pending'. Those are the body-less arrivals the
  // heal deliberately spares in case the download lands — they must not be
  // counted while they wait, or the bar sits at 98% on mail that is not late
  // yet. This is the exact "counted but unworkable" split, in its benign form.
  it('parks a body-less new arrival without letting it hold the bar back', () => {
    seedEveryShape();

    while (runTick(NOW) > 0) { /* drain */ }

    expect(repo.countAgentEligible()).toBe(0);
    expect(repo.countExtractionEligible()).toBe(0);
    expect(repo.getPipelineStats().agentPending).toBe(0);

    // Still parked, on purpose — and every one of them is waiting on a body.
    const parked = repo.getStuckPipelineRows(100);
    expect(parked.length).toBeGreaterThan(0);
    expect(parked.every((r) => r.reason !== 'disqualified')).toBe(true);
  });

  // The termination proof. Let the clock run past the give-up age and every
  // parked row must finalize too — no shape survives as permanent backlog. A
  // bounded pass count matters as much as the end state: a design that only
  // settles after thousands of ticks would still look stuck to the user.
  it('finalizes every shape once the give-up age passes', () => {
    seedEveryShape();

    let passes = 0;
    let clock = NOW;
    for (; passes < 10; passes++) {
      clock += 2 * DAY; // the poll keeps running while mail ages out
      if (runTick(clock) === 0 && repo.getStuckPipelineRows(1).length === 0) break;
    }

    expect(passes).toBeLessThan(10);
    expect(repo.countAgentEligible()).toBe(0);
    expect(repo.countExtractionEligible()).toBe(0);
    expect(repo.getStuckPipelineRows(50)).toHaveLength(0);

    // No row left 'pending' in either phase — a leftover is invisible backlog
    // that no counter reports and no worker drains.
    const stillPending = (db.prepare(`
      SELECT COUNT(*) AS n FROM emails
      WHERE agent_status = 'pending' OR extraction_status = 'pending'
    `).get() as { n: number }).n;
    expect(stillPending).toBe(0);

    // Idempotent at rest: another full tick changes nothing.
    expect(repo.healStuckPipelineRows(7 * DAY, clock))
      .toEqual({ disqualified: 0, abandoned: 0, extractionAbandoned: 0 });
  });
});
