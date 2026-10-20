/**
 * Persisted active-pipeline AI provider config (main process).
 *
 * The background pipeline keeps its AI provider config (`aiConfig`) only in
 * memory, set by the renderer's `pipeline:setAIConfig` push. A main-process
 * restart wipes it, and if the renderer doesn't happen to re-push, the pipeline
 * comes up `hasAI=false` and silently skips ALL categorization / extraction /
 * enrichment — the root cause of "AI is off after a restart".
 *
 * This store mirrors that config to disk so init can reload it and come up
 * AI-ready on its own. It holds only the SERIALIZABLE fields the renderer sends
 * (the non-serializable `resolveBearer` / `fetchImpl` closures are re-attached at
 * load time). For OAuth (Sarv) providers `apiKey` is empty — the token is resolved
 * per request — so the only sensitive field is a third-party API key.
 *
 * Storage moved from a standalone `pipeline-ai-config.json` file INTO the core DB
 * (`core_blobs` row, key `pipeline-ai-config`) — same safeStorage envelope, only
 * the container changed. The legacy file is migrated on first read (write-to-DB
 * FIRST) and removed later by the startup cleanup.
 *
 * Envelope: `ENC1:<safeStorage ciphertext of {type,apiKey,model,baseUrl,…}>`, or
 * a clearly-marked `PLAIN1:` fallback when no OS keychain exists.
 */
import { readFileSync, renameSync, promises as fs } from 'fs';
import { join } from 'path';

import type { AIProviderConfig } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';
import { app } from 'electron';

import { getBlob, setBlob, deleteBlob } from './core-db';
import { sealJson, openJson, type EnvelopeErrors } from './safe-storage-envelope';
import { createWriteQueue } from './write-queue';

const logger = createLogger('pipeline-ai-config-store');

const LEGACY_FILE_NAME = 'pipeline-ai-config.json';
const BLOB_KEY = 'pipeline-ai-config';

/** The subset of AIProviderConfig that is serializable and worth persisting. */
export interface PersistedPipelineAIConfig {
  type: AIProviderConfig['type'];
  apiKey: string;
  model: string;
  baseUrl?: string;
  authMethod?: 'apiKey' | 'oauth';
  oauthProvider?: string;
  oauthEmail?: string;
  /** Names the saved API key (filled in from the vault on restore). */
  providerId?: string;
}

function legacyPath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

/** Keep only the serializable fields — never persist resolveBearer / fetchImpl. */
function pick(config: AIProviderConfig): PersistedPipelineAIConfig | null {
  if (!config?.type) return null;
  const c = config as AIProviderConfig & {
    authMethod?: 'apiKey' | 'oauth';
    oauthProvider?: string;
    oauthEmail?: string;
    providerId?: string;
  };
  return {
    type: c.type,
    // Keys live in the AI key vault, bound to their endpoint; the persisted
    // config only names them. (A key from an older build is kept until the
    // renderer next pushes a config.)
    apiKey: c.providerId ? '' : c.apiKey || '',
    providerId: c.providerId,
    model: c.model,
    baseUrl: c.baseUrl,
    authMethod: c.authMethod,
    oauthProvider: c.oauthProvider,
    oauthEmail: c.oauthEmail,
  };
}

function serialize(config: PersistedPipelineAIConfig): Buffer {
  return sealJson(config);
}

/** This store's wording for an envelope it can't open (tests pin these). */
const ENVELOPE_ERRORS: EnvelopeErrors = {
  locked: 'Pipeline AI config is encrypted but safeStorage is unavailable',
  unknownFormat: 'Unknown pipeline-ai-config format',
};

function deserialize(buf: Buffer): PersistedPipelineAIConfig {
  return openJson<PersistedPipelineAIConfig>(buf, ENVELOPE_ERRORS);
}

const writeQueue = createWriteQueue();

/**
 * Persist the active provider config. Called on every renderer
 * `pipeline:setAIConfig` push so the on-disk copy tracks the live one. Never
 * throws — a persistence failure must not break the live config update.
 */
export async function savePipelineAIConfig(config: AIProviderConfig): Promise<void> {
  const clean = pick(config);
  if (!clean) return;
  const buf = serialize(clean);
  return writeQueue.enqueue(async () => {
    try {
      setBlob(BLOB_KEY, buf);
      logger.info(`[PipelineAIConfig] persisted (${clean.type}/${clean.model})`);
    } catch (err) {
      logger.error('[PipelineAIConfig] persist failed:', err);
    }
  });
}

/**
 * Load the persisted config SYNCHRONOUSLY — read once at pipeline init before the
 * renderer has had a chance to push. Returns null when absent / unreadable.
 */
export function loadPipelineAIConfigSync(): PersistedPipelineAIConfig | null {
  const blob = getBlob(BLOB_KEY);
  if (blob) {
    try { return deserialize(blob); }
    catch (err) { logger.error('[PipelineAIConfig] blob decode failed:', err); return null; }
  }
  // No blob yet → migrate a legacy file if present. Seed the blob FIRST, then
  // rename the file aside for the startup cleanup.
  try {
    const buf = readFileSync(legacyPath());
    const cfg = deserialize(buf);
    setBlob(BLOB_KEY, buf);
    try { renameSync(legacyPath(), `${legacyPath()}.premigrated`); } catch { /* keep original */ }
    logger.info('[PipelineAIConfig] migrated pipeline-ai-config.json into the core DB');
    return cfg;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') logger.error('[PipelineAIConfig] read failed:', err);
    return null;
  }
}

/** Forget the persisted config (provider removed / AI turned off). */
export async function clearPipelineAIConfig(): Promise<void> {
  return writeQueue.enqueue(async () => {
    deleteBlob(BLOB_KEY);
    try { await fs.unlink(legacyPath()); }
    catch (err: any) { if (err?.code !== 'ENOENT') logger.error('[PipelineAIConfig] legacy clear failed:', err); }
  });
}
