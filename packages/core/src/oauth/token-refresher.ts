import { createLogger } from '../utils/logger';

import type { OAuthProviderConfig, OAuthTokenResponse } from './types';
import { OAuthError } from './types';

const logger = createLogger('OAuth');

function encodeTokenBody(
  provider: OAuthProviderConfig,
  params: Record<string, string>,
): { headers: Record<string, string>; body: string } {
  if (provider.tokenBodyFormat === 'json') {
    return {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params),
    };
  }
  return {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  };
}

/**
 * How long a single token-endpoint POST may run before it is ABORTED.
 *
 * This is a real `AbortSignal`, not a `Promise.race`, and the difference is the
 * entire point. `withTimeout` only rejects the CALLER — the HTTP request keeps
 * running with nobody listening. Against a provider that ROTATES refresh
 * tokens that is fatal: the server rotates and marks the presented token
 * consumed, no response ever reaches us so the new token is never persisted,
 * and the next refresh replays a spent token. A reuse detector cannot tell that
 * apart from a stolen token and revokes the whole session.
 *
 * Observed 2026-09-08: a refresh issued inside a 2-second macOS dark-wake was
 * orphaned when the machine slept; the next wake replayed the spent token and
 * Sarv revoked the session at 05:14 — every refresh for the following nine
 * hours returned 400 "Refresh token reuse detected".
 *
 * 8s is deliberately UNDER the IMAP connect path's outer bearer race (see
 * `RESOLVE_BEARER_TIMEOUT_MS`, derived from this constant) so this abort always
 * fires first and the request dies at a moment we chose.
 *
 * Aborting does NOT prove the server declined to commit the rotation — nothing
 * client-side can — so the resulting error says the token state is UNKNOWN
 * instead of pretending the refresh simply failed. The complete remedy is a
 * server-side grace window that briefly honours the previous token.
 */
export const TOKEN_REQUEST_TIMEOUT_MS = 8_000;

/**
 * The interactive code-for-token exchange gets a longer leash: a human is
 * waiting, it runs once, and there is no stored refresh token to lose if it is
 * cut short — a failed exchange just fails the sign-in.
 */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 20_000;

/** Error codes a token POST can fail with, per calling flow. */
interface TokenRequestCodes {
  network: string;
  timeout: string;
  aborted: string;
}

/** Caller-supplied cancellation for a token request. */
export interface TokenRequestControl {
  /**
   * Aborts the request from outside — e.g. the desktop app cancelling refreshes
   * as the machine suspends, so the socket closes at a known moment rather than
   * being frozen mid-flight by sleep. A string `reason` is surfaced in the error.
   */
  signal?: AbortSignal;
  /** Override the per-request abort deadline (defaults per flow). */
  timeoutMs?: number;
}

/**
 * Why a token POST ended, decided from the SIGNALS rather than the thrown
 * value. `fetch` rejects with the signal's `reason`, which may be a plain
 * string (not an Error) and differs across runtimes, so inspecting the signals
 * is the only stable classification.
 */
function abortCause(
  external: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): 'aborted' | 'timeout' | null {
  if (external?.aborted) return 'aborted';
  if (timeoutSignal.aborted) return 'timeout';
  return null;
}

/**
 * POST to the token endpoint and return the raw Response, surfacing any
 * network-level failure with enough context (URL, underlying cause code)
 * to diagnose "fetch failed" noise from Node's undici. Without this, an
 * ECONNREFUSED against a dev OAuth server bubbles up as a bare "fetch
 * failed" and the caller has no idea *which* host is unreachable.
 *
 * Every request is cancellable and self-limiting: it carries an AbortSignal
 * combining the caller's (if any) with its own deadline, so it can never
 * outlive the code that asked for it.
 */
async function postToTokenEndpoint(
  tokenEndpoint: string,
  init: { headers: Record<string, string>; body: string },
  codes: TokenRequestCodes,
  control: TokenRequestControl = {},
): Promise<Response> {
  const timeoutMs = control.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = control.signal
    ? AbortSignal.any([control.signal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(tokenEndpoint, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal,
    });
  } catch (err) {
    // An abort is not a network fault, and above all not an auth fault: the
    // request may have been fully processed server-side. Say so, so no caller
    // treats it as "the refresh definitely did not happen".
    const cause = abortCause(control.signal, timeoutSignal);
    if (cause === 'aborted') {
      const why = typeof control.signal?.reason === 'string'
        ? control.signal.reason
        : 'cancelled by the caller';
      logger.warn('[OAuth] Token request cancelled', tokenEndpoint, `(${why})`);
      throw new OAuthError(
        `OAuth token request to ${tokenEndpoint} was cancelled (${why}) — the server may still have processed it, so the token state is unknown`,
        codes.aborted,
      );
    }
    if (cause === 'timeout') {
      logger.warn('[OAuth] Token request timed out', tokenEndpoint, `after ${timeoutMs}ms`);
      throw new OAuthError(
        `OAuth token request to ${tokenEndpoint} timed out after ${timeoutMs}ms — the server may still have processed it, so the token state is unknown`,
        codes.timeout,
      );
    }

    const e = err as Error & { cause?: { code?: string; message?: string } };
    const causeCode = e.cause?.code ? ` [${e.cause.code}]` : '';
    const causeMsg = e.cause?.message ? `: ${e.cause.message}` : '';
    logger.error('[OAuth] Network error reaching', tokenEndpoint, e);
    throw new OAuthError(
      `Cannot reach OAuth server${causeCode} at ${tokenEndpoint}${causeMsg}`,
      codes.network,
    );
  }
}

/**
 * Read an OK token-endpoint response into a validated `OAuthTokenResponse`.
 *
 * Two failure modes are classified here instead of leaking out raw:
 *
 *  1. NON-JSON 200 — a captive portal / corporate proxy / misrouted reverse
 *     proxy answers 200 with an HTML interstitial. `res.json()` then rejects
 *     with a bare `SyntaxError`, whose `code` is `undefined`, so callers that
 *     branch on `err.code` (see `isTerminalOAuthError` in the desktop
 *     oauth-service) can classify it neither as terminal nor as transient.
 *     A snippet of the body is carried in the message/detail so the log shows
 *     WHAT answered instead of just "Unexpected token <".
 *
 *  2. EMPTY / WHITESPACE access_token on a 200 — some servers report a
 *     transient internal failure this way. Passing it through means the caller
 *     persists it and every later IMAP/SMTP connect sends
 *     `user=…\x01auth=Bearer \x01\x01`; the mail server answers
 *     AUTHENTICATIONFAILED, which is indistinguishable from a genuinely
 *     expired token and drives the app into a re-login loop. Rejecting it at
 *     the source gives it its own code so the caller can tell "the server gave
 *     us nothing usable" from "our token is dead".
 */
async function parseTokenResponse(
  res: Response,
  codes: { invalidResponse: string; emptyAccessToken: string },
  what: 'Token exchange' | 'Token refresh',
): Promise<OAuthTokenResponse> {
  const raw = await res.text().catch(() => '');
  let parsed: OAuthTokenResponse;
  try {
    parsed = JSON.parse(raw) as OAuthTokenResponse;
  } catch {
    const snippet = raw.trim().slice(0, 200);
    logger.error(`[OAuth] ${what} returned a non-JSON body:`, snippet || '(empty)');
    throw new OAuthError(
      `${what} returned a non-JSON body (${res.status}): ${snippet || 'empty body'}`,
      codes.invalidResponse,
      raw,
    );
  }

  if (typeof parsed?.access_token !== 'string' || parsed.access_token.trim() === '') {
    logger.error(`[OAuth] ${what} succeeded but carried no usable access_token`);
    throw new OAuthError(
      `${what} succeeded (${res.status}) but returned an empty access_token`,
      codes.emptyAccessToken,
      raw,
    );
  }

  return parsed;
}

/**
 * Exchange an authorization code (+ PKCE verifier) for access + refresh tokens.
 */
export async function exchangeCodeForTokens(opts: {
  provider: OAuthProviderConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
} & TokenRequestControl): Promise<OAuthTokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: opts.provider.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  };
  if (opts.provider.clientSecret) {
    params.client_secret = opts.provider.clientSecret;
  }

  const { headers, body } = encodeTokenBody(opts.provider, params);
  const res = await postToTokenEndpoint(
    opts.provider.tokenEndpoint,
    { headers, body },
    {
      network: 'TOKEN_EXCHANGE_NETWORK_ERROR',
      timeout: 'TOKEN_EXCHANGE_TIMEOUT',
      aborted: 'TOKEN_EXCHANGE_ABORTED',
    },
    { signal: opts.signal, timeoutMs: opts.timeoutMs ?? TOKEN_EXCHANGE_TIMEOUT_MS },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Surface the provider's actual error in the message so the renderer
    // shows "invalid_grant" / "redirect_uri_mismatch" etc. instead of just
    // "400".
    logger.error('[OAuth] Token exchange failed:', res.status, text);
    throw new OAuthError(
      `Token exchange failed (${res.status}): ${text || 'no body'}`,
      'TOKEN_EXCHANGE_FAILED',
      text,
    );
  }

  return parseTokenResponse(
    res,
    {
      invalidResponse: 'TOKEN_EXCHANGE_INVALID_RESPONSE',
      emptyAccessToken: 'TOKEN_EXCHANGE_EMPTY_ACCESS_TOKEN',
    },
    'Token exchange',
  );
}

/**
 * Refresh an access token using a stored refresh token.
 * Note: Google may omit refresh_token in the response — keep the stored one.
 */
export async function refreshAccessToken(opts: {
  provider: OAuthProviderConfig;
  refreshToken: string;
} & TokenRequestControl): Promise<OAuthTokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: opts.provider.clientId,
    refresh_token: opts.refreshToken,
  };
  if (opts.provider.clientSecret) {
    params.client_secret = opts.provider.clientSecret;
  }

  const { headers, body } = encodeTokenBody(opts.provider, params);
  const res = await postToTokenEndpoint(
    opts.provider.tokenEndpoint,
    { headers, body },
    {
      network: 'TOKEN_REFRESH_NETWORK_ERROR',
      timeout: 'TOKEN_REFRESH_TIMEOUT',
      aborted: 'TOKEN_REFRESH_ABORTED',
    },
    { signal: opts.signal, timeoutMs: opts.timeoutMs },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.error('[OAuth] Token refresh failed:', res.status, text);
    throw new OAuthError(
      `Token refresh failed (${res.status}): ${text || 'no body'}`,
      'TOKEN_REFRESH_FAILED',
      text,
    );
  }

  return parseTokenResponse(
    res,
    {
      invalidResponse: 'TOKEN_REFRESH_INVALID_RESPONSE',
      emptyAccessToken: 'TOKEN_REFRESH_EMPTY_ACCESS_TOKEN',
    },
    'Token refresh',
  );
}
