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
import { existsSync, renameSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';
import { app } from 'electron';

import { getBlob, setBlob } from './core-db';
import { isOsBackedEncryption } from './os-encryption';
import { sealJson, openJson, type EnvelopeErrors } from './safe-storage-envelope';
import { createWriteQueue } from './write-queue';
const logger = createLogger('secure-credential-store');

const LEGACY_FILE_NAME = 'secure-credentials.json';
const BLOB_KEY = 'secure-credentials';

/** The secret fields we pull out of a config so they never touch renderer disk. */
/**
 * One credential kind. `host` is the server the secret was saved FOR: main only
 * ever sends the secret to that host (see vault-credentials.ts). Entries written
 * before host binding have none and are bound on first use.
 */
export interface VaultCredential { password?: string; accessToken?: string; refreshToken?: string; host?: string }

export interface AccountSecrets {
  imap?: VaultCredential;
  smtp?: VaultCredential;
}

type Vault = Record<string, AccountSecrets>;

function legacyFilePath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

/** True only when the OS key store protects the vault (not Linux `basic_text`). */
export function isSecureStorageAvailable(): boolean {
  return isOsBackedEncryption();
}

function serialize(vault: Vault): Buffer {
  return sealJson(vault);
}

/** This store's wording for an envelope it can't open (tests pin these). */
const ENVELOPE_ERRORS: EnvelopeErrors = {
  locked: 'Credentials are encrypted but safeStorage is unavailable',
  unknownFormat: 'Unknown secure-credentials blob format',
};

function deserialize(buf: Buffer): Vault {
  return openJson<Vault>(buf, ENVELOPE_ERRORS);
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
  const pick = (o?: VaultCredential) => {
    if (!o) return undefined;
    const out: Record<string, string> = {};
    for (const k of ['password', 'accessToken', 'refreshToken'] as const) {
      if (o[k]) out[k] = o[k] as string;
    }
    if (!Object.keys(out).length) return undefined;
    // The host travels WITH a secret, never alone: a call carrying only a host
    // must not be able to re-point an existing password at another server.
    if (typeof o.host === 'string' && o.host.trim()) out.host = o.host.trim();
    return out;
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
 * Record the host an UNBOUND (pre-binding) credential belongs to. Never
 * overwrites an existing binding — re-pointing a bound secret takes a new
 * secret via `setAccountSecrets`.
 */
export async function bindAccountSecretHost(accountId: string, kind: 'imap' | 'smtp', host: string): Promise<void> {
  if (!accountId || !host) return;
  await writeVault((v) => {
    const entry = v[accountId]?.[kind];
    if (!entry || entry.host) return;
    entry.host = host;
  });
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
