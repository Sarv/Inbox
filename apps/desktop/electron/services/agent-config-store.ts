/**
 * Agent config store (main process)
 *
 * Persists the UnifiedPipeline's user-facing config — most importantly the
 * `enabled` master switch (AI Assist) — so it SURVIVES A RESTART. Previously the
 * pipeline booted with `enabled:false` every launch and only learned the real
 * value when the renderer's AI/Agent settings tab happened to mount, so
 * auto-categorization silently didn't run until the user visited that tab.
 *
 * Source of truth stays the renderer (localStorage drives the settings UI); this
 * is a main-side mirror written on every `agent:setConfig` / `agent:setEnabled`
 * and read once at boot. Default is OFF.
 *
 * Storage moved from a standalone `agent-config.json` file INTO the core DB
 * (`core_blobs` row, key `agent-config`) so all main-process settings live in one
 * place. Plain JSON in the blob — these are feature toggles, not secrets, and the
 * core DB itself is SQLCipher-encrypted at rest. The legacy file is migrated on
 * first read (write-to-DB FIRST) and removed later by the startup cleanup.
 */

import { app } from 'electron';
import { readFileSync, renameSync } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';

import { getBlob, setBlob } from './core-db';

const logger = createLogger('agent-config-store');

const LEGACY_FILE_NAME = 'agent-config.json';
const BLOB_KEY = 'agent-config';

export interface PersistedAgentConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

let cache: PersistedAgentConfig | null = null;

function legacyPath(): string {
  return join(app.getPath('userData'), LEGACY_FILE_NAME);
}

/** Read the persisted agent config (sync — small blob, read once at boot). */
export function loadAgentConfig(): PersistedAgentConfig {
  if (cache) return cache;

  const blob = getBlob(BLOB_KEY);
  if (blob) {
    try {
      cache = JSON.parse(blob.toString('utf8')) as PersistedAgentConfig;
      return cache;
    } catch (e) {
      logger.error('[AgentConfigStore] blob decode failed:', e);
      cache = {};
      return cache;
    }
  }

  // No blob yet → migrate a legacy JSON file if present. Seed the blob FIRST (the
  // data is now safely in the core DB), then rename the file aside so the startup
  // cleanup can remove it once it confirms the blob exists.
  try {
    const raw = readFileSync(legacyPath(), 'utf8');
    cache = JSON.parse(raw) as PersistedAgentConfig;
    setBlob(BLOB_KEY, Buffer.from(JSON.stringify(cache), 'utf8'));
    try { renameSync(legacyPath(), `${legacyPath()}.premigrated`); } catch { /* keep original */ }
    logger.info('[AgentConfigStore] migrated agent-config.json into the core DB');
    return cache;
  } catch {
    // Missing / unreadable / malformed → default to empty (AI Assist OFF).
    cache = {};
    return cache;
  }
}

/**
 * Merge `partial` into the stored config and persist. Called on every
 * agent:setConfig / agent:setEnabled so the on-disk copy tracks the user's latest
 * settings. Never throws — a persistence failure must not break the live update.
 */
export function saveAgentConfig(partial: PersistedAgentConfig): void {
  const merged = { ...loadAgentConfig(), ...partial };
  cache = merged;
  try {
    setBlob(BLOB_KEY, Buffer.from(JSON.stringify(merged), 'utf8'));
    logger.info('[AgentConfigStore] persisted agent config (enabled:', merged.enabled, ')');
  } catch (err) {
    logger.error('[AgentConfigStore] Failed to persist agent config:', err);
  }
}
