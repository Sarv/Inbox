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
 * Cross-platform: macOS Keychain, Windows DPAPI, or a real Linux keyring is
 * required for a new key. Existing plaintext/weakly sealed keys stay readable
 * and are protected, without rotation, when the OS store recovers.
 */
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';
import { app } from 'electron';

import { isOsBackedEncryption, storedEncryptionProtection } from './os-encryption';
import { isEncryptedEnvelope, isPlaintextEnvelope, openString, sealString, type EnvelopeErrors } from './safe-storage-envelope';
const logger = createLogger('db-key-store');

const FILE_NAME = 'db-key.bin';

let cachedKey: string | null = null;
let cachedKeyNeedsProtection = false;

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME);
}

function serialize(hexKey: string): Buffer {
  return sealString(hexKey);
}

/** This store's wording for an envelope it can't open (tests pin these). */
const ENVELOPE_ERRORS: EnvelopeErrors = {
  locked: 'DB key is encrypted but safeStorage is unavailable',
  unknownFormat: 'Unknown db-key file format',
};

function deserialize(buf: Buffer): string {
  const key = openString(buf, ENVELOPE_ERRORS);
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid database encryption key');
  return key;
}

function needsProtection(buf: Buffer): boolean {
  return isPlaintextEnvelope(buf) || (isEncryptedEnvelope(buf)
    && storedEncryptionProtection(buf.subarray(5, 8).toString('ascii')) === 'unprotected');
}

/** No backup: a plaintext recovery copy would defeat protecting the key. */
function writeKeyAtomically(path: string, sealed: Buffer): void {
  const tmp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(tmp, sealed, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Rewrap the SAME key; no SQLCipher rekey and no unreadable ciphertext replacement. */
function protectExistingKey(path: string, key: string): boolean {
  if (!isOsBackedEncryption()) return false;
  try {
    const current = readFileSync(path);
    if (!needsProtection(current)) return isEncryptedEnvelope(current) && deserialize(current) === key;
    if (deserialize(current) !== key) return false;
    const sealed = serialize(key);
    if (!isEncryptedEnvelope(sealed) || deserialize(sealed) !== key) {
      throw new Error('Secure-storage verification failed');
    }
    writeKeyAtomically(path, sealed);
    logger.info('[DbKeyStore] Protected existing database encryption key with the operating system key store');
    return true;
  } catch {
    // Keep the original key and a usable profile. The status check will still
    // show the actual plaintext header, and a later call can retry recovery.
    logger.warn('[DbKeyStore] Could not protect the existing database encryption key; original file preserved');
    return false;
  }
}

/**
 * The persistent DB encryption key (64-char hex = 256-bit), created on first run.
 * Cached for the process lifetime. Losing this key means the encrypted DBs can't
 * be read — but they're a re-syncable cache, so worst case is a re-download.
 */
export function getDbEncryptionKey(): string {
  if (cachedKey) {
    if (cachedKeyNeedsProtection && protectExistingKey(filePath(), cachedKey)) cachedKeyNeedsProtection = false;
    return cachedKey;
  }
  const path = filePath();
  if (existsSync(path)) {
    const sealed = readFileSync(path);
    cachedKey = deserialize(sealed);
    cachedKeyNeedsProtection = needsProtection(sealed);
    if (cachedKeyNeedsProtection && protectExistingKey(path, cachedKey)) cachedKeyNeedsProtection = false;
    return cachedKey;
  }
  const hex = randomBytes(32).toString('hex');
  const sealed = serialize(hex);
  writeKeyAtomically(path, sealed);
  cachedKey = hex;
  cachedKeyNeedsProtection = isPlaintextEnvelope(sealed);
  logger.info('[DbKeyStore] Generated new database encryption key');
  return hex;
}

/** Whether the OS store can protect a new key now, independent of existing-key protection. */
export function isDbKeyEncryptionAvailable(): boolean {
  return isOsBackedEncryption();
}
