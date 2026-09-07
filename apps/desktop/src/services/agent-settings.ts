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

export const AGENT_CONFIG_KEY = 'sarvinbox-agent-config';
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

/** Load agent settings from localStorage, applying the one-time v2 default-on migration. */
export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(AGENT_CONFIG_KEY);
    if (!raw) return DEFAULT_AGENT_SETTINGS;
    const parsed = JSON.parse(raw);
    const merged: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
    for (const key of Object.keys(DEFAULT_AGENT_SETTINGS) as (keyof AgentSettings)[]) {
      if (parsed[key] !== undefined && typeof parsed[key] === typeof DEFAULT_AGENT_SETTINGS[key]) {
        (merged as unknown as Record<string, unknown>)[key] = parsed[key];
      }
    }
    // One-time default-enable migration for installs that predate v2. A config
    // saved before v2 with enabled:false was the OLD default (the agent
    // produced zero decisions, so it was never a deliberate choice) — flip it
    // on once, then stamp the version so a later deliberate "off" is honored.
    const storedVersion = Number(localStorage.getItem(AGENT_CONFIG_VERSION_KEY) || '1');
    if (storedVersion < AGENT_CONFIG_VERSION) {
      if (merged.enabled === false) merged.enabled = true;
      localStorage.setItem(AGENT_CONFIG_VERSION_KEY, String(AGENT_CONFIG_VERSION));
      localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(merged));
    }
    return merged;
  } catch {
    return DEFAULT_AGENT_SETTINGS;
  }
}

/** Persist agent settings to localStorage. */
export function saveAgentSettings(s: AgentSettings): void {
  try {
    localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(s));
  } catch { /* storage full / unavailable — non-fatal */ }
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

export function pushAgentSettingsToBackend(s: AgentSettings = loadAgentSettings()): void {
  const toList = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const api = window.electronAPI?.agent?.setConfig;
  // Loud, unmissable log so it's obvious in DevTools whether the boot push
  // actually fired and whether the IPC bridge is present.
  console.log('[AgentSettings] pushing to backend — enabled:', s.enabled, 'setConfig present:', typeof api === 'function');
  if (typeof api !== 'function') {
    console.warn('[AgentSettings] window.electronAPI.agent.setConfig is NOT available — preload may be stale/broken');
    return;
  }
  api({
    ...s,
    neverAutoDeleteFrom: toList(s.neverAutoDeleteFrom),
    neverAutoReplyTo: toList(s.neverAutoReplyTo),
  })
    .then(() => console.log('[AgentSettings] backend accepted config (enabled:', s.enabled, ')'))
    .catch((e) => console.warn('[AgentSettings] setConfig failed:', e?.message || e));
}
