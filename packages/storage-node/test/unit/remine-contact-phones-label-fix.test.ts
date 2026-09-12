// Migration 80: clearing the phone-mining watermark a SECOND time, after the
// scorer was corrected.
//
// v78 already cleared it once, for a different fix — which means any install
// that took the previous build has a freshly SET watermark again. The scorer's
// verdict (which number is the person's own) is computed while mining and then
// stored, so correcting the scorer reaches a contact only if their signatures
// are read again. Without this migration the "VP Support" label bug and the
// ranking fix land on nobody who is already up to date.

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationManager,
  createMigrationManager,
  remineContactPhonesAfterLabelFix,
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

const BEFORE = remineContactPhonesAfterLabelFix.version - 1;
const NOW = 1_770_000_000;

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
});

/** A mailbox migrated up to the version just before this one — v78 included. */
function mailboxBefore(): Database.Database {
  const db = openTestDb();
  open.push(db);
  attachSharedContacts(db, '');
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version <= BEFORE).forEach((m) => manager.register(m));
  manager.migrate();
  return db;
}

function seedMinedContact(db: Database.Database, email: string, through: number | null): void {
  db.prepare(
    `INSERT INTO ${SHARED_SCHEMA}.contacts
       (id, email, first_seen, last_seen, phones_mined_through, phones_mined)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`c-${email}`, email, NOW, NOW, through, JSON.stringify({ '+919414511220': 49 }));
}

const watermark = (db: Database.Database, email: string) =>
  db.prepare(
    `SELECT phones_mined_through AS through, phones_mined AS phones
       FROM ${SHARED_SCHEMA}.contacts WHERE email = ?`,
  ).get(email) as { through: number | null; phones: string | null };

describe('migration 80 — re-mine after the scorer fix', () => {
  // Regression: the point of the migration. An install that already ran v78 has
  // its watermark set again, so the corrected scorer would never re-read anyone
  // and every wrong number stays on screen.
  it('clears a watermark that v78 had already re-set', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'bhupesh@sarv.com', NOW);

    createMigrationManager(db).migrate();

    expect(watermark(db, 'bhupesh@sarv.com').through).toBeNull();
  });

  // Regression: the per-sender counts are the evidence the recurrence bonus and
  // the domain-wide switchboard test run on. Clearing them here would throw
  // away exactly what the ranking fix was built to use.
  it('keeps the numbers already mined', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'bhupesh@sarv.com', NOW);

    createMigrationManager(db).migrate();

    expect(JSON.parse(watermark(db, 'bhupesh@sarv.com').phones ?? '{}')).toEqual({ '+919414511220': 49 });
  });

  // Idempotent re-run: a second account opening the same shared directory runs
  // the chain again, and must not behave differently the second time.
  it('is a no-op on a second run', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'bhupesh@sarv.com', NOW);

    createMigrationManager(db).migrate();
    remineContactPhonesAfterLabelFix.up(db, {});

    expect(watermark(db, 'bhupesh@sarv.com').through).toBeNull();
  });

  // Regression: the watermark lives in the shared directory, which a migration
  // can find unattached (a repair path, a half-initialised boot). Throwing
  // there would fail the whole chain over a cache reset.
  it('does nothing, and does not throw, with no directory attached', () => {
    const db = openTestDb();
    open.push(db);
    expect(() => remineContactPhonesAfterLabelFix.up(db, {})).not.toThrow();
  });

  // Regression: `down` restores nothing by design, but it must EXIST — without
  // it every rollback test in the suite fails on "migration(s) 80 have no down
  // function".
  it('rolls back and re-applies cleanly', () => {
    const db = mailboxBefore();
    seedMinedContact(db, 'bhupesh@sarv.com', NOW);

    const manager = createMigrationManager(db);
    manager.migrate();
    manager.rollback(BEFORE);
    expect(manager.getCurrentVersion()).toBe(BEFORE);

    manager.migrate();
    expect(watermark(db, 'bhupesh@sarv.com').through).toBeNull();
  });
});
