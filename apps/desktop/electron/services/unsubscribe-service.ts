/**
 * Leaving a mailing list — the part that touches the network.
 *
 * The DECISION (which route a message offers, and what address that route
 * resolves to) lives in `@sarvinbox/core`'s `resolveUnsubscribeAction`, over the
 * headers the sender themselves set. This module only carries out the one
 * action that decision produced, so nothing here ever chooses a URL.
 *
 * ## Why the POST is written by hand rather than through a library
 *
 * RFC 8058 is one request with a fixed body and no response to parse. What the
 * request must NOT carry is the interesting part, and that is what an HTTP
 * convenience wrapper would quietly add back:
 *
 *   * no cookies and no cached credentials — Node's fetch has no jar and never
 *     sees the Electron session's, so the request cannot be linked to a signed-in
 *     browser identity on the sender's domain,
 *   * no `Referer`, and no request body beyond the required token,
 *   * no redirect off https: a 3xx to `http://` would replay the unsubscribe
 *     token in clear text, so the chain is followed only while it stays https.
 */
import { createLogger } from '@sarvinbox/core';

const logger = createLogger('unsubscribe');

/**
 * How long the reader waits before the click is reported as failed.
 *
 * `AbortSignal.timeout` rather than the shared `withTimeout` helper on purpose:
 * that one stops WAITING for a promise, while this one has to stop the REQUEST.
 * An unsubscribe POST left running after its deadline is an action the reader
 * was told did not happen and that may yet succeed, which is the one outcome a
 * confirmation dialog cannot describe.
 */
export const ONE_CLICK_TIMEOUT_MS = 15_000;

/** How many https hops a sender's unsubscribe link may take. */
export const MAX_REDIRECTS = 5;

export interface OneClickResult {
  ok: boolean;
  /** The final HTTP status, or null when the request never completed. */
  status: number | null;
  error?: string;
}

/** Minimal shape of `fetch`, so tests can supply one without a socket. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual'; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

/**
 * POST the RFC 8058 one-click body and report what the sender's endpoint said.
 *
 * Redirects are followed MANUALLY, and only to https, because `redirect:
 * 'follow'` would send the body onward to whatever Location names — including
 * a plaintext http URL carrying the unsubscribe token. Any non-2xx final status
 * is a failure the reader is told about rather than a silent no-op: a button
 * that reports success without one is how a reader keeps receiving mail they
 * believe they have left.
 */
export async function postOneClick(
  url: string,
  body: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<OneClickResult> {
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: { status: number; headers: { get(name: string): string | null } };
    try {
      response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
      });
    } catch (error) {
      // A blip, a DNS failure or the deadline above. Transient as far as the
      // reader is concerned: nothing was changed, and clicking again is safe.
      logger.warn(`One-click unsubscribe request failed: ${(error as Error).message}`);
      return { ok: false, status: null, error: (error as Error).message };
    }

    const { status } = response;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      const next = location ? nextHttpsHop(target, location) : null;
      if (!next) {
        return { ok: false, status, error: 'Unsubscribe link redirected somewhere we will not follow' };
      }
      target = next;
      continue;
    }

    if (status >= 200 && status < 300) return { ok: true, status };
    return { ok: false, status, error: `The sender's server answered ${status}` };
  }

  return { ok: false, status: null, error: 'Unsubscribe link redirected too many times' };
}

/** Resolve a Location header against the current URL, keeping https only. */
function nextHttpsHop(from: string, location: string): string | null {
  try {
    const next = new URL(location, from);
    return next.protocol === 'https:' ? next.toString() : null;
  } catch {
    return null;
  }
}
