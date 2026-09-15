// The move of `contacts` out of every mailbox and into ONE shared directory
// (migration 77, `src/shared-contacts.ts`).
//
// This is the highest-risk change in the storage layer: it reads the user's
// existing address book out of one database and writes it into another, and
// SQLite gives no atomicity across two files under WAL. Every test here exists
// because a specific way of getting that wrong is silent — a merge that
// duplicates a person, a re-run that doubles their email counts, an adoption
// that drops the source before the destination committed, or a mailbox that
// quietly reads an empty directory because its own table shadowed it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MigrationManager,
  createMigrationManager,
  restoreLostContactDirectory,
  unifiedContactDirectory,
  type Migration,
} from '../../src/migrations';
import { ContactRepository } from '../../src/repositories/contact-repository';
import { SHARED_SCHEMA , attachSharedContacts } from '../../src/shared-contacts';
import { createLegacyContactsTable } from '../../src/test-support/legacy-contacts';
import { newMigratedDb, openTestDb } from '../../src/test-support/test-db';

type ManagerInternals = { migrations: Migration[] };

/** The registered chain, read once so a test can run a PREFIX of it. */
const CHAIN: Migration[] = (() => {
  const probe = openTestDb();
  try {
    return [...(createMigrationManager(probe) as unknown as ManagerInternals).migrations];
  } finally {
    probe.close();
  }
})();

const BEFORE_ADOPTION = unifiedContactDirectory.version - 1;

const NOW = 1_770_000_000;
const DAY = 86_400;

let tempDir: string;
const open: Database.Database[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'contact-directory-'));
});

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed by the test */
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** A directory file two mailboxes can share, as the app's userData dir does. */
const directoryFile = (name = 'sarvinbox-contacts.db'): string => join(tempDir, name);

/**
 * A mailbox as it stands the instant BEFORE the adoption runs: the full
 * production schema, plus the per-account `contacts` table a real upgrader
 * still has, widened by the chain exactly as their app widened it.
 */
function mailboxBeforeAdoption(sharedPath: string): Database.Database {
  const db = openTestDb();
  open.push(db);
  attachSharedContacts(db, sharedPath);
  createLegacyContactsTable(db);
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version <= BEFORE_ADOPTION).forEach((m) => manager.register(m));
  manager.migrate();
  return db;
}

/** Run the adoption (and nothing else) as `accountId`. */
function adopt(db: Database.Database, accountId: string): void {
  createMigrationManager(db, { accountId }).migrate();
}

interface SeedContact {
  email: string;
  name?: string | null;
  organization?: string | null;
  isFavorite?: number;
  emailCount?: number;
  sentCount?: number;
  receivedCount?: number;
  firstSeen?: number;
  lastSeen?: number;
  contactType?: string;
  mobile?: string | null;
}

/** Put a row in the mailbox's OWN (pre-move) contacts table. */
function seedLocalContact(db: Database.Database, contact: SeedContact): string {
  const id = `c-${contact.email.replace(/[^a-z0-9]/gi, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO main.contacts (
       id, email, name, organization, first_seen, last_seen,
       email_count, sent_count, received_count, is_favorite, contact_type, mobile_e164
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    contact.email,
    contact.name ?? null,
    contact.organization ?? null,
    contact.firstSeen ?? NOW,
    contact.lastSeen ?? NOW,
    contact.emailCount ?? 1,
    contact.sentCount ?? 0,
    contact.receivedCount ?? 1,
    contact.isFavorite ?? 0,
    contact.contactType ?? 'unknown',
    contact.mobile ?? null,
  );
  return id;
}

const directoryRow = (db: Database.Database, email: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM ${SHARED_SCHEMA}.contacts WHERE email = ?`).get(email) as
    | Record<string, unknown>
    | undefined;

const directoryCount = (db: Database.Database): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${SHARED_SCHEMA}.contacts`).get() as { n: number }).n;

const provenance = (
  db: Database.Database,
  email: string,
): Array<Record<string, unknown>> =>
  db
    .prepare(
      `SELECT * FROM ${SHARED_SCHEMA}.contact_accounts WHERE email = ? ORDER BY account_id`,
    )
    .all(email) as Array<Record<string, unknown>>;

const localTables = (db: Database.Database): Set<string> =>
  new Set(
    (
      db
        .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

// ---------------------------------------------------------------------------

describe('migration 77 — adopting a mailbox into the shared directory', () => {
  // A brand-new install has no per-account table to move. If the migration did
  // anything at all here it would be writing to the directory on every launch
  // of every account, for nothing.
  it('is a no-op on a mailbox that never had a local contacts table', () => {
    const shared = directoryFile();
    const db = newMigratedDb(':memory:', shared);
    open.push(db);

    expect(localTables(db).has('contacts')).toBe(false);
    expect(localTables(db).has('pre_directory_contacts')).toBe(false);
    expect(directoryCount(db)).toBe(0);
    // Still stamped (the chain has moved past it), so it never runs again.
    expect(createMigrationManager(db).getCurrentVersion())
      .toBeGreaterThanOrEqual(unifiedContactDirectory.version);
  });

  // The upgrade every existing user takes. Losing a row here loses an address
  // book that was never synced from anywhere and cannot be rebuilt.
  it('moves every local contact into the directory and parks the source table', () => {
    const db = mailboxBeforeAdoption(directoryFile());
    seedLocalContact(db, { email: 'Ada@Example.com', name: 'Ada', emailCount: 7, receivedCount: 5 });
    seedLocalContact(db, { email: 'bob@example.com', name: 'Bob' });

    adopt(db, 'acct-work');

    expect(directoryCount(db)).toBe(2);
    // Addresses are FOLDED to lower case on the way in: two accounts that saw
    // the same person with different casing must land on one row, and the
    // directory's UNIQUE(email) is the only thing that can enforce it.
    const ada = directoryRow(db, 'ada@example.com');
    expect(ada?.name).toBe('Ada');
    expect(ada?.email_count).toBe(7);

    // Renamed, never dropped: the commit that wrote the directory spans two
    // files and WAL does not make that atomic, so the source has to survive a
    // crash in between.
    const tables = localTables(db);
    expect(tables.has('contacts')).toBe(false);
    expect(tables.has('pre_directory_contacts')).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM main.pre_directory_contacts').get() as { n: number }).n,
    ).toBe(2);
  });

  // Provenance is what makes removing an account able to subtract exactly what
  // that account contributed, instead of leaving its counts fused into a total.
  it('records which account each address came from', () => {
    const db = mailboxBeforeAdoption(directoryFile());
    seedLocalContact(db, { email: 'ada@example.com', emailCount: 4, sentCount: 1, receivedCount: 3 });

    adopt(db, 'acct-work');

    const rows = provenance(db, 'ada@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe('acct-work');
    expect(rows[0].email_count).toBe(4);
    expect(rows[0].sent_count).toBe(1);
    expect(rows[0].received_count).toBe(3);
  });

  // Falling back to the database file name keeps the adoption runnable for a
  // storage opened with no account behind it (fixtures, the seed script) —
  // it just cannot say whose contacts these are.
  it('falls back to the database file name when no account id is supplied', () => {
    const db = mailboxBeforeAdoption(directoryFile());
    seedLocalContact(db, { email: 'ada@example.com' });

    createMigrationManager(db).migrate();

    expect(provenance(db, 'ada@example.com')[0].account_id).toBe('unknown-account');
  });

  // THE point of the whole change. Two accounts, one person, one row.
  it('merges a second account into the SAME row rather than duplicating the person', () => {
    const shared = directoryFile();

    const work = mailboxBeforeAdoption(shared);
    seedLocalContact(work, {
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      isFavorite: 1,
      emailCount: 10,
      receivedCount: 8,
      firstSeen: NOW - 30 * DAY,
      lastSeen: NOW - 10 * DAY,
    });
    adopt(work, 'acct-work');

    const personal = mailboxBeforeAdoption(shared);
    seedLocalContact(personal, {
      email: 'ADA@example.com',
      name: null,
      organization: 'Analytical Engines Ltd',
      emailCount: 4,
      receivedCount: 4,
      firstSeen: NOW - 5 * DAY,
      lastSeen: NOW,
    });
    seedLocalContact(personal, { email: 'charles@example.com' });
    adopt(personal, 'acct-personal');

    expect(directoryCount(personal)).toBe(2);

    const ada = directoryRow(personal, 'ada@example.com');
    // A name paid for once is not thrown away by an account that lacks it...
    expect(ada?.name).toBe('Ada Lovelace');
    // ...and a field only the second account knew is filled in.
    expect(ada?.organization).toBe('Analytical Engines Ltd');
    // Flags are a union: favourited on one account means favourited everywhere.
    expect(ada?.is_favorite).toBe(1);
    // The activity window widens to cover both mailboxes.
    expect(ada?.first_seen).toBe(NOW - 30 * DAY);
    expect(ada?.last_seen).toBe(NOW);
    // Counts are the SUM of the parts.
    expect(ada?.email_count).toBe(14);
    expect(ada?.received_count).toBe(12);

    expect(provenance(personal, 'ada@example.com').map((r) => r.account_id)).toEqual([
      'acct-personal',
      'acct-work',
    ]);

    // And the FIRST account still sees the merged row through its own
    // connection — the directory is one file, not a copy per mailbox.
    expect(directoryRow(work, 'ada@example.com')?.email_count).toBe(14);
  });

  // A cross-database commit is not atomic under WAL, so the adoption can be
  // interrupted after the directory write and before the rename — and will then
  // run again on the next launch. Counts are RECOMPUTED from provenance rather
  // than accumulated precisely so that second run changes nothing.
  it('re-running the adoption neither duplicates rows nor doubles the counts', () => {
    const db = mailboxBeforeAdoption(directoryFile());
    seedLocalContact(db, { email: 'ada@example.com', emailCount: 6, receivedCount: 6 });
    adopt(db, 'acct-work');

    const before = directoryRow(db, 'ada@example.com');

    // Put the source table back (what an interrupted run leaves behind) and let
    // the adoption run over it a second time.
    unifiedContactDirectory.down!(db, {});
    unifiedContactDirectory.up(db, { accountId: 'acct-work' });

    expect(directoryCount(db)).toBe(1);
    const after = directoryRow(db, 'ada@example.com');
    expect(after?.email_count).toBe(6);
    expect(after?.received_count).toBe(6);
    expect(after?.id).toBe(before?.id);
    expect(provenance(db, 'ada@example.com')).toHaveLength(1);
  });

  // An unreadable store and an empty store are the same value and opposite
  // facts. If the directory were missing, adopting would mean writing the
  // user's address book into a schema that does not exist — and the rename
  // would then destroy the only copy.
  it('refuses to adopt when the directory is not attached, leaving the source intact', () => {
    const db = openTestDb();
    open.push(db);
    createLegacyContactsTable(db);
    const manager = new MigrationManager(db);
    CHAIN.filter((m) => m.version <= BEFORE_ADOPTION).forEach((m) => manager.register(m));
    manager.migrate();
    seedLocalContact(db, { email: 'ada@example.com' });

    expect(() => createMigrationManager(db).migrate()).toThrow(/not attached/);
    expect(localTables(db).has('contacts')).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM main.contacts').get() as { n: number }).n,
    ).toBe(1);
  });

  // Notes are user-authored and the enrichment history is LLM output that cost
  // money. Both are keyed to the contact and would be orphaned by a move that
  // only took the contacts table.
  it('carries notes across and remaps enrichment history onto the directory row id', () => {
    const shared = directoryFile();

    const work = mailboxBeforeAdoption(shared);
    seedLocalContact(work, { email: 'ada@example.com', name: 'Ada' });
    adopt(work, 'acct-work');
    const directoryId = directoryRow(work, 'ada@example.com')?.id as string;

    const personal = mailboxBeforeAdoption(shared);
    const localId = seedLocalContact(personal, { email: 'ada@example.com' });
    personal
      .prepare('INSERT INTO main.contact_notes (email, note, category) VALUES (?, ?, ?)')
      .run('Ada@example.com', 'prefers morning calls', 'general');
    personal
      .prepare(
        `INSERT INTO main.contact_enrichment_history
           (id, contact_id, enrichment, effective_from, source)
         VALUES (?, ?, ?, ?, 'llm')`,
      )
      .run('h-1', localId, '{"title":"Engineer"}', NOW);

    adopt(personal, 'acct-personal');

    const notes = personal
      .prepare(`SELECT email, note FROM ${SHARED_SCHEMA}.contact_notes`)
      .all() as Array<{ email: string; note: string }>;
    expect(notes).toEqual([{ email: 'ada@example.com', note: 'prefers morning calls' }]);

    // The history must point at the row the directory actually holds — which is
    // the id the FIRST account generated, not this mailbox's local id.
    const history = personal
      .prepare(`SELECT id, contact_id FROM ${SHARED_SCHEMA}.contact_enrichment_history`)
      .all() as Array<{ id: string; contact_id: string }>;
    expect(history).toEqual([{ id: 'h-1', contact_id: directoryId }]);
    expect(directoryId).not.toBe(localId);
  });

  // Rolling back to an older app build is an undo of the MOVE, not of the
  // merge: the old build reads a local `contacts` table, and the parked copy is
  // the only thing that can give it one back.
  it('down() restores the mailbox table and leaves the directory populated', () => {
    const db = mailboxBeforeAdoption(directoryFile());
    seedLocalContact(db, { email: 'ada@example.com' });
    adopt(db, 'acct-work');

    unifiedContactDirectory.down!(db, {});

    const tables = localTables(db);
    expect(tables.has('contacts')).toBe(true);
    expect(tables.has('pre_directory_contacts')).toBe(false);
    expect(directoryCount(db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the directory is genuinely shared between connections', () => {
  // The unification has to hold at RUNTIME, not just at migration time: a
  // contact written through one account's repository is the same row the other
  // account reads. If each mailbox kept its own copy, enrichment would be paid
  // for once per account and a favourite would be invisible next door.
  it('a contact written by one account is read by the other', async () => {
    const shared = directoryFile();
    const work = newMigratedDb(':memory:', shared);
    const personal = newMigratedDb(':memory:', shared);
    open.push(work, personal);

    const workRepo = new ContactRepository(() => work, () => 'acct-work');
    const personalRepo = new ContactRepository(() => personal, () => 'acct-personal');

    await workRepo.upsert({ email: 'Ada@example.com', name: 'Ada Lovelace' });

    const seenByPersonal = await personalRepo.getByEmail('ada@example.com');
    expect(seenByPersonal?.name).toBe('Ada Lovelace');
  });

  // Provenance must be written by the RUNTIME too, not only by the one-time
  // adoption — otherwise every contact discovered after the upgrade has no
  // record of which mailbox it came from.
  it('records provenance for each account that upserts the same address', async () => {
    const shared = directoryFile();
    const work = newMigratedDb(':memory:', shared);
    const personal = newMigratedDb(':memory:', shared);
    open.push(work, personal);

    await new ContactRepository(() => work, () => 'acct-work').upsert({
      email: 'ada@example.com',
      name: 'Ada',
    });
    await new ContactRepository(() => personal, () => 'acct-personal').upsert({
      email: 'ada@example.com',
    });

    const rows = personal
      .prepare(
        `SELECT account_id FROM ${SHARED_SCHEMA}.contact_accounts WHERE email = ? ORDER BY account_id`,
      )
      .all('ada@example.com') as Array<{ account_id: string }>;
    expect(rows.map((r) => r.account_id)).toEqual(['acct-personal', 'acct-work']);
    // Still ONE person.
    expect(directoryCount(personal)).toBe(1);
  });

  // Deleting a contact has to take its provenance with it. A leftover
  // provenance row would resurrect the contact's counts the next time they are
  // recomputed from the parts.
  it('deleting a contact removes its provenance rows too', async () => {
    const shared = directoryFile();
    const db = newMigratedDb(':memory:', shared);
    open.push(db);
    const repo = new ContactRepository(() => db, () => 'acct-work');

    const created = await repo.upsert({ email: 'ada@example.com', name: 'Ada' });
    await repo.delete(created.id);

    expect(directoryCount(db)).toBe(0);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${SHARED_SCHEMA}.contact_accounts WHERE email = ?`)
        .get('ada@example.com') as { n: number },
    ).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------

// Migration 81 repairs a REAL data loss, so it shares this file's harness: the
// thing it restores is exactly what migration 77 parked.
//
// `sarvinbox-contacts.db` is the shared directory, not an account database, but
// the desktop app's orphan-DB sweep read its name as a raw legacy per-account
// file and deleted it on the first boot after the directory shipped. The next
// boot recreated it empty and the user's whole address book was gone from the
// UI. The sweep no longer touches it; this migration gives back what the one
// that already happened took.
describe('migration 81 — restoring a directory the sweep deleted', () => {
  const CHAIN_TOP = CHAIN[CHAIN.length - 1].version;

  /** Run the chain as far as v80 — adoption done, the repair not yet written. */
  function adoptBefore81(db: Database.Database): void {
    const manager = new MigrationManager(db, { accountId: 'acct-work' });
    CHAIN.filter((m) => m.version < restoreLostContactDirectory.version)
      .forEach((m) => manager.register(m));
    manager.migrate();
  }

  /** The sweep's effect as the next boot sees it: the file is back, and empty. */
  function emptyTheDirectory(db: Database.Database): void {
    for (const table of ['contact_enrichment_history', 'contact_notes', 'contact_accounts', 'contacts']) {
      db.exec(`DELETE FROM ${SHARED_SCHEMA}.${table}`);
    }
  }

  // Regression: the loss itself. A user whose directory file was deleted must
  // get their address book back on the next launch, not a permanently empty
  // Contacts screen — the rows are still on disk, parked by v77.
  it('re-adopts the parked contacts when the directory is empty', () => {
    const shared = directoryFile();
    const db = mailboxBeforeAdoption(shared);
    seedLocalContact(db, { email: 'ada@example.com', name: 'Ada', isFavorite: 1 });
    seedLocalContact(db, { email: 'grace@example.com', name: 'Grace' });
    adoptBefore81(db);
    expect(directoryCount(db)).toBe(2);

    emptyTheDirectory(db);
    createMigrationManager(db, { accountId: 'acct-work' }).migrate();

    expect(directoryCount(db)).toBe(2);
    expect(directoryRow(db, 'ada@example.com')).toMatchObject({ name: 'Ada', is_favorite: 1 });
    // And parked again, so the mailbox is in the same shape as one that never
    // lost anything — v77's rollback depends on finding them there.
    expect(localTables(db).has('pre_directory_contacts')).toBe(true);
    expect(localTables(db).has('contacts')).toBe(false);
    expect(createMigrationManager(db).getCurrentVersion()).toBe(CHAIN_TOP);
  });

  // Regression: the guard that makes this safe. A directory with rows in it is
  // WORKING — re-adopting into one would resurrect every contact the user has
  // deleted since, on every upgrade.
  it('leaves a directory that still has contacts alone', () => {
    const shared = directoryFile();
    const db = mailboxBeforeAdoption(shared);
    seedLocalContact(db, { email: 'ada@example.com', name: 'Ada' });
    seedLocalContact(db, { email: 'grace@example.com', name: 'Grace' });
    adoptBefore81(db);
    // A deletion through the app takes the provenance row with it, which is
    // exactly what a lost contribution looks like — in miniature.
    db.exec(`DELETE FROM ${SHARED_SCHEMA}.contacts WHERE email = 'grace@example.com'`);
    db.exec(`DELETE FROM ${SHARED_SCHEMA}.contact_accounts WHERE email = 'grace@example.com'`);

    createMigrationManager(db, { accountId: 'acct-work' }).migrate();

    expect(directoryCount(db)).toBe(1);
    expect(directoryRow(db, 'grace@example.com')).toBeUndefined();
  });


  // Regression, and the reason the test is per-MAILBOX rather than "is the
  // directory empty": with two accounts connected, the first to run refills the
  // directory. The second then finds 954 rows that are not its own, and without
  // a per-account test would call the directory healthy and leave its whole
  // address book parked forever.
  it('restores the second mailbox too, after the first has refilled the directory', () => {
    const shared = directoryFile();

    const work = mailboxBeforeAdoption(shared);
    seedLocalContact(work, { email: 'ada@example.com', name: 'Ada' });
    seedLocalContact(work, { email: 'grace@example.com', name: 'Grace' });
    adoptBefore81(work);

    const personal = mailboxBeforeAdoption(shared);
    seedLocalContact(personal, { email: 'kay@example.com', name: 'Kay' });
    seedLocalContact(personal, { email: 'lin@example.com', name: 'Lin' });
    const personalBefore81 = new MigrationManager(personal, { accountId: 'acct-personal' });
    CHAIN.filter((m) => m.version < restoreLostContactDirectory.version)
      .forEach((m) => personalBefore81.register(m));
    personalBefore81.migrate();
    expect(directoryCount(work)).toBe(4);

    emptyTheDirectory(work);
    // The sweep took the file; both mailboxes now run the repaired chain.
    createMigrationManager(work, { accountId: 'acct-work' }).migrate();
    expect(directoryCount(work)).toBe(2);

    createMigrationManager(personal, { accountId: 'acct-personal' }).migrate();

    expect(directoryCount(work)).toBe(4);
    expect(directoryRow(work, 'kay@example.com')).toMatchObject({ name: 'Kay' });
    expect(provenance(work, 'kay@example.com').map((r) => r.account_id)).toEqual(['acct-personal']);
    expect(localTables(personal).has('pre_directory_contacts')).toBe(true);
  });

  // Regression: an install created after the unification has nothing parked and
  // an empty directory is simply an empty address book. Touching anything here
  // would be inventing contacts.
  it('does nothing on a mailbox that never had a local table', () => {
    const shared = directoryFile();
    const db = newMigratedDb(':memory:', shared);
    open.push(db);

    expect(directoryCount(db)).toBe(0);
    expect(localTables(db).has('contacts')).toBe(false);
    expect(() => createMigrationManager(db).migrate()).not.toThrow();
  });

  // Idempotent re-run: the second account opening the same shared directory
  // runs the chain again on its own mailbox. The first one has already refilled
  // the directory, so the second must recognise that and keep its rows parked.
  it('is a no-op once the directory has been restored', () => {
    const shared = directoryFile();
    const db = mailboxBeforeAdoption(shared);
    seedLocalContact(db, { email: 'ada@example.com', name: 'Ada' });
    adoptBefore81(db);
    emptyTheDirectory(db);
    createMigrationManager(db, { accountId: 'acct-work' }).migrate();

    restoreLostContactDirectory.up(db, { accountId: 'acct-work' });

    expect(directoryCount(db)).toBe(1);
    expect(localTables(db).has('contacts')).toBe(false);
  });

  // Regression: the restored rows predate v79/v80, which are already stamped as
  // applied and will never run again on their own. Handing the user back an
  // address book still carrying a colleague's name on a robot address — or a
  // mining watermark that stops their numbers being re-read — would be a
  // half-restore that looks complete.
  it('re-applies the robot-name and re-mine repairs to the restored rows', () => {
    const shared = directoryFile();
    const db = mailboxBeforeAdoption(shared);
    seedLocalContact(db, { email: 'notifications@atlassian.net', name: 'Bhupesh Chugh' });
    seedLocalContact(db, { email: 'ada@example.com', name: 'Ada' });
    adoptBefore81(db);
    db.exec(`UPDATE ${SHARED_SCHEMA}.contacts SET phones_mined_through = ${NOW}`);
    // The parked copy is what comes back, so the marks have to be on it too.
    db.exec(`UPDATE main.pre_directory_contacts SET phones_mined_through = ${NOW}`);
    emptyTheDirectory(db);

    createMigrationManager(db, { accountId: 'acct-work' }).migrate();

    expect(directoryRow(db, 'notifications@atlassian.net')).toMatchObject({
      name: 'atlassian.net',
      contact_type: 'automated',
    });
    expect(directoryRow(db, 'ada@example.com')).toMatchObject({ name: 'Ada' });
    const marks = db
      .prepare(`SELECT COUNT(*) AS n FROM ${SHARED_SCHEMA}.contacts WHERE phones_mined_through IS NOT NULL`)
      .get() as { n: number };
    expect(marks.n).toBe(0);
  });
});
