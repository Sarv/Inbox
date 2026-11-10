/**
 * Sarv CAI catalog — `/oauth/v1/llm/providers`, `/oauth/v1/llm/models` and
 * `/oauth/v1/zones` — fetched by the MAIN process.
 *
 * These read-only discovery endpoints populate the provider / model / zone
 * pickers. Each needs the account's OAuth bearer (scope `llm:view`), and that
 * bearer is also the XOAUTH2 credential for the Sarv mailbox (`email:read`,
 * `email:send`, `email:delete`, …). So the renderer — which also renders
 * untrusted email HTML — never holds it: it asks main over IPC, main mints the
 * bearer, sends it only to the configured Sarv API base URL, and hands back a
 * plain, serialisable result. Normalising the payload into picker entries stays
 * in the renderer (`sarv-cai-api.ts`).
 *
 * This is the only copy of the catalog request and its error parsing.
 */
import { fetchWithBearerRetry, isBearerUnavailableError, type BearerResolver } from '../utils/bearer-retry';
import { trimTrailingSlashes } from '../utils/trailing-slash';

import { isSignInRequiredError } from './oauth-errors';

export type SarvCatalogKind = 'providers' | 'models' | 'zones';

/** Which catalog list, and its optional filters. */
export interface SarvCatalogQuery {
  kind: SarvCatalogKind;
  /** `models` only: the backend whose models to list. */
  providerCode?: string;
  /** `providers` / `models`: scope to a zone. Omitted when empty. */
  zoneCode?: string;
}

/**
 * The catalog answer, as plain data so it survives IPC (an `Error`'s own
 * properties do not).
 *
 * On failure `status` is the HTTP status, or 0 when no response arrived. `code`
 * is Sarv's machine-readable error code when it sent one (`insufficient_scope`,
 * `cai_account_required`, …), else the status, or — with no response — one of
 * `sign_in_required` (only signing in again helps), `token_unavailable` (the
 * token could not be refreshed right now), `network`, `timeout`.
 */
export type SarvCatalogResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; code: string; message: string };

/** How long one catalog lookup may take, token refresh included. */
export const SARV_CATALOG_TIMEOUT_MS = 15_000;

const CATALOG_PATHS: Record<SarvCatalogKind, string> = {
  providers: '/oauth/v1/llm/providers',
  models: '/oauth/v1/llm/models',
  zones: '/oauth/v1/zones',
};

/**
 * The catalog URL under `apiBaseUrl`, which must come from main's own provider
 * config — never from the renderer. Empty filters are left out: an empty
 * `zone_code=` would be sent as a real filter and could match nothing.
 */
export function sarvCatalogUrl(apiBaseUrl: string, query: SarvCatalogQuery): string {
  const params = new URLSearchParams();
  if (query.kind === 'models' && query.providerCode) params.set('provider_code', query.providerCode);
  if (query.kind !== 'zones' && query.zoneCode) params.set('zone_code', query.zoneCode);
  const qs = params.toString();
  return `${trimTrailingSlashes(apiBaseUrl)}${CATALOG_PATHS[query.kind]}${qs ? `?${qs}` : ''}`;
}

/** The human text of a FastAPI field, whichever of its shapes it took. */
function pickText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (Array.isArray(value)) {
    // 422 validation errors: [{ loc, msg, … }, …]
    const parts = value
      .map((entry) => (typeof entry === 'string' ? entry : (entry as { msg?: unknown } | null)?.msg))
      .filter((part): part is string => typeof part === 'string' && part.trim() !== '');
    return parts.length ? parts.join('; ') : null;
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['error_description', 'message', 'error']) {
      if (typeof o[key] === 'string' && (o[key] as string).trim()) return o[key] as string;
    }
  }
  return null;
}

/** The first non-empty string among `candidates`. */
function firstString(...candidates: unknown[]): string | null {
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c;
  return null;
}

/**
 * `{ code, message }` for a non-2xx catalog response body.
 *
 * FastAPI's `detail` comes in three shapes — a string (most 4xx), an object
 * `{ error, error_description, message, … }` (the OAuth errors) or a list of
 * `{ msg }` (422) — and the machine-readable code sits INSIDE `detail` for the
 * object shape. Reading only the top level reported every catalog 403 as the
 * bare status, which cannot tell a missing `llm:view` scope from a missing CAI
 * account. A body that is not JSON (a proxy's HTML page) keeps the status.
 */
export function parseSarvCatalogError(status: number, rawBody: string): { code: string; message: string } {
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { body = undefined; }
  const top = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const detail = top.detail;
  const payload = (detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : top) as Record<string, unknown>;
  const code = firstString(payload.error, payload.code, top.error, top.code) ?? String(status);
  const message = pickText(top.error_description) ?? pickText(top.message) ?? pickText(detail) ?? `Sarv API ${status}`;
  return { code, message };
}

export interface SarvCatalogDeps {
  /** Main's configured Sarv API base URL. */
  apiBaseUrl: string;
  /** Mints the account's bearer; `forceRefresh` after a 401. */
  resolveBearer: BearerResolver;
  /** Main's fetch (Chromium's network stack). */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * Fetch one catalog list. Never throws: every failure comes back as
 * `{ ok: false, … }` so it crosses IPC intact.
 */
export async function fetchSarvCatalog(query: SarvCatalogQuery, deps: SarvCatalogDeps): Promise<SarvCatalogResult> {
  const url = sarvCatalogUrl(deps.apiBaseUrl, query);
  const timeoutMs = deps.timeoutMs ?? SARV_CATALOG_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithBearerRetry(deps.resolveBearer, (bearer) => deps.fetchImpl(url, {
      method: 'GET',
      // A redirect would carry the bearer — a mailbox credential — to
      // wherever the Location header points.
      redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    }));
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, ...parseSarvCatalogError(response.status, text) };
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status: response.status, code: 'invalid_response', message: `Sarv API ${response.status}: the catalog was not valid JSON` };
    }
  } catch (err) {
    if (isBearerUnavailableError(err)) {
      return {
        ok: false,
        status: 0,
        code: isSignInRequiredError(err.cause) ? 'sign_in_required' : 'token_unavailable',
        message: err.message,
      };
    }
    if (controller.signal.aborted) {
      return { ok: false, status: 0, code: 'timeout', message: `Sarv did not answer within ${timeoutMs / 1000}s` };
    }
    return { ok: false, status: 0, code: 'network', message: (err as Error)?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}
