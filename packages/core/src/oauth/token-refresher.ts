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
 * POST to the token endpoint and return the raw Response, surfacing any
 * network-level failure with enough context (URL, underlying cause code)
 * to diagnose "fetch failed" noise from Node's undici. Without this, an
 * ECONNREFUSED against a dev OAuth server bubbles up as a bare "fetch
 * failed" and the caller has no idea *which* host is unreachable.
 */
async function postToTokenEndpoint(
  tokenEndpoint: string,
  init: { headers: Record<string, string>; body: string },
  errorCode: string,
): Promise<Response> {
  try {
    return await fetch(tokenEndpoint, {
      method: 'POST',
      headers: init.headers,
      body: init.body,
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const causeCode = e.cause?.code ? ` [${e.cause.code}]` : '';
    const causeMsg = e.cause?.message ? `: ${e.cause.message}` : '';
    logger.error('[OAuth] Network error reaching', tokenEndpoint, e);
    throw new OAuthError(
      `Cannot reach OAuth server${causeCode} at ${tokenEndpoint}${causeMsg}`,
      errorCode,
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
}): Promise<OAuthTokenResponse> {
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
    'TOKEN_EXCHANGE_NETWORK_ERROR',
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
}): Promise<OAuthTokenResponse> {
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
    'TOKEN_REFRESH_NETWORK_ERROR',
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
