import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildRollupContext,
  computeThreadRollup,
  deriveRollup,
  rebuildThread,
  rebuildThreads,
  verifyThread,
  type RollupContext,
  type RollupEmailRow,
} from '../../../src/repositories/thread-rollup';
import { openTestDb } from '../../../src/test-support/test-db';

// ---------------------------------------------------------------------------
// Pure derivation tests (deriveRollup) — no DB
// ---------------------------------------------------------------------------

const CTX: RollupContext = {
  folderPaths: new Map<string, string>([
    ['INBOX', 'f-inbox'],
    ['Sent', 'f-sent'],
    ['Trash', 'f-trash'],
    ['Drafts', 'f-drafts'],
    ['Sarv Inbox/Reminders', 'f-reminders'],
  ]),
  categorySlugs: new Set(['reminders', 'needs_response']),
};

let seq = 0;
function email(tags: string, over: Partial<RollupEmailRow> = {}): RollupEmailRow {
  seq += 1;
  return {
    id: over.id ?? `e${seq}`,
    message_id: over.message_id ?? `<m${seq}>`,
    tags: `|${tags}|`,
    date: over.date ?? 1000 + seq,
    has_attachments: over.has_attachments ?? 0,
    priority_score: over.priority_score ?? null,
    from_name: over.from_name ?? `Sender ${seq}`,
    from_address: over.from_address ?? `s${seq}@x.com`,
    subject: over.subject ?? `Subject ${seq}`,
    updated_at: over.updated_at ?? 5000 + seq,
  };
}

describe('deriveRollup', () => {
  it('returns an empty rollup for a thread with no rows', () => {
    const r = deriveRollup('t1', [], CTX);
    expect(r.hasEmails).toBe(false);
    expect(r.folders).toEqual([]);
    expect(r.stateVersion).toBe(0);
  });

  it('marks an unread INBOX mail unread and emits an INBOX folder row', () => {
    const r = deriveRollup('t1', [email('INBOX', { date: 1234 })], CTX);
    expect(r.hasUnread).toBe(true);
    expect(r.liveMessageCount).toBe(1);
    expect(r.lastMessageDate).toBe(1234);
    expect(r.folders).toHaveLength(1);
    expect(r.folders[0]).toMatchObject({ folderId: 'f-inbox', lastMessageDate: 1234, hasUnread: true });
  });

  it('distinguishes has_important_unread from has_important + has_unread', () => {
    // Important-but-READ message + a separate unimportant UNREAD message.
    const r = deriveRollup('t1', [
      email('INBOX|read|important', { date: 10 }),
      email('INBOX', { date: 20 }),
    ], CTX);
    expect(r.hasImportant).toBe(true);
    expect(r.hasUnread).toBe(true);
    expect(r.hasImportantUnread).toBe(false); // no single message is both
  });

  it('sets has_important_unread when one message is both important AND unread', () => {
    const r = deriveRollup('t1', [email('INBOX|important')], CTX);
    expect(r.hasImportantUnread).toBe(true);
  });

  it('detects starred and attachments (conversation-wide, live)', () => {
    const r = deriveRollup('t1', [
      email('INBOX|read|starred', { date: 1 }),
      email('INBOX|read', { date: 2, has_attachments: 1 }),
    ], CTX);
    expect(r.hasFlagged).toBe(true);
    expect(r.hasAttachment).toBe(true);
    expect(r.hasUnread).toBe(false);
  });

  it('excludes unsent drafts from live count and last date, but sets has_draft', () => {
    const r = deriveRollup('t1', [
      email('INBOX|read', { date: 100 }),
      email('Drafts|draft', { date: 999 }), // newer, but a draft
    ], CTX);
    expect(r.hasDraft).toBe(true);
    expect(r.liveMessageCount).toBe(1);       // the draft is not counted
    expect(r.lastMessageDate).toBe(100);      // the draft does not bump the date
    // The draft still produces a Drafts folder row (browsable), not an INBOX one.
    const paths = r.folders.map((f) => f.folderId).sort();
    expect(paths).toEqual(['f-drafts', 'f-inbox']);
  });

  it('emits one folder row per folder a thread appears in (label + INBOX)', () => {
    const r = deriveRollup('t1', [email('INBOX|Sarv Inbox/Reminders|read', { date: 42 })], CTX);
    const byFolder = Object.fromEntries(r.folders.map((f) => [f.folderId, f.lastMessageDate]));
    expect(byFolder).toEqual({ 'f-inbox': 42, 'f-reminders': 42 });
  });

  it('keeps folder-local last dates for a thread spanning INBOX and Sent', () => {
    const r = deriveRollup('t1', [
      email('INBOX', { date: 100 }),
      email('Sent|read', { date: 200 }), // a sent reply, separate message
    ], CTX);
    const byFolder = Object.fromEntries(r.folders.map((f) => [f.folderId, f.lastMessageDate]));
    expect(byFolder['f-inbox']).toBe(100);
    expect(byFolder['f-sent']).toBe(200);
  });

  it('treats a thread as labelled if ANY live mail carries a category (not unlabelled)', () => {
    const mixed = deriveRollup('t1', [
      email('INBOX|reminders|read', { date: 1 }),
      email('INBOX|read', { date: 2 }),
    ], CTX);
    expect(mixed.categories).toEqual(['reminders']);
    expect(mixed.folders.every((f) => f.hasCategory)).toBe(true);

    const none = deriveRollup('t2', [email('INBOX|read')], CTX);
    expect(none.categories).toEqual([]);
    expect(none.folders.every((f) => f.hasCategory === false)).toBe(true);
  });

  it('excludes Trash copies from live flags but still lists them under Trash', () => {
    const r = deriveRollup('t1', [email('Trash|starred', { date: 7 })], CTX);
    expect(r.hasFlagged).toBe(false);   // starred copy in Trash is not "live"
    expect(r.hasUnread).toBe(false);
    expect(r.liveMessageCount).toBe(0);
    expect(r.lastMessageDate).toBe(7);  // fallback to newest when nothing is live
    expect(r.folders.map((f) => f.folderId)).toEqual(['f-trash']);
  });

  it('keeps flag state for a |deleted| copy (matches threadTagExists) but not unread', () => {
    // An un-expunged \Deleted copy still in INBOX, starred + read.
    const r = deriveRollup('t1', [email('INBOX|deleted|starred|read')], CTX);
    expect(r.hasFlagged).toBe(true);                 // starred still counts
    expect(r.folders.some((f) => f.hasFlagged)).toBe(true);
    expect(r.hasUnread).toBe(false);                 // it's read anyway
  });

  it('a |deleted| UNREAD copy does not count as unread (matches liveUnreadSum)', () => {
    const del = deriveRollup('t1', [email('INBOX|deleted')], CTX);   // unread + deleted
    expect(del.hasUnread).toBe(false);
    const live = deriveRollup('t2', [email('INBOX')], CTX);          // unread, not deleted
    expect(live.hasUnread).toBe(true);
  });

  it('produces a stable stateVersion that changes only when a flag changes', () => {
    const base = deriveRollup('t1', [email('INBOX', { id: 'e1', updated_at: 500 })], CTX);
    const same = deriveRollup('t1', [email('INBOX', { id: 'e1', updated_at: 500 })], CTX);
    const read = deriveRollup('t1', [email('INBOX|read', { id: 'e1', updated_at: 500 })], CTX);
    expect(base.stateVersion).toBe(same.stateVersion);
    expect(base.stateVersion).not.toBe(read.stateVersion);
  });
});

// ---------------------------------------------------------------------------
// Persistence tests (rebuildThread / rebuildThreads / verifyThread) — in-memory DB
// ---------------------------------------------------------------------------

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
      participants TEXT,
      has_unread INTEGER NOT NULL DEFAULT 0, has_flagged INTEGER NOT NULL DEFAULT 0,
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
    CREATE TABLE thread_categories (
      thread_id TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (thread_id, slug)
    ) WITHOUT ROWID;
    INSERT INTO folders (id, path) VALUES
      ('f-inbox','INBOX'), ('f-sent','Sent'), ('f-drafts','Drafts'),
      ('f-reminders','Sarv Inbox/Reminders');
    INSERT INTO ai_category_definitions (slug) VALUES ('reminders'), ('needs_response');
  `);
  return db;
}

let n = 0;
function insertEmail(db: Database.Database, threadId: string, tags: string, over: Partial<RollupEmailRow> = {}): void {
  n += 1;
  db.prepare(`INSERT INTO emails (id, message_id, thread_id, tags, date, has_attachments, priority_score, from_name, from_address, subject, updated_at)
              VALUES (@id,@mid,@tid,@tags,@date,@att,@pri,@fn,@fa,@sub,@ua)`).run({
    id: over.id ?? `db${n}`,
    mid: over.message_id ?? `<db${n}>`,
    tid: threadId,
    tags: `|${tags}|`,
    date: over.date ?? 1000 + n,
    att: over.has_attachments ?? 0,
    pri: over.priority_score ?? null,
    fn: over.from_name ?? `Sender ${n}`,
    fa: over.from_address ?? `s${n}@x.com`,
    sub: over.subject ?? `Subject ${n}`,
    ua: over.updated_at ?? 5000 + n,
  });
}

describe('rebuildThread (persistence)', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('materializes threads flags, thread_folders and thread_categories', () => {
    insertEmail(db, 't1', 'INBOX|important|reminders', { date: 2000, priority_score: 9 });
    insertEmail(db, 't1', 'INBOX|read', { date: 2100 });
    rebuildThread(db, 't1');

    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get('t1') as any;
    expect(thread.has_important).toBe(1);
    expect(thread.has_important_unread).toBe(1);
    expect(thread.has_unread).toBe(1);
    expect(thread.has_category).toBe(1);
    expect(thread.max_priority_score).toBe(9);
    expect(thread.live_message_count).toBe(2);

    const tf = db.prepare('SELECT * FROM thread_folders WHERE thread_id = ?').all('t1') as any[];
    expect(tf).toHaveLength(1);
    expect(tf[0]).toMatchObject({ folder_id: 'f-inbox', last_message_date: 2100, has_category: 1 });

    const tc = db.prepare('SELECT slug FROM thread_categories WHERE thread_id = ?').all('t1') as any[];
    expect(tc.map((r) => r.slug)).toEqual(['reminders']);
  });

  it('is idempotent — running twice yields the same rows, no duplicates', () => {
    insertEmail(db, 't1', 'INBOX|Sarv Inbox/Reminders|read');
    rebuildThread(db, 't1');
    rebuildThread(db, 't1');
    const count = db.prepare('SELECT COUNT(*) c FROM thread_folders WHERE thread_id = ?').get('t1') as any;
    expect(count.c).toBe(2); // INBOX + the label, exactly once each
  });

  it('clears the read-model when a thread loses all its emails', () => {
    insertEmail(db, 't1', 'INBOX', { id: 'x1' });
    rebuildThread(db, 't1');
    expect((db.prepare('SELECT COUNT(*) c FROM thread_folders').get() as any).c).toBe(1);

    db.prepare('DELETE FROM emails WHERE thread_id = ?').run('t1');
    rebuildThread(db, 't1');
    expect((db.prepare('SELECT COUNT(*) c FROM thread_folders').get() as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM thread_categories').get() as any).c).toBe(0);
  });

  it('rebuildThreads processes a batch and reports the count', () => {
    insertEmail(db, 't1', 'INBOX');
    insertEmail(db, 't2', 'INBOX|read');
    const done = rebuildThreads(db, ['t1', 't2', 't1']); // duplicate id is de-duped
    expect(done).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM thread_folders').get() as any).c).toBe(2);
  });

  it('verifyThread detects drift when a tag changes without a rebuild', () => {
    insertEmail(db, 't1', 'INBOX', { id: 'x1', updated_at: 10 });
    rebuildThread(db, 't1');
    expect(verifyThread(db, 't1')).toBe(true);

    // Mutate the email out-of-band (simulating a write path that forgot the hook).
    db.prepare('UPDATE emails SET tags = ?, updated_at = ? WHERE id = ?').run('|INBOX|read|', 11, 'x1');
    expect(verifyThread(db, 't1')).toBe(false);

    rebuildThread(db, 't1');
    expect(verifyThread(db, 't1')).toBe(true);
  });

  it('computeThreadRollup + buildRollupContext read live folder/category state', () => {
    insertEmail(db, 't1', 'INBOX|needs_response');
    const ctx = buildRollupContext(db);
    const r = computeThreadRollup(db, 't1', ctx);
    expect(r.categories).toEqual(['needs_response']);
    expect(r.folders[0].folderId).toBe('f-inbox');
  });
});
