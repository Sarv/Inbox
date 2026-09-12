// Migration 79: taking colleagues' names off the robot mailboxes wearing them.
//
// Notification services send from a machine address but put the HUMAN who
// triggered the event in the From display name, so the directory filled with
// "Devendra Rathore <pullrequests-reply@bitbucket.org>" and "Bhupesh Chugh
// <notifications@atlassian.net>" — a real person's name on an address that is
// not theirs. Searching for that colleague returned mostly robots.
//
// It needs a migration rather than just a fix at the edge because the contact
// upsert only fills a name when the row has none: a wrong name written once is
// never corrected by a later scan, however many times the user rescans.

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationManager,
  createMigrationManager,
  machineMailboxNames,
  type Migration,
} from '../../src/migrations';
import { SHARED_SCHEMA, attachSharedContacts } from '../../src/shared-contacts';
import { openTestDb } from '../../src/test-support/test-db';

type ManagerInternals = { migrations: Migration[] };

const CHAIN: Migration[] = (() => {
  const probe = openTestDb();
  try {
    return [...(createMigrationManager(probe) as unknown as ManagerInternals).migrations];
  } finally {
    probe.close();
  }
})();

const BEFORE = machineMailboxNames.version - 1;
const NOW = 1_770_000_000;

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
});

/** A mailbox migrated up to the version just before the rename. */
function mailboxBefore(): Database.Database {
  const db = openTestDb();
  open.push(db);
  attachSharedContacts(db, '');
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version <= BEFORE).forEach((m) => manager.register(m));
  manager.migrate();
  return db;
}

function seedContact(
  db: Database.Database,
  email: string,
  name: string | null,
  contactType: string | null = null,
  contactTypeSource: string | null = null,
): void {
  db.prepare(
    `INSERT INTO ${SHARED_SCHEMA}.contacts
       (id, email, name, first_seen, last_seen, contact_type, contact_type_source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`c-${email}`, email, name, NOW, NOW, contactType, contactTypeSource);
}

const read = (db: Database.Database, email: string) =>
  db.prepare(
    `SELECT name, contact_type AS type, contact_type_source AS source
       FROM ${SHARED_SCHEMA}.contacts WHERE email = ?`,
  ).get(email) as { name: string | null; type: string | null; source: string | null };

describe('migration 79 — machine mailbox names', () => {
  // Regression: the whole point. These three are the exact rows the user
  // reported, one per provider shape (bare prefix, `-reply` suffix, `-noreply`
  // suffix inside a longer generated local-part).
  it('renames the robot rows wearing a colleague’s name', () => {
    const db = mailboxBefore();
    seedContact(db, 'notifications@atlassian.net', 'Bhupesh Chugh');
    seedContact(db, 'pullrequests-reply@bitbucket.org', 'Devendra Rathore');
    seedContact(db, 'drive-shares-dm-noreply@google.com', 'Bhupesh Chugh (via Google Docs)');

    createMigrationManager(db).migrate();

    expect(read(db, 'notifications@atlassian.net').name).toBe('atlassian.net');
    expect(read(db, 'pullrequests-reply@bitbucket.org').name).toBe('bitbucket.org');
    expect(read(db, 'drive-shares-dm-noreply@google.com').name).toBe('google.com');
  });

  // Regression: this migration rewrites NAMES in the user's address book. If it
  // ever reached a real person the damage would be silent and unrecoverable —
  // the original name is not stored anywhere else.
  it('never touches a real person', () => {
    const db = mailboxBefore();
    seedContact(db, 'bhupesh@sarv.com', 'Bhupesh Chugh');
    seedContact(db, 'mahima.k@sarv.com', 'Mahima Kumawat');
    // A human-staffed role mailbox is a shared mailbox, not a robot: a person
    // mans it and signs off, so the signer's name stays.
    seedContact(db, 'hr@sarv.com', 'Priya Nair');

    createMigrationManager(db).migrate();

    expect(read(db, 'bhupesh@sarv.com').name).toBe('Bhupesh Chugh');
    expect(read(db, 'mahima.k@sarv.com').name).toBe('Mahima Kumawat');
    expect(read(db, 'hr@sarv.com').name).toBe('Priya Nair');
  });

  // A type a user or the agent chose is a decision, not a guess — overwriting
  // it would undo their correction every time the chain runs.
  it('fills in an unclassified type but never overrides a chosen one', () => {
    const db = mailboxBefore();
    seedContact(db, 'noreply@example.com', 'Someone', null, null);
    seedContact(db, 'alerts@example.com', 'Someone', 'unknown', 'heuristic');
    seedContact(db, 'notify@example.com', 'Someone', 'person', 'user');

    createMigrationManager(db).migrate();

    expect(read(db, 'noreply@example.com').type).toBe('automated');
    expect(read(db, 'alerts@example.com').type).toBe('automated');
    expect(read(db, 'notify@example.com').type).toBe('person');
    expect(read(db, 'notify@example.com').source).toBe('user');
  });

  // Idempotent re-run: the shared directory is opened by EVERY account, so this
  // runs once per mailbox against the same rows. It must compute the same
  // answer the second time rather than compounding.
  it('is a no-op on a second run', () => {
    const db = mailboxBefore();
    seedContact(db, 'notifications@atlassian.net', 'Bhupesh Chugh');

    createMigrationManager(db).migrate();
    const after = read(db, 'notifications@atlassian.net');
    machineMailboxNames.up(db, {});

    expect(read(db, 'notifications@atlassian.net')).toEqual(after);
  });

  // Regression: a migration can find the shared directory unattached (a repair
  // path, a half-initialised boot, a test harness). Throwing there would fail
  // the whole chain over a cosmetic rename.
  it('does nothing, and does not throw, with no directory attached', () => {
    const db = openTestDb();
    open.push(db);
    expect(() => machineMailboxNames.up(db, {})).not.toThrow();
  });

  // A row with no name at all must still get one — otherwise the next
  // notification from that robot writes the acting human's name into the gap,
  // which is the bug all over again.
  it('names an unnamed robot row', () => {
    const db = mailboxBefore();
    seedContact(db, 'noreply@vendor.co.in', null);

    createMigrationManager(db).migrate();

    expect(read(db, 'noreply@vendor.co.in').name).toBe('vendor.co.in');
  });

  // Regression: the chain must roll back and forward again. `down` restores
  // nothing by design, but it must exist or every rollback test fails on
  // "migration(s) 79 have no down function".
  it('rolls back and re-applies cleanly', () => {
    const db = mailboxBefore();
    seedContact(db, 'notifications@atlassian.net', 'Bhupesh Chugh');
    const manager = createMigrationManager(db);

    manager.migrate();
    expect(() => manager.rollback(BEFORE)).not.toThrow();
    expect(() => manager.migrate()).not.toThrow();

    expect(read(db, 'notifications@atlassian.net').name).toBe('atlassian.net');
  });
});
