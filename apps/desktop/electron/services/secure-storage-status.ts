/**
 * Report saved protection separately from the ability to encrypt RIGHT NOW.
 * Only envelope markers and database readability are inspected. The database
 * opens through its normal key-recovery path, but credential values are never
 * read, logged or sent to the renderer by this service.
 */
import { closeSync, existsSync, openSync, readSync } from 'fs';
import { join } from 'path';

import type { Database } from 'better-sqlite3';
import { app, safeStorage } from 'electron';

import type { SecureStorageEnvelope, SecureStorageStatus, SecureStorageStoreStatus } from '../../src/types/secure-storage';

import { CORE_DB_FILE, getCoreDb } from './core-db';
import { isOsBackedEncryption, storedEncryptionProtection } from './os-encryption';

interface InspectedEnvelope {
  envelope: SecureStorageEnvelope;
  version: string;
}

const STORES = [
  { id: 'credentials', label: 'Saved passwords', blob: 'secure-credentials', legacy: 'secure-credentials.json' },
  { id: 'oauth-tokens', label: 'Sign-in tokens', blob: 'oauth-accounts', legacy: 'oauth-accounts.json' },
  { id: 'ai-keys', label: 'AI keys', blob: 'ai-secrets', legacy: 'ai-secrets.json' },
  { id: 'imap-account', label: 'Saved mailbox sign-in', blob: 'imap-account', legacy: 'imap-account.json' },
  { id: 'pipeline-ai-config', label: 'Saved AI configuration', blob: 'pipeline-ai-config', legacy: 'pipeline-ai-config.json' },
] as const;

function platform(): SecureStorageStatus['platform'] {
  return process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
    ? process.platform : 'other';
}

function keyStore(): SecureStorageStatus['keyStore'] {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return 'basic-text';
    return isOsBackedEncryption() ? 'available' : 'unavailable';
  } catch { return 'unavailable'; }
}

function fileEnvelope(path: string): InspectedEnvelope {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(8);
    const length = readSync(fd, header, 0, header.length, 0);
    if (header.subarray(0, 5).toString('ascii') === 'ENC1:') return { envelope: 'encrypted', version: header.subarray(5, 8).toString('ascii') };
    if (length >= 7 && header.subarray(0, 7).toString('ascii') === 'PLAIN1:') return { envelope: 'plaintext', version: '' };
    return { envelope: 'unknown', version: '' };
  } catch (error) {
    return { envelope: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown', version: '' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function storeStatus(
  id: string,
  label: string,
  inspection: InspectedEnvelope,
  protectedByDatabase: boolean,
): SecureStorageStoreStatus {
  const { envelope, version } = inspection;
  return {
    id, label, envelope, protectedByDatabase,
    protection: envelope === 'missing' ? 'missing'
      : protectedByDatabase ? 'encrypted'
        : envelope === 'plaintext' ? 'unprotected'
          : envelope === 'encrypted' ? storedEncryptionProtection(version) : 'unknown',
  };
}

function keyProtection(inspection: InspectedEnvelope): SecureStorageStoreStatus['protection'] {
  return storeStatus('', '', inspection, false).protection;
}

/** SQL returns just a marker category, never the stored bytes. Column names are internal constants. */
function envelopeCase(column: 'data' | 'secret'): string {
  return `CASE
    WHEN hex(substr(${column}, 1, 5)) = '454E43313A' THEN 'encrypted'
    WHEN hex(substr(${column}, 1, 7)) = '504C41494E313A' THEN 'plaintext'
    WHEN hex(substr(${column}, 1, 6)) = '4C4F434B313A' THEN 'encrypted'
    ELSE 'unknown' END`;
}

function blobEnvelope(db: Database, key: string): InspectedEnvelope {
  try {
    const row = db.prepare(`SELECT ${envelopeCase('data')} AS envelope,
      CASE hex(substr(data, 6, 3)) WHEN '763130' THEN 'v10' WHEN '763131' THEN 'v11' ELSE '' END AS version
      FROM core_blobs WHERE key = ?`).get(key) as InspectedEnvelope | undefined;
    return row ?? { envelope: 'missing', version: '' };
  } catch { return { envelope: 'unknown', version: '' }; }
}

function pgpStatus(db: Database | null, protectedByDatabase: boolean): SecureStorageStoreStatus {
  const unknown = () => storeStatus('pgp-keys', 'OpenPGP private keys', { envelope: 'unknown', version: '' }, protectedByDatabase);
  if (!db) return unknown();
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pgp_own_keys'").get();
    if (!table) return storeStatus('pgp-keys', 'OpenPGP private keys', { envelope: 'missing', version: '' }, false);
    const rows = db.prepare(`SELECT ${envelopeCase('secret')} AS envelope,
      CASE hex(substr(secret, 6, 3)) WHEN '763130' THEN 'v10' WHEN '763131' THEN 'v11' ELSE '' END AS version,
      CASE WHEN hex(substr(secret, 1, 6)) = '4C4F434B313A' THEN 1 ELSE 0 END AS passphrase
      FROM pgp_own_keys`).all() as Array<InspectedEnvelope & { passphrase: number }>;
    if (!rows.length) return storeStatus('pgp-keys', 'OpenPGP private keys', { envelope: 'missing', version: '' }, false);
    const envelope = rows.some(row => row.envelope === 'plaintext') ? 'plaintext'
      : rows.some(row => row.envelope === 'unknown') ? 'unknown' : 'encrypted';
    const result = storeStatus('pgp-keys', 'OpenPGP private keys', { envelope, version: '' }, protectedByDatabase);
    const protections = rows.map(row => row.passphrase === 1 ? 'encrypted'
      : storeStatus('', '', row, protectedByDatabase).protection);
    result.protection = protections.includes('unprotected') ? 'unprotected'
      : protections.includes('unknown') ? 'unknown' : 'encrypted';
    return result;
  } catch { return unknown(); }
}

function scannerStatus(db: Database | null, protectedByDatabase: boolean): SecureStorageStoreStatus {
  const unknown = () => storeStatus('scanner-credentials', 'Scanner credentials', { envelope: 'unknown', version: '' }, protectedByDatabase);
  if (!db) return unknown();
  try {
    const rows = db.prepare(`SELECT ${envelopeCase('data')} AS envelope,
      CASE hex(substr(data, 6, 3)) WHEN '763130' THEN 'v10' WHEN '763131' THEN 'v11' ELSE '' END AS version
      FROM core_blobs WHERE key LIKE 'antivirus-config:%'`).all() as InspectedEnvelope[];
    if (!rows.length) return storeStatus('scanner-credentials', 'Scanner credentials', { envelope: 'missing', version: '' }, false);
    const envelope = rows.some(row => row.envelope === 'plaintext') ? 'plaintext'
      : rows.some(row => row.envelope === 'unknown') ? 'unknown' : 'encrypted';
    const result = storeStatus('scanner-credentials', 'Scanner credentials', { envelope, version: '' }, protectedByDatabase);
    const protections = rows.map(row => storeStatus('', '', row, protectedByDatabase).protection);
    result.protection = protections.includes('unprotected') ? 'unprotected'
      : protections.includes('unknown') ? 'unknown' : 'encrypted';
    return result;
  } catch { return unknown(); }
}

export function getSecureStorageStatus(): SecureStorageStatus {
  const directory = app.getPath('userData');
  let keyInspection = fileEnvelope(join(directory, 'db-key.bin'));
  const status: SecureStorageStatus = {
    platform: platform(), keyStore: keyStore(),
    databaseKey: keyInspection.envelope,
    databaseKeyProtection: keyProtection(keyInspection),
    databaseReadable: null, stores: [],
  };
  let protectedByDatabase = false;
  let db: Database | null = null;
  const databaseExists = existsSync(join(directory, CORE_DB_FILE));
  if (databaseExists && (status.databaseKey === 'encrypted' || status.databaseKey === 'plaintext')) {
    try {
      db = getCoreDb();
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      status.databaseReadable = true;
      // Opening an existing profile may safely rewrap a legacy plaintext key.
      keyInspection = fileEnvelope(join(directory, 'db-key.bin'));
      status.databaseKey = keyInspection.envelope;
      status.databaseKeyProtection = keyProtection(keyInspection);
      protectedByDatabase = status.databaseKeyProtection === 'encrypted';
    } catch {
      db = null;
      status.databaseReadable = false;
    }
  }
  for (const store of STORES) {
    status.stores.push(storeStatus(store.id, store.label,
      db ? blobEnvelope(db, store.blob) : { envelope: databaseExists ? 'unknown' : 'missing', version: '' }, protectedByDatabase));
    // A plaintext legacy copy outside SQLCipher remains exposed after its
    // migrated database copy is protected. Include existing recovery copies.
    for (const [index, suffix] of ['', '.premigrated', '.bak'].entries()) {
      const inspection = fileEnvelope(join(directory, store.legacy + suffix));
      if (inspection.envelope !== 'missing') status.stores.push(storeStatus(
        `${store.id}-legacy-${index}`, `${store.label} (legacy copy)`, inspection, false,
      ));
    }
  }
  status.stores.push(db || databaseExists ? pgpStatus(db, protectedByDatabase)
    : storeStatus('pgp-keys', 'OpenPGP private keys', { envelope: 'missing', version: '' }, false));
  status.stores.push(db || databaseExists ? scannerStatus(db, protectedByDatabase)
    : storeStatus('scanner-credentials', 'Scanner credentials', { envelope: 'missing', version: '' }, false));
  return status;
}
