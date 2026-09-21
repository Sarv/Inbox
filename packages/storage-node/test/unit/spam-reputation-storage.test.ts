import { describe, expect, it } from 'vitest';

import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Storage side of the spam filter's reputation stage (migration v87).
 *
 * What this protects: the pending query decides which rows are judged and the
 * batch stamp decides which leave the queue. A row selected forever (no uid,
 * never stamped) would be looked up on every tick; a stamp that overwrote a
 * later judgement, or added the same points twice on a retried batch, would
 * make a score drift upward with every restart.
 */
let n = 0;
const seed = (db: ReturnType<typeof newMigratedDb>, opts: {
  uid?: number | null; score?: number | null; checked?: number | null; date?: number; ip?: string | null;
  body?: string | null; bodyLen?: number | null; linkChecked?: number | null; verdict?: 'spam' | 'ham' | null; tags?: string;
} = {}) => {
  n += 1;
  db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, 's', ?, ?, 1)`)
    .run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
  const body = opts.body ?? '';
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, reply_to, date,
       raw_body, clean_body, raw_body_len, clean_body_len, content_type, content_hash, spam_score, spam_reasons, origin_ip,
       reputation_checked_at, link_reputation_checked_at, spam_user_verdict)
     VALUES (?, ?, ?, 'f1', ?, ?, 's', 'a@b.com', 'r@c.com', ?, ?, '', ?, 0, 'text', ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(`e${n}`, `<m${n}@x>`, `t${n}`, opts.uid === undefined ? n : opts.uid, opts.tags ?? '|INBOX|', opts.date ?? n, body,
    opts.bodyLen === undefined ? body.length : opts.bodyLen, `h${n}`,
    opts.score === undefined ? 0 : opts.score, opts.ip === undefined ? '8.8.8.8' : opts.ip, opts.checked ?? null,
    opts.linkChecked ?? null, opts.verdict ?? null);
  return `e${n}`;
};
const storage = () => {
  n = 0;
  const db = newMigratedDb();
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX')`).run();
  const s = Object.create(SQLiteStorage.prototype) as SQLiteStorage;
  (s as unknown as { db: unknown }).db = db;
  (s as unknown as { ensureInitialized: () => void }).ensureInitialized = () => {};
  return { s, db };
};

describe('v87 schema', () => {
  it('adds reputation_checked_at and the partial index over the waiting rows', () => {
    const db = newMigratedDb();
    const cols = (db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('reputation_checked_at');
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_emails_reputation_pending'`).get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/WHERE reputation_checked_at IS NULL AND spam_score IS NOT NULL/);
  });
});

describe('getEmailsPendingReputation', () => {
  it('lists unjudged, header-scored rows newest first with what the lookup needs', () => {
    const { s, db } = storage();
    seed(db, { date: 100, score: 2 });
    seed(db, { date: 300, score: 0 });
    seed(db, { date: 200, score: 5, checked: 1 }); // already judged
    seed(db, { date: 400, score: null }); // never scored by the header stage (own mail)

    const rows = s.getEmailsPendingReputation(10);
    expect(rows.map((r) => [r.spamScore, r.folderPath, r.originIp, r.replyTo])).toEqual([[0, 'INBOX', '8.8.8.8', 'r@c.com'], [2, 'INBOX', '8.8.8.8', 'r@c.com']]);
    expect(s.countEmailsPendingReputation()).toBe(2);
  });

  // A row without a server uid cannot be re-filed on the server; it must not
  // be handed to the stage on every tick forever.
  it('skips rows with no uid and honours the limit', () => {
    const { s, db } = storage();
    seed(db, { uid: null });
    seed(db, { uid: 0 });
    seed(db, { uid: 5 });
    seed(db, { uid: 6 });
    expect(s.getEmailsPendingReputation(10).map((r) => r.uid).sort()).toEqual([5, 6]);
    expect(s.getEmailsPendingReputation(1)).toHaveLength(1);
    expect(s.countEmailsPendingReputation()).toBe(2);
  });
});

describe('applyReputationBatch', () => {
  it('writes score and reasons and stamps the rows, in one transaction', () => {
    const { s, db } = storage();
    const a = seed(db, { score: 2 }); const b = seed(db, { score: 0 });
    const written = s.applyReputationBatch([
      { id: a, spamScore: 7, spamReasons: '[{"id":"ip-blocklisted","points":5,"detail":"x"}]' },
      { id: b, spamScore: 0, spamReasons: '[]' },
    ], 1_700_000_000);
    expect(written).toBe(2);
    expect(s.countEmailsPendingReputation()).toBe(0);
    const row = db.prepare('SELECT spam_score, spam_reasons, reputation_checked_at FROM emails WHERE id = ?').get(a) as Record<string, unknown>;
    expect(row).toEqual({ spam_score: 7, spam_reasons: '[{"id":"ip-blocklisted","points":5,"detail":"x"}]', reputation_checked_at: 1_700_000_000 });
  });

  // THE idempotence guard: a batch replayed after a crash must not add the
  // same points a second time or move the stamp.
  it('never touches a row that was already judged', () => {
    const { s, db } = storage();
    const a = seed(db, { score: 2 });
    expect(s.applyReputationBatch([{ id: a, spamScore: 7, spamReasons: '[]' }], 100)).toBe(1);
    expect(s.applyReputationBatch([{ id: a, spamScore: 12, spamReasons: '[]' }], 200)).toBe(0);
    const row = db.prepare('SELECT spam_score, reputation_checked_at FROM emails WHERE id = ?').get(a) as Record<string, unknown>;
    expect(row).toEqual({ spam_score: 7, reputation_checked_at: 100 });
  });

  it('is a no-op for an empty batch', () => {
    const { s } = storage();
    expect(s.applyReputationBatch([], 1)).toBe(0);
  });
});

describe('v88 schema', () => {
  it('adds link_reputation_checked_at, a constrained spam_user_verdict, and the body-stage index', () => {
    const db = newMigratedDb();
    const cols = (db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['link_reputation_checked_at', 'spam_user_verdict']));
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_emails_link_reputation_pending'`).get() as { sql: string } | undefined;
    expect(idx?.sql).toMatch(/link_reputation_checked_at IS NULL AND spam_score IS NOT NULL AND raw_body_len > 0/);
    // Only the two words the code writes are storable — a typo cannot become a third state.
    const { db: seeded } = storage();
    seed(seeded, {});
    expect(() => seeded.prepare("UPDATE emails SET spam_user_verdict = 'maybe'").run()).toThrow(/CHECK constraint/);
  });
});

describe('getEmailsPendingLinkReputation', () => {
  it('lists header-scored rows that HAVE a body and no link verdict yet, with the body, newest first', () => {
    const { s, db } = storage();
    seed(db, { date: 100, body: '<a href="https://x.example">x</a>' });
    seed(db, { date: 200, body: '' }); // no body yet
    seed(db, { date: 300, body: 'https://y.example', linkChecked: 5 }); // already judged
    seed(db, { date: 400, body: 'plain', bodyLen: null }); // length unknown: left for the metrics backfill
    seed(db, { date: 500, body: 'https://z.example', score: null }); // never header-scored (own mail)
    seed(db, { date: 600, body: 'https://w.example', uid: 0 }); // no server uid

    const rows = s.getEmailsPendingLinkReputation(10);
    expect(rows.map((r) => r.rawBody)).toEqual(['<a href="https://x.example">x</a>']);
    expect(rows[0]).toMatchObject({ folderPath: 'INBOX', spamScore: 0, spamUserVerdict: null, fromAddress: 'a@b.com' });
    expect(s.countEmailsPendingLinkReputation()).toBe(1);
  });
});

describe('applyLinkReputationBatch', () => {
  it('stamps once and never re-adds points', () => {
    const { s, db } = storage();
    const a = seed(db, { body: 'x' });
    expect(s.applyLinkReputationBatch([{ id: a, spamScore: 5, spamReasons: '[]' }], 100)).toBe(1);
    expect(s.applyLinkReputationBatch([{ id: a, spamScore: 9, spamReasons: '[]' }], 200)).toBe(0);
    expect(db.prepare('SELECT spam_score, link_reputation_checked_at FROM emails WHERE id = ?').get(a)).toEqual({ spam_score: 5, link_reputation_checked_at: 100 });
    expect(s.applyLinkReputationBatch([], 1)).toBe(0);
    expect(s.countEmailsPendingLinkReputation()).toBe(0);
  });
});

describe('the user’s verdict and the Spam tab listing', () => {
  it('sets and clears the verdict, and the pending queries carry it', async () => {
    const { s, db } = storage();
    const a = seed(db, {});
    await s.setSpamUserVerdict(a, 'ham');
    expect(s.getEmailsPendingReputation(5)[0].spamUserVerdict).toBe('ham');
    await s.setSpamUserVerdict(a, null);
    expect(s.getEmailsPendingReputation(5)[0].spamUserVerdict).toBeNull();
  });

  // The tab shows everything the filter had an opinion on: suspicious and up,
  // tagged, or overruled — not the clean bulk of the mailbox.
  it('lists suspicious, tagged and overruled rows, newest first, and nothing clean', () => {
    const { s, db } = storage();
    seed(db, { date: 1, score: 0 }); // clean
    const b = seed(db, { date: 2, score: 3 }); // suspicious
    const c = seed(db, { date: 3, score: 0, tags: '|INBOX|spam|' }); // tagged by the AI
    const d = seed(db, { date: 4, score: 1, verdict: 'ham' }); // overruled
    const rows = s.getSpamJudgedEmails(10, 3);
    expect(rows.map((r) => r.id)).toEqual([d, c, b]);
    expect(rows[0]).toMatchObject({ spamUserVerdict: 'ham', folderPath: 'INBOX', fromAddress: 'a@b.com' });
    expect(s.getSpamJudgedEmails(1, 3)).toHaveLength(1);
  });
});

describe('the reputation queries stay off the mail table', () => {
  // Measured before the pin, on 26,700 synthetic rows with ANALYZE run: both
  // COUNTs planned `SEARCH emails USING INDEX idx_emails_uid (uid>?)` — a seek
  // the planner prefers because `uid > 0` is a range, and which then visits
  // every row in the mailbox — at 12ms against 0.03ms through the partial
  // index, on the main process, on every pass. The SELECTs happened to plan
  // right only because `ORDER BY date DESC` matched the index; one dropped
  // sort would have taken them the same way. Nothing but the plan asserts
  // this: a drift between the clause helpers and the migration's WHERE would
  // silently restore the scan, so the plan is what is pinned.
  it('plans every reputation query through its partial index, never a table scan', () => {
    const { s, db } = storage();
    seed(db, { score: 0, body: '<a href="https://x.example">x</a>' });
    const statements: string[] = [];
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      statements.push(sql);
      return realPrepare(sql);
    };
    s.getEmailsPendingReputation(50);
    s.countEmailsPendingReputation();
    s.getEmailsPendingLinkReputation(50);
    s.countEmailsPendingLinkReputation();
    (db as unknown as { prepare: unknown }).prepare = realPrepare;

    expect(statements).toHaveLength(4);
    for (const sql of statements) {
      const params = new Array((sql.match(/\?/g) ?? []).length).fill(50);
      const plan = (realPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((step) => step.detail)
        .join(' | ');
      expect(plan).toMatch(/idx_emails_(link_)?reputation_pending/);
      expect(plan).not.toMatch(/idx_emails_uid/);
      // A scan THROUGH the partial index is the goal (it holds only waiting
      // rows); a scan of the table itself, under any alias, is the bug.
      expect(plan).not.toMatch(/SCAN (emails|e)\b(?! USING)/);
      expect(plan).not.toContain('USE TEMP B-TREE'); // the index already supplies date DESC
    }
  });
});
