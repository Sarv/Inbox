import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { ReadModelMaintainer } from '../../src/read-model-maintainer';
import { openTestDb } from '../../src/test-support/test-db';

// A DB with the read-model tables + the emails dirty triggers (the same DDL the
// v64/v65 migrations install), so we exercise trigger -> queue -> drain end to end.
function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
    CREATE TABLE ai_category_definitions (slug TEXT PRIMARY KEY);
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '||', date INTEGER NOT NULL,
      has_attachments INTEGER NOT NULL DEFAULT 0, priority_score INTEGER,
      from_name TEXT, from_address TEXT NOT NULL, subject TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL,
      first_message_id TEXT NOT NULL, last_message_id TEXT NOT NULL,
      last_message_date INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 1,
      participants TEXT, has_unread INTEGER NOT NULL DEFAULT 0, has_flagged INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]',
      has_important INTEGER NOT NULL DEFAULT 0, has_important_unread INTEGER NOT NULL DEFAULT 0,
      has_attachment INTEGER NOT NULL DEFAULT 0, has_draft INTEGER NOT NULL DEFAULT 0,
      has_category INTEGER NOT NULL DEFAULT 0, max_priority_score INTEGER NOT NULL DEFAULT 0,
      first_sender TEXT, last_sender TEXT,
      live_message_count INTEGER NOT NULL DEFAULT 0, state_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE thread_folders (
      folder_id TEXT NOT NULL, thread_id TEXT NOT NULL, last_message_date INTEGER NOT NULL,
      max_priority_score INTEGER NOT NULL DEFAULT 0,
      has_unread INTEGER NOT NULL DEFAULT 0, has_important INTEGER NOT NULL DEFAULT 0,
      has_important_unread INTEGER NOT NULL DEFAULT 0, has_flagged INTEGER NOT NULL DEFAULT 0,
      has_attachment INTEGER NOT NULL DEFAULT 0, has_draft INTEGER NOT NULL DEFAULT 0,
      has_category INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (folder_id, thread_id)
    ) WITHOUT ROWID;
    CREATE TABLE thread_categories (thread_id TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (thread_id, slug)) WITHOUT ROWID;
    CREATE TABLE read_model_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE read_model_dirty (thread_id TEXT PRIMARY KEY) WITHOUT ROWID;

    CREATE TRIGGER trg_emails_rm_dirty_insert AFTER INSERT ON emails BEGIN
      INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id);
    END;
    CREATE TRIGGER trg_emails_rm_dirty_update
    AFTER UPDATE OF tags, folder_id, has_attachments, priority_score, date, thread_id ON emails BEGIN
      INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id);
      INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (OLD.thread_id);
    END;
    CREATE TRIGGER trg_emails_rm_dirty_delete AFTER DELETE ON emails BEGIN
      INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (OLD.thread_id);
    END;

    INSERT INTO folders (id, path) VALUES ('f-inbox','INBOX');
    INSERT INTO ai_category_definitions (slug) VALUES ('reminders');
  `);
  return db;
}

let n = 0;
function insertEmail(db: Database.Database, threadId: string, tags: string, over: Record<string, any> = {}): void {
  n += 1;
  db.prepare(`INSERT INTO emails (id, message_id, thread_id, tags, date, has_attachments, priority_score, from_name, from_address, subject, updated_at)
              VALUES (@id,@mid,@tid,@tags,@date,@att,@pri,@fn,@fa,@sub,@ua)`).run({
    id: over.id ?? `e${n}`, mid: `<e${n}>`, tid: threadId, tags: `|${tags}|`,
    date: over.date ?? 1000 + n, att: over.att ?? 0, pri: over.pri ?? null,
    fn: `S${n}`, fa: `s${n}@x.com`, sub: `Sub ${n}`, ua: over.ua ?? 5000 + n,
  });
}

const dirtyCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) c FROM read_model_dirty').get() as any).c;
const tfCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) c FROM thread_folders').get() as any).c;
const state = (db: Database.Database, k: string) => (db.prepare('SELECT value v FROM read_model_state WHERE key=?').get(k) as any)?.v ?? null;

describe('ReadModelMaintainer', () => {
  let db: Database.Database;
  let m: ReadModelMaintainer;
  beforeEach(() => { db = newDb(); m = new ReadModelMaintainer(() => db); });

  it('triggers enqueue changed threads on insert', () => {
    insertEmail(db, 't1', 'INBOX');
    insertEmail(db, 't1', 'INBOX|read');
    insertEmail(db, 't2', 'INBOX');
    expect(dirtyCount(db)).toBe(2); // deduped to two distinct threads
  });

  it('drains the queue into thread_folders and clears it', () => {
    insertEmail(db, 't1', 'INBOX|important');
    insertEmail(db, 't2', 'INBOX|read');
    const done = m.drainChunk();
    expect(done).toBe(2);
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(2);
    const t1 = db.prepare('SELECT * FROM threads WHERE id=?').get('t1') as any;
    expect(t1.has_important_unread).toBe(1);
  });

  it('backfillNow seeds all threads and marks status complete', () => {
    insertEmail(db, 't1', 'INBOX');
    insertEmail(db, 't2', 'INBOX|reminders');
    db.prepare('DELETE FROM read_model_dirty').run(); // simulate a pre-trigger existing DB
    expect(dirtyCount(db)).toBe(0);

    m.backfillNow();
    expect(state(db, 'status')).toBe('complete');
    expect(state(db, 'threads_total')).toBe('2');
    expect(tfCount(db)).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM thread_categories').get() as any).c).toBe(1); // t2/reminders
  });

  it('is resumable — a partial drain leaves the rest queued, a later drain finishes', () => {
    for (let i = 0; i < 5; i++) insertEmail(db, `t${i}`, 'INBOX');
    m.backfillNow();               // seed sets status=running/total, then drains all
    expect(state(db, 'status')).toBe('complete');
    expect(Number(state(db, 'threads_done'))).toBe(5);
  });

  it('keeps the read-model current on tag change and delete after backfill', () => {
    insertEmail(db, 't1', 'INBOX', { id: 'x1' });
    m.backfillNow();
    expect((db.prepare('SELECT has_unread FROM thread_folders WHERE thread_id=?').get('t1') as any).has_unread).toBe(1);

    // Tag change via ad-hoc UPDATE (a path that does NOT go through repo methods) —
    // the trigger still captures it.
    db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|', 'x1');
    expect(dirtyCount(db)).toBe(1);
    m.flushNow();
    expect((db.prepare('SELECT has_unread FROM thread_folders WHERE thread_id=?').get('t1') as any).has_unread).toBe(0);

    // Delete the last email -> thread's read-model rows are cleared.
    db.prepare('DELETE FROM emails WHERE id = ?').run('x1');
    m.flushNow();
    expect(tfCount(db)).toBe(0);
  });

  it('flips has_category off when a category is undefined and the thread re-dirtied', () => {
    insertEmail(db, 't1', 'INBOX|reminders|read', { id: 'c1' });
    m.backfillNow();
    expect((db.prepare('SELECT has_category FROM threads WHERE id=?').get('t1') as any).has_category).toBe(1);

    // Category deleted from definitions (the |reminders| tag is left stale on the
    // email) + the affected thread re-enqueued — what dirtyThreadsForCategorySlug does.
    db.prepare("DELETE FROM ai_category_definitions WHERE slug='reminders'").run();
    db.prepare("INSERT OR IGNORE INTO read_model_dirty(thread_id) SELECT DISTINCT thread_id FROM emails WHERE instr(tags,'|reminders|')>0").run();
    m.flushNow();

    expect((db.prepare('SELECT has_category FROM threads WHERE id=?').get('t1') as any).has_category).toBe(0);
    expect((db.prepare('SELECT has_category FROM thread_folders WHERE thread_id=?').get('t1') as any).has_category).toBe(0);
  });

  // --- chunk pacing ------------------------------------------------------
  //
  // The drain's stall bound used to be a ROW COUNT (100 threads per synchronous
  // transaction), which bounds nothing: a chunk's cost is the sum of its threads'
  // costs and those differ by orders of magnitude. These pin the time budget that
  // replaced it — if they fail, one chunk can hold the main thread for as long as
  // its heaviest 100 threads take, and the UI freezes for exactly that long.

  it('stops a chunk once the time budget is spent and leaves the rest queued', () => {
    for (let i = 0; i < 12; i++) insertEmail(db, `tb${i}`, 'INBOX');
    expect(dirtyCount(db)).toBe(12);

    // A zero budget: the deadline is already past when the first thread finishes,
    // so exactly one thread is rebuilt and the other eleven stay queued.
    const processed = m.drainChunk(100, 0);
    expect(processed).toBe(1);
    expect(dirtyCount(db)).toBe(11);
    expect(tfCount(db)).toBe(1);
  });

  it('makes progress on every chunk even with a zero budget (no livelock)', () => {
    // The deadline is checked AFTER a thread is written, never before. Checking it
    // first would make a zero/elapsed budget return 0 forever: pump() reads 0 as
    // "queue empty", stops, and the read model never rebuilds at all.
    for (let i = 0; i < 5; i++) insertEmail(db, `tz${i}`, 'INBOX');
    let guard = 0;
    while (m.drainChunk(100, 0) > 0 && guard++ < 50) { /* drain one at a time */ }
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(5);
    expect(guard).toBe(5); // one thread per chunk, five chunks — not an early stop
  });

  it('dequeues only the threads it actually rebuilt', () => {
    // The dangerous half of an early stop: a dirty row deleted without its rollup
    // committing is a rebuild lost for good, because nothing re-dirties it. The
    // thread would serve stale counts/flags forever.
    for (let i = 0; i < 4; i++) insertEmail(db, `tq${i}`, 'INBOX|important');
    m.drainChunk(100, 0);

    const remaining = (db.prepare('SELECT thread_id FROM read_model_dirty ORDER BY thread_id').all() as any[])
      .map((r) => r.thread_id);
    const built = (db.prepare('SELECT id FROM threads ORDER BY id').all() as any[]).map((r) => r.id);
    expect(built).toHaveLength(1);
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain(built[0]); // the one built is the one dequeued

    m.flushNow();
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(4);
  });

  it('flushNow drains to empty in one pass, unpaced', () => {
    // Shutdown and tests ask for an EMPTY queue on return; pacing it would either
    // leave rows behind or turn the flush into a long loop of tiny transactions.
    for (let i = 0; i < 40; i++) insertEmail(db, `tf${i}`, 'INBOX');
    m.flushNow();
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(40);
  });

  it('drainChunk is unpaced by default', () => {
    // Every existing caller (and the public API) keeps run-to-completion semantics;
    // only the background pump opts into a budget.
    for (let i = 0; i < 7; i++) insertEmail(db, `td${i}`, 'INBOX');
    expect(m.drainChunk()).toBe(7);
    expect(dirtyCount(db)).toBe(0);
  });

  it('seeding is idempotent (no duplicate thread_folders rows)', () => {
    insertEmail(db, 't1', 'INBOX|Sarv Inbox/Reminders|read');
    db.prepare("INSERT INTO folders (id, path) VALUES ('f-rem','Sarv Inbox/Reminders')").run();
    m.backfillNow();
    m.backfillNow();
    expect(tfCount(db)).toBe(2); // INBOX + the label, once each
  });
});
