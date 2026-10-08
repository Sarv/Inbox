/**
 * Last-good IMAP account store. The renderer keeps the active IMAP config
 * in localStorage, but that can be lost (cleared cache, a stale wipe, a
 * corrupted profile) — which used to force a full re-login. This persists
 * the last successfully-connected config in the main process (password
 * encrypted via Electron safeStorage, OS-keychain backed) so startup can
 * recover the session without the user signing in again.
 *
 * Storage moved from a standalone `imap-account.json` file INTO the core DB
 * (`core_blobs` row, key `imap-account`) — same safeStorage envelope, only the
 * container changed. The legacy file is migrated on first read and renamed
 * `.premigrated` (removed later by the startup cleanup).
 */
import { existsSync, renameSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';
import { app } from 'electron';

import { getBlob, setBlob, deleteBlob } from './core-db';
import { sealJson, openJson, type EnvelopeErrors } from './safe-storage-envelope';
import { createWriteQueue } from './write-queue';
const logger = createLogger('imap-account-store');

const LEGACY_FILE_NAME = 'imap-account.json';
const BLOB_KEY = 'imap-account';

function legacyFilePath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

function serialize(config: unknown): Buffer {
  return sealJson(config);
}

/** This store's wording for an envelope it can't open (tests pin these). */
const ENVELOPE_ERRORS: EnvelopeErrors = {
  locked: 'IMAP account is encrypted but safeStorage is unavailable',
  unknownFormat: 'Unknown imap-account file format',
};

function deserialize(buf: Buffer): any {
  return openJson<any>(buf, ENVELOPE_ERRORS);
}

// Serialize writes so overlapping connects can't interleave.
const writeQueue = createWriteQueue();

/** Persist the last successfully-connected IMAP config. No-op if incomplete. */
export async function saveImapAccount(config: any): Promise<void> {
  if (!config || !config.host || !config.username) return;
  const buf = serialize(config);
  return writeQueue.enqueue(async () => {
    setBlob(BLOB_KEY, buf);
  });
}

/** Load the last-good IMAP config, or null if none / unreadable. */
export async function loadImapAccount(): Promise<any | null> {
  const blob = getBlob(BLOB_KEY);
  if (blob) {
    try { return deserialize(blob); }
    catch (e) { logger.error('[ImapAccountStore] blob decode failed:', e); return null; }
  }
  // No blob yet → migrate a legacy file if present (best-effort).
  const path = legacyFilePath();
  try {
    const buf = await fs.readFile(path);
    const config = deserialize(buf);
    setBlob(BLOB_KEY, buf);
    try { renameSync(path, `${path}.premigrated`); } catch { /* keep original */ }
    logger.info('[ImapAccountStore] migrated imap-account.json into core DB');
    return config;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') logger.error('[ImapAccountStore] load failed:', err);
    return null; // best-effort recovery; renderer falls back to the sign-in dialog
  }
}

/** Forget the saved account (explicit disconnect / definitive auth rejection). */
export async function clearImapAccount(): Promise<void> {
  deleteBlob(BLOB_KEY);
  try { await fs.unlink(legacyFilePath()); } catch { /* nothing to clear */ }
}

/** True if the legacy imap-account.json (or its rename) still exists — used by
 *  the startup cleanup to remove it after migration. */
export function legacyImapFilesExist(): boolean {
  const p = legacyFilePath();
  return existsSync(p) || existsSync(`${p}.premigrated`);
}
