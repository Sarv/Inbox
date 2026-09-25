// Registering a Sarv-hosted LLM as an AI provider.
//
// Onboarding (SarvSignInStep) and Settings → AI → Providers both turn a
// (zone, provider, model) selection into an AIProvider entry, and both had
// their own copy of "build the friendly name, build the edge URL, call
// addProvider". This is the single source for that, so the two surfaces
// cannot drift the way their recommended-model defaults once did.

import {
  addProvider,
  loadAISettings,
  setDefaultProvider,
  syncAIProviderToMain,
  type AIProvider,
} from './ai-service';
import {
  buildSarvEdgeBaseUrl,
  type SarvLLMModel,
  type SarvLLMProvider,
  type SarvZone,
} from './sarv-cai-api';

/** A resolved catalog selection, as both pickers hold it in state. */
export interface SarvProviderSelection {
  email: string;
  providerCode: string;
  modelCode: string;
  zoneCode: string;
  providers: SarvLLMProvider[];
  models: SarvLLMModel[];
  zones: SarvZone[];
  /** Env-configured edge URL — the only source when the account has no zone. */
  fallbackEdgeBaseUrl?: string | null;
}

/** What an AIProvider entry for that selection would be built from. */
export interface SarvProviderDraft {
  name: string;
  modelCode: string;
  baseUrl: string;
  email: string;
}

export type SarvProviderDraftResult =
  | { ok: true; draft: SarvProviderDraft }
  /** The selection isn't complete yet (still loading, or nothing picked). */
  | { ok: false; reason: 'incomplete' }
  /** No zone AND no configured fallback — a provider here would be broken. */
  | { ok: false; reason: 'no-edge-url' };

export const NO_EDGE_URL_MESSAGE =
  'No Sarv edge URL available — no zone and no configured fallback.';

/**
 * Pure: turn a catalog selection into the draft AIProvider fields, or say why
 * it can't be turned into one. Callers show `NO_EDGE_URL_MESSAGE` for
 * `no-edge-url` and stay silent for `incomplete`.
 */
export function buildSarvProviderDraft(
  selection: SarvProviderSelection,
): SarvProviderDraftResult {
  const { email, providerCode, modelCode } = selection;
  if (!email || !providerCode || !modelCode) return { ok: false, reason: 'incomplete' };

  const caiProvider = selection.providers.find((p) => p.code === providerCode);
  const caiModel = selection.models.find((m) => m.code === modelCode);
  const zone = selection.zones.find((z) => z.code === selection.zoneCode);
  // Zone api_domain when there is a zone, env fallback when there isn't (an
  // account with credits but no org has no zone at all).
  const baseUrl = buildSarvEdgeBaseUrl(zone?.api_domain, selection.fallbackEdgeBaseUrl);
  if (!baseUrl) return { ok: false, reason: 'no-edge-url' };

  const providerLabel = caiProvider?.name || providerCode;
  const modelLabel = caiModel?.display_name || caiModel?.code || modelCode;
  return {
    ok: true,
    draft: { name: `Sarv · ${providerLabel} · ${modelLabel}`, modelCode, baseUrl, email },
  };
}

/**
 * Pure: the entry already registered for this draft, if any. Identity is
 * (Sarv account, model, edge URL) — the same model in a different region is a
 * different provider, the same tuple twice is a duplicate.
 */
export function findRegisteredSarvProvider(
  providers: AIProvider[],
  draft: SarvProviderDraft,
): AIProvider | undefined {
  return providers.find(
    (p) =>
      p.oauthProvider === 'sarv'
      && p.oauthEmail === draft.email
      && p.model === draft.modelCode
      && p.baseUrl === draft.baseUrl,
  );
}

/**
 * Register the drafted model as an AI provider and push it to the main
 * process. IDEMPOTENT: re-registering the same tuple returns the existing
 * entry instead of adding a second one, so an auto-registration and a later
 * click on "Add to AI providers" can't produce duplicates.
 *
 * Dedupes against stored settings rather than a caller-held array, which can
 * be a render behind.
 */
export function registerSarvProvider(
  draft: SarvProviderDraft,
  options?: { makeDefault?: boolean },
): { provider: AIProvider; added: boolean } {
  const existing = findRegisteredSarvProvider(loadAISettings().providers, draft);
  const provider =
    existing
    ?? addProvider('sarv', '', draft.modelCode, {
      name: draft.name,
      baseUrl: draft.baseUrl,
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: draft.email,
    });
  // addProvider already makes the FIRST provider the default; only force it
  // when the caller means to override an existing default.
  if (options?.makeDefault) setDefaultProvider(provider.id);
  // Push BOTH the scheduler gate AND the pipeline aiConfig so AI works right
  // away, without waiting for a sync or a restart.
  void syncAIProviderToMain();
  return { provider, added: !existing };
}
