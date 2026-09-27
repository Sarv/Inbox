// Background auto-registration of the recommended Sarv AI provider.
//
// Signing in to Sarv IS the intent to use Sarv AI. The onboarding picker and
// Settings → AI → Providers both register the recommended model, but only
// while they are on screen — and onboarding can be replaced by the inbox the
// moment the Sarv mailbox connects, before its picker ever renders. That left
// fresh installs signed in with no provider and an "AI is inactive" banner.
//
// `ensureSarvAiProvider` owns no UI and keeps no component state, so it
// finishes whatever screen is open. App runs it on boot and both sign-in
// surfaces run it right after a Sarv sign-in; it is safe to call any time.

import { getDefaultProvider } from './ai-service';
import {
  listCaiModels,
  listCaiProviders,
  loadZoneSelection,
  pickRecommendedModel,
  pickRecommendedProvider,
} from './sarv-cai-api';
import {
  buildSarvProviderDraft,
  registerSarvProvider,
  type SarvProviderDraftResult,
} from './sarv-llm-provider';

/** The signed-in Sarv account plus the URLs its catalog lives at. */
export interface SarvAccountEndpoints {
  email: string;
  apiBaseUrl: string;
  fallbackEdgeBaseUrl?: string | null;
}

export interface SarvCatalogDeps {
  loadZoneSelection: typeof loadZoneSelection;
  listCaiProviders: typeof listCaiProviders;
  listCaiModels: typeof listCaiModels;
}

const defaultCatalog: SarvCatalogDeps = { loadZoneSelection, listCaiProviders, listCaiModels };

/**
 * Walk the catalog the way the pickers do — zone (optional), then the
 * recommended provider, then its recommended model — and draft the provider.
 * Throws on a catalog failure (network, auth) so the caller can tell a
 * transient error from an account that has no models.
 */
export async function resolveRecommendedSarvDraft(
  account: SarvAccountEndpoints,
  catalog: SarvCatalogDeps = defaultCatalog,
): Promise<SarvProviderDraftResult> {
  const { email, apiBaseUrl } = account;
  const { zones, zoneCode } = await catalog.loadZoneSelection(apiBaseUrl, email);
  const providers = await catalog.listCaiProviders(apiBaseUrl, email, zoneCode);
  const providerCode = pickRecommendedProvider(providers)?.code ?? '';
  const models = providerCode
    ? await catalog.listCaiModels(apiBaseUrl, email, providerCode, zoneCode)
    : [];
  const modelCode = pickRecommendedModel(models, providerCode)?.code ?? '';
  return buildSarvProviderDraft({
    email,
    providerCode,
    modelCode,
    zoneCode,
    providers,
    models,
    zones,
    fallbackEdgeBaseUrl: account.fallbackEdgeBaseUrl,
  });
}

/** Read the signed-in Sarv account from main; null when nobody is signed in. */
async function readSarvAccountFromMain(): Promise<SarvAccountEndpoints | null> {
  const oauth = window.electronAPI.oauth;
  const [providersRes, accountsRes] = await Promise.all([oauth.listProviders(), oauth.listAccounts()]);
  const sarv = providersRes.success ? providersRes.data?.find((p) => p.id === 'sarv') : undefined;
  const account = accountsRes.success ? accountsRes.data?.find((a) => a.provider === 'sarv') : undefined;
  if (!account?.email || !sarv?.apiBaseUrl) return null;
  return { email: account.email, apiBaseUrl: sarv.apiBaseUrl, fallbackEdgeBaseUrl: sarv.llmBaseUrl };
}

export type EnsureSarvAiOutcome =
  /** Registered the recommended model; AI is now active. */
  | 'registered'
  /** Some provider is already the default — the user's choice stands. */
  | 'has-default'
  /** No Sarv account signed in. */
  | 'not-signed-in'
  /** The account's catalog offers no provider/model to register. */
  | 'incomplete'
  /** No zone and no configured fallback edge URL. */
  | 'no-edge-url'
  /** Catalog or IPC failure — transient; the next boot or sign-in retries. */
  | 'failed';

export interface EnsureSarvAiDeps {
  readAccount: () => Promise<SarvAccountEndpoints | null>;
  resolveDraft: (account: SarvAccountEndpoints) => Promise<SarvProviderDraftResult>;
  hasDefaultProvider: () => boolean;
  register: typeof registerSarvProvider;
}

const defaultDeps: EnsureSarvAiDeps = {
  readAccount: readSarvAccountFromMain,
  resolveDraft: (account) => resolveRecommendedSarvDraft(account),
  hasDefaultProvider: () => getDefaultProvider() !== null,
  register: registerSarvProvider,
};

/**
 * Register the recommended Sarv model when a Sarv account is signed in and NO
 * AI provider exists yet. Never replaces a provider the user already has, so a
 * deliberately chosen model (or a non-Sarv provider) is left alone.
 */
export async function runEnsureSarvAiProvider(
  deps: EnsureSarvAiDeps = defaultDeps,
): Promise<EnsureSarvAiOutcome> {
  try {
    if (deps.hasDefaultProvider()) return 'has-default';
    const account = await deps.readAccount();
    if (!account) return 'not-signed-in';
    const drafted = await deps.resolveDraft(account);
    if (!drafted.ok) {
      console.warn(`[sarv-ai-auto-register] nothing to register for ${account.email}: ${drafted.reason}`);
      return drafted.reason;
    }
    // The catalog walk is async: a provider added meanwhile (onboarding's
    // Continue, Settings) wins, so re-check before registering.
    if (deps.hasDefaultProvider()) return 'has-default';
    deps.register(drafted.draft);
    console.info(`[sarv-ai-auto-register] registered ${drafted.draft.name} for ${account.email}`);
    return 'registered';
  } catch (err) {
    console.warn('[sarv-ai-auto-register] failed (will retry on next boot/sign-in):', (err as Error)?.message);
    return 'failed';
  }
}

let inFlight: Promise<EnsureSarvAiOutcome> | null = null;

/**
 * Fire-and-forget entry point. Concurrent callers (boot + a sign-in landing at
 * the same moment) share one run, so the catalog is fetched once.
 */
export function ensureSarvAiProvider(): Promise<EnsureSarvAiOutcome> {
  inFlight ??= runEnsureSarvAiProvider().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
