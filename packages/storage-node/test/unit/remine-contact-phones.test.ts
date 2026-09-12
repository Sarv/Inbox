// Migration 78: clearing the phone-mining watermark after the mining rules
// changed.
//
// Mining is incremental — `phones_mined_through` means "we already read this
// contact's mail". That is only safe while the reading itself does not change,
// and it just did (both ends of a body instead of the tail alone; a `tel:` href
// no longer read as an office label). The contacts whose numbers were missed
// are precisely the ones the watermark bars from being re-read, so without this
// migration the fix reaches nobody until they happen to receive new mail — and
// never at all from a correspondent who has gone quiet.

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationManager,
  createMigrationManager,
  remineContactPhones,
  type Migration,
} from '../../src/migrations';
import { SHARED_SCHEMA, attachSharedContacts } from '../../src/shared-contacts';
import { openTestDb } from '../../src/test-support/test-db';

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

const BEFORE = remineContactPhones.version - 1;
const NOW = 1_770_000_000;

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
});

/** A mailbox migrated up to the version just before the re-mine. */
function mailboxBefore(): Database.Database {
  const db = openTestDb();
  open.push(db);
  attachSharedContacts(db, '');
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version <= BEFORE).forEach((m) => manager.register(m));
  manager.migrate();
  return db;
}

function seedMinedContact(
  db: Database.Database,
  email: string,
  through: number | null,
  phones: Record<string, number> | null = { '+919876543210': 3 },
): void {
  db.prepare(
    `INSERT INTO ${SHARED_SCHEMA}.contacts
       (id, email, first_seen, last_seen, phones_mined_through, phones_mined)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`c-${email}`, email, NOW, NOW, through, phones ? JSON.stringify(phones) : null);
}

const watermark = (db: Database.Database, email: string) =>
  db.prepare(
    `SELECT phones_mined_through AS through, phones_mined AS phones
       FROM ${SHARED_SCHEMA}.contacts WHERE email = ?`,
  ).get(email) as { through: number | null; phones: string | null };

describe('migration 78 — re-mine contact phones', () => {
  // Regression: the whole point. An upgrader's contacts must be re-read once
  // under the fixed mining rules instead of being skipped as already mined.
  it('clears the watermark on an upgraded mailbox', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'amit@acme.in', 1_770_000_000);

    createMigrationManager(db).migrate();

    expect(watermark(db, 'amit@acme.in').through).toBeNull();
  });

  // Regression: the mined NUMBERS are not the cache — they are the evidence the
  // domain-wide switchboard test runs on, and the next scan needs them before
  // re-mining replaces them. Clearing them too would make every contact on a
  // domain look like they had no shared line.
  it('keeps the numbers it already mined', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'amit@acme.in', 1_770_000_000, { '+919876543210': 3 });

    createMigrationManager(db).migrate();

    expect(JSON.parse(watermark(db, 'amit@acme.in').phones ?? '{}')).toEqual({ '+919876543210': 3 });
  });

  // Idempotent re-run: a partial run that is repeated (or a second account
  // opening the same shared directory, which is now the normal case) must not
  // behave differently the second time.
  it('is a no-op when every watermark is already clear', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'amit@acme.in', 1_770_000_000);
    seedMinedContact(db, 'ravi@vendor.co.in', null);

    createMigrationManager(db).migrate();
    remineContactPhones.up(db, {});

    expect(watermark(db, 'amit@acme.in').through).toBeNull();
    expect(watermark(db, 'ravi@vendor.co.in').through).toBeNull();
  });

  // Regression: the watermark lives in the shared directory, which a migration
  // can find unattached (a repair path, a test harness, a half-initialised
  // boot). Throwing there would fail the whole chain over a cache reset.
  it('does nothing, and does not throw, with no directory attached', () => {
    const db = openTestDb();
    open.push(db);
    expect(() => remineContactPhones.up(db, {})).not.toThrow();
  });

  // Regression: the chain must roll back and forward again. `down` restores
  // nothing by design — the old values are gone and an older build re-mines
  // them itself — but it must exist, or every rollback test in the suite fails
  // on "migration(s) 78 have no down function".
  it('rolls back and re-applies cleanly', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'amit@acme.in', 1_770_000_000);

    const manager = createMigrationManager(db);
    manager.migrate();
    manager.rollback(BEFORE);
    expect(manager.getCurrentVersion()).toBe(BEFORE);

    manager.migrate();
    // The top of the chain, not 78 — later migrations are registered above it
    // and re-applying stops at the newest one.
    expect(manager.getCurrentVersion()).toBe(CHAIN[CHAIN.length - 1].version);
    expect(watermark(db, 'amit@acme.in').through).toBeNull();
  });
});
