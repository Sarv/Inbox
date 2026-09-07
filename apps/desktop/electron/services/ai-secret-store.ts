/**
 * Secure AI-provider secret vault (main process).
 *
 * Third-party LLM API keys (OpenAI, Gemini, custom) used to be persisted in
 * plaintext in the renderer's localStorage (`sarvinbox-ai-settings`), readable by
 * anyone with disk access. This store keeps the keys in the MAIN process only,
 * encrypted with Electron `safeStorage` (OS-keychain backed), keyed by provider
 * id. The renderer keeps only non-secret provider metadata (name, model, baseUrl)
 * and rehydrates the key into memory at startup.
 *
 * Storage moved from a standalone `ai-secrets.json` file INTO the core DB
 * (`core_blobs` row, key `ai-secrets`) — same safeStorage envelope, only the
 * container changed, so the whole vault is double-protected (safeStorage +
 * SQLCipher). The legacy file is migrated on first read (write-to-DB FIRST) and
 * removed later by the startup cleanup.
 *
 * Envelope: `ENC1:<safeStorage ciphertext of {"<providerId>":"<apiKey>",…}>`, or
 * a clearly-marked `PLAIN1:` fallback when no OS keychain exists.
 */
import { app, safeStorage } from 'electron';
import { promises as fs, renameSync } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';

import { getBlob, setBlob } from './core-db';
import { createWriteQueue } from './write-queue';

const logger = createLogger('ai-secret-store');

const LEGACY_FILE_NAME = 'ai-secrets.json';
const BLOB_KEY = 'ai-secrets';
const MAGIC_ENC = 'ENC1:';
const MAGIC_PLAIN = 'PLAIN1:';

type Vault = Record<string, string>;

function legacyPath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

/** True when the OS keychain is usable (else keys fall back to marked plaintext). */
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function serialize(vault: Vault): Buffer {
  const payload = JSON.stringify(vault);
  if (safeStorage.isEncryptionAvailable()) {
    return Buffer.concat([Buffer.from(MAGIC_ENC, 'utf8'), safeStorage.encryptString(payload)]);
  }
  return Buffer.from(MAGIC_PLAIN + payload, 'utf8');
}

function deserialize(buf: Buffer): Vault {
  const enc = buf.subarray(0, MAGIC_ENC.length).toString('utf8');
  if (enc === MAGIC_ENC) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('AI secrets are encrypted but safeStorage is unavailable');
    }
    return JSON.parse(safeStorage.decryptString(buf.subarray(MAGIC_ENC.length)));
  }
  const plain = buf.subarray(0, MAGIC_PLAIN.length).toString('utf8');
  if (plain === MAGIC_PLAIN) {
    return JSON.parse(buf.subarray(MAGIC_PLAIN.length).toString('utf8'));
  }
  throw new Error('Unknown ai-secrets format');
}

async function readVault(): Promise<Vault> {
  const blob = getBlob(BLOB_KEY);
  if (blob) {
    try { return deserialize(blob) || {}; }
    catch (e) { logger.error('[AiSecrets] blob decode failed:', e); return {}; }
  }
  // No blob yet → migrate a legacy file if present. Seed the blob FIRST, then
  // rename the file aside for the startup cleanup.
  try {
    const buf = await fs.readFile(legacyPath());
    const vault = deserialize(buf) || {};
    setBlob(BLOB_KEY, buf);
    try { renameSync(legacyPath(), `${legacyPath()}.premigrated`); } catch { /* keep original */ }
    logger.info('[AiSecrets] migrated ai-secrets.json into the core DB');
    return vault;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') logger.error('[AiSecrets] read failed:', err);
    return {};
  }
}

const writeQueue = createWriteQueue();

async function writeVault(mutate: (vault: Vault) => void): Promise<void> {
  return writeQueue.enqueue(async () => {
    const vault = await readVault();
    mutate(vault);
    setBlob(BLOB_KEY, serialize(vault));
  });
}

/** All stored provider keys, keyed by provider id. */
export async function getAllAiSecrets(): Promise<Vault> {
  return readVault();
}

/** Store (or replace) a provider's API key. Empty key deletes the entry. */
export async function setAiSecret(providerId: string, apiKey: string): Promise<void> {
  if (!providerId) return;
  await writeVault((v) => {
    if (apiKey) v[providerId] = apiKey;
    else delete v[providerId];
  });
}

/** Forget a provider's key (on provider removal). */
export async function deleteAiSecret(providerId: string): Promise<void> {
  if (!providerId) return;
  await writeVault((v) => { delete v[providerId]; });
}
