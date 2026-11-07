/**
 * AI provider requests that need a credential the renderer must not hold, sent
 * from main.
 *
 * The renderer also renders untrusted email HTML, so it never holds a SAVED API
 * key (CASA H-1) or a Sarv access token (CASA I-2) — the latter is also the
 * Sarv mailbox's XOAUTH2 credential (email:read/send/delete). It asks main to
 * make the request instead, naming the credential, never carrying it:
 *
 *  - a saved key, by provider id: main attaches the key, and only when the
 *    request goes to the endpoint origin it was saved for (`resolveAiKey`);
 *  - a Sarv sign-in, by provider and account email: main mints the bearer, and
 *    only for a Sarv AI endpoint (`sarvAIBearerResolver`, the same rule the
 *    background categorizers use). A 401 forces a fresh token and retries once.
 *
 * The URL comes from the renderer in both cases, which is why each check is
 * made here. Keys the user has just typed (onboarding, Settings tests) never
 * come here: the renderer already has those and sends them directly.
 */
import {
  aiApiKeyHeaders,
  aiEndpointOrigin,
  createLogger,
  fetchWithBearerRetry,
  isBearerUnavailableError,
  isSignInRequiredError,
  toOneLine,
} from '@sarvinbox/core';

import { resolveAiKey } from './ai-secret-store';
import { chromiumFetch } from './net-fetch';
import { sarvAIBearerResolver } from './oauth-service';

const logger = createLogger('ai-provider-proxy');

/** Ceiling for one proxied request; the renderer's own timeouts are shorter. */
const MAX_REQUEST_MS = 120_000;

export interface AiProviderFetchRequest {
  /** Lets the renderer abort this request (`abortAiProviderFetch`). */
  requestId: string;
  /** Saved-key requests: the provider whose saved key to attach. */
  providerId: string;
  /** Provider type — decides which header carries a saved key. */
  type: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /**
   * OAuth requests: which sign-in authenticates this one. Names the account —
   * never a token. Its presence selects the OAuth path.
   */
  oauth?: { provider: string; email: string };
}

export type AiProviderFetchResult =
  | {
    ok: true;
    status: number;
    statusText: string;
    contentType: string | null;
    /** The other response headers callers read (`retry-after`, `x-request-id`). */
    headers: Record<string, string>;
    body: string;
  }
  /** No usable saved key: none saved, or saved for a different endpoint. */
  | { ok: false; reason: 'no-key' | 'origin-mismatch' | 'invalid-request'; error: string }
  /** The OAuth sign-in may not authenticate this URL (not Sarv, or not a Sarv AI endpoint). */
  | { ok: false; reason: 'oauth-refused'; error: string }
  /** Permanent: only signing in again yields a token (revoked, signed out). */
  | { ok: false; reason: 'sign-in-required'; error: string }
  /** Transient: the token could not be refreshed right now (OAuth server unreachable). */
  | { ok: false; reason: 'token-unavailable'; error: string }
  /** The request itself failed (network, timeout, abort) — like a fetch rejection. */
  | { ok: false; reason: 'network' | 'aborted'; error: string };

/** Headers the renderer may not set: credentials are main's to attach. */
const STRIPPED_HEADERS = new Set(['authorization', 'x-goog-api-key', 'cookie', 'proxy-authorization']);

/**
 * Response headers handed back besides content-type: `retry-after` drives the
 * renderer's 429 back-off, `x-request-id` identifies the call to the provider.
 */
const FORWARDED_RESPONSE_HEADERS = ['retry-after', 'x-request-id'] as const;

const inFlight = new Map<string, AbortController>();

/** An `oauth` field the request may carry: a provider and a non-empty email. */
function isOAuthRef(value: unknown): value is { provider: string; email: string } {
  const v = value as { provider?: unknown; email?: unknown } | null;
  return !!v && typeof v === 'object' && typeof v.provider === 'string'
    && typeof v.email === 'string' && v.email.trim() !== '';
}

export async function proxyAiProviderFetch(req: AiProviderFetchRequest): Promise<AiProviderFetchResult> {
  const origin = aiEndpointOrigin(req?.url);
  const method = req?.method ?? 'POST';
  const usesOAuth = req?.oauth !== undefined;
  if (
    !req?.requestId || !origin || (method !== 'GET' && method !== 'POST')
    || (usesOAuth ? !isOAuthRef(req.oauth) : !req.providerId)
  ) {
    return { ok: false, reason: 'invalid-request', error: 'Invalid AI provider request.' };
  }

  // Registered before the first await, so an abort sent while main is still
  // resolving the credential is not lost.
  const controller = new AbortController();
  inFlight.set(req.requestId, controller);
  const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === 'string' && !STRIPPED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  const send = (auth: Record<string, string>) => chromiumFetch(req.url, {
    method,
    headers: { ...headers, ...auth },
    body: method === 'POST' ? req.body : undefined,
    // A redirect could carry the credential to another origin.
    redirect: 'error',
    signal: controller.signal,
  });

  try {
    let response: Response;
    if (usesOAuth) {
      const { provider, email } = req.oauth!;
      // Refused before the token store is read.
      const resolveBearer = sarvAIBearerResolver(provider, email, req.url);
      if (!resolveBearer) {
        return { ok: false, reason: 'oauth-refused', error: `Only a Sarv sign-in can authenticate AI requests, and only to Sarv AI — not ${origin}.` };
      }
      response = await fetchWithBearerRetry(
        (forceRefresh) => {
          if (forceRefresh) logger.info(`[AiProxy] ${origin} refused the Sarv token (401) — refreshing it and retrying once`);
          return resolveBearer(forceRefresh);
        },
        (bearer) => send({ Authorization: `Bearer ${bearer}` }),
      );
    } else {
      const saved = await resolveAiKey(req.providerId, req.url);
      if (saved.status === 'none') {
        return { ok: false, reason: 'no-key', error: 'No API key is saved for this AI provider. Enter it in Settings → AI.' };
      }
      if (saved.status === 'origin-mismatch') {
        return {
          ok: false,
          reason: 'origin-mismatch',
          error: `Your saved API key is for ${saved.boundOrigin}. Re-enter your API key to use ${origin}.`,
        };
      }
      response = await send(aiApiKeyHeaders(req.type, saved.key));
    }
    const forwarded: Record<string, string> = {};
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) forwarded[name] = value;
    }
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      headers: forwarded,
      body: await response.text(),
    };
  } catch (error) {
    // Checked first: once the renderer has given up, why is moot.
    if (controller.signal.aborted) return { ok: false, reason: 'aborted', error: 'The AI request was cancelled.' };
    if (isBearerUnavailableError(error)) {
      // The account and the OAuth error stay out of the log; the renderer
      // gets the message it always showed.
      const signIn = isSignInRequiredError(error.cause);
      logger.warn(`[AiProxy] no Sarv token for ${origin}: ${signIn ? 'sign-in required' : 'refresh failed, transient'}`);
      return { ok: false, reason: signIn ? 'sign-in-required' : 'token-unavailable', error: error.message };
    }
    // One line: a fetch error can quote renderer text (an invalid header value
    // with a CR/LF in it), which must not be able to forge app.log lines.
    logger.warn(`[AiProxy] request to ${origin} failed: ${toOneLine((error as Error).message)}`);
    return { ok: false, reason: 'network', error: (error as Error).message };
  } finally {
    clearTimeout(timer);
    inFlight.delete(req.requestId);
  }
}

/** Abort a proxied request the renderer gave up on. No-op if it already settled. */
export function abortAiProviderFetch(requestId: string): void {
  inFlight.get(requestId)?.abort();
}
