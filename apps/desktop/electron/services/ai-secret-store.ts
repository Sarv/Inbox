/**
 * Secure AI-provider secret vault (main process).
 *
 * Third-party LLM API keys (OpenAI, Gemini, custom) used to be persisted in
 * plaintext in the renderer's localStorage (`sarvinbox-ai-settings`), readable by
 * anyone with disk access. This store keeps the keys in the MAIN process only,
 * encrypted with Electron `safeStorage` (OS-keychain backed), keyed by provider
 * id. The renderer keeps only non-secret provider metadata (name, model, baseUrl)
 * and never reads a key back: main attaches it to requests itself, and only
 * to the endpoint origin it was saved for (see `resolveAiKey`).
 *
 * Storage moved from a standalone `ai-secrets.json` file INTO the core DB
 * (`core_blobs` row, key `ai-secrets`) — same safeStorage envelope, only the
 * container changed, so the whole vault is double-protected (safeStorage +
 * SQLCipher). The legacy file is migrated on first read (write-to-DB FIRST) and
 * removed later by the startup cleanup.
 *
 * Envelope: `ENC1:<safeStorage ciphertext of {"<providerId>":{"key","origin"},…}>`,
 * or a clearly-marked `PLAIN1:` fallback when no OS keychain exists. Entries
 * written before origin binding are a bare key string; they are bound to the
 * first origin they're used with.
 */
import { promises as fs, renameSync } from 'fs';
import { join } from 'path';

import { aiEndpointOrigin, createLogger } from '@sarvinbox/core';
import { app, safeStorage } from 'electron';

import { getBlob, setBlob } from './core-db';
import { isEncryptedEnvelope, sealJson, openJson, type EnvelopeErrors } from './safe-storage-envelope';
import { createWriteQueue } from './write-queue';

const logger = createLogger('ai-secret-store');

const LEGACY_FILE_NAME = 'ai-secrets.json';
const BLOB_KEY = 'ai-secrets';

/** A key, and the endpoint origin it may be sent to. A bare string is a
 *  pre-binding entry (bound on first use). */
type VaultEntry = string | { key: string; origin?: string };
type Vault = Record<string, VaultEntry>;

const keyOf = (entry: VaultEntry | undefined): string => (typeof entry === 'string' ? entry : entry?.key ?? '');
const originOf = (entry: VaultEntry | undefined): string | undefined => (typeof entry === 'string' ? undefined : entry?.origin);

function legacyPath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

/** True when the OS keychain is usable (else keys fall back to marked plaintext). */
export function isSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function serialize(vault: Vault): Buffer {
  return sealJson(vault);
}

/** This store's wording for an envelope it can't open (tests pin these). */
const ENVELOPE_ERRORS: EnvelopeErrors = {
  locked: 'AI secrets are encrypted but safeStorage is unavailable',
  unknownFormat: 'Unknown ai-secrets format',
};

function deserialize(buf: Buffer): Vault {
  return openJson<Vault>(buf, ENVELOPE_ERRORS);
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

/**
 * A present blob that can't be decrypted RIGHT NOW (keychain locked, or not
 * yet available at startup) holds keys that are still fine. Reads degrade to
 * empty, but a write must not: it would persist that empty read over every
 * saved key, turning a transient condition into permanent loss. A blob in an
 * unknown format is corrupt for good and may be overwritten.
 */
function assertWritable(): void {
  const blob = getBlob(BLOB_KEY);
  if (!blob || !isEncryptedEnvelope(blob)) return;
  try {
    deserialize(blob);
  } catch (error) {
    throw new Error(`AI keys are encrypted but cannot be read right now; not overwriting them (${(error as Error).message})`);
  }
}

async function writeVault(mutate: (vault: Vault) => void): Promise<void> {
  return writeQueue.enqueue(async () => {
    assertWritable();
    const vault = await readVault();
    mutate(vault);
    setBlob(BLOB_KEY, serialize(vault));
  });
}

/** All stored provider keys, keyed by provider id. */
/**
 * The entry each provider had before its LAST set/delete, tagged with that
 * write's id — so a renderer edit that fails or is cancelled can undo its own
 * write (revertAiSecret) without the renderer ever holding the old key.
 * Process memory only; `previous: null` = there was no key.
 */
const lastWrites = new Map<string, { writeId: number; previous: VaultEntry | null }>();
let writeSeq = 0;

/** Every stored key by provider id. MAIN-PROCESS ONLY — never sent over IPC. */
export async function getAllAiSecrets(): Promise<Record<string, string>> {
  const vault = await readVault();
  return Object.fromEntries(Object.entries(vault).map(([id, entry]) => [id, keyOf(entry)]).filter(([, key]) => key));
}

/** The provider ids that have a key saved — all the renderer may learn. */
export async function listAiSecretIds(): Promise<string[]> {
  return Object.keys(await getAllAiSecrets());
}

/**
 * Save (or replace) a provider's key, bound to the origin of `baseUrl` — the
 * endpoint the user configured it for. An empty key deletes the entry.
 */
export async function setAiSecret(providerId: string, apiKey: string, baseUrl?: string): Promise<number | undefined> {
  if (!providerId) return undefined;
  const origin = aiEndpointOrigin(baseUrl) ?? undefined;
  let writeId: number | undefined;
  await writeVault((v) => {
    writeId = ++writeSeq;
    lastWrites.set(providerId, { writeId, previous: v[providerId] ?? null });
    if (apiKey) v[providerId] = { key: apiKey, ...(origin ? { origin } : {}) };
    else delete v[providerId];
  });
  return writeId;
}

/**
 * Undo write `writeId` to a provider's key (an edit that failed or was
 * cancelled after its key was written) — but ONLY if it is still the latest
 * write for that provider. If another write landed since (a newer edit), the
 * newer key is the right one to keep, so this is a no-op.
 */
export async function revertAiSecret(providerId: string, writeId: number): Promise<void> {
  if (!providerId) return;
  await writeVault((v) => {
    const last = lastWrites.get(providerId);
    if (!last || last.writeId !== writeId) return;
    if (last.previous) v[providerId] = last.previous;
    else delete v[providerId];
    lastWrites.delete(providerId);
  });
}

export type AiKeyResult =
  | { status: 'found'; key: string }
  /** A key is saved, but for a different endpoint than the one asked for. */
  | { status: 'origin-mismatch'; boundOrigin: string }
  | { status: 'none' };

/**
 * The saved key for `providerId`, but only if `url` is on the origin it was
 * saved for. The URL (like the provider id) comes from the renderer, which
 * also renders untrusted email HTML — without this check, it could have main
 * attach the user's OpenAI key to a request to a server of its own. An
 * unbound (pre-binding) key is bound to `url`'s origin on first use.
 */
export async function resolveAiKey(providerId: string, url: string | undefined): Promise<AiKeyResult> {
  const origin = aiEndpointOrigin(url);
  if (!providerId || !origin) return { status: 'none' };
  // Through the write queue, so a key saved just before this request (the
  // renderer saves, then immediately pushes a config naming it) is seen.
  let vault: Vault = {};
  await writeQueue.enqueue(async () => { vault = await readVault(); });
  const entry = vault[providerId];
  const key = keyOf(entry);
  if (!key) return { status: 'none' };
  const bound = originOf(entry);
  if (bound) {
    if (bound === origin) return { status: 'found', key };
    logger.warn(`[AiSecrets] refused the saved key for ${providerId} at ${origin} — it was saved for ${bound}`);
    return { status: 'origin-mismatch', boundOrigin: bound };
  }
  await writeVault((v) => {
    const current = v[providerId];
    if (keyOf(current) === key && !originOf(current)) v[providerId] = { key, origin };
  });
  logger.info(`[AiSecrets] bound the saved key for ${providerId} to ${origin} (first use)`);
  return { status: 'found', key };
}

/** Forget a provider's key (on provider removal). */
export async function deleteAiSecret(providerId: string): Promise<number | undefined> {
  if (!providerId) return undefined;
  let writeId: number | undefined;
  await writeVault((v) => {
    writeId = ++writeSeq;
    lastWrites.set(providerId, { writeId, previous: v[providerId] ?? null });
    delete v[providerId];
  });
  return writeId;
}
