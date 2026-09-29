/**
 * Config resolution for the unified pipeline's start: at app launch
 * (bootPipelineConfig) and for a DEFERRED init (resolveDeferredPipelineConfig).
 * Both decide the AI Assist master switch, which is what lets the pipeline send
 * new mail to the AI provider for sorting, so both go through isAIAssistOn.
 *
 * On a first launch the pipeline is initialized before any account exists, so it
 * DEFERS (no storage yet) and captures the boot config — which carries the OFF
 * default for the AI-Assist `enabled` switch. Meanwhile the renderer's
 * `agent:setConfig` push (default enabled:true, and again after "login with
 * Sarv") can only PERSIST that switch to disk, because there's no live pipeline
 * object to apply it to yet. If the deferred init then rebuilds the pipeline from
 * the stale boot config, categorization comes up disabled until the user manually
 * toggles AI Assist ("I have to start it").
 *
 * This resolves the effective config by preferring the PERSISTED settings over
 * the captured boot config, so a first-time login comes up in the user's real
 * state. Kept pure + dependency-free so it's unit-testable in isolation.
 */
export interface DeferredInitConfig {
  enabled?: boolean;
  userEmail?: string;
  [key: string]: unknown;
}

export function resolveDeferredPipelineConfig(
  bootConfig: DeferredInitConfig | undefined,
  persisted: DeferredInitConfig | undefined,
): DeferredInitConfig {
  const boot = bootConfig ?? {};
  const p = persisted ?? {};
  return {
    ...boot,
    ...p,
    // The AI-Assist master switch: the persisted value wins when the user (or the
    // renderer's default-on boot push) has set one; otherwise fall back to the
    // boot value, then OFF. This is what flips a first-time Sarv login to enabled
    // without a manual toggle, while still honoring a deliberate persisted `false`.
    // Only a real `true` counts: a stored value that is set but not a boolean is
    // unreadable, and unreadable is OFF (see isAIAssistOn).
    enabled: p.enabled !== undefined ? isAIAssistOn(p.enabled) : isAIAssistOn(boot.enabled),
    // The boot path resolves userEmail from the accounts registry / IMAP username;
    // keep it when the persisted copy doesn't carry one.
    userEmail: (p.userEmail as string) || (boot.userEmail as string) || undefined,
  };
}

/**
 * Whether a stored AI Assist value means ON. AI Assist is the one switch that
 * lets the pipeline send new mail to the AI provider for sorting, so only a
 * real boolean `true` turns it on. Anything else (missing, `false`, or a value
 * that did not survive storage, such as the string "false") is OFF: an
 * unreadable switch must fail closed, never open.
 */
export function isAIAssistOn(value: unknown): boolean {
  return value === true;
}

/**
 * The config the pipeline starts with at app launch, built from the main-side
 * mirror of the AI Assist settings (agent-config-store). The mirror is what
 * keeps a deliberate "off" in force across a restart, before the renderer has
 * re-sent anything. A fresh install has no mirror yet and starts OFF until the
 * renderer pushes the user's real settings at boot.
 *
 * `userEmail` comes from the accounts registry and wins over any stale copy in
 * the mirror.
 */
export function bootPipelineConfig(
  persisted: DeferredInitConfig | undefined,
  userEmail: string,
): DeferredInitConfig {
  return { ...(persisted ?? {}), enabled: isAIAssistOn(persisted?.enabled), userEmail };
}
