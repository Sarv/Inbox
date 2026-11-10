// Sarv CAI catalog API — renderer-side.
//
// The catalog is FETCHED by main (`oauth:sarvCatalog`, core's
// `fetchSarvCatalog`): it needs the account's Sarv bearer, which is also the
// Sarv mailbox's XOAUTH2 credential, and the renderer — which renders untrusted
// email HTML — never holds it (CASA I-2). This module names the account and the
// list, then normalises main's raw answer into the shapes the pickers use. Main
// sends the request to its own configured Sarv API base URL; there is no URL
// for the renderer to choose.
//
// We deliberately DON'T runtime-import from `@sarvinbox/core` here: that
// package's barrel re-exports imapflow / nodemailer / agent pipeline code,
// which drags Node's `events` module into the renderer bundle and breaks Vite's
// ESM loader (see "Dynamic require of 'events' is not supported" errors).

import { createLogger } from '@sarvinbox/core/logger';
import { trimTrailingSlashes } from '@sarvinbox/core/trailing-slash';

const log = createLogger('sarv-cai-api');

// Normalized shapes the UI consumes. `code` maps to whatever the server
// calls the stable identifier (some endpoints use `id`, others `code`);
// the wrapper normalizes either into `code` so consumers don't care.
export interface SarvLLMProvider {
  code: string;
  name: string;
}

export interface SarvLLMModel {
  code: string;
  display_name?: string | null;
  provider_code: string;
  supports_streaming?: boolean;
}

export interface SarvZone {
  code: string;
  name?: string | null;
  country?: string | null;
  city?: string | null;
  /** Edge gateway base URL for LLM/TTS/STT calls in this zone. */
  api_domain?: string | null;
  is_default?: boolean;
}

// Raw wire shapes from `/api/v1/agent-models/llm/*` (what the dashboard
// currently uses). Older endpoint family, session- or Bearer-authenticated.
interface RawProvider {
  id?: string;
  code?: string;
  name?: string;
  display_name?: string;
}

interface RawModel {
  id?: string;
  code?: string;
  name?: string;
  display_name?: string;
  provider_id?: string;
  provider_code?: string;
  supports_streaming?: boolean;
}

interface RawZone {
  id?: string;
  code?: string;
  name?: string;
  country?: string;
  city?: string;
  api_domain?: string;
  is_default?: boolean;
}

/**
 * A failed catalog lookup. `status` is the HTTP status (0 when no response
 * arrived); `code` is Sarv's error code (`insufficient_scope`,
 * `cai_account_required`, …) or main's own (`sign_in_required`,
 * `token_unavailable`, `network`, `timeout`).
 */
export interface SarvApiErrorShape extends Error {
  status: number;
  code: string;
}

type SarvCatalogRequest = Parameters<typeof window.electronAPI.oauth.sarvCatalog>[0];

/** Main's answer, or a SarvApiErrorShape carrying its status, code and message. */
async function getCatalog(request: SarvCatalogRequest): Promise<unknown> {
  const res = await window.electronAPI.oauth.sarvCatalog(request);
  if (res.ok) return res.body;
  // Main logs the failure with its code; rebuilt here because an Error's own
  // properties do not survive IPC.
  throw Object.assign(new Error(res.message), { status: res.status, code: res.code }) as SarvApiErrorShape;
}

function normalizeProvider(p: RawProvider): SarvLLMProvider {
  return {
    code: p.code || p.id || '',
    name: p.name || p.display_name || p.code || p.id || '',
  };
}

function normalizeModel(m: RawModel): SarvLLMModel {
  return {
    code: m.code || m.id || '',
    display_name: m.display_name || m.name || null,
    provider_code: m.provider_code || m.provider_id || '',
    supports_streaming: m.supports_streaming,
  };
}

function unwrapArray<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['data', 'providers', 'models', 'zones', 'items', 'results']) {
      if (Array.isArray(b[key])) return b[key] as T[];
    }
  }
  return [];
}

// The Sarv CAI API exposes the catalog under `/oauth/v1/*` (scope `llm:view`).
// `zoneCode` is an optional filter, the way the dashboard scopes the catalog
// to a region; an empty one is dropped rather than sent as a real filter.

export async function listCaiProviders(
  email: string,
  zoneCode?: string,
): Promise<SarvLLMProvider[]> {
  const body = await getCatalog({ kind: 'providers', email, zoneCode });
  return unwrapArray<RawProvider>(body).map(normalizeProvider);
}

export async function listCaiModels(
  email: string,
  providerCode?: string,
  zoneCode?: string,
): Promise<SarvLLMModel[]> {
  const body = await getCatalog({ kind: 'models', email, providerCode, zoneCode });
  return unwrapArray<RawModel>(body).map(normalizeModel);
}

export async function listCaiZones(email: string): Promise<SarvZone[]> {
  const body = await getCatalog({ kind: 'zones', email });
  return unwrapArray<RawZone>(body).map((z) => ({
    code: z.code || z.id || '',
    name: z.name || null,
    country: z.country || null,
    city: z.city || null,
    api_domain: z.api_domain || null,
    is_default: Boolean(z.is_default),
  }));
}

/**
 * Pick the zone Sarv Inbox should use by default: the one flagged
 * `is_default`, falling back to the first zone. Returns `null` if the
 * user has no zones at all.
 *
 * A `null` here is NORMAL, not a failure — zones are organization-scoped on
 * the Sarv side, so a personal CAI account (credits, no org) legitimately
 * has none and `/oauth/v1/zones` answers 403. See `buildSarvEdgeBaseUrl`.
 */
export function pickDefaultZone(zones: SarvZone[]): SarvZone | null {
  if (zones.length === 0) return null;
  return zones.find((z) => z.is_default) || zones[0];
}

export interface SarvZoneSelection {
  zones: SarvZone[];
  /** '' when the account has no zones — a normal state, not a failure. */
  zoneCode: string;
}

/**
 * Best-effort zone lookup for an account. NEVER rejects.
 *
 * `/oauth/v1/zones` is the one org-gated endpoint in the CAI catalog, so an
 * account with credits but no organization membership gets a 403 here. That
 * must not stop the LLM catalog from loading: the zone only ever supplied
 * `api_domain` (which has an env fallback) and `zone_code` is an optional
 * filter on the providers/models endpoints. Treating this failure as fatal
 * is what left such accounts signed in with zero AI providers.
 *
 * Both the onboarding step and Settings go through here, so they cannot
 * drift on which failures are fatal.
 */
export async function loadZoneSelection(email: string): Promise<SarvZoneSelection> {
  try {
    const zones = await listCaiZones(email);
    return { zones, zoneCode: pickDefaultZone(zones)?.code ?? '' };
  } catch (err) {
    // Still non-fatal (see above), but no longer INVISIBLE. A 403 with
    // `insufficient_scope` here means the token lacks llm:view, which will also
    // fail providers/models — i.e. the whole AI catalog, not just zones. That is
    // worth one line in the log to tell apart from the ordinary org-scoped 403.
    log.warn('zone lookup failed (non-fatal):', (err as Error).message);
    return { zones: [], zoneCode: '' };
  }
}

/**
 * Sarv's recommended default: `sarv_partners` (Sarv's hosting of
 * GPT-OSS-120B, fine-tuned for this product). Onboarding and Settings must
 * default to the SAME thing, so the codes live here rather than in either
 * component — they had drifted already (Settings defaulted to whatever the
 * catalog happened to list first).
 */
export const RECOMMENDED_SARV_PROVIDER = 'sarv_partners';
export const RECOMMENDED_SARV_MODEL = 'gpt-oss-120b';

/** The entry with this `code`, else the first one, else `undefined`. */
function preferByCode<T extends { code: string }>(list: T[], code: string): T | undefined {
  return list.find((entry) => entry.code === code) ?? list[0];
}

export function pickRecommendedProvider(
  providers: SarvLLMProvider[],
): SarvLLMProvider | undefined {
  return preferByCode(providers, RECOMMENDED_SARV_PROVIDER);
}

export function pickRecommendedModel(
  models: SarvLLMModel[],
  providerCode: string,
): SarvLLMModel | undefined {
  // Only sarv_partners has a fine-tuned model worth preferring; every other
  // provider gets whatever the catalog listed first.
  return providerCode === RECOMMENDED_SARV_PROVIDER
    ? preferByCode(models, RECOMMENDED_SARV_MODEL)
    : models[0];
}

/**
 * The edge-gateway base URL to register a Sarv LLM provider against.
 *
 * A zone's `api_domain` is the preferred source, but zones are
 * ORGANIZATION-scoped: an account with CAI credits but no org membership
 * gets a 403 from `/oauth/v1/zones` and so has no zone at all. The
 * env-configured fallback is therefore a REAL code path that has to keep
 * such an account working end to end — not a mid-upgrade safety net.
 *
 * Returns '' when neither source is available; callers must treat that as
 * "cannot register a provider" rather than building a broken URL.
 */
export function buildSarvEdgeBaseUrl(
  zoneApiDomain: string | null | undefined,
  fallbackEdgeBaseUrl: string | null | undefined,
): string {
  const root = zoneApiDomain || (fallbackEdgeBaseUrl ?? '').replace(/\/edge\/v1\/llm\/?$/, '');
  const trimmed = trimTrailingSlashes(root);
  return trimmed ? `${trimmed}/edge/v1/llm` : '';
}
