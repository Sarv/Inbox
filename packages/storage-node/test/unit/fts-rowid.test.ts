import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { applyFtsSchema, FTS_BACKFILL_MISSING_SQL, FTS_COLUMNS, FTS_REBUILD_SQL, FTS_TABLE_DDL } from '../../src/fts-schema';
import { ftsRowidAlignment } from '../../src/migrations';
import { openTestDb } from '../../src/test-support/test-db';

// The search index is keyed by `rowid`, not by its stored `email_id` column.
//
// `email_id` is declared UNINDEXED and fts5 exposes no secondary index, so
// `WHERE email_id = ?` plans as `SCAN ... VIRTUAL TABLE INDEX 0:` — a full scan
// of the entire index, per row. On a real mailbox that made a 410-row deletion
// take 9.2 seconds instead of 44ms, and it sat on the UPDATE path too (the update
// trigger deletes before re-inserting), so every arriving body paid it. These
// tests pin BOTH halves: the plan stays a seek, and the triggers still keep the
// index exactly in step with `emails` + `email_bodies`.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY, subject TEXT, from_address TEXT, from_name TEXT,
      to_address TEXT, cc_address TEXT, attachment_names TEXT, clean_body TEXT
    );
    CREATE TABLE email_bodies (email_id TEXT PRIMARY KEY, clean_body TEXT);
  `);
  applyFtsSchema(db);
  return db;
}

const addEmail = (db: Database.Database, id: string, subject: string, body: string | null = null): void => {
  db.prepare(
    `INSERT INTO emails (id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body)
     VALUES (?, ?, 'a@x.com', 'Sender', 'me@x.com', '', '', ?)`,
  ).run(id, subject, body);
};

const hits = (db: Database.Database, term: string): string[] =>
  (db.prepare("SELECT email_id FROM emails_fts WHERE emails_fts MATCH ? ORDER BY email_id").all(term) as { email_id: string }[])
    .map((r) => r.email_id);

const indexSize = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM emails_fts').get() as { n: number }).n;

/** The rowid the index row for `id` is stored under. */
const ftsRowid = (db: Database.Database, id: string): number | undefined =>
  (db.prepare('SELECT rowid FROM emails_fts WHERE email_id = ?').get(id) as { rowid: number } | undefined)?.rowid;

describe('FTS rowid contract', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('addresses the index by rowid — a seek, not a whole-index scan', () => {
    // THE regression. If this plan goes back to SCAN, every insert, update and
    // delete of an email walks the entire search index, and a bulk delete freezes
    // the main process for minutes.
    addEmail(db, 'e1', 'Quarterly plan');
    const plan = (db.prepare('EXPLAIN QUERY PLAN DELETE FROM emails_fts WHERE rowid = ?').all(1) as { detail: string }[])
      .map((r) => r.detail).join(' | ');
    // SQLite reports every virtual-table access as "SCAN <t> VIRTUAL TABLE INDEX
    // <n>:<idxStr>"; what separates a seek from a full walk is the constraint
    // fts5 accepted, which it reports as the `=` in the idxStr.
    expect(plan).toContain('VIRTUAL TABLE INDEX 0:=');

    // And the shape we moved AWAY from gets no constraint at all — so the
    // assertion above is testing something real, not a plan every query gets.
    const scanPlan = (db.prepare('EXPLAIN QUERY PLAN DELETE FROM emails_fts WHERE email_id = ?').all('e1') as { detail: string }[])
      .map((r) => r.detail).join(' | ');
    expect(scanPlan).toContain('VIRTUAL TABLE INDEX 0:');
    expect(scanPlan).not.toContain('VIRTUAL TABLE INDEX 0:=');
  });

  it('indexes a new email under its own emails.rowid', () => {
    // The whole scheme rests on the two rowids being the same number; if the
    // insert trigger stopped supplying it, fts5 would assign its own and every
    // later delete-by-rowid would remove the WRONG message from search.
    addEmail(db, 'e1', 'Quarterly plan');
    addEmail(db, 'e2', 'Lunch');
    const emailRowid = (db.prepare('SELECT rowid FROM emails WHERE id = ?').get('e2') as { rowid: number }).rowid;
    expect(ftsRowid(db, 'e2')).toBe(emailRowid);
    expect(hits(db, 'quarterly')).toEqual(['e1']);
  });

  it('deleting an email removes exactly its own index row', () => {
    // A delete that missed would leave a ghost: search keeps returning a message
    // that no longer exists, and opening the hit shows nothing.
    addEmail(db, 'e1', 'Quarterly plan');
    addEmail(db, 'e2', 'Quarterly budget');
    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');
    expect(hits(db, 'quarterly')).toEqual(['e2']);
    expect(indexSize(db)).toBe(1);
  });

  it('re-keys the index row when a subject is edited', () => {
    // The update trigger deletes then re-inserts. A delete keyed on the wrong row
    // would drop an unrelated message from search on every subject change.
    addEmail(db, 'e1', 'Quarterly plan');
    addEmail(db, 'e2', 'Lunch');
    db.prepare('UPDATE emails SET subject = ? WHERE id = ?').run('Annual plan', 'e1');
    expect(hits(db, 'quarterly')).toEqual([]);
    expect(hits(db, 'annual')).toEqual(['e1']);
    expect(hits(db, 'lunch')).toEqual(['e2']);
    expect(indexSize(db)).toBe(2);
  });

  it('indexes a body that arrives after its header row', () => {
    // The normal sync order: header first, body later. If the body trigger failed
    // to replace the header-only entry, bodies would never become searchable.
    addEmail(db, 'e1', 'Quarterly plan');
    expect(hits(db, 'kangaroo')).toEqual([]);
    db.prepare('INSERT INTO email_bodies (email_id, clean_body) VALUES (?, ?)').run('e1', 'a kangaroo appeared');
    expect(hits(db, 'kangaroo')).toEqual(['e1']);
    expect(indexSize(db)).toBe(1); // replaced, not duplicated
    expect(ftsRowid(db, 'e1')).toBe((db.prepare('SELECT rowid FROM emails WHERE id = ?').get('e1') as { rowid: number }).rowid);
  });

  it('re-indexes on a body update and falls back to the inline body on a body delete', () => {
    addEmail(db, 'e1', 'Quarterly plan', 'inline original');
    db.prepare('INSERT INTO email_bodies (email_id, clean_body) VALUES (?, ?)').run('e1', 'side kangaroo');
    expect(hits(db, 'kangaroo')).toEqual(['e1']);

    db.prepare('UPDATE email_bodies SET clean_body = ? WHERE email_id = ?').run('side wombat', 'e1');
    expect(hits(db, 'kangaroo')).toEqual([]);
    expect(hits(db, 'wombat')).toEqual(['e1']);

    // Body row gone, email survives: the entry falls back to the inline column and
    // keeps its header terms. Losing the entry entirely would make the message
    // unfindable even by subject.
    db.prepare('DELETE FROM email_bodies WHERE email_id = ?').run('e1');
    expect(hits(db, 'wombat')).toEqual([]);
    expect(hits(db, 'original')).toEqual(['e1']);
    expect(hits(db, 'quarterly')).toEqual(['e1']);
    expect(indexSize(db)).toBe(1);
  });

  it('cascade delete of a body whose email is already gone is a clean no-op', () => {
    // Deleting an email fires BOTH triggers: the email delete removes the index
    // row and then deletes the body row, whose own trigger tries to re-index an
    // email that no longer exists. The rowid subquery yields NULL there, which
    // matches nothing — a resurrected half-row would be a search hit pointing at
    // a deleted message.
    addEmail(db, 'e1', 'Quarterly plan');
    addEmail(db, 'e2', 'Lunch');
    db.prepare('INSERT INTO email_bodies (email_id, clean_body) VALUES (?, ?)').run('e1', 'side kangaroo');
    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');

    expect(indexSize(db)).toBe(1);
    expect(hits(db, 'quarterly')).toEqual([]);
    expect(hits(db, 'kangaroo')).toEqual([]);
    expect(hits(db, 'lunch')).toEqual(['e2']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM email_bodies').get() as { n: number }).n).toBe(0);
  });

  it('a bulk delete leaves exactly the surviving messages indexed', () => {
    // The shape of the incident: many rows deleted in one transaction. Correctness
    // of the batch, not just of one row.
    for (let i = 1; i <= 50; i++) addEmail(db, `e${i}`, i % 2 === 0 ? 'Quarterly plan' : 'Lunch');
    db.prepare("DELETE FROM emails WHERE subject = 'Lunch'").run();
    expect(indexSize(db)).toBe(25);
    expect(hits(db, 'lunch')).toEqual([]);
    expect(hits(db, 'quarterly')).toHaveLength(25);
  });

  it('rebuild and backfill write rowid-aligned rows', () => {
    // A rebuild that let fts5 assign its own rowids would produce an index that
    // looks right and silently breaks every subsequent delete — which is exactly
    // what migration v84 exists to repair.
    addEmail(db, 'e1', 'Quarterly plan');
    addEmail(db, 'e2', 'Lunch');
    db.prepare('INSERT INTO email_bodies (email_id, clean_body) VALUES (?, ?)').run('e2', 'side kangaroo');

    db.exec('DELETE FROM emails_fts;');
    db.exec(FTS_REBUILD_SQL);
    expect(indexSize(db)).toBe(2);
    expect(hits(db, 'kangaroo')).toEqual(['e2']); // rebuild reads the side body, not the inline column
    for (const id of ['e1', 'e2']) {
      expect(ftsRowid(db, id)).toBe((db.prepare('SELECT rowid FROM emails WHERE id = ?').get(id) as { rowid: number }).rowid);
    }

    // Backfill is the idempotent form: it must add nothing when every row is
    // already indexed, or search returns every hit twice.
    db.exec(FTS_BACKFILL_MISSING_SQL);
    expect(indexSize(db)).toBe(2);

    // ...and fill in only what is missing.
    db.prepare('DELETE FROM emails_fts WHERE rowid = (SELECT rowid FROM emails WHERE id = ?)').run('e1');
    expect(indexSize(db)).toBe(1);
    db.exec(FTS_BACKFILL_MISSING_SQL);
    expect(indexSize(db)).toBe(2);
    expect(hits(db, 'quarterly')).toEqual(['e1']);
  });
});

describe('migration v84 — fts_rowid_alignment', () => {
  // An index built by an older build is keyed by fts5's own auto-assigned rowids,
  // which do NOT match emails.rowid. The new triggers delete by rowid, so on such
  // a database every delete would remove some OTHER message's entry and the one
  // actually deleted would linger as a phantom hit. The migration re-keys it.

  /** A DB whose index was written the old way: fts5 assigns the rowids. */
  function legacyDb(): Database.Database {
    const db = openTestDb();
    db.exec(`
      CREATE TABLE emails (
        id TEXT PRIMARY KEY, subject TEXT, from_address TEXT, from_name TEXT,
        to_address TEXT, cc_address TEXT, attachment_names TEXT, clean_body TEXT
      );
      CREATE TABLE email_bodies (email_id TEXT PRIMARY KEY, clean_body TEXT);
    `);
    db.exec(FTS_TABLE_DDL);
    for (let i = 1; i <= 6; i++) addEmail(db, `e${i}`, i % 2 === 0 ? 'Quarterly plan' : 'Lunch');
    db.prepare('INSERT INTO email_bodies (email_id, clean_body) VALUES (?, ?)').run('e2', 'side kangaroo');
    // Delete a couple of emails so emails.rowid has gaps — without them the two
    // numbering schemes could coincide and the test would prove nothing.
    db.prepare("DELETE FROM emails WHERE id IN ('e1','e3')").run();
    db.exec(`INSERT INTO emails_fts(${FTS_COLUMNS})
             SELECT id, subject, from_address, from_name, to_address, cc_address, attachment_names,
                    COALESCE((SELECT b.clean_body FROM email_bodies b WHERE b.email_id = emails.id), clean_body)
             FROM emails;`);
    return db;
  }

  it('re-keys an index that was built by email_id', () => {
    const db = legacyDb();
    try {
      // Precondition: the old index really is mis-keyed, so the fix has work to do.
      const before = ftsRowid(db, 'e6');
      const emailRowid = (db.prepare('SELECT rowid FROM emails WHERE id = ?').get('e6') as { rowid: number }).rowid;
      expect(before).not.toBe(emailRowid);

      ftsRowidAlignment.up(db);

      expect(indexSize(db)).toBe(4);
      for (const row of db.prepare('SELECT id FROM emails').all() as { id: string }[]) {
        const wanted = (db.prepare('SELECT rowid FROM emails WHERE id = ?').get(row.id) as { rowid: number }).rowid;
        expect(ftsRowid(db, row.id)).toBe(wanted);
      }
      // Content survives the re-key, side bodies included.
      expect(hits(db, 'kangaroo')).toEqual(['e2']);
      expect(hits(db, 'quarterly')).toEqual(['e2', 'e4', 'e6']);

      // And the whole point: a delete now hits the right row.
      db.prepare('DELETE FROM emails WHERE id = ?').run('e4');
      expect(hits(db, 'quarterly')).toEqual(['e2', 'e6']);
      expect(indexSize(db)).toBe(3);
    } finally { db.close(); }
  });

  it('is a no-op on a database that has no FTS table', () => {
    // Search is optional — a DB built without FTS5 has no emails_fts at all, and a
    // migration that assumed otherwise would throw and block the whole upgrade
    // chain, leaving the user on an older schema with no way forward.
    const db = openTestDb();
    try {
      db.exec('CREATE TABLE emails (id TEXT PRIMARY KEY, subject TEXT);');
      expect(() => ftsRowidAlignment.up(db)).not.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='emails_fts'").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('is idempotent — a second run leaves the same index', () => {
    // Migrations get re-run in tests, on repaired databases, and after a partial
    // upgrade. Running twice must not double every message in search.
    const db = legacyDb();
    try {
      ftsRowidAlignment.up(db);
      const first = (db.prepare('SELECT rowid, email_id FROM emails_fts ORDER BY rowid').all() as unknown[]);
      ftsRowidAlignment.up(db);
      expect(db.prepare('SELECT rowid, email_id FROM emails_fts ORDER BY rowid').all()).toEqual(first);
      expect(indexSize(db)).toBe(4);
    } finally { db.close(); }
  });
});
