// TEST-ONLY helper: a real SQLite database carrying the READ-MODEL tables and
// the `emails` dirty triggers exactly as migrations v64/v65 install them.
//
// Shared by every suite that exercises the trigger -> dirty queue -> drain ->
// derived-state chain (the maintainer's own tests and the folder-badge tests),
// so the two can never drift into testing different schemas — a drifted fixture
// is worse than no fixture: it goes green while production goes wrong.
//
// Dependency-free of vitest (like test-db) so importing it registers no suites.

import type Database from 'better-sqlite3';

import { createEmailTagsIndex, openTestDb } from './test-db';

/** The v64/v65 shape, trimmed to the columns the rollup actually reads. */
const READ_MODEL_DDL = `
  CREATE TABLE folders (
    id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
    total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
  );
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
  CREATE INDEX idx_tf_unread ON thread_folders(folder_id, last_message_date DESC, thread_id DESC)
    WHERE has_unread = 1;
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
`;

/**
 * Open a read-model database seeded with `folders` and `ai_category_definitions`
 * rows. Defaults reproduce the original single-INBOX fixture; pass your own to
 * test multi-folder behaviour.
 */
export function openReadModelTestDb(
  folders: Array<{ id: string; path: string }> = [{ id: 'f-inbox', path: 'INBOX' }],
  categorySlugs: string[] = ['reminders'],
): Database.Database {
  const db = openTestDb();
  db.exec(READ_MODEL_DDL);
  createEmailTagsIndex(db);
  const insertFolder = db.prepare('INSERT INTO folders (id, path) VALUES (?, ?)');
  for (const folder of folders) insertFolder.run(folder.id, folder.path);
  const insertCategory = db.prepare('INSERT INTO ai_category_definitions (slug) VALUES (?)');
  for (const slug of categorySlugs) insertCategory.run(slug);
  return db;
}

let sequence = 0;

/** Insert one email into the read-model fixture. `tags` is given WITHOUT the
 *  surrounding pipes ('INBOX|read'); everything else has a usable default. */
export function insertReadModelEmail(
  db: Database.Database,
  threadId: string,
  tags: string,
  over: { id?: string; date?: number; att?: number; pri?: number | null; ua?: number } = {},
): void {
  sequence += 1;
  db.prepare(`INSERT INTO emails (id, message_id, thread_id, tags, date, has_attachments, priority_score, from_name, from_address, subject, updated_at)
              VALUES (@id,@mid,@tid,@tags,@date,@att,@pri,@fn,@fa,@sub,@ua)`).run({
    id: over.id ?? `e${sequence}`, mid: `<e${sequence}>`, tid: threadId, tags: `|${tags}|`,
    date: over.date ?? 1000 + sequence, att: over.att ?? 0, pri: over.pri ?? null,
    fn: `S${sequence}`, fa: `s${sequence}@x.com`, sub: `Sub ${sequence}`, ua: over.ua ?? 5000 + sequence,
  });
}
