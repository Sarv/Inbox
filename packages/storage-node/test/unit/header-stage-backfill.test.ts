import { describe, expect, it } from 'vitest';

import { HEADER_STAGE_MAX_ATTEMPTS } from '../../src/migrations';
import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Storage side of the header backfill.
 *
 * What this protects: the backlog query decides which rows get a fetch and the
 * batch write decides which rows leave the backlog. A row that is retried
 * forever (no uid, or own mail that can never be scored), or a verdict that
 * overwrites one the sync already recorded, would both be silent — this pins
 * the contract the scheduler relies on.
 */
let n = 0;
const seed = (
  db: ReturnType<typeof newMigratedDb>,
  folderId: string,
  opts: { uid?: number | null; auth?: string | null; spam?: number | null; date?: number } = {},
) => {
  n += 1;
  db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, 's', ?, ?, 1)`)
    .run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       raw_body, clean_body, raw_body_len, clean_body_len, content_type, content_hash, auth_status, spam_score)
     VALUES (?, ?, ?, ?, ?, '|INBOX|', 's', 'a@b.com', ?, '', '', 0, 0, 'text', ?, ?, ?)`,
  ).run(
    `e${n}`, `<m${n}@x>`, `t${n}`, folderId,
    opts.uid === undefined ? n : opts.uid,
    opts.date ?? n, `h${n}`, opts.auth ?? null, opts.spam ?? null,
  );
  return `e${n}`;
};

const storage = () => {
  n = 0;
  const db = newMigratedDb();
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX'), ('f2','Archive','Archive'), ('f3','Sent','Sent')`).run();
  const s = Object.create(SQLiteStorage.prototype) as SQLiteStorage;
  (s as unknown as { db: unknown }).db = db;
  (s as unknown as { ensureInitialized: () => void }).ensureInitialized = () => {};
  return { s, db };
};

describe('getEmailsMissingHeaderStage', () => {
  it('lists rows missing either verdict, newest first, with their folder path and id', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: 10, date: 100 });
    seed(db, 'f2', { uid: 20, date: 300 });
    seed(db, 'f1', { uid: 30, date: 200, auth: '{"overall":"pass"}', spam: 2 }); // fully decided

    const rows = s.getEmailsMissingHeaderStage(50);
    expect(rows.map((r) => [r.uid, r.folderPath, r.folderId])).toEqual([[20, 'Archive', 'f2'], [10, 'INBOX', 'f1']]);
  });

  // The two halves are independent: a row that has one verdict and not the
  // other is still work. Requiring both to be NULL would have left every
  // pre-v86 message with an auth verdict permanently unscored.
  it('selects a row that has an auth verdict but no spam score, and vice versa', () => {
    const { s, db } = storage();
    const scoredOnly = seed(db, 'f1', { uid: 1, spam: 4 });
    const authOnly = seed(db, 'f1', { uid: 2, auth: '{"overall":"pass"}' });
    expect(new Set(s.getEmailsMissingHeaderStage(50).map((r) => r.id))).toEqual(new Set([scoredOnly, authOnly]));
  });

  // Own mail is deliberately never spam-scored, so `spam_score IS NULL` can
  // never be satisfied for it. Left in the spam half of the predicate, Sent and
  // Drafts would be fetched, declined and reselected every 1.5 seconds forever.
  it('keeps own mail out of the spam half once it has its auth verdict', () => {
    const { s, db } = storage();
    seed(db, 'f3', { uid: 1, auth: '{"overall":"pass"}' }); // Sent, already verified, never scorable
    expect(s.getEmailsMissingHeaderStage(50, ['f3'])).toEqual([]);
    expect(s.countEmailsMissingHeaderStage(['f3'])).toBe(0);
  });

  // ...but own mail with no auth verdict IS work: a Sent message's SPF/DKIM
  // result is worth reading like any other message's.
  it('still selects own mail that has no auth verdict yet', () => {
    const { s, db } = storage();
    const sent = seed(db, 'f3', { uid: 1 });
    expect(s.getEmailsMissingHeaderStage(50, ['f3']).map((r) => r.id)).toEqual([sent]);
  });

  // A relinked row has no uid; it cannot be fetched by uid and would otherwise
  // be handed to the scheduler on every tick forever.
  it('excludes rows with no uid rather than retrying them forever', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: null });
    seed(db, 'f1', { uid: 5 });
    expect(s.getEmailsMissingHeaderStage(50).map((r) => r.uid)).toEqual([5]);
    expect(s.countEmailsMissingHeaderStage()).toBe(1);
  });

  // A locally-appended Sent/Drafts copy has uid 0 — the server never numbered
  // it. It cannot be fetched by uid any more than a NULL can, and letting it
  // through parked the live status line at "7 to go" after everything else
  // had drained.
  it('treats uid 0 like a missing uid', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: 0 });
    seed(db, 'f1', { uid: 7 });
    expect(s.getEmailsMissingHeaderStage(50).map((r) => r.uid)).toEqual([7]);
    expect(s.countEmailsMissingHeaderStage()).toBe(1);
  });

  it('honours the limit', () => {
    const { s, db } = storage();
    for (let i = 0; i < 5; i++) seed(db, 'f1');
    expect(s.getEmailsMissingHeaderStage(2)).toHaveLength(2);
  });
});

describe('updateEmailHeaderStageBatch', () => {
  it('writes every row in one transaction and reports the count', () => {
    const { s, db } = storage();
    const a = seed(db, 'f1'); const b = seed(db, 'f1');
    const written = s.updateEmailHeaderStageBatch([
      { id: a, authStatus: '{"overall":"pass"}', spamScore: 0, spamReasons: '[]', originIp: '203.0.113.1' },
      { id: b, authStatus: '{"overall":"none"}', spamScore: 7, spamReasons: '["X"]', originIp: null },
    ]);
    expect(written).toBe(2);
    expect(s.countEmailsMissingHeaderStage()).toBe(0);
    const stored = db.prepare(`SELECT spam_score, spam_reasons, origin_ip FROM emails WHERE id = ?`).get(b) as
      { spam_score: number; spam_reasons: string; origin_ip: string | null };
    expect(stored).toEqual({ spam_score: 7, spam_reasons: '["X"]', origin_ip: null });
  });

  // THE guard. The sync records verdicts at insert for new mail; if the
  // backfill's slice was read before that insert, its write must not clobber
  // the fresher value — per column, so filling one gap cannot restate another.
  it('never overwrites a verdict that already exists, and still fills the gaps beside it', () => {
    const { s, db } = storage();
    const a = seed(db, 'f1', { auth: '{"overall":"pass"}', spam: 1 });
    const written = s.updateEmailHeaderStageBatch([
      { id: a, authStatus: '{"overall":"fail"}', spamScore: 9, spamReasons: '["LATE"]', originIp: '198.51.100.7' },
    ]);
    expect(written).toBe(1); // origin_ip was a real gap
    const stored = db.prepare(`SELECT auth_status, spam_score, origin_ip FROM emails WHERE id = ?`).get(a) as
      { auth_status: string; spam_score: number; origin_ip: string };
    expect(stored.auth_status).toBe('{"overall":"pass"}');
    expect(stored.spam_score).toBe(1);
    expect(stored.origin_ip).toBe('198.51.100.7');
  });

  // Without the WHERE guard SQLite counts a no-op UPDATE as a change, and the
  // progress line would claim work it did not do.
  it('reports nothing written for a row that had no gap at all', () => {
    const { s, db } = storage();
    const a = seed(db, 'f1', { auth: '{"overall":"pass"}', spam: 1 });
    db.prepare(`UPDATE emails SET origin_ip = '203.0.113.5' WHERE id = ?`).run(a);
    expect(s.updateEmailHeaderStageBatch([
      { id: a, authStatus: '{"overall":"fail"}', spamScore: 9, spamReasons: '["LATE"]', originIp: '198.51.100.7' },
    ])).toBe(0);
  });

  // Own mail is written with a null score on purpose. It must leave the backlog
  // on the strength of its auth verdict alone.
  it('accepts a null spam score for own mail and drains the row', () => {
    const { s, db } = storage();
    const sent = seed(db, 'f3', { uid: 4 });
    expect(s.updateEmailHeaderStageBatch([
      { id: sent, authStatus: '{"overall":"pass"}', spamScore: null, spamReasons: null, originIp: '203.0.113.2' },
    ])).toBe(1);
    expect(db.prepare(`SELECT spam_score FROM emails WHERE id = ?`).get(sent)).toEqual({ spam_score: null });
    expect(s.countEmailsMissingHeaderStage(['f3'])).toBe(0);
  });

  it('is a no-op for an empty batch', () => {
    const { s } = storage();
    expect(s.updateEmailHeaderStageBatch([])).toBe(0);
  });
});

describe('a backlog the server cannot satisfy', () => {
  // THE regression: a uid the server no longer has can never be written, so
  // before the attempt counter the sweep selected it, fetched it, wrote
  // nothing and did it again 1.5s later for as long as the app ran — silently,
  // at 12.7% of the main process. A row must run out of tries.
  it('retires a row after HEADER_STAGE_MAX_ATTEMPTS fruitless attempts', () => {
    const { s, db } = storage();
    const doomed = seed(db, 'f1', { uid: 9 });
    for (let attempt = 1; attempt <= HEADER_STAGE_MAX_ATTEMPTS; attempt += 1) {
      expect(s.countEmailsMissingHeaderStage()).toBe(1); // still worth asking
      s.recordHeaderStageMiss([doomed]);
    }
    expect(s.getEmailsMissingHeaderStage(50)).toEqual([]);
    expect(s.countEmailsMissingHeaderStage()).toBe(0);
    // Retired, not answered: the columns still say "never checked", which is
    // the truth. Only the asking stopped.
    expect(db.prepare('SELECT auth_status, spam_score FROM emails WHERE id = ?').get(doomed))
      .toEqual({ auth_status: null, spam_score: null });
  });

  it('counts one attempt per id and reports how many rows it touched', () => {
    const { s, db } = storage();
    const first = seed(db, 'f1', { uid: 1 });
    const second = seed(db, 'f1', { uid: 2 });
    expect(s.recordHeaderStageMiss([first, second, 'no-such-row'])).toBe(2);
    expect(db.prepare('SELECT header_stage_attempts AS a FROM emails WHERE id = ?').get(first)).toEqual({ a: 1 });
    expect(db.prepare('SELECT header_stage_attempts AS a FROM emails WHERE id = ?').get(second)).toEqual({ a: 1 });
  });

  it('is a no-op for an empty list', () => {
    const { s } = storage();
    expect(s.recordHeaderStageMiss([])).toBe(0);
  });

  // A blip is not an expunge. One miss must leave the row in the backlog, or a
  // dropped connection would silently retire a mailbox's worth of real mail.
  it('keeps a row that has missed fewer times than the limit', () => {
    const { s, db } = storage();
    const blipped = seed(db, 'f1', { uid: 3 });
    s.recordHeaderStageMiss([blipped]);
    expect(s.getEmailsMissingHeaderStage(50).map((r) => r.id)).toEqual([blipped]);
  });
});

describe('the backlog queries stay off the mail table', () => {
  // THE reason this change exists. The predicate was one `OR`, no index
  // covered either column, and both queries scanned all 26,700 rows on every
  // tick — 8.9 seconds of synchronous SQLite per 70 seconds, measured on the
  // main process, as 300-500ms of frozen UI at a time. SQLite only uses a
  // partial index when the query's WHERE implies the index's, so a one-term
  // drift between the clause helpers and the migration would not fail any
  // other test: it would quietly restore the full scan. This asserts the plan.
  it('plans every backlog query through a partial index, never a table scan', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: 1 });
    const statements: string[] = [];
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      statements.push(sql);
      return realPrepare(sql);
    };
    s.countEmailsMissingHeaderStage(['f3']);
    s.getEmailsMissingHeaderStage(50, ['f3']);
    (db as unknown as { prepare: unknown }).prepare = realPrepare;

    expect(statements).toHaveLength(4); // two halves, twice
    for (const sql of statements) {
      const params = new Array((sql.match(/\?/g) ?? []).length).fill('f3');
      const plan = (realPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((step) => step.detail)
        .join(' | ');
      expect(plan).toMatch(/idx_emails_(auth|spam)_pending/);
      expect(plan).not.toMatch(/SCAN emails\b|SCAN e\b(?! USING)/);
      expect(plan).not.toContain('USE TEMP B-TREE'); // the index already supplies date DESC
    }
  });
});
