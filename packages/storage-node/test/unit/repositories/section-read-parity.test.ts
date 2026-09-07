import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestDb } from '../../../src/test-support/test-db';
import { EmailRepository } from '../../../src/repositories/email-repository';
import { ReadModelMaintainer } from '../../../src/read-model-maintainer';

// Proves the read-model fast path (thread_folders) returns the SAME thread set as
// the legacy GROUP BY path for every section + a quick-filter — the parity that
// justifies flipping SARVINBOX_READMODEL_READS on.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
    CREATE TABLE ai_category_definitions (slug TEXT PRIMARY KEY);
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      folder_id TEXT NOT NULL DEFAULT 'f-inbox', tags TEXT NOT NULL DEFAULT '||',
      subject TEXT, from_address TEXT NOT NULL, from_name TEXT,
      date INTEGER NOT NULL, has_attachments INTEGER NOT NULL DEFAULT 0,
      priority_score INTEGER, clean_body TEXT NOT NULL DEFAULT '', raw_body TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    -- Where bodies live since migration 73. Every reader COALESCEs through it,
    -- so a minimal schema without it fails to prepare rather than returning a
    -- wrong answer.
    CREATE TABLE email_bodies (email_id TEXT PRIMARY KEY, clean_body TEXT, raw_body TEXT);
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
    CREATE TRIGGER trg_i AFTER INSERT ON emails BEGIN INSERT OR IGNORE INTO read_model_dirty(thread_id) VALUES (NEW.thread_id); END;
    INSERT INTO folders (id, path) VALUES ('f-inbox','INBOX'), ('f-trash','Trash'), ('f-sent','Sent');
    INSERT INTO ai_category_definitions (slug) VALUES ('reminders');
  `);
  return db;
}

let n = 0;
function add(db: Database.Database, threadId: string, tags: string, over: Record<string, any> = {}): void {
  n += 1;
  db.prepare(`INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address, from_name, date, has_attachments, priority_score, clean_body, updated_at)
              VALUES (@id,@mid,@tid,@fid,@tags,@sub,@fa,@fn,@date,@att,@pri,@cb,@ua)`).run({
    id: `e${n}`, mid: `<e${n}>`, tid: threadId, fid: over.fid ?? 'f-inbox', tags: `|${tags}|`,
    sub: `S${n}`, fa: `s${n}@x.com`, fn: `S${n}`, date: over.date ?? 1000 + n,
    att: over.att ?? 0, pri: over.pri ?? null, cb: 'body', ua: 5000 + n,
  });
}

const sortedThreadIds = (rows: { threadId: string }[]): string[] =>
  [...new Set(rows.map((r) => r.threadId))].sort();

describe('section read parity (legacy GROUP BY vs read-model)', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
    // A spread of INBOX threads across every flag combination, plus off-INBOX noise.
    add(db, 't-impunread', 'INBOX|important', { pri: 9 });                 // important + unread
    add(db, 't-impread', 'INBOX|important|read');                          // important, read
    add(db, 't-star', 'INBOX|starred|read');                              // starred, read
    add(db, 't-unread', 'INBOX');                                          // plain unread
    add(db, 't-read', 'INBOX|read');                                       // plain read
    add(db, 't-attach', 'INBOX|read', { att: 1 });                         // read + attachment
    add(db, 't-cat', 'INBOX|read|reminders');                             // read + category
    add(db, 't-stardel', 'INBOX|deleted|starred|read');                  // starred + un-expunged \Deleted
    add(db, 't-mixed', 'INBOX|read|reminders', { date: 50 });            // categorized...
    add(db, 't-mixed', 'INBOX', { date: 60 });                            // ...+ an unread reply
    add(db, 't-trash', 'Trash|starred', { fid: 'f-trash' });              // not in INBOX
    add(db, 't-sent', 'Sent|read', { fid: 'f-sent' });                    // not in INBOX

    new ReadModelMaintainer(() => db).backfillNow();
    process.env.SARVINBOX_READMODEL_READS = '1';
  });
  afterEach(() => { delete process.env.SARVINBOX_READMODEL_READS; });

  const opts = { limit: 100, offset: 0, folderPath: 'INBOX' };
  const cases: Array<[string, () => Promise<any[]>]> = [
    ['important_unread', () => repo.getImportantUnread(opts)],
    ['starred', () => repo.getStarredNotImportantUnread(opts)],
    ['everything_else', () => repo.getEverythingElse(opts)],
    ['unread', () => repo.getUnreadSection(opts)],
    ['read', () => repo.getReadSection(opts)],
  ];

  for (const [filter, legacy] of cases) {
    it(`fast path matches legacy for section "${filter}"`, async () => {
      const legacyIds = sortedThreadIds(await legacy());
      const fastIds = sortedThreadIds(await repo.listSectionFast(filter, 'f-inbox', { limit: 100, offset: 0 }));
      expect(fastIds).toEqual(legacyIds);
    });
  }

  it('fast path matches legacy for everything_else + Unlabelled quick-filter', async () => {
    const vf = { noCategory: true };
    const legacyIds = sortedThreadIds(await repo.getEverythingElse({ ...opts, viewFilter: vf } as any));
    const fastIds = sortedThreadIds(await repo.listSectionFast('everything_else', 'f-inbox', { limit: 100, offset: 0, viewFilter: vf }));
    expect(fastIds).toEqual(legacyIds);
    // The mixed thread (has a categorized mail) must NOT be unlabelled.
    expect(fastIds).not.toContain('t-mixed');
  });

  it('section counts match between legacy and fast', async () => {
    for (const [filter] of cases) {
      // legacy count path — kill-switch forces it
      process.env.SARVINBOX_READMODEL_READS = '0';
      const legacy = await repo.getSectionCount(filter, 'INBOX');
      // fast count path — default-on (unset) once backfill is complete
      delete process.env.SARVINBOX_READMODEL_READS;
      const fast = await repo.getSectionCount(filter, 'INBOX');
      expect(fast).toBe(legacy);
    }
  });

  // getByFolder cutover: the read-model folder listing (thread_folders) returns
  // the SAME thread set as the legacy instr(tags) scan, and never leaks off-folder
  // mail — the parity that justifies routing plain folder views through it.
  it('getByFolder fast path matches the legacy folder thread set', async () => {
    process.env.SARVINBOX_READMODEL_READS = '0';
    const legacyIds = sortedThreadIds(await repo.getByFolder('f-inbox', { limit: 100, offset: 0 } as any));
    delete process.env.SARVINBOX_READMODEL_READS;
    const fastIds = sortedThreadIds(await repo.getByFolder('f-inbox', { limit: 100, offset: 0, collapseThreads: true } as any));
    expect(fastIds).toEqual(legacyIds);
    // off-INBOX copies (Trash/Sent) never leak into the INBOX listing
    expect(fastIds).not.toContain('t-trash');
    expect(fastIds).not.toContain('t-sent');
  });

  it('countFolderFast equals the folder distinct-thread count', async () => {
    process.env.SARVINBOX_READMODEL_READS = '0';
    const legacyThreadCount = sortedThreadIds(await repo.getByFolder('f-inbox', { limit: 1000, offset: 0 } as any)).length;
    delete process.env.SARVINBOX_READMODEL_READS;
    expect(repo.countFolderFast('f-inbox')).toBe(legacyThreadCount);
  });

  it('getByFolder fast path applies the Unlabelled filter at THREAD level', async () => {
    // Thread-level (correct) semantics — a thread with ANY categorized mail is
    // labelled, unlike legacy getByFolder's per-email filter.
    const fastIds = sortedThreadIds(await repo.getByFolder('f-inbox', { limit: 100, offset: 0, filter: { noCategory: true }, collapseThreads: true } as any));
    expect(fastIds).not.toContain('t-cat');    // categorized → labelled
    expect(fastIds).not.toContain('t-mixed');  // has a categorized mail → labelled
    expect(fastIds).toContain('t-unread');     // genuinely unlabelled
  });
});
