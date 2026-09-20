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
const seed = (db: ReturnType<typeof newMigratedDb>, opts: { uid?: number | null; score?: number | null; checked?: number | null; date?: number; ip?: string | null } = {}) => {
  n += 1;
  db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, 's', ?, ?, 1)`)
    .run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, reply_to, date,
       raw_body, clean_body, raw_body_len, clean_body_len, content_type, content_hash, spam_score, spam_reasons, origin_ip, reputation_checked_at)
     VALUES (?, ?, ?, 'f1', ?, '|INBOX|', 's', 'a@b.com', 'r@c.com', ?, '', '', 0, 0, 'text', ?, ?, '[]', ?, ?)`,
  ).run(`e${n}`, `<m${n}@x>`, `t${n}`, opts.uid === undefined ? n : opts.uid, opts.date ?? n, `h${n}`,
    opts.score === undefined ? 0 : opts.score, opts.ip === undefined ? '8.8.8.8' : opts.ip, opts.checked ?? null);
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
