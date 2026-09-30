/**
 * OpenPGP keyring rows in the core DB.
 *
 * Keys belong to ADDRESSES, not to a mailbox: the same person's key serves
 * every account that writes to them, and an own key is found by the From
 * address a message goes out as (alias included). So both tables live in the
 * main-owned core DB, next to the account registry.
 *
 *   - pgp_own_keys     the user's key pairs. `secret` is a sealed envelope
 *                      (pgp-secret-seal.ts), never a bare private key.
 *   - pgp_contact_keys other people's PUBLIC keys, one row per
 *                      (address, fingerprint), with where the key came from.
 *
 * Every timestamp is UTC ISO-8601. This module only moves rows; it does not
 * parse keys or decide which one to use — that is pgp-keyring.ts.
 */
import type { PgpKeySource } from '@sarvinbox/core/pgp';
import type Database from 'better-sqlite3';

import { getCoreDb } from './core-db';

export type OwnKeyProtection = 'keychain' | 'passphrase';
export type AutocryptPreferEncrypt = 'mutual' | 'nopreference';

export interface OwnKeyRow {
  fingerprint: string;
  email: string;
  publicKey: string;
  secret: Buffer;
  protection: OwnKeyProtection;
  signByDefault: boolean;
  createdAt: string;
  addedAt: string;
}

export interface ContactKeyRow {
  email: string;
  fingerprint: string;
  publicKey: string;
  source: PgpKeySource;
  /** Autocrypt only: the sender's stated preference. */
  preferEncrypt: AutocryptPreferEncrypt | null;
  firstSeen: string;
  lastSeen: string;
}

export function ensurePgpKeySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pgp_own_keys (
      fingerprint     TEXT PRIMARY KEY,
      email           TEXT NOT NULL,
      public_key      TEXT NOT NULL,
      secret          BLOB NOT NULL,
      protection      TEXT NOT NULL,
      sign_by_default INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      added_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pgp_own_keys_email ON pgp_own_keys(email);
    CREATE TABLE IF NOT EXISTS pgp_contact_keys (
      email          TEXT NOT NULL,
      fingerprint    TEXT NOT NULL,
      public_key     TEXT NOT NULL,
      source         TEXT NOT NULL,
      prefer_encrypt TEXT,
      first_seen     TEXT NOT NULL,
      last_seen      TEXT NOT NULL,
      PRIMARY KEY (email, fingerprint)
    );
  `);
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

interface OwnKeyDbRow {
  fingerprint: string;
  email: string;
  public_key: string;
  secret: Buffer;
  protection: OwnKeyProtection;
  sign_by_default: number;
  created_at: string;
  added_at: string;
}

interface ContactKeyDbRow {
  email: string;
  fingerprint: string;
  public_key: string;
  source: PgpKeySource;
  prefer_encrypt: AutocryptPreferEncrypt | null;
  first_seen: string;
  last_seen: string;
}

const ownFromDb = (row: OwnKeyDbRow): OwnKeyRow => ({
  fingerprint: row.fingerprint,
  email: row.email,
  publicKey: row.public_key,
  secret: Buffer.isBuffer(row.secret) ? row.secret : Buffer.from(row.secret),
  protection: row.protection,
  signByDefault: row.sign_by_default === 1,
  createdAt: row.created_at,
  addedAt: row.added_at,
});

const contactFromDb = (row: ContactKeyDbRow): ContactKeyRow => ({
  email: row.email,
  fingerprint: row.fingerprint,
  publicKey: row.public_key,
  source: row.source,
  preferEncrypt: row.prefer_encrypt,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
});

export class PgpKeyStore {
  constructor(private readonly db: Database.Database) {
    ensurePgpKeySchema(db);
  }

  // ------------------------------------------------------------- own keys

  listOwnKeys(): OwnKeyRow[] {
    const rows = this.db.prepare('SELECT * FROM pgp_own_keys ORDER BY email, added_at DESC').all() as OwnKeyDbRow[];
    return rows.map(ownFromDb);
  }

  getOwnKey(fingerprint: string): OwnKeyRow | null {
    const row = this.db.prepare('SELECT * FROM pgp_own_keys WHERE fingerprint = ?').get(fingerprint) as
      | OwnKeyDbRow
      | undefined;
    return row ? ownFromDb(row) : null;
  }

  /** Insert or replace — re-importing a key the user already has refreshes it in place. */
  putOwnKey(row: OwnKeyRow): void {
    this.db
      .prepare(
        `INSERT INTO pgp_own_keys (fingerprint, email, public_key, secret, protection, sign_by_default, created_at, added_at)
         VALUES (@fingerprint, @email, @publicKey, @secret, @protection, @signByDefault, @createdAt, @addedAt)
         ON CONFLICT(fingerprint) DO UPDATE SET
           email = excluded.email, public_key = excluded.public_key, secret = excluded.secret,
           protection = excluded.protection, created_at = excluded.created_at`,
      )
      .run({ ...row, email: normalizeEmail(row.email), signByDefault: row.signByDefault ? 1 : 0 });
  }

  setSignByDefault(fingerprint: string, on: boolean): boolean {
    return this.db.prepare('UPDATE pgp_own_keys SET sign_by_default = ? WHERE fingerprint = ?').run(on ? 1 : 0, fingerprint)
      .changes > 0;
  }

  deleteOwnKey(fingerprint: string): boolean {
    return this.db.prepare('DELETE FROM pgp_own_keys WHERE fingerprint = ?').run(fingerprint).changes > 0;
  }

  // --------------------------------------------------------- contact keys

  listContactKeys(): ContactKeyRow[] {
    const rows = this.db
      .prepare('SELECT * FROM pgp_contact_keys ORDER BY email, last_seen DESC')
      .all() as ContactKeyDbRow[];
    return rows.map(contactFromDb);
  }

  contactKeysFor(email: string): ContactKeyRow[] {
    const rows = this.db
      .prepare('SELECT * FROM pgp_contact_keys WHERE email = ? ORDER BY last_seen DESC')
      .all(normalizeEmail(email)) as ContactKeyDbRow[];
    return rows.map(contactFromDb);
  }

  /**
   * Record a sighting of a key. A new (address, fingerprint) is inserted; a known
   * one keeps its first sighting and takes the newer key material, last-seen and
   * preference. A MANUAL import is never demoted by a later automatic sighting:
   * the user vouched for that key, a header on some message did not.
   */
  upsertContactKey(row: Omit<ContactKeyRow, 'firstSeen'> & { firstSeen?: string }): void {
    this.db
      .prepare(
        `INSERT INTO pgp_contact_keys (email, fingerprint, public_key, source, prefer_encrypt, first_seen, last_seen)
         VALUES (@email, @fingerprint, @publicKey, @source, @preferEncrypt, @firstSeen, @lastSeen)
         ON CONFLICT(email, fingerprint) DO UPDATE SET
           public_key     = excluded.public_key,
           source         = CASE WHEN pgp_contact_keys.source = 'manual' THEN 'manual' ELSE excluded.source END,
           prefer_encrypt = COALESCE(excluded.prefer_encrypt, pgp_contact_keys.prefer_encrypt),
           last_seen      = MAX(pgp_contact_keys.last_seen, excluded.last_seen)`,
      )
      .run({
        ...row,
        email: normalizeEmail(row.email),
        preferEncrypt: row.preferEncrypt ?? null,
        firstSeen: row.firstSeen ?? row.lastSeen,
      });
  }

  deleteContactKey(email: string, fingerprint: string): boolean {
    return (
      this.db
        .prepare('DELETE FROM pgp_contact_keys WHERE email = ? AND fingerprint = ?')
        .run(normalizeEmail(email), fingerprint).changes > 0
    );
  }
}

let store: PgpKeyStore | null = null;

export function getPgpKeyStore(): PgpKeyStore {
  store ??= new PgpKeyStore(getCoreDb());
  return store;
}
