// Agent (AI Assist) settings — storage contract + main-process push.
//
// Single source of truth shared by the Email Agent settings tab and the app
// boot sequence. The renderer persists these to localStorage; the main-process
// UnifiedPipeline only learns them via `agent:setConfig`. Pushing at BOOT (not
// only when the settings tab mounts) is what makes AI Assist actually run after
// a restart — otherwise the pipeline sits at its boot default (off) until the
// user happens to open the tab. The main process ALSO persists what it receives
// (agent-config.json), so this push is what seeds that file on an existing
// install whose enable-state lived only in renderer localStorage.

import { createLogger } from '@sarvinbox/core/logger';

const log = createLogger('AgentSettings');
export const AGENT_CONFIG_KEY = 'sarvinbox-agent-config';
export const AI_ASSIST_CHANGED_EVENT = 'sarvinbox:ai-assist-changed';
const AGENT_CONFIG_VERSION = 2;
const AGENT_CONFIG_VERSION_KEY = 'sarvinbox-agent-config-version';

export interface AgentSettings {
  enabled: boolean;
  autoActThreshold: number;
  suggestThreshold: number;
  autoTriage: boolean;
  autoRead: boolean;
  draftReplies: boolean;
  autoReply: boolean;
  autoPrioritize: boolean;
  neverAutoDeleteFrom: string; // comma-separated in storage, array over IPC
  neverAutoReplyTo: string;
  maxAutoActionsPerHour: number;
  searchWebEnabled: boolean;
  tavilyApiKey: string;
  testMode: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  // Default ON — keep in sync with UnifiedPipeline DEFAULT_CONFIG. Only the
  // passive surface (categorize / prioritize / draft) turns on; the autonomous-
  // action toggles below stay off, so nothing is sent or deleted without
  // explicit opt-in.
  enabled: true,
  autoActThreshold: 0.85,
  suggestThreshold: 0.5,
  autoTriage: false,
  autoRead: true,
  draftReplies: true,
  autoReply: false,
  autoPrioritize: true,
  neverAutoDeleteFrom: '',
  neverAutoReplyTo: '',
  maxAutoActionsPerHour: 50,
  searchWebEnabled: false,
  tavilyApiKey: '',
  testMode: false,
};

/**
 * What an UNREADABLE stored config loads as: the defaults with AI Assist OFF.
 * AI Assist is the one switch for automatic sorting, so an "off" that can no
 * longer be read must not come back as the default "on" and quietly resume
 * sending new mail to the AI provider. Turning it on again rewrites the store.
 */
const UNREADABLE_AGENT_SETTINGS: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, enabled: false };

function unreadable(reason: string): AgentSettings {
  log.warn(`Stored AI Assist settings are unreadable (${reason}) — AI Assist stays OFF until it is turned on again`);
  return UNREADABLE_AGENT_SETTINGS;
}

/**
 * Load agent settings from localStorage, applying the one-time v2 default-on
 * migration.
 *
 * Nothing stored (a fresh install) is NOT the same as something stored that
 * cannot be read. Nothing stored loads the defaults, AI Assist on: connecting an
 * AI provider is the user's opt-in to sorting. A value that is present but
 * unreadable (corrupt JSON, not an object, a non-boolean `enabled`, storage that
 * throws) loads with AI Assist OFF, and nothing is written back over it.
 */
export function loadAgentSettings(): AgentSettings {
  let raw: string | null;
  try {
    raw = localStorage.getItem(AGENT_CONFIG_KEY);
  } catch {
    return unreadable('storage unavailable');
  }
  if (raw === null) return DEFAULT_AGENT_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return unreadable('not an object');
  const stored = parsed as Record<string, unknown>;
  if (stored.enabled !== undefined && typeof stored.enabled !== 'boolean') return unreadable('enabled is not true/false');

  const merged: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  for (const key of Object.keys(DEFAULT_AGENT_SETTINGS) as (keyof AgentSettings)[]) {
    if (stored[key] !== undefined && typeof stored[key] === typeof DEFAULT_AGENT_SETTINGS[key]) {
      (merged as unknown as Record<string, unknown>)[key] = stored[key];
    }
  }
  // One-time default-enable migration for installs that predate v2. A config
  // saved before v2 with enabled:false was the OLD default (the agent
  // produced zero decisions, so it was never a deliberate choice) — flip it
  // on once, then stamp the version so a later deliberate "off" is honored.
  try {
    const storedVersion = Number(localStorage.getItem(AGENT_CONFIG_VERSION_KEY) || '1');
    if (storedVersion < AGENT_CONFIG_VERSION) {
      if (merged.enabled === false) merged.enabled = true;
      localStorage.setItem(AGENT_CONFIG_VERSION_KEY, String(AGENT_CONFIG_VERSION));
      localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(merged));
    }
  } catch { /* storage full / unavailable — the migration retries next load */ }
  return merged;
}

/**
 * Whether AI Assist is on — the ONE switch for automatic sorting (Settings → AI
 * → Email Agent). Every renderer path that decides whether mail may be sent to
 * the AI provider for sorting asks this, never a separate per-feature toggle.
 */
export function isAIAssistEnabled(): boolean {
  return loadAgentSettings().enabled;
}

/** Persist agent settings to localStorage. */
export function saveAgentSettings(s: AgentSettings, options: { strict?: boolean } = {}): void {
  try {
    // This is an explicit user choice, not the historical default. Stamp the
    // version first so a saved "off" cannot be migrated back to "on" later.
    localStorage.setItem(AGENT_CONFIG_VERSION_KEY, String(AGENT_CONFIG_VERSION));
    localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(s));
  } catch (error) {
    if (options.strict) throw error;
    // Best-effort callers retain their existing non-fatal storage behavior.
  }
  (globalThis as { window?: Window }).window?.dispatchEvent?.(new Event(AI_ASSIST_CHANGED_EVENT));
}

/**
 * Push settings to the main-process pipeline (comma lists become arrays). Main
 * mirrors them to disk so they survive the next restart. Defaults to the stored
 * settings, so `pushAgentSettingsToBackend()` at boot restores the user's state.
 */
/**
 * Push the category-label mirroring setting (from the app settings blob) to the
 * pipeline. Called at boot and whenever the toggle changes. Safe defaults (off)
 * when unset; silently no-ops if the bridge isn't ready.
 */
export function pushCategoryLabelSetting(): void {
  try {
    const raw = localStorage.getItem('sarvinbox-settings');
    const s = raw ? JSON.parse(raw) : {};
    // Default ON when unset (fresh install / existing user pre-feature) so it
    // matches defaultSettings; an explicit stored `false` is respected. Writes
    // nothing until AI Assist is on, so on-by-default is safe.
    const cl = (s.categoryLabels && typeof s.categoryLabels === 'object') ? s.categoryLabels : { enabled: true, folderMode: 'copy' };
    const cfg = { enabled: cl.enabled !== false, folderMode: cl.folderMode === 'move' ? 'move' as const : 'copy' as const };
    (window.electronAPI as any)?.agent?.setCategoryLabels?.(cfg)?.catch?.(() => {});
  } catch { /* ignore */ }
}

function backendConfig(s: AgentSettings) {
  const toList = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return { ...s, neverAutoDeleteFrom: toList(s.neverAutoDeleteFrom), neverAutoReplyTo: toList(s.neverAutoReplyTo) };
}

/** Confirm the native pipeline has accepted an explicit onboarding choice. */
export async function pushAgentSettingsToBackendStrict(s: AgentSettings): Promise<void> {
  const api = (globalThis as { window?: Window }).window?.electronAPI?.agent?.setConfig;
  if (typeof api !== 'function') throw new Error('AI settings could not be saved because the native app connection is unavailable.');
  const response = await api(backendConfig(s));
  if (!response?.success) throw new Error(response?.error || 'The native app could not save AI settings.');
}

export function pushAgentSettingsToBackend(s: AgentSettings = loadAgentSettings()): void {
  const api = window.electronAPI?.agent?.setConfig;
  // Loud, unmissable log so it's obvious in DevTools whether the boot push
  // actually fired and whether the IPC bridge is present.
  log.info('Pushing to backend — enabled:', s.enabled, 'setConfig present:', typeof api === 'function');
  if (typeof api !== 'function') {
    log.warn('window.electronAPI.agent.setConfig is NOT available — preload may be stale/broken');
    return;
  }
  api(backendConfig(s))
    .then(() => log.info('Backend accepted config (enabled:', s.enabled, ')'))
    .catch((e) => log.warn('setConfig failed:', e?.message || e));
}
