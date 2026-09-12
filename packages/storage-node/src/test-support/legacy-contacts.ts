// TEST-ONLY: the per-account `contacts` table as it existed BEFORE the shared
// directory.
//
// Contacts used to be a plain table in every mailbox, created by that era's
// `schema.sql` and widened column-by-column by migrations 29/39/58/63. Nothing
// creates it any more, so a test that wants to prove the adoption (v77) has to
// stand one up the way a real upgrader's database already has one.
//
// Shared rather than copied into each test file: this DDL is the INPUT to the
// migration under test, and two drifting copies would mean two different
// "legacy" shapes, only one of which matches what users actually have.

import type Database from 'better-sqlite3';

/**
 * The v24-era shape — deliberately NARROW. Every column the later migrations
 * add is absent on purpose: running the chain over this is what proves those
 * migrations still widen a mailbox that has the table, which is the only path
 * by which a real upgrader reaches v77 with a complete `contacts` row.
 */
export const LEGACY_CONTACTS_DDL = `
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  display_name TEXT,
  avatar_url TEXT,
  organization TEXT,
  title TEXT,
  phone TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  email_count INTEGER DEFAULT 1,
  sent_count INTEGER DEFAULT 0,
  received_count INTEGER DEFAULT 0,
  is_favorite INTEGER DEFAULT 0,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
`;

/** Create the legacy per-account `contacts` table in `main`. */
export function createLegacyContactsTable(db: Database.Database): void {
  db.exec(LEGACY_CONTACTS_DDL);
}
