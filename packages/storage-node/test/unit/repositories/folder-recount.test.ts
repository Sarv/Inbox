import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { FolderRepository } from '../../../src/repositories/folder-repository';
import { openTestDb } from '../../../src/test-support/test-db';

// recalculateFolderCounts is the source of truth for the sidebar badge
// (unread_count) and the flat-folder pagination denominator (total_count). Two
// invariants matter and are asserted here:
//   1. total_count = MESSAGE count per folder token (read + unread, once per
//      copy, counted in EVERY folder a labelled mail belongs to); unread_count =
//      distinct non-read thread count (NULL threads ignored). folder-unread-delta
//      covers the delta-vs-full parity; this pins the absolute totals.
//   2. SCOPED recount (recalculateFolderCounts([paths])) yields the SAME numbers
//      for the listed folders as a full recount, and touches ONLY those folders.
//      The background backfill / gap-drain rely on this to refresh just the
//      folder that received mail — if scoped drifted from full, the live sidebar
//      counter would be wrong until the next full sync.

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

const snapshot = (db: Database.Database): Record<string, { total: number; unread: number }> =>
  Object.fromEntries(
    (db.prepare('SELECT path, total_count, unread_count FROM folders').all() as
      { path: string; total_count: number; unread_count: number }[])
      .map((r) => [r.path, { total: r.total_count, unread: r.unread_count }]),
  );

describe('recalculateFolderCounts — absolute totals', () => {
  let db: Database.Database;
  let repo: FolderRepository;

  beforeEach(async () => {
    db = newDb();
    repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');                       // t1 unread (2 copies)
    add(db, 'e2', 't1', 'INBOX');
    add(db, 'e3', 't2', 'INBOX|read');                  // t2 read
    add(db, 'e4', 't3', 'INBOX|Sarv Inbox/Invoices');   // t3 unread, in BOTH folders
    add(db, 'e5', 't4', 'Trash');                        // off-inbox unread
    add(db, 'e6', null, 'INBOX');                        // NULL thread — message counts, unread does not
    await repo.recalculateFolderCounts();
  });

  it('total_count = messages per folder (including multi-folder membership + NULL threads)', () => {
    const s = snapshot(db);
    expect(s.INBOX.total).toBe(5);                    // e1,e2,e3,e4,e6
    expect(s['Sarv Inbox/Invoices'].total).toBe(1);  // e4
    expect(s.Trash.total).toBe(1);                    // e5
  });

  it('unread_count = distinct non-read threads (NULL thread ignored)', () => {
    const s = snapshot(db);
    expect(s.INBOX.unread).toBe(2);                   // t1, t3 (t2 read; e6 NULL ignored)
    expect(s['Sarv Inbox/Invoices'].unread).toBe(1); // t3
    expect(s.Trash.unread).toBe(1);                   // t4
  });
});

describe('recalculateFolderCounts — scoped == full, and scope isolation', () => {
  it('a scoped recount matches a full recount for the listed folder', async () => {
    const db = newDb();
    const repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');
    add(db, 'e2', 't2', 'INBOX|read');
    add(db, 'e3', 't3', 'Sarv Inbox/Invoices');
    await repo.recalculateFolderCounts();

    // New unread mail lands in INBOX (what the backfill/drain does).
    add(db, 'e4', 't4', 'INBOX');
    add(db, 'e5', 't4', 'INBOX'); // same new thread, second copy → +1 total, no extra unread thread

    await repo.recalculateFolderCounts(['INBOX']);   // scoped: only INBOX
    const scoped = snapshot(db);
    await repo.recalculateFolderCounts();            // full: authoritative
    const full = snapshot(db);

    // The listed folder's scoped numbers equal the full recount's numbers.
    expect(scoped.INBOX).toEqual(full.INBOX);
    expect(full.INBOX).toEqual({ total: 4, unread: 2 }); // e1,e2,e4,e5 msgs; t1,t4 unread (t2 read)
  });

  it('scoped recount does NOT alter folders outside the list', async () => {
    const db = newDb();
    const repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');
    add(db, 'e2', 't2', 'Sarv Inbox/Invoices');
    await repo.recalculateFolderCounts();
    const invBefore = snapshot(db)['Sarv Inbox/Invoices'];

    // Mail changes in Invoices, but we scope the recount to INBOX only.
    add(db, 'e3', 't3', 'Sarv Inbox/Invoices');
    await repo.recalculateFolderCounts(['INBOX']);

    // Invoices is untouched by the scoped recount (still its stale value) — proving
    // scope isolation; a caller must list every folder it changed.
    expect(snapshot(db)['Sarv Inbox/Invoices']).toEqual(invBefore);
  });

  it('an empty / omitted path list recounts everything', async () => {
    const db = newDb();
    const repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');
    add(db, 'e2', 't2', 'Sarv Inbox/Invoices');
    await repo.recalculateFolderCounts([]); // empty → treated as "all"
    const s = snapshot(db);
    expect(s.INBOX).toEqual({ total: 1, unread: 1 });
    expect(s['Sarv Inbox/Invoices']).toEqual({ total: 1, unread: 1 });
  });
});

// recalculateFolderCounts picks a strategy by folder count: a targeted per-folder
// aggregate scan for a FEW folders (the hot realtime/sync path that recounts one
// folder after new mail — this removed the repeated full-table JS scan that
// beachballed a big mailbox), and a single full-table JS pass for MANY. Both must
// return byte-identical numbers or the sidebar badge would flicker between a
// scoped recount and the periodic full-recount backstop.
describe('recalculateFolderCounts — targeted vs full-scan strategy parity', () => {
  // Regression: a folder whose path is a PREFIX of another (Work vs Work/Reports)
  // must not cross-count. The targeted path relies on instr(tags,'|path|') with
  // BOTH delimiters to prevent it; if a bare instr(tags,'path') crept in, Work
  // would absorb every Work/Reports message.
  it('targeted recount does not let a path-prefix folder absorb its children', async () => {
    const db = openTestDb();
    db.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE emails (id TEXT PRIMARY KEY, thread_id TEXT, tags TEXT NOT NULL DEFAULT '||');
      INSERT INTO folders (id, path) VALUES ('f-work','Work'), ('f-rep','Work/Reports');
    `);
    const repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'Work');            // only Work
    add(db, 'e2', 't2', 'Work/Reports');    // only the child
    await repo.recalculateFolderCounts(['Work', 'Work/Reports']); // 2 folders → targeted

    const s = snapshot(db);
    expect(s.Work).toEqual({ total: 1, unread: 1 });          // e1 only, NOT e2
    expect(s['Work/Reports']).toEqual({ total: 1, unread: 1 }); // e2 only
  });

  // The two implementations must agree exactly. Build >6 folders (so a full,
  // omitted-path recount takes the full-scan branch) and compare its numbers to a
  // per-folder targeted recount over the same data.
  it('full-scan and targeted recounts produce identical numbers on the same data', async () => {
    const db = openTestDb();
    const paths = ['INBOX', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6']; // 7 > SCOPED_RECOUNT_MAX_FOLDERS
    db.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE emails (id TEXT PRIMARY KEY, thread_id TEXT, tags TEXT NOT NULL DEFAULT '||');
      ${paths.map((p, i) => `INSERT INTO folders (id, path) VALUES ('f${i}','${p}');`).join('\n')}
    `);
    const repo = new FolderRepository(() => db);
    add(db, 'e1', 't1', 'INBOX');
    add(db, 'e2', 't1', 'INBOX');            // same thread, 2nd copy
    add(db, 'e3', 't2', 'INBOX|read');       // read
    add(db, 'e4', 't3', 'INBOX|F1');         // multi-folder, unread
    add(db, 'e5', null, 'F1');               // NULL thread — total yes, unread no
    add(db, 'e6', 't4', 'F2|read');          // read
    add(db, 'e7', 't5', 'F6');               // unread

    // Full recount (omitted list, 7 folders) → full-scan branch → authoritative.
    await repo.recalculateFolderCounts();
    const full = snapshot(db);

    // Now recount every folder ONE AT A TIME (each a 1-folder targeted recount)
    // and confirm the numbers land identically.
    for (const p of paths) await repo.recalculateFolderCounts([p]);
    const targeted = snapshot(db);

    expect(targeted).toEqual(full);
    expect(full.INBOX).toEqual({ total: 4, unread: 2 });   // e1,e2,e3,e4 msgs; t1,t3 unread
    expect(full.F1).toEqual({ total: 2, unread: 1 });      // e4,e5 msgs; t3 unread (e5 NULL ignored)
    expect(full.F6).toEqual({ total: 1, unread: 1 });      // e7
  });
});

describe('recalculateFolderCounts — unread only counts copies that LIST in the folder', () => {
  // Regression: the INBOX badge showed 11 while "Filtered: Unread" showed 0. The
  // list hides any INBOX copy that also sits in Trash/Junk/Sent/Drafts or carries
  // \Deleted (liveUnreadSum / thread_folders.has_unread), but the badge counted
  // every unread copy tagged INBOX. Both recount strategies must apply the same
  // listing scope as the list, or the badge counts mail the user can't find.
  function seeded(paths: string[]): { db: Database.Database; repo: FolderRepository } {
    const db = openTestDb();
    db.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE emails (id TEXT PRIMARY KEY, thread_id TEXT, tags TEXT NOT NULL DEFAULT '||');
      ${paths.map((p, i) => `INSERT INTO folders (id, path) VALUES ('f${i}','${p}');`).join('\n')}
    `);
    add(db, 'e1', 't1', 'INBOX');                 // plain unread → counts
    add(db, 'e2', 't2', 'INBOX|Trash');           // webmail-trashed, tag never dropped → hidden from INBOX
    add(db, 'e3', 't3', 'INBOX|Junk');            // same, Junk
    add(db, 'e4', 't4', 'INBOX|deleted');         // \Deleted but not expunged → hidden
    add(db, 'e5', 't5', 'INBOX|Sent');            // a Sent copy leaking INBOX → hidden
    add(db, 'e6', 't6', 'Trash');                 // Trash's OWN unread → counts for Trash
    add(db, 'e7', 't7', 'Trash|Junk');            // Trash copy shadowed by Junk → hidden from Trash
    add(db, 'e8', 't8', 'INBOX|Sarv Inbox/Invoices'); // a plain label is NOT a shadow → counts for both
    return { db, repo: new FolderRepository(() => db) };
  }

  const expected = {
    INBOX: { total: 6, unread: 2 }, // every copy counts for total; unread = t1, t8 only
    // e2, e6, e7 are Trash members. INBOX is not a special folder, so e2 LISTS in
    // Trash (unread); e7 is shadowed there by Junk. Unread = t2, t6.
    Trash: { total: 3, unread: 2 },
  };

  it('targeted recount (few folders) excludes trashed/junked/deleted/sent copies', async () => {
    const { db, repo } = seeded(['INBOX', 'Trash', 'Junk', 'Sent', 'Sarv Inbox/Invoices']);
    await repo.recalculateFolderCounts(['INBOX', 'Trash']); // 2 folders → targeted
    const s = snapshot(db);
    expect(s.INBOX).toEqual(expected.INBOX);
    expect(s.Trash).toEqual(expected.Trash);
  });

  it('full-scan recount (many folders) yields the SAME numbers as targeted', async () => {
    const many = ['INBOX', 'Trash', 'Junk', 'Sent', 'Sarv Inbox/Invoices', 'F5', 'F6']; // 7 → full-scan
    const { db, repo } = seeded(many);
    await repo.recalculateFolderCounts();
    const full = snapshot(db);
    for (const p of many) await repo.recalculateFolderCounts([p]);
    expect(snapshot(db)).toEqual(full);
    expect(full.INBOX).toEqual(expected.INBOX);
    expect(full.Trash).toEqual(expected.Trash);
    // Junk lists e3 (INBOX is not a special folder, so it does not shadow Junk) but
    // not e7 (Trash does) — Junk's own unread badge is 1, exactly what its list shows.
    expect(full.Junk).toEqual({ total: 2, unread: 1 });
    expect(full['Sarv Inbox/Invoices']).toEqual({ total: 1, unread: 1 });
  });
});
