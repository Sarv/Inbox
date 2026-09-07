/**
 * Core app DB (`sarvinbox-core.db`) — the single, durable, encrypted store the
 * MAIN process owns for ALL app-level state that used to be scattered across
 * renderer localStorage and a handful of JSON files:
 *
 *   - account_registry   configured mail accounts (non-secret config)      [accounts-registry.ts]
 *   - app_settings        global settings mirror (signatures, prefs, …)
 *   - registry_meta       small internal key/values (active/primary id, flags)
 *   - core_blobs          opaque encrypted BLOBs (OAuth tokens, credential
 *                         vault, last-good IMAP config, pipeline state) — each
 *                         stored EXACTLY as its owning store already serialized
 *                         it (safeStorage ENC1:/PLAIN1:), so the encryption model
 *                         is unchanged; only the container moved from a file to
 *                         a DB row (defense-in-depth: the DB is also encrypted).
 *
 * This module is DEPENDENCY-FREE (imports nothing from the other stores) so it
 * can be the shared foundation every store builds on without import cycles.
 *
 * Irreducible companion file: `db-key.bin` — the SQLCipher key that unlocks THIS
 * DB. It can't live inside the DB it encrypts, so it stays a separate file
 * (itself safeStorage-encrypted). Losing `db-key.bin` makes every DB unreadable;
 * losing `core.db` loses accounts/settings/secrets but NOT the per-account mail
 * DBs (those are re-adopted on re-add via the deterministic id hash).
 */
import { existsSync, copyFileSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';
import Database from 'better-sqlite3';

import { createLogger } from '@sarvinbox/core';

import { getDbEncryptionKey } from './db-key-store';

const logger = createLogger('core-db');

export const CORE_DB_FILE = 'sarvinbox-core.db';

let db: Database.Database | null = null;

/** Lazily open + initialize the core DB (encrypted with the shared DB key). */
export function getCoreDb(): Database.Database {
  if (db) return db;
  const dbPath = join(app.getPath('userData'), CORE_DB_FILE);
  const handle = new Database(dbPath);
  // Encrypt at rest with the same key the per-account DBs use. This file is new
  // in this version, so there is never a legacy-plaintext DB to rekey — `key=`
  // is applied as the very first statement, before any other pragma.
  const key = getDbEncryptionKey();
  if (key) handle.pragma(`key='${key.replace(/'/g, "''")}'`);
  handle.pragma('journal_mode = WAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS account_registry (
      id               TEXT PRIMARY KEY,
      email            TEXT NOT NULL,
      name             TEXT,
      imap_config      TEXT,
      smtp_config      TEXT,
      smtp_configured  INTEGER NOT NULL DEFAULT 0,
      auth_method      TEXT,
      oauth_provider   TEXT,
      color            TEXT,
      include_in_unified INTEGER NOT NULL DEFAULT 1,
      background_sync    INTEGER NOT NULL DEFAULT 1,
      notify             INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER,
      updated_at       INTEGER
    );
    CREATE TABLE IF NOT EXISTS registry_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS core_blobs (
      key        TEXT PRIMARY KEY,
      data       BLOB,
      updated_at INTEGER
    );
  `);
  db = handle;
  logger.info('[CoreDB] opened', dbPath);
  return db;
}

/** True once the core DB file exists on disk. */
export function coreDbExists(): boolean {
  return existsSync(join(app.getPath('userData'), CORE_DB_FILE));
}

/**
 * Best-effort backup of the core DB (the crown jewels now). Call at startup:
 * a WAL-checkpointed copy → `sarvinbox-core.db.bak`, so a corrupted core DB is
 * recoverable. No-op if the DB isn't open yet / copy fails.
 */
export function backupCoreDb(): void {
  try {
    if (!coreDbExists()) return;
    // Checkpoint so the .bak is a complete, self-contained snapshot.
    try { getCoreDb().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    const src = join(app.getPath('userData'), CORE_DB_FILE);
    copyFileSync(src, `${src}.bak`);
  } catch (e) {
    logger.warn('[CoreDB] backup failed:', (e as Error)?.message);
  }
}

// ===== registry_meta (small internal key/values) ===========================

export function getMeta(key: string): string | null {
  try {
    const row = getCoreDb().prepare('SELECT value FROM registry_meta WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function setMeta(key: string, value: string | null): void {
  try {
    if (value == null) {
      getCoreDb().prepare('DELETE FROM registry_meta WHERE key = ?').run(key);
      return;
    }
    getCoreDb()
      .prepare('INSERT INTO registry_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  } catch (e) {
    logger.error('[CoreDB] setMeta failed:', key, e);
  }
}

// ===== One-time migration flags ============================================

export function isMigrationDone(flag: string): boolean {
  return getMeta(flag) === '1';
}

export function markMigrationDone(flag: string): void {
  setMeta(flag, '1');
}

// ===== Global app settings (durable mirror of localStorage) =================
// Stores the raw localStorage VALUE (a JSON string) verbatim under its
// localStorage key, so the renderer restores it byte-for-byte on boot.

export function getAllAppSettings(): Record<string, string> {
  try {
    const rows = getCoreDb().prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string | null }>;
    const out: Record<string, string> = {};
    for (const r of rows) if (r.value != null) out[r.key] = r.value;
    return out;
  } catch (e) {
    logger.error('[CoreDB] getAllAppSettings failed:', e);
    return {};
  }
}

export function setAppSetting(key: string, value: string): void {
  if (!key) return;
  try {
    getCoreDb()
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  } catch (e) {
    logger.error('[CoreDB] setAppSetting failed:', key, e);
  }
}

export function deleteAppSetting(key: string): void {
  if (!key) return;
  try {
    getCoreDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  } catch (e) {
    logger.error('[CoreDB] deleteAppSetting failed:', key, e);
  }
}

// ===== Opaque encrypted BLOBs ==============================================
// Each store hands us the SAME serialized buffer it used to write to its file
// (safeStorage ENC1:/PLAIN1:). We just persist it as a DB row. The store owns
// (de)serialization + the encryption; core-db is only the container.

export function getBlob(key: string): Buffer | null {
  try {
    const row = getCoreDb().prepare('SELECT data FROM core_blobs WHERE key = ?').get(key) as any;
    const data = row?.data;
    if (data == null) return null;
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch (e) {
    logger.error('[CoreDB] getBlob failed:', key, e);
    return null;
  }
}

export function setBlob(key: string, data: Buffer): void {
  if (!key) return;
  try {
    getCoreDb()
      .prepare(
        `INSERT INTO core_blobs (key, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(key, data, Date.now());
  } catch (e) {
    logger.error('[CoreDB] setBlob failed:', key, e);
  }
}

export function deleteBlob(key: string): void {
  if (!key) return;
  try {
    getCoreDb().prepare('DELETE FROM core_blobs WHERE key = ?').run(key);
  } catch (e) {
    logger.error('[CoreDB] deleteBlob failed:', key, e);
  }
}

export function hasBlob(key: string): boolean {
  try {
    return !!getCoreDb().prepare('SELECT 1 FROM core_blobs WHERE key = ?').get(key);
  } catch {
    return false;
  }
}
