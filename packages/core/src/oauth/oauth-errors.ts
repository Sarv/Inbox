// OAuth error classification — the single source of truth for "can retrying
// this ever work?".
//
// It lives in core rather than in the desktop main process because two very
// different layers need the SAME answer and must not drift: the refresh
// scheduler (retry, or ask the user to sign in?) and the IMAP connection
// manager's auth latch (should the reconnect ladder stop?). While those two
// disagreed, a revoked session produced an endless reconnect storm — a failure
// to MINT a bearer did not look like an authentication failure to the ladder,
// so it kept dialling and replaying a dead refresh token at the token endpoint
// hundreds of times a minute (observed 2026-09-08).

import { OAuthError } from './types';

/**
 * Every `code` the OAuth layer mints, so an error can be recognised as ours
 * WITHOUT `instanceof`.
 *
 * The class check is not safe here: core and the Electron main process are
 * bundled separately, so the same logical `OAuthError` can be two distinct
 * classes at runtime and `instanceof` silently answers false — which would
 * quietly disable the auth latch this list exists to drive. The code survives
 * any number of bundle boundaries.
 */
const OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'ACCOUNT_NOT_FOUND',
  'BAD_CALLBACK',
  'EMPTY_REFRESH_TOKEN',
  'EMPTY_STORED_TOKEN',
  'FLOW_CANCELLED',
  'FLOW_TIMEOUT',
  'NO_REFRESH_TOKEN',
  'PROVIDER_ERROR',
  'PROVIDER_NOT_CONFIGURED',
  'REAUTH_REQUIRED',
  'REFRESH_DEFERRED_SUSPENDED',
  'STATE_MISMATCH',
  'TOKEN_EXCHANGE_ABORTED',
  'TOKEN_EXCHANGE_EMPTY_ACCESS_TOKEN',
  'TOKEN_EXCHANGE_FAILED',
  'TOKEN_EXCHANGE_INVALID_RESPONSE',
  'TOKEN_EXCHANGE_NETWORK_ERROR',
  'TOKEN_EXCHANGE_TIMEOUT',
  'TOKEN_REFRESH_ABORTED',
  'TOKEN_REFRESH_EMPTY_ACCESS_TOKEN',
  'TOKEN_REFRESH_FAILED',
  'TOKEN_REFRESH_INVALID_RESPONSE',
  'TOKEN_REFRESH_NETWORK_ERROR',
  'TOKEN_REFRESH_TIMEOUT',
  'USERINFO_FAILED',
  'USERINFO_NO_EMAIL',
]);

/**
 * Whether this error came from the OAuth token layer at all.
 *
 * Callers that classify errors from MANY sources (see `isAuthError` in
 * `imap-errors`) must gate on this before reading a terminal/transient verdict,
 * because `isTerminalOAuthError` falls back to matching `(400)`/`(401)` in the
 * message — harmless for an error already known to be ours, but a trap for an
 * arbitrary IMAP or socket error that happens to carry those digits.
 */
export function isOAuthTokenError(err: unknown): boolean {
  if (err instanceof OAuthError) return true;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && OAUTH_ERROR_CODES.has(code);
}

/**
 * Whether an OAuth refresh error is TERMINAL — the refresh token itself is
 * dead/revoked/expired and ONLY interactive re-authentication can fix it — vs a
 * transient failure (network blip, rate-limit, 5xx) that's worth retrying.
 *
 * Terminal signals: a missing/blank stored token, an already-recorded
 * re-authentication requirement, or the token endpoint rejecting the grant
 * (`invalid_grant` / `invalid_client` / `unauthorized_client` / `invalid_token`,
 * or a 400/401 response). Everything else — `TOKEN_REFRESH_NETWORK_ERROR`, 429,
 * 5xx, timeouts — is transient.
 */
export function isTerminalOAuthError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string') {
    if (code === 'EMPTY_STORED_TOKEN' || code === 'EMPTY_REFRESH_TOKEN') return true;
    // Raised by the fast-fail gate in front of the token endpoint once a
    // session is known to need an interactive sign-in. It REPLAYS an earlier
    // terminal verdict, so it must classify the same way — otherwise the gate
    // that exists to stop a retry storm would itself read as transient and
    // feed one.
    if (code === 'REAUTH_REQUIRED') return true;
    if (code === 'TOKEN_REFRESH_NETWORK_ERROR') return false;
    // A refresh we cut short (deadline, suspend) or never started (asleep) says
    // NOTHING about the credentials. Treating these as terminal would sign the
    // user out over a laptop lid — the opposite of the bug being fixed here.
    if (
      code === 'TOKEN_REFRESH_TIMEOUT' ||
      code === 'TOKEN_REFRESH_ABORTED' ||
      code === 'REFRESH_DEFERRED_SUSPENDED'
    ) {
      return false;
    }
  }
  // `detail` is where OAuthError actually carries the provider's raw body;
  // `serverResponse` is the field other layers use. Reading only the latter
  // (as this did before it moved here) made the body fallback dead code for
  // every OAuthError — harmless so far only because the refresh path also
  // interpolates the body into the message, which is not a property to rely on.
  const e = err as { message?: string; serverResponse?: string; detail?: string };
  const msg = `${e?.message ?? ''} ${e?.serverResponse ?? ''} ${e?.detail ?? ''}`.toLowerCase();
  if (/invalid_grant|invalid_client|unauthorized_client|invalid_token/.test(msg)) return true;
  if (/\(400\)|\(401\)/.test(msg)) return true;
  return false;
}
