import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { FolderRepository } from '../../../src/repositories/folder-repository';
import { openTestDb } from '../../../src/test-support/test-db';

// Proves the scan-free per-flip unread delta (applyReadFlagDelta) keeps
// folders.unread_count IDENTICAL to a full recalculateFolderCounts across a
// sequence of read/unread toggles — including multi-folder (label) membership,
// same-thread multi-copy, off-inbox, and NULL-thread edge cases. Parity is what
// lets the hot path skip the full-table scan without the badge drifting.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE emails (id TEXT PRIMARY KEY, thread_id TEXT, tags TEXT NOT NULL DEFAULT '||');
    INSERT INTO folders (id, path) VALUES
      ('f-inbox','INBOX'), ('f-inv','Sarv Inbox/Invoices'), ('f-trash','Trash');
  `);
  return db;
}

function add(db: Database.Database, id: string, threadId: string | null, tags: string): void {
  db.prepare('INSERT INTO emails (id, thread_id, tags) VALUES (?,?,?)').run(id, threadId, `|${tags}|`);
}

/** Mirror the markRead handler's tag flip. */
function setRead(db: Database.Database, id: string, read: boolean): void {
  const row = db.prepare('SELECT tags FROM emails WHERE id = ?').get(id) as { tags: string };
  const parts = row.tags.split('|').filter((t) => t);
  const has = parts.includes('read');
  if (read && !has) parts.push('read');
  if (!read && has) parts.splice(parts.indexOf('read'), 1);
  db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(`|${parts.join('|')}|`, id);
}

const unreadByPath = (db: Database.Database): Record<string, number> =>
  Object.fromEntries(
    (db.prepare('SELECT path, unread_count FROM folders').all() as { path: string; unread_count: number }[])
      .map((r) => [r.path, r.unread_count]),
  );

describe('folder unread delta parity (applyReadFlagDelta vs full recount)', () => {
  let db: Database.Database;
  let repo: FolderRepository;

  beforeEach(async () => {
    db = newDb();
    repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');                         // t1: two unread copies in INBOX
    add(db, 'e2', 't1', 'INBOX');
    add(db, 'e3', 't2', 'INBOX|read');                    // t2: read
    add(db, 'e4', 't3', 'INBOX|Sarv Inbox/Invoices');     // t3: unread in INBOX *and* Invoices
    add(db, 'e5', 't4', 'Trash');                         // off-inbox unread
    add(db, 'e6', null, 'INBOX');                         // NULL thread — never counts
    await repo.recalculateFolderCounts();
  });

  it('baseline full recount has the expected distinct-thread unread counts', () => {
    expect(unreadByPath(db)).toEqual({
      INBOX: 2,                       // t1, t3 (t2 read; e6 NULL-thread ignored)
      'Sarv Inbox/Invoices': 1,       // t3
      Trash: 1,                       // t4
    });
  });

  // After each flip, the delta-maintained counts must equal a fresh full recount.
  async function flipAndExpectParity(id: string, read: boolean): Promise<void> {
    setRead(db, id, read);
    await repo.applyReadFlagDelta(id, read);
    const afterDelta = unreadByPath(db);
    await repo.recalculateFolderCounts(); // authoritative — overwrites
    expect(afterDelta).toEqual(unreadByPath(db));
  }

  it('read one of two copies in a thread keeps the folder unread (no change)', async () => {
    await flipAndExpectParity('e1', true);
    expect(unreadByPath(db).INBOX).toBe(2);
  });

  it('reading the last unread copy drops the thread from the folder', async () => {
    await flipAndExpectParity('e1', true);
    await flipAndExpectParity('e2', true);
    expect(unreadByPath(db).INBOX).toBe(1); // only t3 left
  });

  it('reading a multi-folder (label) mail decrements BOTH folders', async () => {
    await flipAndExpectParity('e4', true);
    const u = unreadByPath(db);
    expect(u.INBOX).toBe(1);                  // t1 remains
    expect(u['Sarv Inbox/Invoices']).toBe(0); // t3 gone
  });

  it('marking unread re-adds the thread (round-trips exactly)', async () => {
    await flipAndExpectParity('e4', true);
    await flipAndExpectParity('e4', false);
    expect(unreadByPath(db)).toEqual({ INBOX: 2, 'Sarv Inbox/Invoices': 1, Trash: 1 });
  });

  it('flipping the NULL-thread copy never moves any count', async () => {
    await flipAndExpectParity('e6', true);
    expect(unreadByPath(db)).toEqual({ INBOX: 2, 'Sarv Inbox/Invoices': 1, Trash: 1 });
  });

  it('off-inbox (Trash) flip only touches Trash', async () => {
    await flipAndExpectParity('e5', true);
    expect(unreadByPath(db).Trash).toBe(0);
  });

  // Batch form — flip ALL emails first (like bulkUpdateTags), then one delta call.
  async function batchFlipAndExpectParity(flips: Array<{ id: string; read: boolean }>): Promise<void> {
    for (const f of flips) setRead(db, f.id, f.read);
    await repo.applyReadFlagDeltaBatch(flips.map((f) => ({ emailId: f.id, nowRead: f.read })));
    const afterDelta = unreadByPath(db);
    await repo.recalculateFolderCounts();
    expect(afterDelta).toEqual(unreadByPath(db));
  }

  it('batch reading BOTH copies of a thread at once decrements once (no double-count)', async () => {
    await batchFlipAndExpectParity([{ id: 'e1', read: true }, { id: 'e2', read: true }]);
    expect(unreadByPath(db).INBOX).toBe(1); // t1 gone, t3 remains
  });

  it('batch with mixed directions across threads stays exact', async () => {
    // e4 (t3) → read; e3 (t2, currently read) → unread. Net INBOX: -1 (t3) +1 (t2) = 0 change.
    await batchFlipAndExpectParity([{ id: 'e4', read: true }, { id: 'e3', read: false }]);
    const u = unreadByPath(db);
    expect(u.INBOX).toBe(2);
    expect(u['Sarv Inbox/Invoices']).toBe(0); // t3 left Invoices
  });

  it('batch with OPPOSITE flips in the same thread nets correctly', async () => {
    // Pre-read e1, then batch: e1 → unread AND e2 → read (same thread t1). t1 still
    // has exactly one unread copy throughout → INBOX unread must not move.
    setRead(db, 'e1', true);
    await repo.recalculateFolderCounts();
    await batchFlipAndExpectParity([{ id: 'e1', read: false }, { id: 'e2', read: true }]);
    expect(unreadByPath(db).INBOX).toBe(2);
  });
});

describe('folder unread delta — threshold fallback to full recount', () => {
  it('a batch at/above the 200 flip threshold still yields correct counts', async () => {
    const db = newDb();
    const repo = new FolderRepository(() => db);
    // 200 distinct unread threads in INBOX → over the delta threshold.
    for (let i = 0; i < 200; i++) add(db, `b${i}`, `bt${i}`, 'INBOX');
    await repo.recalculateFolderCounts();
    expect(unreadByPath(db).INBOX).toBe(200);

    const flips = Array.from({ length: 200 }, (_, i) => `b${i}`);
    for (const id of flips) setRead(db, id, true);
    await repo.applyReadFlagDeltaBatch(flips.map((emailId) => ({ emailId, nowRead: true })));
    expect(unreadByPath(db).INBOX).toBe(0); // fell back to a full recount, still exact
  });
});

describe('folder unread delta — copies hidden from the folder never move its badge', () => {
  // Regression: the badge is delta-maintained, so if the recount learned to skip a
  // trashed/deleted INBOX copy but the ±1 delta still counted its read flips, the
  // badge would drift off the list again after the first mark-read in webmail.
  let db: Database.Database;
  let repo: FolderRepository;

  beforeEach(async () => {
    db = newDb();
    repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');               // counts for INBOX
    add(db, 'e2', 't2', 'INBOX|Trash');         // hidden from INBOX, counts for Trash
    add(db, 'e3', 't3', 'INBOX|deleted');       // \Deleted → hidden everywhere
    add(db, 'e4', 't4', 'INBOX|Sarv Inbox/Invoices|Trash'); // hidden from INBOX AND the label
    await repo.recalculateFolderCounts();
  });

  async function flipAndExpectParity(id: string, read: boolean): Promise<void> {
    setRead(db, id, read);
    await repo.applyReadFlagDelta(id, read);
    const afterDelta = unreadByPath(db);
    await repo.recalculateFolderCounts();
    expect(afterDelta).toEqual(unreadByPath(db));
  }

  it('baseline: only listable unread copies are badged', () => {
    expect(unreadByPath(db)).toEqual({ INBOX: 1, 'Sarv Inbox/Invoices': 0, Trash: 2 });
  });

  it('reading a trashed INBOX copy moves Trash, not INBOX', async () => {
    await flipAndExpectParity('e2', true);
    expect(unreadByPath(db)).toEqual({ INBOX: 1, 'Sarv Inbox/Invoices': 0, Trash: 1 });
  });

  it('reading a \\Deleted copy moves nothing', async () => {
    await flipAndExpectParity('e3', true);
    await flipAndExpectParity('e3', false);
    expect(unreadByPath(db)).toEqual({ INBOX: 1, 'Sarv Inbox/Invoices': 0, Trash: 2 });
  });

  it('a label copy shadowed by Trash does not badge the label either', async () => {
    await flipAndExpectParity('e4', true);
    expect(unreadByPath(db)).toEqual({ INBOX: 1, 'Sarv Inbox/Invoices': 0, Trash: 1 });
    await flipAndExpectParity('e4', false);
    expect(unreadByPath(db)).toEqual({ INBOX: 1, 'Sarv Inbox/Invoices': 0, Trash: 2 });
  });

  it('batch with a mix of listable and hidden copies stays exact', async () => {
    for (const id of ['e1', 'e2', 'e3', 'e4']) setRead(db, id, true);
    await repo.applyReadFlagDeltaBatch(['e1', 'e2', 'e3', 'e4'].map((emailId) => ({ emailId, nowRead: true })));
    const afterDelta = unreadByPath(db);
    await repo.recalculateFolderCounts();
    expect(afterDelta).toEqual(unreadByPath(db));
    expect(afterDelta).toEqual({ INBOX: 0, 'Sarv Inbox/Invoices': 0, Trash: 0 });
  });
});
