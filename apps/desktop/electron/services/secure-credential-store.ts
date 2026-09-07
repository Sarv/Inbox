/**
 * Secure per-account credential vault (main process).
 *
 * The renderer must NEVER persist IMAP/SMTP passwords or OAuth tokens — those
 * used to live in plaintext in localStorage. This store keeps them in the MAIN
 * process only, encrypted with Electron `safeStorage` (OS-keychain backed),
 * keyed by account id. The renderer keeps non-secret metadata and asks main to
 * inject the secret at connect time.
 *
 * Storage moved from a standalone `secure-credentials.json` file INTO the core
 * DB (`core_blobs` row, key `secure-credentials`). The stored bytes are the SAME
 * safeStorage ENC1:/PLAIN1: envelope that used to be written to the file — the
 * encryption model is unchanged; only the container moved. On first run the
 * legacy file is migrated into the DB and renamed `.premigrated` (kept as a
 * recovery fallback until the startup cleanup removes it).
 */
import { app, safeStorage } from 'electron';
import { existsSync, renameSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

import { createWriteQueue } from './write-queue';
import { getBlob, setBlob } from './core-db';
import { createLogger } from '@sarvinbox/core';
const logger = createLogger('secure-credential-store');

const LEGACY_FILE_NAME = 'secure-credentials.json';
const BLOB_KEY = 'secure-credentials';
const MAGIC_ENC = 'ENC1:';
const MAGIC_PLAIN = 'PLAIN1:';

/** The secret fields we pull out of a config so they never touch renderer disk. */
export interface AccountSecrets {
  imap?: { password?: string; accessToken?: string; refreshToken?: string };
  smtp?: { password?: string; accessToken?: string; refreshToken?: string };
}

type Vault = Record<string, AccountSecrets>;

function legacyFilePath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

/** True when the OS keychain is usable — callers can refuse to store plaintext. */
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function serialize(vault: Vault): Buffer {
  const payload = JSON.stringify(vault);
  if (safeStorage.isEncryptionAvailable()) {
    return Buffer.concat([Buffer.from(MAGIC_ENC, 'utf8'), safeStorage.encryptString(payload)]);
  }
  // No keychain (e.g. Linux without a Secret Service): fall back to a clearly
  // MARKED plaintext blob rather than silently dropping creds. The caller is
  // warned via isSecureStorageAvailable() so it can surface this to the user.
  return Buffer.from(MAGIC_PLAIN + payload, 'utf8');
}

function deserialize(buf: Buffer): Vault {
  const enc = buf.subarray(0, MAGIC_ENC.length).toString('utf8');
  if (enc === MAGIC_ENC) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Credentials are encrypted but safeStorage is unavailable');
    }
    return JSON.parse(safeStorage.decryptString(buf.subarray(MAGIC_ENC.length)));
  }
  const plain = buf.subarray(0, MAGIC_PLAIN.length).toString('utf8');
  if (plain === MAGIC_PLAIN) {
    return JSON.parse(buf.subarray(MAGIC_PLAIN.length).toString('utf8'));
  }
  throw new Error('Unknown secure-credentials blob format');
}

/** One-time migration of the legacy secure-credentials.json into the core DB. */
async function migrateLegacyFile(): Promise<Vault | null> {
  const path = legacyFilePath();
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const vault = deserialize(buf); // may throw — do NOT swallow (never clobber)
  setBlob(BLOB_KEY, buf);
  try { renameSync(path, `${path}.premigrated`); } catch { /* keep original if rename fails */ }
  logger.info('[SecureCreds] migrated secure-credentials.json into core DB');
  return vault;
}

async function readVault(): Promise<Vault> {
  const blob = getBlob(BLOB_KEY);
  if (blob) {
    // A present-but-undecryptable vault must NOT read as empty (that would let a
    // later write clobber every other account's secret) — deserialize throws.
    return deserialize(blob) || {};
  }
  const migrated = await migrateLegacyFile();
  if (migrated) return migrated;
  // Re-check: a concurrent call may have migrated + renamed the file between our
  // getBlob and here — don't conclude "empty vault" (which a later write would
  // then persist, clobbering the real secrets).
  const blob2 = getBlob(BLOB_KEY);
  return blob2 ? (deserialize(blob2) || {}) : {};
}

// Serialize writes so two concurrent set/delete calls can't clobber each other
// (read-modify-write on the whole vault).
const writeQueue = createWriteQueue();

async function writeVault(mutate: (vault: Vault) => void): Promise<void> {
  return writeQueue.enqueue(async () => {
    const vault = await readVault();
    mutate(vault);
    setBlob(BLOB_KEY, serialize(vault));
  });
}

/** Store the secrets for one account, MERGING per kind. Each account holds up to
 *  two independent credentials — `imap` and `smtp` — so writing one (e.g. on an
 *  SMTP connect) must NEVER wipe the other (the IMAP mailbox password). Empty/
 *  undefined fields are dropped so we never persist blank strings, and a kind
 *  that's absent from THIS call is left untouched (that's how "leave blank to
 *  keep current" preserves the stored password). No-op if there's nothing new. */
export async function setAccountSecrets(accountId: string, secrets: AccountSecrets): Promise<void> {
  if (!accountId) return;
  const pick = (o?: Record<string, string | undefined>) => {
    if (!o) return undefined;
    const out: Record<string, string> = {};
    for (const k of ['password', 'accessToken', 'refreshToken'] as const) {
      if (o[k]) out[k] = o[k] as string;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const imap = pick(secrets.imap);
  const smtp = pick(secrets.smtp);
  if (!imap && !smtp) return;
  await writeVault((v) => {
    const existing = v[accountId] ?? {};
    // Only overwrite the kind(s) actually supplied; keep the other kind intact.
    v[accountId] = {
      ...existing,
      ...(imap ? { imap } : {}),
      ...(smtp ? { smtp } : {}),
    };
  });
}

/** Get the stored secrets for one account, or null if none. */
export async function getAccountSecrets(accountId: string): Promise<AccountSecrets | null> {
  if (!accountId) return null;
  const vault = await readVault();
  return vault[accountId] ?? null;
}

/**
 * Move an account's vaulted secrets from `oldId` to `newId` (account-id
 * canonicalization). No-op if there's nothing under `oldId`. If `newId` already
 * has secrets they win (the old entry is just dropped) — the canonical id is
 * authoritative. Idempotent.
 */
export async function rekeyAccountSecrets(oldId: string, newId: string): Promise<void> {
  if (!oldId || !newId || oldId === newId) return;
  await writeVault((v) => {
    const old = v[oldId];
    if (!old) return;
    if (!v[newId]) v[newId] = old;
    delete v[oldId];
  });
}

/** Forget one account's secrets (on account removal). */
export async function deleteAccountSecrets(accountId: string): Promise<void> {
  if (!accountId) return;
  await writeVault((v) => { delete v[accountId]; });
}

/** True if we have any secret on file for this account (renderer can skip a
 *  re-login prompt when secrets already live in the vault). */
export async function hasAccountSecrets(accountId: string): Promise<boolean> {
  return (await getAccountSecrets(accountId)) !== null;
}

/** True if the legacy secure-credentials.json (or its rename) still exists —
 *  used by the startup cleanup to remove it after migration. */
export function legacySecureCredFilesExist(): boolean {
  const p = legacyFilePath();
  return existsSync(p) || existsSync(`${p}.premigrated`) || existsSync(`${p}.bak`);
}

/**
 * Force the one-time file→DB migration for the vault. Unlike the OAuth/IMAP
 * stores (migrated during the startup registry seed), the vault is only read on
 * connect/reveal — so nothing triggers its migration at startup. Call this
 * before the legacy-file cleanup so the vault lands in the core DB and its old
 * file can be safely removed. Best-effort; on a keychain-locked read it throws
 * inside readVault and is caught by the caller (file is then left in place).
 */
export async function migrateSecureCredsFromFile(): Promise<void> {
  await readVault();
}
