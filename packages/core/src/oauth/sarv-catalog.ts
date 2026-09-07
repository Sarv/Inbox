/**
 * Sarv CAI catalog fetchers — ``/oauth/v1/llm/*`` + ``/oauth/v1/zones``.
 *
 * These are read-only discovery endpoints that let the app populate its
 * provider / model / zone pickers without hard-coding the catalog. Each
 * call needs a valid oauth JWT with the ``llm:view`` scope.
 *
 * Endpoints (canonical, from Sarv OAuth spec):
 *   GET  {apiBaseUrl}/oauth/v1/llm/providers
 *   GET  {apiBaseUrl}/oauth/v1/llm/models[?provider_code=…]
 *   GET  {apiBaseUrl}/oauth/v1/zones
 *
 * The ``apiBaseUrl`` is whatever ``buildSarvProvider`` resolves to at
 * runtime (prod ``https://ai.sarv.com``, dev ``http://localhost:<port>``).
 *
 * Error handling: on a non-2xx, we surface the same ``SarvApiError`` shape
 * the chat path throws, so the calling UI only needs one error handler.
 */
import { SarvApiError, type SarvErrorCode } from '../agent/categorization-utils';

export interface SarvLLMProvider {
  code: string;
  name: string;
}

export interface SarvLLMModel {
  code: string;
  display_name?: string | null;
  provider_code: string;
  supports_streaming: boolean;
}

export interface SarvZone {
  code: string;
  name?: string | null;
}

export interface SarvWallet {
  balance: number;
  currency: string;
  locked: boolean;
}

/** Fetch and throw a typed error on non-2xx. Shared by the four fetchers. */
async function getJson<T>(url: string, accessToken: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    signal,
  });
  if (!res.ok) {
    throw await buildSarvApiError(res);
  }
  return (await res.json()) as T;
}

/** Minimal duplicate of ``parseSarvApiError`` — kept separate so this file
 * doesn't depend on Node / browser Response internals the rest of ``agent``
 * already guards against. Any future change to error-parsing should apply
 * to both. */
async function buildSarvApiError(response: Response): Promise<SarvApiError> {
  const raw = await response.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { /* not JSON */ }
  const payload = body?.detail ?? body;
  const errCode: string | undefined =
    (typeof payload === 'object' && payload && typeof payload.error === 'string')
      ? payload.error
      : undefined;
  const known: ReadonlySet<SarvErrorCode> = new Set<SarvErrorCode>([
    'invalid_token', 'cai_account_required', 'insufficient_scope',
    'insufficient_role', 'insufficient_balance', 'rate_limit_exceeded',
  ]);
  const code: SarvErrorCode = (errCode && known.has(errCode as SarvErrorCode))
    ? (errCode as SarvErrorCode)
    : (response.status === 401 ? 'invalid_token'
      : response.status === 402 ? 'insufficient_balance'
      : response.status === 429 ? 'rate_limit_exceeded'
      : 'upstream_error');
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined;
  const message =
    (typeof payload === 'object' && payload && typeof payload.message === 'string')
      ? payload.message
      : `Sarv API ${response.status}`;
  return new SarvApiError(message, { status: response.status, code, retryAfterSec, detail: payload });
}

export async function fetchSarvProviders(
  apiBaseUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SarvLLMProvider[]> {
  return getJson<SarvLLMProvider[]>(
    `${apiBaseUrl.replace(/\/$/, '')}/oauth/v1/llm/providers`,
    accessToken,
    signal,
  );
}

export async function fetchSarvModels(
  apiBaseUrl: string,
  accessToken: string,
  options: { providerCode?: string; signal?: AbortSignal } = {},
): Promise<SarvLLMModel[]> {
  const qs = options.providerCode
    ? `?provider_code=${encodeURIComponent(options.providerCode)}`
    : '';
  return getJson<SarvLLMModel[]>(
    `${apiBaseUrl.replace(/\/$/, '')}/oauth/v1/llm/models${qs}`,
    accessToken,
    options.signal,
  );
}

export async function fetchSarvZones(
  apiBaseUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SarvZone[]> {
  return getJson<SarvZone[]>(
    `${apiBaseUrl.replace(/\/$/, '')}/oauth/v1/zones`,
    accessToken,
    signal,
  );
}

/** Requires ``wallet:view`` scope. Optional — only call if the app has UI
 * for showing the user's CAI balance. */
export async function fetchSarvWallet(
  apiBaseUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SarvWallet> {
  return getJson<SarvWallet>(
    `${apiBaseUrl.replace(/\/$/, '')}/oauth/v1/wallet`,
    accessToken,
    signal,
  );
}
