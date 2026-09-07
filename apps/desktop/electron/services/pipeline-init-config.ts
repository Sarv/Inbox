/**
 * Config resolution for a DEFERRED unified-pipeline init.
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
    enabled: p.enabled ?? boot.enabled ?? false,
    // The boot path resolves userEmail from the accounts registry / IMAP username;
    // keep it when the persisted copy doesn't carry one.
    userEmail: (p.userEmail as string) || (boot.userEmail as string) || undefined,
  };
}
