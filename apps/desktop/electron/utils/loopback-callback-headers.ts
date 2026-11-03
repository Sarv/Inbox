/**
 * The headers every OAuth loopback callback response carries — the mail/Sarv
 * sign-in listener (oauth-service.ts) and the antivirus scanner's
 * (antivirus-oauth-service.ts) answer the browser through the same rules, so
 * they live here once instead of drifting apart in two inline copies (CASA
 * 3.2.2).
 *
 * The browser arrives with the authorization code in its URL, so each response:
 *   - is never cached (`no-store`) — a cached page is a stored copy of a URL
 *     that carried a code;
 *   - never leaks that URL onward (`no-referrer`);
 *   - can run nothing, load nothing, submit nowhere and not be framed (CSP);
 *   - is not content-sniffed into something else (`nosniff`);
 *   - closes its connection — the listener goes away as soon as the sign-in
 *     settles, so a kept-alive socket would only be handed to a dead server.
 */

import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * The Content-Security-Policy for a loopback callback page. Nothing is allowed
 * by default; `inlineStyle` — the exact text inside the page's one `<style>`
 * element — is admitted by its SHA-256 hash, never by `'unsafe-inline'`, so a
 * style that was not written into the page itself cannot apply.
 */
export function loopbackCallbackCsp(options: { inlineStyle?: string } = {}): string {
  const directives = ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"];
  if (options.inlineStyle !== undefined) {
    const hash = createHash('sha256').update(options.inlineStyle, 'utf8').digest('base64');
    directives.push(`style-src 'sha256-${hash}'`);
  }
  return directives.join('; ');
}

/** The policy for a page with no styling of its own (plain-text responses). */
export const LOOPBACK_CALLBACK_CSP = loopbackCallbackCsp();

/**
 * Stamp the callback headers on `response`. Call it FIRST, before any branch
 * writes a status, so every answer — the success page, an error, a 404 or a
 * 405 — carries them.
 */
export function setLoopbackCallbackHeaders(response: ServerResponse, csp: string = LOOPBACK_CALLBACK_CSP): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Connection', 'close');
}
