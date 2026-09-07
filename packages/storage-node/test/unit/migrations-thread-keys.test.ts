import { normalizeSubject } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigrationManager, emailThreadKeys } from '../../src/migrations';
import { openTestDb } from '../../src/test-support/test-db';
import { SQL_REPAIR_ROWS_SINCE, SQL_SUBJECT_CANDIDATES } from '../../src/thread-resolver';

// v70 is a PERFORMANCE migration, and a performance regression here is not a
// slow app — it is a frozen one. The thread resolver runs its subject fallback
// once per email at insert time and once per email per repair iteration; before
// this migration that lookup was `LOWER(subject) LIKE '%norm%'` against a table
// with no index on subject, i.e. a full scan per email. Measured on a real
// 26,184-email mailbox: 94.5% of all main-thread JS time in that one statement,
// producing a 25-second UI freeze every 30 seconds.
//
// The keys live in their own narrow table, NOT in a column on `emails`. That is
// also a measured decision: `emails` stores the bodies inline (6.5 GB for those
// 26k rows), and backfilling a column there rewrote every spilled record — five
// minutes of 100% CPU and a 700 MB WAL before it was killed. These tests pin
// both halves: the key is recorded for EVERY row, and the planner still seeks.

/** An `emails` table as it exists before v70: no key table anywhere. */
function legacyEmailsDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      subject TEXT,
      from_address TEXT,
      date INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

function addLegacyEmail(db: Database.Database, id: string, subject: string | null, date = 1_700_000_000): void {
  db.prepare('INSERT INTO emails (id, subject, from_address, date) VALUES (?,?,?,?)')
    .run(id, subject, 'sender@example.com', date);
}

const keyOf = (db: Database.Database, id: string): { subject_norm: string; date: number; created_at: number } | undefined =>
  db.prepare('SELECT subject_norm, date, created_at FROM email_thread_keys WHERE email_id = ?').get(id) as
    | { subject_norm: string; date: number; created_at: number }
    | undefined;

const indexExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

describe('v70 email_thread_keys migration — upgrading an existing mailbox', () => {
  let db: Database.Database;

  beforeEach(() => { db = legacyEmailsDb(); });
  afterEach(() => db.close());

  // The upgrade path for every existing user. A row with no key row is invisible
  // to the resolver's seek, so its replies would start new threads forever.
  it('creates the table and indexes and backfills a key for every row', () => {
    addLegacyEmail(db, 'e1', 'Quarterly report', 1_700_000_100);
    addLegacyEmail(db, 'e2', 'Re: Quarterly report', 1_700_000_200);
    addLegacyEmail(db, 'e3', 'FWD: Quarterly report', 1_700_000_300);

    emailThreadKeys.up(db);

    expect(tableExists(db, 'email_thread_keys')).toBe(true);
    // All three normalise to the SAME key — that identity is what lets the
    // resolver find a reply's parent with an equality seek instead of a scan.
    expect(keyOf(db, 'e1')?.subject_norm).toBe('quarterly report');
    expect(keyOf(db, 'e2')?.subject_norm).toBe('quarterly report');
    expect(keyOf(db, 'e3')?.subject_norm).toBe('quarterly report');
    // The date is copied so the resolver's window filter never touches `emails`.
    expect(keyOf(db, 'e2')?.date).toBe(1_700_000_200);
    expect(indexExists(db, 'idx_email_thread_keys_lookup')).toBe(true);
    expect(indexExists(db, 'idx_email_thread_keys_created_at')).toBe(true);
  });

  // Backfilled rows are stamped created_at = 0 on purpose: they predate every
  // future incremental-repair window. Reading the real `emails.created_at` —
  // a late-ALTER column that lives past the bodies in the overflow pages —
  // would mean the multi-GB read this migration exists to avoid.
  it('stamps backfilled keys as older than any future repair window', () => {
    addLegacyEmail(db, 'e1', 'Old mail');

    emailThreadKeys.up(db);

    expect(keyOf(db, 'e1')?.created_at).toBe(0);
  });

  // A NULL or empty subject is common (drafts, rows awaiting the envelope
  // repair). It must become '' — a real, seekable value — and the column is NOT
  // NULL precisely so a normalisation that returned null would fail loudly here
  // rather than silently dropping the row out of the index.
  it('stores an empty string, not NULL, for a missing subject', () => {
    addLegacyEmail(db, 'e1', null);
    addLegacyEmail(db, 'e2', '');

    emailThreadKeys.up(db);

    expect(keyOf(db, 'e1')?.subject_norm).toBe('');
    expect(keyOf(db, 'e2')?.subject_norm).toBe('');
  });

  // Partial run: a launch interrupted mid-backfill (app killed, crash) must
  // resume, not restart or duplicate. The LEFT JOIN is what makes that true, so
  // a key already written must be left exactly as it was.
  it('resumes an interrupted backfill and leaves already-written keys alone', () => {
    addLegacyEmail(db, 'e1', 'Re: Invoice 42');
    addLegacyEmail(db, 'e2', 'Re: Invoice 42');
    // Simulate the first (interrupted) attempt having finished only e1.
    db.exec(`
      CREATE TABLE email_thread_keys (
        email_id TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
        subject_norm TEXT NOT NULL,
        date INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    db.prepare('INSERT INTO email_thread_keys (email_id, subject_norm, date, created_at) VALUES (?,?,?,?)')
      .run('e1', 'invoice 42', 1_700_000_000, 12345);

    emailThreadKeys.up(db);

    expect(keyOf(db, 'e1')).toEqual({ subject_norm: 'invoice 42', date: 1_700_000_000, created_at: 12345 });
    expect(keyOf(db, 'e2')?.subject_norm).toBe('invoice 42');
  });

  // Idempotent re-run: the manager can replay a migration against an already
  // migrated DB (a restored file, a downgrade/upgrade cycle). It must not throw
  // on the existing table or duplicate any key row.
  it('is safe to run twice', () => {
    addLegacyEmail(db, 'e1', 'Re: Invoice 42');

    emailThreadKeys.up(db);
    expect(() => emailThreadKeys.up(db)).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS c FROM email_thread_keys').get()).toEqual({ c: 1 });
  });

  // `down` must actually undo this one (unlike the additive-column migrations
  // that cannot), so a rollback through the ladder does not stop here.
  it('drops the table on down()', () => {
    emailThreadKeys.up(db);
    expect(() => emailThreadKeys.down!(db)).not.toThrow();
    expect(tableExists(db, 'email_thread_keys')).toBe(false);
  });
});

describe('v70 email_thread_keys — the resolver query is a SEEK, not a SCAN', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    createMigrationManager(db).migrate();
  });
  afterEach(() => db.close());

  // THE regression guard. If someone reintroduces a function on the column, a
  // leading wildcard, or drops the index, this plan flips back to a full scan of
  // `emails` per email — which is the freeze. Asserted against the resolver's
  // REAL exported SQL so the two cannot drift.
  it('uses idx_email_thread_keys_lookup for the subject-fallback lookup', () => {
    // better-sqlite3 requires every placeholder bound, even to explain, so the
    // five real parameters are supplied: subject_norm, date low/high, self id,
    // and the sort anchor.
    const plan = (db
      .prepare(`EXPLAIN QUERY PLAN ${SQL_SUBJECT_CANDIDATES}`)
      .all('invoice 42', 0, 2_000_000_000, 'e1', 1_700_000_000) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ');

    expect(plan).toContain('idx_email_thread_keys_lookup');
    // `emails` is only ever reached by primary key, for the ≤50 rows that
    // survived the seek — never scanned.
    expect(plan).not.toMatch(/SCAN emails/);
  });

  // The incremental thread repair asks "anything stored since the last pass?"
  // every 10 minutes forever. Without this index that question costs a full
  // table scan even when the answer is "nothing".
  it('uses idx_email_thread_keys_created_at for the incremental repair window', () => {
    const plan = (db
      .prepare(`EXPLAIN QUERY PLAN ${SQL_REPAIR_ROWS_SINCE}`)
      .all(1_700_000_000) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ');

    // `SEARCH`, not `SCAN`: it seeks to the window. Ordering this query by
    // `date` instead would make SQLite walk a whole date index and the
    // created_at bound would stop paying for itself — the mistake this pins.
    expect(plan).toContain('idx_email_thread_keys_created_at');
    expect(plan).toMatch(/SEARCH k /); // `k` is the key table's alias in the query
    expect(plan).not.toMatch(/SCAN emails/);
  });

  // A fresh install gets the table from schema.sql rather than the migration, so
  // both paths must land on the same shape — otherwise new users and upgraded
  // users run different code.
  it('a fresh install has the table and both indexes', () => {
    expect(tableExists(db, 'email_thread_keys')).toBe(true);
    expect(indexExists(db, 'idx_email_thread_keys_lookup')).toBe(true);
    expect(indexExists(db, 'idx_email_thread_keys_created_at')).toBe(true);
  });

  // Guards the contract between the migration, the insert path and the resolver:
  // all three must derive the key with the SAME helper. If one of them ever
  // lower-cased differently or kept the "Re:" prefix, threading breaks silently.
  it('normalizes the same way the resolver looks the key up', () => {
    expect(normalizeSubject('RE: Re: FWD: Weekly sync')).toBe('weekly sync');
  });

  // The key table must not outlive its email. `foreign_keys = ON` is set by
  // SQLiteStorage, so a deleted email takes its key with it; a leaked key row
  // would keep a deleted mail as a candidate and re-thread live mail onto it.
  it('drops a key row with its email (ON DELETE CASCADE)', () => {
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO folders (id, name, path) VALUES ('f1','INBOX','INBOX')").run();
    db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date,
                message_count, participants, has_unread, has_flagged, labels)
                VALUES ('t1','S','m1','m1',1,1,'[]',0,0,'[]')`).run();
    db.prepare(`INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject,
                from_address, date, clean_body, raw_body, content_type, content_hash)
                VALUES ('e1','m1','t1','f1',1,'||','Subject','a@b.com',1,'','','text','h')`).run();
    db.prepare('INSERT INTO email_thread_keys (email_id, subject_norm, date) VALUES (?,?,?)')
      .run('e1', 'subject', 1);

    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');

    expect(keyOf(db, 'e1')).toBeUndefined();
  });
});
