/**
 * Persistent database encryption key (main process).
 *
 * Mints a random 256-bit key once, stores it encrypted via Electron `safeStorage`
 * (OS keychain), and returns the same key for the app's lifetime. That key is
 * handed to SQLiteStorage (better-sqlite3-multiple-ciphers) as the SQLCipher
 * passphrase, so the mail-cache DBs are encrypted at rest.
 *
 * SYNCHRONOUS on purpose: storage is constructed synchronously at startup, and
 * this runs after app-ready (safeStorage + userData both available by then).
 *
 * Cross-platform: macOS (Keychain) / Windows (DPAPI) encrypt the key file; Linux
 * without a Secret Service falls back to a clearly-marked plaintext key file
 * (documented, warned — encryption then only raises the bar, it isn't airtight).
 */
import { randomBytes } from 'crypto';
import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@sarvinbox/core';
const logger = createLogger('db-key-store');

const FILE_NAME = 'db-key.bin';
const MAGIC_ENC = 'ENC1:';
const MAGIC_PLAIN = 'PLAIN1:';

let cachedKey: string | null = null;

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME);
}

function serialize(hexKey: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return Buffer.concat([Buffer.from(MAGIC_ENC, 'utf8'), safeStorage.encryptString(hexKey)]);
  }
  logger.warn('[DbKeyStore] safeStorage unavailable — DB key stored UNENCRYPTED (no OS keychain)');
  return Buffer.from(MAGIC_PLAIN + hexKey, 'utf8');
}

function deserialize(buf: Buffer): string {
  const enc = buf.subarray(0, MAGIC_ENC.length).toString('utf8');
  if (enc === MAGIC_ENC) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('DB key is encrypted but safeStorage is unavailable');
    }
    return safeStorage.decryptString(buf.subarray(MAGIC_ENC.length));
  }
  const plain = buf.subarray(0, MAGIC_PLAIN.length).toString('utf8');
  if (plain === MAGIC_PLAIN) return buf.subarray(MAGIC_PLAIN.length).toString('utf8');
  throw new Error('Unknown db-key file format');
}

/**
 * The persistent DB encryption key (64-char hex = 256-bit), created on first run.
 * Cached for the process lifetime. Losing this key means the encrypted DBs can't
 * be read — but they're a re-syncable cache, so worst case is a re-download.
 */
export function getDbEncryptionKey(): string {
  if (cachedKey) return cachedKey;
  const path = filePath();
  if (existsSync(path)) {
    cachedKey = deserialize(readFileSync(path));
    return cachedKey;
  }
  const hex = randomBytes(32).toString('hex');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serialize(hex), { mode: 0o600 });
  renameSync(tmp, path);
  cachedKey = hex;
  logger.info('[DbKeyStore] Generated new database encryption key');
  return hex;
}

/** Whether the DB key is (or would be) protected by the OS keychain. */
export function isDbKeyEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
