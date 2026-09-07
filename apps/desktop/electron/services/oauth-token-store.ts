/**
 * OAuth token store — persists OAuth accounts (refresh + access tokens)
 * encrypted via Electron safeStorage (OS keychain-backed).
 *
 * Storage moved from a standalone `oauth-accounts.json` file INTO the core DB
 * (`core_blobs` row, key `oauth-accounts`). The bytes are identical to what used
 * to be written to the file — the SAME safeStorage ENC1:/PLAIN1: envelope — so
 * the encryption model is unchanged; only the container moved (the core DB is
 * additionally encrypted at rest). On first run the legacy file is migrated into
 * the DB and then renamed `.premigrated` (kept, not deleted, so it's a recovery
 * fallback until the startup cleanup removes it).
 *
 * On Linux without a Secret Service provider safeStorage falls back to
 * plaintext; the ENC1/PLAIN1 tag records which, so load() decodes correctly.
 */

import { app, safeStorage } from 'electron';
import { existsSync, renameSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { OAuthAccount, OAuthProviderId } from '@sarvinbox/core';
import { createWriteQueue } from './write-queue';
import { getBlob, setBlob } from './core-db';
import { createLogger } from '@sarvinbox/core';
const logger = createLogger('oauth-token-store');

const LEGACY_FILE_NAME = 'oauth-accounts.json';
const BLOB_KEY = 'oauth-accounts';
const MAGIC_ENC = 'ENC1:';
const MAGIC_PLAIN = 'PLAIN1:';

let cache: OAuthAccount[] | null = null;

function legacyFilePath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

function serialize(accounts: OAuthAccount[]): Buffer {
  const payload = JSON.stringify(accounts);
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(payload);
    return Buffer.concat([Buffer.from(MAGIC_ENC, 'utf8'), enc]);
  }
  return Buffer.from(MAGIC_PLAIN + payload, 'utf8');
}

function deserialize(buf: Buffer): OAuthAccount[] {
  const enc = buf.subarray(0, MAGIC_ENC.length).toString('utf8');
  if (enc === MAGIC_ENC) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Stored tokens are encrypted but safeStorage is unavailable');
    }
    const plain = safeStorage.decryptString(buf.subarray(MAGIC_ENC.length));
    return JSON.parse(plain) as OAuthAccount[];
  }
  const plain = buf.subarray(0, MAGIC_PLAIN.length).toString('utf8');
  if (plain === MAGIC_PLAIN) {
    return JSON.parse(buf.subarray(MAGIC_PLAIN.length).toString('utf8')) as OAuthAccount[];
  }
  throw new Error('Unknown oauth-accounts blob format');
}

/**
 * One-time migration of the legacy `oauth-accounts.json` into the core DB. Reads
 * the file, writes its bytes to the blob, then renames the file `.premigrated`
 * (recoverable; the startup cleanup removes it later). Returns the migrated
 * accounts, or null if there was no legacy file.
 */
async function migrateLegacyFile(): Promise<OAuthAccount[] | null> {
  const path = legacyFilePath();
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err; // real read error — surface it (never cache [] on a transient failure)
  }
  const accounts = deserialize(buf); // may throw on bad data — do NOT swallow
  setBlob(BLOB_KEY, buf); // store the exact same envelope bytes
  try { renameSync(path, `${path}.premigrated`); } catch { /* keep original if rename fails */ }
  logger.info('[OAuthStore] migrated oauth-accounts.json into core DB');
  return accounts;
}

export async function loadAccounts(): Promise<OAuthAccount[]> {
  if (cache) return cache;
  const blob = getBlob(BLOB_KEY);
  if (blob) {
    // Do NOT fall back to [] on a decrypt/parse failure: caching "no accounts"
    // would make the next saveAccount destroy every other account's refresh
    // token. deserialize throws → propagate so callers fail loudly.
    cache = deserialize(blob);
    return cache;
  }
  // No blob yet → migrate a legacy file if present.
  const migrated = await migrateLegacyFile();
  if (migrated) { cache = migrated; return cache; }
  // migrateLegacyFile returned null: either there was no file, OR a concurrent
  // first-load already migrated + renamed it. Re-check the blob before caching
  // "empty" — otherwise a race could permanently strand this session at [].
  const blob2 = getBlob(BLOB_KEY);
  cache = blob2 ? deserialize(blob2) : [];
  return cache;
}

// Serialize persist() calls so concurrent saves can't interleave writes.
const writeQueue = createWriteQueue();

async function persist(accounts: OAuthAccount[]): Promise<void> {
  cache = accounts;
  const buf = serialize(accounts);
  return writeQueue.enqueue(async () => {
    setBlob(BLOB_KEY, buf);
  });
}

export async function saveAccount(account: OAuthAccount): Promise<void> {
  const accounts = await loadAccounts();
  const key = (a: OAuthAccount) => `${a.provider}:${a.email.toLowerCase()}`;
  const idx = accounts.findIndex((a) => key(a) === key(account));
  if (idx >= 0) {
    accounts[idx] = account;
  } else {
    accounts.push(account);
  }
  await persist(accounts);
}

export async function getAccount(
  provider: OAuthProviderId,
  email: string,
): Promise<OAuthAccount | null> {
  const accounts = await loadAccounts();
  const lc = email.toLowerCase();
  return accounts.find((a) => a.provider === provider && a.email.toLowerCase() === lc) || null;
}

export async function removeAccount(
  provider: OAuthProviderId,
  email: string,
): Promise<boolean> {
  const accounts = await loadAccounts();
  const lc = email.toLowerCase();
  const next = accounts.filter(
    (a) => !(a.provider === provider && a.email.toLowerCase() === lc),
  );
  if (next.length === accounts.length) return false;
  await persist(next);
  return true;
}

export async function listAccounts(): Promise<OAuthAccount[]> {
  return [...(await loadAccounts())];
}

/** True if the legacy oauth-accounts.json (or its .premigrated rename) still
 *  exists — used by the startup cleanup to remove it after migration. */
export function legacyOAuthFilesExist(): boolean {
  const p = legacyFilePath();
  return existsSync(p) || existsSync(`${p}.premigrated`) || existsSync(`${p}.bak`);
}
