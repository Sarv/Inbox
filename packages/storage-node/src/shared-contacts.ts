/**
 * The SHARED contact directory — one address book for the whole app, not one
 * per mailbox.
 *
 * `contacts` used to be a table in every per-account database, so the same
 * person emailing two of the user's accounts became two independent rows with
 * two independent enrichments: the LLM work was paid for twice, the phone
 * classifier only ever saw one account's slice of a domain (and a switchboard
 * is only identifiable by how many colleagues carry it), and a favourite set on
 * one account was invisible on the other.
 *
 * It now lives ONCE, in `sarvinbox-contacts.db`, which every account connection
 * ATTACHes as the schema `shared`. That is what makes the unification real
 * rather than a merge performed on every read: there is a single physical row
 * per address, and SQLite still lets a query join it against the LOCAL `emails`
 * table of whichever account is asking.
 *
 * Three rules keep this safe, and each of them has a failure it exists to
 * prevent:
 *
 *  1. **Contact SQL is always schema-qualified** (`shared.contacts`, never a
 *     bare `contacts`) — see {@link SHARED}. SQLite resolves an unqualified
 *     name against `main` FIRST, so a stray `CREATE TABLE contacts` in an
 *     account database would silently shadow the directory and the app would
 *     read an empty address book without a single error. Qualifying makes that
 *     impossible and makes every directory access greppable.
 *  2. **A failed ATTACH throws.** An unreadable store and an empty store are
 *     the same value and opposite facts; the one thing we must never do is
 *     carry on and let "no contacts" mean "the file didn't open".
 *  3. **The directory is never written by a migration that deletes.** The
 *     per-account adoption pass (see `migrations.ts`, `unified_contact_directory`)
 *     only ever merges rows INTO the directory.
 */
import type Database from 'better-sqlite3';

import { createLogger } from '@sarvinbox/core';

import { escapeDbKey, isExistingPlaintextDb } from './db-encryption';

const log = createLogger('SharedContacts');

/**
 * The schema name every account connection attaches the directory under.
 *
 * Use the {@link SHARED} helper rather than interpolating this by hand, so a
 * table name can never be written unqualified by accident.
 */
export const SHARED_SCHEMA = 'shared';

/** Qualify a directory table: `SHARED('contacts')` -> `shared.contacts`. */
export const SHARED = (table: string): string => `${SHARED_SCHEMA}.${table}`;

/** File name of the shared directory, a sibling of the per-account databases. */
export const SHARED_CONTACTS_FILE = 'sarvinbox-contacts.db';

/**
 * Tables that live in the directory rather than in a mailbox.
 *
 * `sender_stats` is deliberately NOT here: it counts what the USER did to a
 * sender (replied, read, deleted, marked VIP), which is a property of one
 * mailbox's relationship, not of the person. It stays per-account and is still
 * joined to the directory by address.
 */
export const DIRECTORY_TABLES = [
  'contacts',
  'contact_notes',
  'contact_enrichment_history',
  'contact_accounts',
] as const;

/**
 * The directory schema, fully evolved.
 *
 * This is deliberately the FINAL shape rather than a replay of the per-account
 * migration chain: the directory is a new file in every install, so there is no
 * older version of it in the wild to upgrade from. The column list mirrors
 * `contacts` as it stands after the per-account migrations that built it up
 * (v20 contact types, v39 enrichment/person identity, v58 phone-mining
 * watermark, v63 avatar confirmation) — when a column is added to one, add it
 * here too.
 */
const directorySchema = (prefix: string): string => `
CREATE TABLE IF NOT EXISTS ${prefix}contacts (
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
  updated_at INTEGER DEFAULT (unixepoch()),
  -- v20: agent contact typing
  contact_type TEXT DEFAULT 'unknown',
  contact_type_confidence REAL DEFAULT 0,
  contact_type_source TEXT DEFAULT 'unset',
  company TEXT,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  avg_response_time_sec INTEGER,
  thread_count INTEGER DEFAULT 0,
  needs_response INTEGER DEFAULT 0,
  -- v39: enrichment + person/company identity
  kind TEXT NOT NULL DEFAULT 'individual',
  person_id TEXT,
  company_contact_id TEXT,
  mobile_e164 TEXT,
  enrichment TEXT,
  enriched_through_email_at INTEGER,
  enrichment_source TEXT,
  -- v58: incremental phone mining
  phones_mined_through INTEGER,
  phones_mined TEXT,
  -- v63: avatar confirmation
  avatar_status TEXT,
  avatar_checked_at INTEGER
);

CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_kind ON contacts(kind);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_person_id ON contacts(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_company_id ON contacts(company_contact_id) WHERE company_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_mobile ON contacts(mobile_e164) WHERE mobile_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_enriched_through ON contacts(enriched_through_email_at);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_last_seen ON contacts(last_seen DESC);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_email_nocase ON contacts(email COLLATE NOCASE);
-- v20's classification indexes. They were created per-account by migration 29;
-- the directory needs them for the same reason (the agent filters the whole
-- address book by contact_type and by needs_response on every pass).
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_type ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_needs_response ON contacts(needs_response) WHERE needs_response = 1;
CREATE INDEX IF NOT EXISTS ${prefix}idx_contacts_last_inbound ON contacts(last_inbound_at DESC);

CREATE TRIGGER IF NOT EXISTS ${prefix}contacts_update_timestamp
AFTER UPDATE ON contacts
BEGIN
  UPDATE contacts SET updated_at = unixepoch() WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS ${prefix}contact_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  note TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source_email_id TEXT,
  confidence REAL DEFAULT 0.8,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  is_active INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contact_notes_email ON contact_notes(email);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contact_notes_category ON contact_notes(email, category);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contact_notes_active ON contact_notes(email, is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS ${prefix}contact_enrichment_history (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  person_id TEXT,
  enrichment TEXT NOT NULL,
  company_contact_id TEXT,
  designation TEXT,
  organization TEXT,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  source TEXT NOT NULL DEFAULT 'llm',
  source_email_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS ${prefix}idx_enrichment_history_contact ON contact_enrichment_history(contact_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS ${prefix}idx_enrichment_history_person ON contact_enrichment_history(person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${prefix}idx_enrichment_history_open ON contact_enrichment_history(contact_id) WHERE effective_to IS NULL;

-- Provenance: which mailbox(es) this address was actually seen in, and what it
-- contributed. The directory row is the union; this is the breakdown.
--
-- It is not UI (nothing renders it yet). It is here because the union is only
-- maintainable if the parts are known: removing an account has to be able to
-- subtract that account's counts instead of leaving them fused into a total
-- that no longer has a source, and "which account do I reply from?" is
-- answerable only from here.
CREATE TABLE IF NOT EXISTS ${prefix}contact_accounts (
  email          TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  first_seen     INTEGER,
  last_seen      INTEGER,
  email_count    INTEGER DEFAULT 0,
  sent_count     INTEGER DEFAULT 0,
  received_count INTEGER DEFAULT 0,
  updated_at     INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (email, account_id)
);
CREATE INDEX IF NOT EXISTS ${prefix}idx_contact_accounts_account ON contact_accounts(account_id);
`;

/**
 * True when this connection has the contact directory attached.
 *
 * Queried off `pragma database_list` rather than remembered in a module flag:
 * every account opens its own connection, and whether THAT connection can see
 * the directory is a property of the connection, never of the process.
 */
export function hasSharedContacts(db: Database.Database): boolean {
  try {
    const rows = db.pragma('database_list') as Array<{ name: string }>;
    return rows.some((r) => r.name === SHARED_SCHEMA);
  } catch {
    return false;
  }
}

/**
 * Attach the directory to an account connection as `shared`.
 *
 * THROWS on failure, and that is the point. Every core-DB read in this app is
 * wrapped in a try/catch that answers with an empty result, so a directory that
 * failed to open would not look like an error to anything downstream — it would
 * look like a user with no contacts, and the enrichment schedulers would set
 * about rebuilding one from scratch over the top of the real one. The caller
 * must not be able to miss this.
 */
export function attachSharedContacts(
  db: Database.Database,
  path: string,
  key?: string,
): void {
  // An install that predates at-rest encryption has a PLAINTEXT directory file
  // and a key to apply to it. Attaching that file WITH the key fails outright
  // (`SQLITE_NOTADB`), so it has to be attached open and rekeyed in place —
  // exactly what `SQLiteStorage.initialize` does for the mailbox itself. Decided
  // from the file before attaching, because ATTACH creates it when absent and a
  // brand-new file looks plaintext too.
  const legacyPlaintext = !!key && isExistingPlaintextDb(path);

  // `ATTACH … KEY …` is the SQLCipher-compatible form implemented by
  // sqlite3mc (the cipher build this project uses); the key is bound, never
  // interpolated, so it cannot terminate the string. ATTACH creates the file
  // when it does not exist yet, so the first account to open is also the one
  // that brings the directory into being.
  const attachKey = key && !legacyPlaintext ? key : '';
  db.prepare(`ATTACH DATABASE ? AS ${SHARED_SCHEMA} KEY ?`).run(path, attachKey);

  if (legacyPlaintext) {
    // Leave WAL first: rekey rewrites every page, and doing that under a
    // rollback journal is the recoverable path. WAL is restored below.
    db.pragma(`${SHARED_SCHEMA}.journal_mode = DELETE`);
    db.pragma(`${SHARED_SCHEMA}.rekey='${escapeDbKey(key!)}'`);
    log.info(`[SharedContacts] migrated plaintext directory to encrypted: ${path}`);
  }

  // Every CREATE here is schema-qualified and IF NOT EXISTS: applying the
  // schema on the attached connection (rather than on a second connection of
  // its own) means there is exactly ONE place that can create these tables, and
  // it can never create them in the caller's mailbox by forgetting a prefix.
  // An empty path attaches an anonymous temporary database, which needs the
  // same treatment for the opposite reason — it has no file to have been
  // prepared from.
  db.exec(directorySchema(`${SHARED_SCHEMA}.`));

  // WAL on the directory itself, so the account that writes a contact does not
  // block the account reading one. Skipped for the anonymous temporary database
  // (`path === ''`), which has no file to journal against.
  if (path) db.pragma(`${SHARED_SCHEMA}.journal_mode = WAL`);

  // Prove the attached file is actually READABLE before anyone trusts it. A
  // wrong key attaches without complaint and only fails on first use, which
  // would otherwise surface deep inside a list query as "no contacts".
  const probe = db
    .prepare(`SELECT COUNT(*) AS n FROM ${SHARED('contacts')}`)
    .get() as { n: number };

  db.pragma(`${SHARED_SCHEMA}.synchronous = NORMAL`);
  // Two accounts share one file and better-sqlite3 is synchronous, so a busy
  // lock cannot be waited out by yielding — give SQLite permission to block
  // briefly instead of throwing SQLITE_BUSY at whichever account wrote second.
  db.pragma('busy_timeout = 5000');

  log.info(`[SharedContacts] attached ${path} (${probe.n} contacts)`);
}
