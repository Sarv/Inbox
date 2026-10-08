/**
 * AI provider requests that need a SAVED API key, sent from main.
 *
 * The renderer never holds a saved key (CASA H-1): it asks main to make the
 * request, naming the provider by id. Main attaches the key itself — and only
 * when the request goes to the endpoint origin the key was saved for, because
 * the URL comes from the renderer too (see `resolveAiKey`). Keys the user has
 * just typed (onboarding, Settings tests) never come here: the renderer
 * already has those and sends them directly.
 */
import { aiApiKeyHeaders, aiEndpointOrigin, createLogger } from '@sarvinbox/core';

import { resolveAiKey } from './ai-secret-store';
import { chromiumFetch } from './net-fetch';

const logger = createLogger('ai-provider-proxy');

/** Ceiling for one proxied request; the renderer's own timeouts are shorter. */
const MAX_REQUEST_MS = 120_000;

export interface AiProviderFetchRequest {
  /** Lets the renderer abort this request (`abortAiProviderFetch`). */
  requestId: string;
  providerId: string;
  /** Provider type — decides which header carries the key. */
  type: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export type AiProviderFetchResult =
  | { ok: true; status: number; statusText: string; contentType: string | null; body: string }
  /** No usable saved key: none saved, or saved for a different endpoint. */
  | { ok: false; reason: 'no-key' | 'origin-mismatch' | 'invalid-request'; error: string }
  /** The request itself failed (network, timeout, abort) — like a fetch rejection. */
  | { ok: false; reason: 'network' | 'aborted'; error: string };

/** Headers the renderer may not set: credentials are main's to attach. */
const STRIPPED_HEADERS = new Set(['authorization', 'x-goog-api-key', 'cookie', 'proxy-authorization']);

const inFlight = new Map<string, AbortController>();

export async function proxyAiProviderFetch(req: AiProviderFetchRequest): Promise<AiProviderFetchResult> {
  const origin = aiEndpointOrigin(req?.url);
  const method = req?.method ?? 'POST';
  if (!req?.providerId || !req.requestId || !origin || (method !== 'GET' && method !== 'POST')) {
    return { ok: false, reason: 'invalid-request', error: 'Invalid AI provider request.' };
  }

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

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (typeof value === 'string' && !STRIPPED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  Object.assign(headers, aiApiKeyHeaders(req.type, saved.key));

  const controller = new AbortController();
  inFlight.set(req.requestId, controller);
  const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS);
  try {
    const response = await chromiumFetch(req.url, {
      method,
      headers,
      body: method === 'POST' ? req.body : undefined,
      // A redirect could carry the key header to another origin.
      redirect: 'error',
      signal: controller.signal,
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type'),
      body: await response.text(),
    };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: 'aborted', error: 'The AI request was cancelled.' };
    logger.warn(`[AiProxy] request to ${origin} failed: ${(error as Error).message}`);
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
