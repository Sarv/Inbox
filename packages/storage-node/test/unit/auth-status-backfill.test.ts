import { describe, expect, it } from 'vitest';

import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Storage side of the auth-header backfill.
 *
 * What this protects: the backlog query decides which rows get a fetch and the
 * batch write decides which rows leave the backlog. A row that is retried
 * forever (no uid), or a verdict that overwrites one the sync already recorded,
 * would both be silent — this pins the contract the scheduler relies on.
 */
let n = 0;
const seed = (db: ReturnType<typeof newMigratedDb>, folderId: string, opts: { uid?: number | null; auth?: string | null; date?: number } = {}) => {
  n += 1;
  db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, 's', ?, ?, 1)`)
    .run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       raw_body, clean_body, raw_body_len, clean_body_len, content_type, content_hash, auth_status)
     VALUES (?, ?, ?, ?, ?, '|INBOX|', 's', 'a@b.com', ?, '', '', 0, 0, 'text', ?, ?)`,
  ).run(`e${n}`, `<m${n}@x>`, `t${n}`, folderId, opts.uid === undefined ? n : opts.uid, opts.date ?? n, `h${n}`, opts.auth ?? null);
  return `e${n}`;
};

const storage = () => {
  n = 0;
  const db = newMigratedDb();
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX'), ('f2','Archive','Archive')`).run();
  const s = Object.create(SQLiteStorage.prototype) as SQLiteStorage;
  (s as unknown as { db: unknown }).db = db;
  (s as unknown as { ensureInitialized: () => void }).ensureInitialized = () => {};
  return { s, db };
};

describe('getEmailsMissingAuthStatus', () => {
  it('lists NULL-verdict rows newest first with their folder path', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: 10, date: 100 });
    seed(db, 'f2', { uid: 20, date: 300 });
    seed(db, 'f1', { uid: 30, date: 200, auth: '{"overall":"pass"}' }); // already has a verdict

    const rows = s.getEmailsMissingAuthStatus(50);
    expect(rows.map((r) => [r.uid, r.folderPath])).toEqual([[20, 'Archive'], [10, 'INBOX']]);
  });

  // A relinked row has no uid; it cannot be fetched by uid and would otherwise
  // be handed to the scheduler on every tick forever.
  it('excludes rows with no uid rather than retrying them forever', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: null });
    seed(db, 'f1', { uid: 5 });
    expect(s.getEmailsMissingAuthStatus(50).map((r) => r.uid)).toEqual([5]);
    expect(s.countEmailsMissingAuthStatus()).toBe(1);
  });

  // A locally-appended Sent/Drafts copy has uid 0 — the server never numbered
  // it. It cannot be fetched by uid any more than a NULL can, and letting it
  // through parked the live status line at "7 to go" after everything else
  // had drained.
  it('treats uid 0 like a missing uid', () => {
    const { s, db } = storage();
    seed(db, 'f1', { uid: 0 });
    seed(db, 'f1', { uid: 7 });
    expect(s.getEmailsMissingAuthStatus(50).map((r) => r.uid)).toEqual([7]);
    expect(s.countEmailsMissingAuthStatus()).toBe(1);
  });

  it('honours the limit', () => {
    const { s, db } = storage();
    for (let i = 0; i < 5; i++) seed(db, 'f1');
    expect(s.getEmailsMissingAuthStatus(2)).toHaveLength(2);
  });
});

describe('updateEmailAuthStatusBatch', () => {
  it('writes every row in one transaction and reports the count', () => {
    const { s, db } = storage();
    const a = seed(db, 'f1'); const b = seed(db, 'f1');
    const written = s.updateEmailAuthStatusBatch([{ id: a, authStatus: '{"overall":"pass"}' }, { id: b, authStatus: '{"overall":"none"}' }]);
    expect(written).toBe(2);
    expect(s.countEmailsMissingAuthStatus()).toBe(0);
  });

  // THE guard. The sync records a verdict at insert for new mail; if the
  // backfill's slice was read before that insert, its write must not clobber
  // the fresher value.
  it('never overwrites a verdict that already exists', () => {
    const { s, db } = storage();
    const a = seed(db, 'f1', { auth: '{"overall":"pass"}' });
    const written = s.updateEmailAuthStatusBatch([{ id: a, authStatus: '{"overall":"fail"}' }]);
    expect(written).toBe(0);
    expect((db.prepare(`SELECT auth_status FROM emails WHERE id = ?`).get(a) as { auth_status: string }).auth_status).toBe('{"overall":"pass"}');
  });

  it('is a no-op for an empty batch', () => {
    const { s } = storage();
    expect(s.updateEmailAuthStatusBatch([])).toBe(0);
  });
});
