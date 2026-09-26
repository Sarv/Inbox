import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { ReadModelMaintainer } from '../../../src/read-model-maintainer';
import { FolderRepository } from '../../../src/repositories/folder-repository';
import { insertReadModelEmail, openReadModelTestDb } from '../../../src/test-support/read-model-test-db';
import { openTestDb } from '../../../src/test-support/test-db';

// The sidebar badge (`folders.unread_count`) used to be a hand-maintained scalar:
// every path that wrote the `|read|` tag owed it a +/-1 delta, and one path that
// forgot (the triage pipeline's auto-read) left INBOX badged 7 over an unread
// list with nothing in it, for the rest of the session.
//
// These tests pin the STRUCTURAL replacement: the badge is counted from
// `thread_folders` — the same projection the unread-filtered list scans — and it
// is refreshed by the read-model drain, which the `emails` triggers make
// unavoidable for ANY write to a mail's tags, repository method or ad-hoc SQL.
// What breaks if they fail is a badge that disagrees with the list it labels.

const FOLDERS = [
  { id: 'f-inbox', path: 'INBOX' },
  { id: 'f-inv', path: 'Sarv Inbox/Invoices' },
  { id: 'f-trash', path: 'Trash' },
];

const badge = (db: Database.Database, path: string): number =>
  (db.prepare('SELECT unread_count FROM folders WHERE path = ?').get(path) as { unread_count: number }).unread_count;

const total = (db: Database.Database, path: string): number =>
  (db.prepare('SELECT total_count FROM folders WHERE path = ?').get(path) as { total_count: number }).total_count;

/** What the unread-filtered LIST would show for a folder: the read model's own
 *  count, queried exactly as the list queries it. */
const listUnread = (db: Database.Database, folderId: string): number =>
  (db.prepare('SELECT COUNT(*) c FROM thread_folders WHERE folder_id = ? AND has_unread = 1')
    .get(folderId) as { c: number }).c;

const setBadge = (db: Database.Database, path: string, value: number): void => {
  db.prepare('UPDATE folders SET unread_count = ? WHERE path = ?').run(value, path);
};

describe('folders.unread_count from the read model', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  let maintainer: ReadModelMaintainer;

  beforeEach(() => {
    db = openReadModelTestDb(FOLDERS);
    repo = new FolderRepository(() => db);
    // Exactly the production wiring (sqlite-storage.ts): the drain refreshes the
    // badges, so no write site has to know a badge exists.
    maintainer = new ReadModelMaintainer(() => db, () => { repo.refreshUnreadFromReadModel(); });
  });

  describe('refreshUnreadFromReadModel', () => {
    it('re-states a drifted badge from the projection the list reads', () => {
      // The reported bug, in miniature: badge says 7, the list has nothing.
      insertReadModelEmail(db, 't1', 'INBOX|read');
      maintainer.backfillNow();
      setBadge(db, 'INBOX', 7);

      expect(repo.refreshUnreadFromReadModel()).toEqual({ refreshed: true, changed: ['INBOX'] });
      expect(badge(db, 'INBOX')).toBe(0);
      expect(badge(db, 'INBOX')).toBe(listUnread(db, 'f-inbox'));
    });

    it('counts DISTINCT THREADS, not messages (the unit the list renders)', () => {
      // A two-message unread thread is ONE row in the list, so one in the badge.
      insertReadModelEmail(db, 't1', 'INBOX');
      insertReadModelEmail(db, 't1', 'INBOX');
      insertReadModelEmail(db, 't2', 'INBOX');
      maintainer.backfillNow();
      expect(badge(db, 'INBOX')).toBe(2);
    });

    it('refuses while the backfill is still running (a partial projection under-reports)', () => {
      // Counting from a half-built read model is the failure that looks like
      // "my unread mail vanished" — the tags scan owns the badge until it is done.
      insertReadModelEmail(db, 't1', 'INBOX');
      maintainer.backfillNow();
      db.prepare("UPDATE read_model_state SET value = 'running' WHERE key = 'status'").run();
      setBadge(db, 'INBOX', 5);

      expect(repo.refreshUnreadFromReadModel()).toEqual({ refreshed: false, changed: [] });
      expect(badge(db, 'INBOX')).toBe(5); // untouched, not zeroed
    });

    it('refuses while dirty rows are pending (the projection is one drain behind)', () => {
      // `thread_folders` is rebuilt asynchronously. Counting from it with a
      // rebuild outstanding stores a number that was true a moment ago.
      insertReadModelEmail(db, 't1', 'INBOX');
      maintainer.backfillNow();
      expect(badge(db, 'INBOX')).toBe(1);

      db.prepare('UPDATE emails SET tags = ? WHERE thread_id = ?').run('|INBOX|read|', 't1');
      expect(repo.refreshUnreadFromReadModel()).toEqual({ refreshed: false, changed: [] });
      expect(badge(db, 'INBOX')).toBe(1); // still the pre-drain value
    });

    it('refuses (and never throws) on a DB with no read-model tables', () => {
      // A store below migration v65, or a fixture that builds only what it needs.
      const bare = openTestDb();
      bare.exec(`CREATE TABLE folders (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0);
        INSERT INTO folders (id, path, unread_count) VALUES ('f','INBOX', 3);`);
      const bareRepo = new FolderRepository(() => bare);

      expect(bareRepo.refreshUnreadFromReadModel()).toEqual({ refreshed: false, changed: [] });
      expect(badge(bare, 'INBOX')).toBe(3);
      bare.close();
    });

    it('scoped to folder ids, it leaves every other folder alone', () => {
      // The drain refreshes everything, but a scoped caller must not blow away a
      // badge it was never asked about.
      insertReadModelEmail(db, 't1', 'INBOX');
      insertReadModelEmail(db, 't2', 'Sarv Inbox/Invoices');
      maintainer.backfillNow();
      setBadge(db, 'INBOX', 9);
      setBadge(db, 'Sarv Inbox/Invoices', 9);

      expect(repo.refreshUnreadFromReadModel(['f-inbox'])).toEqual({ refreshed: true, changed: ['INBOX'] });
      expect(badge(db, 'INBOX')).toBe(1);
      expect(badge(db, 'Sarv Inbox/Invoices')).toBe(9);
    });

    it('is idempotent — re-running changes nothing', () => {
      insertReadModelEmail(db, 't1', 'INBOX');
      maintainer.backfillNow();
      repo.refreshUnreadFromReadModel();
      const first = badge(db, 'INBOX');
      repo.refreshUnreadFromReadModel();
      repo.refreshUnreadFromReadModel();
      expect(badge(db, 'INBOX')).toBe(first);
    });

    it('does not leak across accounts — each account DB has its own badges', () => {
      // Accounts are separate database files; a refresh driven by one account's
      // drain must not touch another's counts.
      insertReadModelEmail(db, 't1', 'INBOX');
      maintainer.backfillNow();

      const other = openReadModelTestDb([{ id: 'f-inbox', path: 'INBOX' }]);
      const otherRepo = new FolderRepository(() => other);
      const otherMaintainer = new ReadModelMaintainer(() => other, () => { otherRepo.refreshUnreadFromReadModel(); });
      insertReadModelEmail(other, 'o1', 'INBOX');
      insertReadModelEmail(other, 'o2', 'INBOX');
      otherMaintainer.backfillNow();

      expect(badge(db, 'INBOX')).toBe(1);
      expect(badge(other, 'INBOX')).toBe(2);
      other.close();
    });
  });

  describe('the drain keeps the badge honest without the writer knowing', () => {
    it('an ad-hoc UPDATE that marks the last unread mail read still drops the badge', () => {
      // THE regression. This write calls no count helper at all — exactly what
      // the triage pipeline did. The trigger dirties the thread and the drain's
      // refresh pays the debt the writer never knew it owed.
      insertReadModelEmail(db, 't1', 'INBOX', { id: 'x1' });
      maintainer.backfillNow();
      expect(badge(db, 'INBOX')).toBe(1);

      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|', 'x1');
      maintainer.flushNow();

      expect(badge(db, 'INBOX')).toBe(0);
      expect(badge(db, 'INBOX')).toBe(listUnread(db, 'f-inbox'));
    });

    it('seven auto-read mails in one burst leave the badge at zero, not seven', () => {
      // The exact shape of the report: seven single-message threads marked read
      // by the pipeline in one pass, seven decrements never paid.
      for (let i = 0; i < 7; i++) insertReadModelEmail(db, `t${i}`, 'INBOX', { id: `p${i}` });
      maintainer.backfillNow();
      expect(badge(db, 'INBOX')).toBe(7);

      db.prepare("UPDATE emails SET tags = '|INBOX|read|' WHERE id LIKE 'p%'").run();
      maintainer.flushNow();

      expect(badge(db, 'INBOX')).toBe(0);
    });

    it('marking mail UNREAD again raises the badge back', () => {
      // The delta path has a sign; this one is derived, so it cannot get it wrong.
      insertReadModelEmail(db, 't1', 'INBOX|read', { id: 'x1' });
      maintainer.backfillNow();
      expect(badge(db, 'INBOX')).toBe(0);

      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|', 'x1');
      maintainer.flushNow();
      expect(badge(db, 'INBOX')).toBe(1);
    });

    it('an interrupted drain leaves the badge behind, and the next drain finishes it', () => {
      // Budgeted chunks mean a burst can stop half-way. The queue is persistent,
      // so the repair is "resume", never "lost".
      for (let i = 0; i < 4; i++) insertReadModelEmail(db, `t${i}`, 'INBOX', { id: `q${i}` });
      maintainer.backfillNow();
      expect(badge(db, 'INBOX')).toBe(4);

      db.prepare("UPDATE emails SET tags = '|INBOX|read|' WHERE id LIKE 'q%'").run();
      maintainer.drainChunk(2);                 // partial: two threads rebuilt, two queued
      expect(repo.refreshUnreadFromReadModel().refreshed).toBe(false); // rows still pending
      expect(badge(db, 'INBOX')).toBe(4);       // deliberately NOT a half-truth

      maintainer.flushNow();
      expect(badge(db, 'INBOX')).toBe(0);
    });
  });

  describe('recalculateFolderCounts', () => {
    it('takes unread from the read model, and total_count still from the messages', async () => {
      insertReadModelEmail(db, 't1', 'INBOX');
      insertReadModelEmail(db, 't1', 'INBOX');       // same thread, second message
      insertReadModelEmail(db, 't2', 'INBOX|read');
      maintainer.backfillNow();
      setBadge(db, 'INBOX', 9);

      await repo.recalculateFolderCounts(['INBOX']);
      expect(badge(db, 'INBOX')).toBe(1);            // threads, from thread_folders
      expect(total(db, 'INBOX')).toBe(3);            // messages, from emails
    });

    it('falls back to the tags scan while a rebuild is pending, then converges', async () => {
      // Recounts fire right after a move/bulk action, when the projection is
      // still catching up — the answer must be the CURRENT one, not the stale one.
      insertReadModelEmail(db, 't1', 'INBOX', { id: 'x1' });
      insertReadModelEmail(db, 't2', 'INBOX', { id: 'x2' });
      maintainer.backfillNow();

      db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|', 'x1');
      await repo.recalculateFolderCounts(['INBOX']);
      expect(badge(db, 'INBOX')).toBe(1);            // counted from email_tags: current, not the stale 2

      maintainer.flushNow();
      expect(badge(db, 'INBOX')).toBe(1);            // read model agrees once drained
    });

    it('uses the read model for a whole-mailbox recount too (many folders)', async () => {
      // The folder count used to select a second implementation; it no longer
      // does, and the badge must still not depend on how many folders the caller
      // happened to ask about.
      const many = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, path: `F${i}` }));
      const manyDb = openReadModelTestDb(many);
      const manyRepo = new FolderRepository(() => manyDb);
      const manyMaintainer = new ReadModelMaintainer(() => manyDb, () => { manyRepo.refreshUnreadFromReadModel(); });
      insertReadModelEmail(manyDb, 'm1', 'F0');
      insertReadModelEmail(manyDb, 'm2', 'F0|read');
      manyMaintainer.backfillNow();
      manyDb.prepare("UPDATE folders SET unread_count = 9").run();

      await manyRepo.recalculateFolderCounts();
      expect(badge(manyDb, 'F0')).toBe(1);
      expect(badge(manyDb, 'F1')).toBe(0);
      manyDb.close();
    });

    it('scoped and full recounts agree on the unread number', async () => {
      insertReadModelEmail(db, 't1', 'INBOX');
      insertReadModelEmail(db, 't2', 'Sarv Inbox/Invoices');
      maintainer.backfillNow();

      await repo.recalculateFolderCounts();
      const full = { inbox: badge(db, 'INBOX'), inv: badge(db, 'Sarv Inbox/Invoices') };
      setBadge(db, 'INBOX', 9);
      setBadge(db, 'Sarv Inbox/Invoices', 9);
      await repo.recalculateFolderCounts(['INBOX', 'Sarv Inbox/Invoices']);

      expect({ inbox: badge(db, 'INBOX'), inv: badge(db, 'Sarv Inbox/Invoices') }).toEqual(full);
    });

    it('DELIBERATE CHANGE: Trash no longer badges unread, matching its own list', async () => {
      // The tags scan counted an unread Trash copy for Trash itself, but the read
      // model treats trashed copies as not-live, so the Trash LIST shows nothing.
      // Badge 13 over an empty list is the same bug as INBOX's 7 — pinned here so
      // the 0 reads as a decision, not an accident.
      insertReadModelEmail(db, 't1', 'Trash');
      maintainer.backfillNow();

      await repo.recalculateFolderCounts(['Trash']);
      expect(badge(db, 'Trash')).toBe(0);
      expect(listUnread(db, 'f-trash')).toBe(0);
      expect(total(db, 'Trash')).toBe(1);          // the message itself is still there
    });
  });
});

// `changed` is what wakes the renderer. Too eager and every drain re-queries the
// sidebar; too quiet and a repaired badge sits in the DB unseen.
describe('refreshUnreadFromReadModel — what it reports as changed', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  let maintainer: ReadModelMaintainer;

  beforeEach(() => {
    db = openReadModelTestDb(FOLDERS);
    repo = new FolderRepository(() => db);
    maintainer = new ReadModelMaintainer(() => db, () => { repo.refreshUnreadFromReadModel(); });
  });

  it('reports nothing when every badge already agrees with the read model', () => {
    insertReadModelEmail(db, 't1', 'INBOX');
    maintainer.backfillNow();
    expect(repo.refreshUnreadFromReadModel()).toEqual({ refreshed: true, changed: [] });
  });

  it('names only the folders whose badge actually moved', () => {
    insertReadModelEmail(db, 't1', 'INBOX');
    insertReadModelEmail(db, 't2', 'Sarv Inbox/Invoices');
    maintainer.backfillNow();
    setBadge(db, 'Sarv Inbox/Invoices', 4);

    expect(repo.refreshUnreadFromReadModel()).toEqual({ refreshed: true, changed: ['Sarv Inbox/Invoices'] });
  });

  it('reports each drifted folder once, and nothing on the immediate re-run', () => {
    insertReadModelEmail(db, 't1', 'INBOX');
    insertReadModelEmail(db, 't2', 'Sarv Inbox/Invoices');
    maintainer.backfillNow();
    setBadge(db, 'INBOX', 6);
    setBadge(db, 'Sarv Inbox/Invoices', 6);

    expect(repo.refreshUnreadFromReadModel().changed.sort()).toEqual(['INBOX', 'Sarv Inbox/Invoices']);
    expect(repo.refreshUnreadFromReadModel().changed).toEqual([]);
  });
});
