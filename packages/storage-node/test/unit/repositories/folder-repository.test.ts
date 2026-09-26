import type { FolderRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FolderRepository } from '../../../src/repositories/folder-repository';
import { createEmailTagsIndex, newMigratedDb, openTestDb } from '../../../src/test-support/test-db';


// Covers the folder repository's persistence and counting contracts. The three
// sibling files (folder-unread-delta, folder-invalidate, folder-move-back)
// already pin the unread-delta parity, the UIDVALIDITY re-key and the external
// move-back; this file pins everything else: the sync upsert/prune (which can
// CASCADE-delete real mail if it prunes the wrong folder), the hierarchy/path
// round-trips the sidebar is built from, the tag<->folder link helpers, and the
// full count recalculation the badges read.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete FolderRecord — sync() reads every field, so none may be undefined. */
const folder = (over: Partial<FolderRecord> & Pick<FolderRecord, 'id' | 'name' | 'path'>): FolderRecord => ({
  parentId: null,
  uidValidity: null,
  lastSyncUid: null,
  lastSyncTime: null,
  highestModseq: null,
  totalCount: 0,
  unreadCount: 0,
  specialUse: null,
  subscribed: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** Insert an email (plus its parent thread) into a FULL production schema. */
const addMigratedEmail = (
  db: Database.Database,
  opts: { id: string; folderId: string; threadId?: string; tags?: string; date?: number },
): void => {
  const threadId = opts.threadId ?? `t-${opts.id}`;
  const date = opts.date ?? 1000;
  db.prepare(`
    INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date, message_count)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(threadId, 'Subject', `<${opts.id}>`, `<${opts.id}>`, date);
  db.prepare(`
    INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address, date, clean_body, raw_body, content_type, content_hash)
    VALUES (?, ?, ?, ?, ?, 'Subject', 'sender@example.com', ?, '', '', 'text', 'hash')
  `).run(opts.id, `<${opts.id}>`, threadId, opts.folderId, opts.tags ?? '|INBOX|', date);
};

/**
 * Minimal tables for the tag/counting paths. Hand-rolled (rather than migrated)
 * because `thread_id` and `tags` must be NULLABLE here: the recount has explicit
 * guards for both, and the production schema forbids them.
 */
function newMinimalDb(folders: Array<[string, string]>): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, folder_id TEXT, thread_id TEXT, uid INTEGER, tags TEXT
    );
  `);
  createEmailTagsIndex(db);
  const insert = db.prepare('INSERT INTO folders (id, path) VALUES (?, ?)');
  for (const [id, path] of folders) insert.run(id, path);
  return db;
}

const addEmail = (
  db: Database.Database,
  id: string,
  folderId: string | null,
  threadId: string | null,
  tags: string | null,
  uid: number | null = null,
): void => {
  db.prepare('INSERT INTO emails (id, folder_id, thread_id, tags, uid) VALUES (?,?,?,?,?)')
    .run(id, folderId, threadId, tags, uid);
};

const emailRow = (db: Database.Database, id: string) =>
  db.prepare('SELECT folder_id AS folderId, thread_id AS threadId, uid, tags FROM emails WHERE id = ?').get(id) as
    | { folderId: string | null; threadId: string | null; uid: number | null; tags: string | null }
    | undefined;

const countsByPath = (db: Database.Database): Record<string, { total: number; unread: number }> =>
  Object.fromEntries(
    (db.prepare('SELECT path, total_count, unread_count FROM folders').all() as Array<{
      path: string; total_count: number; unread_count: number;
    }>).map((r) => [r.path, { total: r.total_count, unread: r.unread_count }]),
  );

// ---------------------------------------------------------------------------
// sync(): hierarchy, delimiters, special-use
// ---------------------------------------------------------------------------

describe('sync — folder hierarchy, delimiters and identity', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => { db = newMigratedDb(); repo = new FolderRepository(() => db); });
  afterEach(() => { db.close(); });

  // The sidebar tree is built from (name, path, parentId). Servers use '/' OR
  // '.' as the hierarchy delimiter, and the display NAME is the leaf while the
  // PATH is what every tag/selection uses — conflating them makes nested
  // folders unreachable (a SELECT on "Work" instead of "INBOX/Work").
  it('stores nested paths for both delimiters, keeps name != path, and lists by path', async () => {
    await repo.sync([
      folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }),
      folder({ id: 'f-work', name: 'Work', path: 'INBOX/Work', parentId: 'f-inbox' }),
      folder({ id: 'f-q3', name: 'Q3', path: 'INBOX/Work/Q3', parentId: 'f-work' }),
      folder({ id: 'f-arch', name: 'Archive', path: 'INBOX.Archive', parentId: 'f-inbox' }),
    ]);

    const all = await repo.getAll();
    expect(all.map((f) => f.path)).toEqual(['INBOX', 'INBOX.Archive', 'INBOX/Work', 'INBOX/Work/Q3']);

    const work = await repo.getByPath('INBOX/Work');
    expect(work).toMatchObject({ id: 'f-work', name: 'Work', path: 'INBOX/Work', parentId: 'f-inbox' });

    const deep = await repo.getByPath('INBOX/Work/Q3');
    expect(deep!.parentId).toBe('f-work');

    const dotted = await repo.getByPath('INBOX.Archive');
    expect(dotted).toMatchObject({ name: 'Archive', parentId: 'f-inbox' });
  });

  // get/getByPath must be EXACT lookups — a prefix or trailing-delimiter match
  // would hand back the wrong folder and mis-file synced mail.
  it('looks up by exact id and exact path, returning null otherwise', async () => {
    await repo.sync([folder({ id: 'f-work', name: 'Work', path: 'INBOX/Work' })]);

    expect((await repo.get('f-work'))!.path).toBe('INBOX/Work');
    expect(await repo.get('f-missing')).toBeNull();
    expect(await repo.getByPath('INBOX/Work/')).toBeNull();
    expect(await repo.getByPath('INBOX')).toBeNull();
    expect(await repo.getByPath('inbox/work')).toBeNull();
  });

  // special_use is how the app finds Sent/Drafts/Trash for a provider whose
  // folder NAMES are localised or Gmail-prefixed. It must round-trip verbatim,
  // and a plain user folder must stay null (no guessing).
  it('round-trips every special-use attribute and leaves user folders unclassified', async () => {
    const cases: Array<[string, string | null]> = [
      ['INBOX', '\\Inbox'],
      ['Sent', '\\Sent'],
      ['Drafts', '\\Drafts'],
      ['Trash', '\\Trash'],
      ['Spam', '\\Junk'],
      ['Junk Email', '\\Junk'],
      ['[Gmail]/All Mail', '\\All'],
      ['[Gmail]/Trash', '\\Trash'],
      ['[Gmail]/Drafts', '\\Drafts'],
      ['Projects/2026', null],
    ];
    await repo.sync(cases.map(([path, specialUse], i) =>
      folder({ id: `f${i}`, name: path.split(/[/.]/).pop()!, path, specialUse })));

    for (const [path, specialUse] of cases) {
      expect((await repo.getByPath(path))!.specialUse, path).toBe(specialUse);
    }
  });
});

describe('sync — upsert preserves incremental sync state', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => { db = newMigratedDb(); repo = new FolderRepository(() => db); });
  afterEach(() => { db.close(); });

  // The folder-LIST sync knows nothing about UIDs, so it passes nulls. Without
  // COALESCE those nulls would wipe uid_validity/last_sync_uid/highest_modseq on
  // every list refresh, forcing a full re-download of every folder (and a
  // UIDVALIDITY re-key that deletes local mail).
  it('null sync-state fields keep the stored values while metadata still updates', async () => {
    await repo.sync([folder({
      id: 'f-inbox', name: 'INBOX', path: 'INBOX',
      uidValidity: 12, lastSyncUid: 42, lastSyncTime: 1700, highestModseq: 77,
    })]);

    await repo.sync([folder({
      id: 'f-inbox', name: 'Inbox (renamed)', path: 'INBOX',
      specialUse: '\\Inbox', subscribed: false,
    })]);

    expect(await repo.get('f-inbox')).toMatchObject({
      name: 'Inbox (renamed)',
      specialUse: '\\Inbox',
      subscribed: false,
      uidValidity: 12,
      lastSyncUid: 42,
      lastSyncTime: 1700,
      highestModseq: 77,
    });
  });

  // ...but a REAL new value must win, otherwise incremental sync never advances.
  it('non-null sync-state fields overwrite the stored values', async () => {
    await repo.sync([folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX', uidValidity: 1, lastSyncUid: 5, lastSyncTime: 100, highestModseq: 9 })]);
    await repo.sync([folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX', uidValidity: 2, lastSyncUid: 6, lastSyncTime: 200, highestModseq: 10 })]);

    expect(await repo.get('f-inbox')).toMatchObject({
      uidValidity: 2, lastSyncUid: 6, lastSyncTime: 200, highestModseq: 10,
    });
  });

  // A server without CONDSTORE reports no MODSEQ at all: the record omits the
  // field entirely and must store NULL rather than crashing the insert.
  it('accepts a record with no highestModseq at all (non-CONDSTORE server)', async () => {
    const noModseq = folder({ id: 'f-x', name: 'X', path: 'X' });
    delete (noModseq as Partial<FolderRecord>).highestModseq;
    await repo.sync([noModseq]);
    expect((await repo.get('f-x'))!.highestModseq).toBeNull();
  });

  it('syncing an empty list is a no-op (no inserts, no prune)', async () => {
    await repo.sync([folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX' })]);
    await repo.sync([]);
    expect((await repo.getAll()).map((f) => f.id)).toEqual(['f-inbox']);
  });
});

describe('sync — pruning folders deleted server-side', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => { db = newMigratedDb(); repo = new FolderRepository(() => db); });
  afterEach(() => { db.close(); });

  it('removes a vanished EMPTY folder so it stops lingering in the sidebar', async () => {
    await repo.sync([
      folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX' }),
      folder({ id: 'f-old', name: 'Reminders', path: 'Reminders' }),
    ]);

    await repo.sync([folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX' })]);

    expect((await repo.getAll()).map((f) => f.id)).toEqual(['f-inbox']);
  });

  // DATA LOSS GUARD: emails.folder_id is ON DELETE CASCADE, so pruning a folder
  // that still holds local mail would silently destroy that mail as a side
  // effect of a folder LIST. Such a folder must be left for the email-deletion
  // reconcile instead.
  it('NEVER prunes a vanished folder that still holds mail', async () => {
    db.pragma('foreign_keys = ON');
    await repo.sync([
      folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX' }),
      folder({ id: 'f-keep', name: 'Work', path: 'Work' }),
    ]);
    addMigratedEmail(db, { id: 'e1', folderId: 'f-keep', tags: '|Work|' });

    await repo.sync([folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX' })]);

    expect((await repo.getAll()).map((f) => f.id).sort()).toEqual(['f-inbox', 'f-keep']);
    expect(emailRow(db, 'e1')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// update / delete / row mapping
// ---------------------------------------------------------------------------

describe('update, delete and column round-trips', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(async () => {
    db = newMigratedDb();
    repo = new FolderRepository(() => db);
    await repo.sync([folder({ id: 'f-inbox', name: 'INBOX', path: 'INBOX' })]);
  });
  afterEach(() => { db.close(); });

  // The backfill scheduler resumes from these columns; a booleans-as-booleans
  // write would throw at the driver, and a lost backfillOldestUid restarts
  // paging the whole mailbox from the newest UID again.
  it('writes booleans as 0/1 and round-trips backfill + CONDSTORE progress', async () => {
    await repo.update('f-inbox', {
      subscribed: false,
      backfillComplete: true,
      backfillOldestUid: 314,
      highestModseq: 999,
      lastSyncUid: 88,
      totalCount: 7,
      unreadCount: 3,
    });

    expect(await repo.get('f-inbox')).toMatchObject({
      subscribed: false,
      backfillComplete: true,
      backfillOldestUid: 314,
      highestModseq: 999,
      lastSyncUid: 88,
      totalCount: 7,
      unreadCount: 3,
    });
  });

  it('an update with no defined fields is a silent no-op, not an SQL error', async () => {
    await repo.update('f-inbox', {});
    await repo.update('f-inbox', { name: undefined });
    expect((await repo.get('f-inbox'))!.name).toBe('INBOX');
  });

  it('updating an unknown folder changes nothing and does not throw', async () => {
    await repo.update('f-nope', { unreadCount: 5 });
    expect((await repo.get('f-inbox'))!.unreadCount).toBe(0);
  });

  it('maps unset backfill/CONDSTORE/server-count columns to their safe defaults', async () => {
    const rec = (await repo.get('f-inbox'))!;
    expect(rec.highestModseq).toBeNull();
    expect(rec.backfillOldestUid).toBeNull();
    expect(rec.backfillComplete).toBe(false);
    expect(rec.serverMessageCount).toBe(0); // NULL last_known_message_count -> 0
    expect(rec.subscribed).toBe(true);
  });

  it('deletes a folder (and unknown ids are harmless)', async () => {
    await repo.delete('f-nope');
    expect(await repo.get('f-inbox')).not.toBeNull();
    await repo.delete('f-inbox');
    expect(await repo.get('f-inbox')).toBeNull();
    expect(await repo.getAll()).toEqual([]);
  });

  // Why sync()'s prune is guarded on emptiness: deleting a folder row takes its
  // mail with it.
  it('deleting a folder CASCADES its emails away', async () => {
    db.pragma('foreign_keys = ON');
    addMigratedEmail(db, { id: 'e1', folderId: 'f-inbox' });
    await repo.delete('f-inbox');
    expect(emailRow(db, 'e1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// linkEmail / unlinkEmail / getEmailFolders / flags
// ---------------------------------------------------------------------------

describe('linkEmail guards', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX'], ['f-label', 'Work']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // A sync event for a folder/email we don't have locally must not throw or
  // invent rows — sync events arrive for folders the user just deleted.
  it('ignores an unknown folder or unknown email', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|', 10);
    await repo.linkEmail('e1', 'f-ghost', 55);
    await repo.linkEmail('e-ghost', 'f-inbox', 55);
    expect(emailRow(db, 'e1')).toMatchObject({ tags: '|INBOX|', uid: 10 });
  });

  // A link without a uid (or with a bogus 0) must never blank/clobber the
  // primary uid the expunge reconcile matches on.
  it('adds the tag but leaves the uid alone when no usable uid is given', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|', 10);
    await repo.linkEmail('e1', 'f-label');
    expect(emailRow(db, 'e1')).toMatchObject({ tags: '|INBOX|Work|', uid: 10 });

    addEmail(db, 'e2', 'f-inbox', 't2', '|INBOX|', 20);
    await repo.linkEmail('e2', 'f-inbox', 0);
    expect(emailRow(db, 'e2')!.uid).toBe(20);
  });

  it('is idempotent: re-linking with the same uid leaves the row untouched', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|read|', 10);
    await repo.linkEmail('e1', 'f-inbox', 10);
    expect(emailRow(db, 'e1')).toMatchObject({ tags: '|INBOX|read|', uid: 10 });
  });

  // Renumbered UID (server re-key) on an ALREADY-tagged primary: only the uid
  // moves. If it didn't, the folder's reconcile would diff a stale uid against
  // the server and delete live mail.
  it('refreshes only the uid when the folder tag is already present', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|', 10);
    await repo.linkEmail('e1', 'f-inbox', 11);
    expect(emailRow(db, 'e1')).toMatchObject({ tags: '|INBOX|', uid: 11 });
  });

  it('adds the tag AND the uid in one write for a fresh primary link', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '||', null);
    await repo.linkEmail('e1', 'f-inbox', 7);
    expect(emailRow(db, 'e1')).toMatchObject({ tags: '|INBOX|', uid: 7 });
  });
});

describe('unlinkEmail', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX'], ['f-label', 'Work']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // Removing a Gmail label must drop ONLY that folder's tag — the flags and the
  // other memberships are what keep the mail visible elsewhere.
  it('drops just the folder tag and keeps flags plus other memberships', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|Work|read|starred|', 10);
    await repo.unlinkEmail('e1', 'f-label');
    expect(emailRow(db, 'e1')!.tags).toBe('|INBOX|read|starred|');
  });

  it('no-ops for an unknown folder, unknown email, or a tag that is not there', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|', 10);
    await repo.unlinkEmail('e1', 'f-ghost');
    await repo.unlinkEmail('e-ghost', 'f-inbox');
    await repo.unlinkEmail('e1', 'f-label'); // never had the Work tag
    expect(emailRow(db, 'e1')!.tags).toBe('|INBOX|');
  });
});

describe('unlinkOrDeleteFromFolder input guards', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX'], ['f-trash', 'Trash']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // An expunge batch may reference ids we already dropped, and may arrive for a
  // folder that has since been deleted. Neither may abort the batch or throw
  // (the whole IDLE handler would die with it).
  it('returns zeros for an empty batch or an unknown folder, and skips missing ids', async () => {
    expect(await repo.unlinkOrDeleteFromFolder([], 'f-trash')).toEqual({ unlinked: 0, deleted: 0 });
    expect(await repo.unlinkOrDeleteFromFolder(['e1'], 'f-ghost')).toEqual({ unlinked: 0, deleted: 0 });

    addEmail(db, 'e1', 'f-trash', 't1', '|Trash|', 5);
    const res = await repo.unlinkOrDeleteFromFolder(['e-ghost', 'e1'], 'f-trash');
    expect(res).toEqual({ unlinked: 0, deleted: 1 });
    expect(emailRow(db, 'e1')).toBeUndefined();
  });

  // A category/flag tag is NOT a folder membership: a row whose only other tags
  // are `read`/`important` has nowhere left to live and must be deleted, not
  // stranded as an invisible orphan.
  it('treats flag and category tags as non-memberships (row is deleted)', async () => {
    addEmail(db, 'e1', 'f-trash', 't1', '|Trash|read|important|needs_response|', 5);
    expect(await repo.unlinkOrDeleteFromFolder(['e1'], 'f-trash')).toEqual({ unlinked: 0, deleted: 1 });
    expect(emailRow(db, 'e1')).toBeUndefined();
  });
});

describe('getEmailFolders', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX'], ['f-label', 'Work'], ['f-trash', 'Trash']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // The outbound IMAP ops need to know WHICH folder holds the server-side uid: a
  // secondary label has no uid of its own, so reporting the primary's uid for it
  // would send a STORE/MOVE against the wrong folder's message.
  it('lists every tagged folder, exposing the uid only for the primary one', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|Work|read|starred|', 42);

    const folders = await repo.getEmailFolders('e1');
    expect(folders).toEqual([
      { folderId: 'f-inbox', uid: 42, flags: ['\\Seen', '\\Flagged'] },
      { folderId: 'f-label', uid: null, flags: ['\\Seen', '\\Flagged'] },
    ]);
  });

  it('returns an empty list for an unknown email and for an untagged one', async () => {
    expect(await repo.getEmailFolders('e-ghost')).toEqual([]);
    addEmail(db, 'e2', 'f-inbox', 't2', '||', 1);
    expect(await repo.getEmailFolders('e2')).toEqual([]);
  });
});

describe('updateEmailFolderFlags', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // A server flag push is AUTHORITATIVE for flags only. Folder memberships and
  // AI category tags live in the same column and must survive the replacement —
  // losing them would empty the user's category views on every flag sync.
  it('replaces flag tags while preserving folder and category tags', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|read|starred|needs_response|', 1);
    await repo.updateEmailFolderFlags('e1', 'f-inbox', ['\\Answered', '\\Deleted']);
    expect(emailRow(db, 'e1')!.tags).toBe('|INBOX|needs_response|answered|deleted|');
  });

  it('clearing every flag leaves only the non-flag tags', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|read|', 1);
    await repo.updateEmailFolderFlags('e1', 'f-inbox', []);
    expect(emailRow(db, 'e1')!.tags).toBe('|INBOX|');
  });

  it('no-ops for an unknown email', async () => {
    await repo.updateEmailFolderFlags('e-ghost', 'f-inbox', ['\\Seen']);
    expect(db.prepare('SELECT COUNT(*) AS c FROM emails').get()).toMatchObject({ c: 0 });
  });
});

// ---------------------------------------------------------------------------
// recalculateFolderCounts
// ---------------------------------------------------------------------------

describe('recalculateFolderCounts', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([
      ['f-inbox', 'INBOX'], ['f-work', 'INBOX/Work'], ['f-trash', 'Trash'],
    ]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // total_count is per MESSAGE, unread_count is per distinct THREAD — the sidebar
  // shows "3 conversations unread", not 3 messages, so two unread copies of one
  // thread must count once. Rows with no tags or no thread are skipped rather
  // than crashing or inflating the badge.
  it('counts messages for totals and distinct threads for unread', async () => {
    addEmail(db, 'a1', 'f-inbox', 't1', '|INBOX|');
    addEmail(db, 'a2', 'f-inbox', 't1', '|INBOX|');       // same thread, still unread
    addEmail(db, 'a3', 'f-inbox', 't2', '|INBOX|read|');  // read
    addEmail(db, 'a4', 'f-inbox', null, '|INBOX|');       // NULL thread — never unread
    addEmail(db, 'a5', 'f-inbox', 't3', null);            // no tags at all — skipped
    addEmail(db, 'a6', 'f-trash', 't4', '|Trash|');

    await repo.recalculateFolderCounts();

    expect(countsByPath(db)).toEqual({
      INBOX: { total: 4, unread: 1 },        // 4 tagged messages, only thread t1 unread
      'INBOX/Work': { total: 0, unread: 0 },
      Trash: { total: 1, unread: 1 },
    });
  });

  // Nested paths are separate tokens: a message in "INBOX/Work" must not also
  // inflate INBOX, or the parent badge double-counts every child's mail.
  it('does not let a nested child path leak into its parent folder', async () => {
    addEmail(db, 'c1', 'f-work', 't1', '|INBOX/Work|');
    await repo.recalculateFolderCounts();
    const counts = countsByPath(db);
    expect(counts['INBOX/Work']).toEqual({ total: 1, unread: 1 });
    expect(counts.INBOX).toEqual({ total: 0, unread: 0 });
  });

  // Gmail labels: one message, many folders. It must be counted in EVERY folder
  // it is tagged with, and removing one label may only move that folder's count.
  it('counts a multi-folder (label) message in every folder, and unlinking moves only one', async () => {
    addEmail(db, 'm1', 'f-inbox', 't1', '|INBOX|INBOX/Work|');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db)).toMatchObject({
      INBOX: { total: 1, unread: 1 },
      'INBOX/Work': { total: 1, unread: 1 },
    });

    await repo.unlinkEmail('m1', 'f-work');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db)).toMatchObject({
      INBOX: { total: 1, unread: 1 },
      'INBOX/Work': { total: 0, unread: 0 },
    });
  });

  it('drops counts back down after the emails are deleted', async () => {
    addEmail(db, 'd1', 'f-inbox', 't1', '|INBOX|');
    addEmail(db, 'd2', 'f-inbox', 't2', '|INBOX|');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db).INBOX).toEqual({ total: 2, unread: 2 });

    db.prepare('DELETE FROM emails WHERE id = ?').run('d1');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db).INBOX).toEqual({ total: 1, unread: 1 });
  });

  it('tracks read/unread flips without touching total_count', async () => {
    addEmail(db, 'f1', 'f-inbox', 't1', '|INBOX|');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db).INBOX).toEqual({ total: 1, unread: 1 });

    db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|', 'f1');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db).INBOX).toEqual({ total: 1, unread: 0 });

    db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|', 'f1');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db).INBOX).toEqual({ total: 1, unread: 1 });
  });

  // Scoping the recount is the fix for mark-read lag; it must recount exactly
  // the named folders and leave the rest alone (their own action recounts them).
  it('recounts only the named folders when a filter is supplied', async () => {
    addEmail(db, 's1', 'f-inbox', 't1', '|INBOX|');
    addEmail(db, 's2', 'f-trash', 't2', '|Trash|');
    db.prepare('UPDATE folders SET total_count = 99, unread_count = 99').run();

    await repo.recalculateFolderCounts(['INBOX']);

    const counts = countsByPath(db);
    expect(counts.INBOX).toEqual({ total: 1, unread: 1 });
    expect(counts.Trash).toEqual({ total: 99, unread: 99 }); // untouched
  });

  it('an empty filter means "recount everything"', async () => {
    addEmail(db, 's1', 'f-inbox', 't1', '|INBOX|');
    db.prepare('UPDATE folders SET total_count = 99, unread_count = 99').run();

    await repo.recalculateFolderCounts([]);

    expect(countsByPath(db)).toEqual({
      INBOX: { total: 1, unread: 1 },
      'INBOX/Work': { total: 0, unread: 0 },
      Trash: { total: 0, unread: 0 },
    });
  });

  it('a filter naming no known folder short-circuits without touching anything', async () => {
    db.prepare('UPDATE folders SET total_count = 99, unread_count = 99').run();
    await repo.recalculateFolderCounts(['Nope/Missing']);
    expect(countsByPath(db).INBOX).toEqual({ total: 99, unread: 99 });
  });
});

// ---------------------------------------------------------------------------
// applyReadFlagDeltaBatch guards (parity is covered by folder-unread-delta)
// ---------------------------------------------------------------------------

describe('applyReadFlagDeltaBatch guards', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // The delta is called from generic handlers that may have nothing to report;
  // an empty/irrelevant batch must not trigger a scan or move a badge.
  it('does nothing for an empty batch, unknown ids, or tags with no folder token', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|');
    db.prepare('UPDATE folders SET unread_count = 7').run();

    await repo.applyReadFlagDeltaBatch([]);
    await repo.applyReadFlagDeltaBatch([{ emailId: 'e-ghost', nowRead: true }]);

    addEmail(db, 'e2', 'f-inbox', 't2', '|starred|');   // flags only, no folder tag
    addEmail(db, 'e3', 'f-inbox', null, '|INBOX|');     // NULL thread never counts
    addEmail(db, 'e4', 'f-inbox', 't4', null);          // no tags
    await repo.applyReadFlagDeltaBatch([
      { emailId: 'e2', nowRead: true },
      { emailId: 'e3', nowRead: true },
      { emailId: 'e4', nowRead: true },
    ]);

    expect(countsByPath(db).INBOX.unread).toBe(7); // untouched
  });

  // Above the threshold a single full recount is cheaper than N lookups — and it
  // is also self-healing, so a drifted stored count comes back exact.
  it('falls back to a full recount above the batch threshold, repairing drift', async () => {
    for (let i = 0; i < 200; i++) addEmail(db, `b${i}`, 'f-inbox', `bt${i}`, '|INBOX|read|');
    db.prepare('UPDATE folders SET unread_count = 123, total_count = 0').run();

    await repo.applyReadFlagDeltaBatch(
      Array.from({ length: 200 }, (_, i) => ({ emailId: `b${i}`, nowRead: true })),
    );

    expect(countsByPath(db).INBOX).toEqual({ total: 200, unread: 0 });
  });

  it('the single-email wrapper moves exactly the folders the email is tagged with', async () => {
    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|read|');
    await repo.recalculateFolderCounts();
    expect(countsByPath(db).INBOX.unread).toBe(0);

    db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|', 'e1');
    await repo.applyReadFlagDelta('e1', false);
    expect(countsByPath(db).INBOX.unread).toBe(1);
  });
});

describe('recalculateStarredCount', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => {
    db = newMinimalDb([['f-inbox', 'INBOX']]);
    repo = new FolderRepository(() => db);
  });
  afterEach(() => { db.close(); });

  // Drives the Starred view's badge: it is mailbox-wide (any folder) and must
  // match on the exact tag, not a "starred_by_me"-style look-alike.
  it('counts starred messages across folders and ignores look-alike tags', async () => {
    expect(await repo.recalculateStarredCount()).toBe(0);

    addEmail(db, 'e1', 'f-inbox', 't1', '|INBOX|starred|');
    addEmail(db, 'e2', 'f-inbox', 't2', '|Trash|starred|');
    addEmail(db, 'e3', 'f-inbox', 't3', '|INBOX|starred_by_me|');
    addEmail(db, 'e4', 'f-inbox', 't4', '|INBOX|');

    expect(await repo.recalculateStarredCount()).toBe(2);
  });
});

describe('repository initialisation', () => {
  // Every repository method reaches through the accessor; if the DB isn't up yet
  // the caller must get a clear error rather than a TypeError on undefined.
  it('throws a clear error when storage is not initialised', async () => {
    const repo = new FolderRepository(() => undefined as unknown as Database.Database);
    await expect(repo.get('f-inbox')).rejects.toThrow('Storage not initialized');
  });
});
