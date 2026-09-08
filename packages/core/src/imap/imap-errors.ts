// Centralized IMAP error classification — the single source of truth for how to
// react to a failure. Previously duplicated (with divergent substring lists)
// across connection-manager, operation-queue, and realtime-manager, which let
// quota/throttle responses be misclassified as generic failures and retried
// into a storm.
//
// Ordering matters at call sites: check isRateLimited / isQuotaError BEFORE
// isConnectionError, since a quota/throttle error is not a socket failure and
// must be backed off, not reconnected.

import { isOAuthTokenError, isTerminalOAuthError } from '../oauth/oauth-errors';

type AnyErr = Error & {
  code?: string;
  textCode?: string;
  source?: string;
  serverResponse?: string;
  responseText?: string;
  throttleReset?: number;
  status?: number;
  cause?: unknown;
};

/**
 * Lowercased haystack of all human-readable fields on the error — including
 * `error.cause`. undici's `fetch` rejects with a bland `TypeError: fetch failed`
 * and stashes the real reason (ECONNREFUSED / ENOTFOUND / ETIMEDOUT …) on
 * `.cause`, so classifiers must look there too or every network fetch failure
 * reads as "unknown".
 */
function haystack(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const e = error as AnyErr;
  const causeText = e.cause instanceof Error
    ? e.cause.message
    : typeof e.cause === 'string'
      ? e.cause
      : '';
  const causeCode = e.cause instanceof Error ? (e.cause as AnyErr).code || '' : '';
  return [e.message, causeText, causeCode, e.serverResponse, e.responseText]
    .filter(Boolean).join(' ').toLowerCase();
}

/**
 * Split a failed IMAP op into the three things the Outbox "Failed actions" list
 * shows the user: the error message, the COMMAND we sent, and the SERVER's reply.
 *   - `attemptedCommand`: the literal IMAP command (ImapFlow `executedCommand`),
 *     e.g. "UID STORE 3085 +FLAGS (\Seen)". Undefined for connection errors — the
 *     op never reached the server — where the UI falls back to describing the op.
 *   - `serverResponse`: the tagged NO/BAD status + server text, e.g.
 *     "NO [TRYCREATE] Mailbox doesn't exist". Undefined when there was no reply
 *     (a pure connection failure) — then the message ("Connection not available")
 *     is the whole story.
 * Works on both our IMAPError and a raw ImapFlow error.
 */
export function extractOpFailureDetail(error: unknown): {
  message: string;
  attemptedCommand?: string;
  serverResponse?: string;
} {
  const e = error as (Error & {
    executedCommand?: string;
    responseStatus?: string;
    responseText?: string;
    serverResponse?: string;
  }) | undefined;
  const message = e?.message ?? String(error);
  const attemptedCommand = e?.executedCommand || undefined;
  const serverResponse = [e?.responseStatus, e?.responseText ?? e?.serverResponse]
    .filter(Boolean)
    .join(' ')
    .trim() || undefined;
  return { message, attemptedCommand, serverResponse };
}

/**
 * ImapFlow's connect-PHASE timeouts — the TCP/TLS connect, the STARTTLS upgrade,
 * or the server greeting failing to complete inside ImapFlow's OWN window (10s by
 * default here). ImapFlow raises these as plain `Error`s with `code` one of
 * CONNECT_TIMEOUT / UPGRADE_TIMEOUT / GREETING_TIMEOUT and a "... in required
 * time" message. Our `toImapError` rewrites that code to the generic
 * CONNECTION_ERROR but KEEPS the message verbatim, so we match on BOTH the raw
 * code (defense in depth for un-wrapped errors) and the surviving message.
 *
 * These slip past `isTimeoutError` (they are not our withTimeout `TimeoutError`
 * and carry no `isTimeout` flag) AND — because "required time" is neither "timed
 * out" nor "timeout" — past every substring in `isConnectionError` too, so with
 * nothing matching them they were classified as NOTHING. Near a saturated
 * per-account cap (Gmail ~15) a fresh connect just hangs until this fires, which
 * makes it the DOMINANT failure of the pool's backfill/drain: the shared quota
 * back-off never recognised it, so the pool re-hammered the cap indefinitely.
 * It must be treated as a connection error AND parked. */
export function isConnectTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as AnyErr).code;
  if (code === 'CONNECT_TIMEOUT' || code === 'UPGRADE_TIMEOUT' || code === 'GREETING_TIMEOUT') {
    return true;
  }
  return haystack(error).includes('in required time');
}

/**
 * The pool's own connection-cap back-off refusal (`PoolConnectionParkedError`):
 * a connect was declined because the shared per-account window is still parked.
 * It is NOT a socket failure and NOT the op's fault — the right response is to
 * retry after the window, exactly like a transient connection error — so it is
 * folded into `isConnectionError` below, which is what every re-queue / "don't
 * dead-letter" / "don't WARN-spam" guard already keys off. Matched by message
 * because the class lives in connection-pool.ts and importing it here would be a
 * circular dependency; the message is stable and distinctive.
 */
export function isConnectionParkedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return haystack(error).includes('connection pool parked');
}

/**
 * Socket/network-level failure — reconnecting (IMAP) or retrying (HTTP) is the
 * correct response. Deliberately conservative (does NOT match a bare
 * "timeout"/"connection") so a command-level timeout isn't mistaken for a dead
 * socket and re-queued forever. Also covers undici `fetch failed` (host
 * unreachable / DNS / connection refused) so LLM HTTP calls can reuse this.
 */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // ImapFlow's connect/upgrade/greeting timeouts are genuine connection-
  // establishment failures — reconnect/retry, don't dead-letter — but their
  // "in required time" wording matches none of the substrings below.
  if (isConnectTimeoutError(error)) return true;
  // A pool cap back-off refusal is "connection temporarily unavailable, retry
  // later" — the same handling as a transient connection error (re-queue, no
  // dead-letter, no error-level log).
  if (isConnectionParkedError(error)) return true;
  const m = haystack(error);
  return (
    m.includes('connection ended') ||
    m.includes('connection closed') ||
    m.includes('not connected') ||
    // ImapFlow raises "Connection not available" (code NoConnection) when the
    // socket drops mid-command — and our openFolder wraps it as
    // SELECT_FOLDER_ERROR with the same message. It means the CONNECTION died,
    // not that the op is invalid, so RE-QUEUE + retry after reconnect instead of
    // dead-lettering a valid op (the label-mirror ops that piled up as "failed"
    // on disconnect/shutdown).
    m.includes('connection not available') ||
    m.includes('socket') ||
    m.includes('epipe') ||
    m.includes('econnreset') ||
    m.includes('econnrefused') ||
    m.includes('etimedout') ||
    // Our own op/connect timeouts (withTimeout → "IMAP STORE … timed out after
    // 60000ms", "… timed out after Nms") mean the CONNECTION is hung, not that
    // the change is invalid. Treat as connection errors so the op-queue RE-QUEUES
    // and retries after reconnect instead of dead-lettering a valid read/move on
    // the first stall (the "Failed actions" pile-up on a flaky server).
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('enotconn') ||
    m.includes('enotfound') ||
    m.includes('eai_again') ||
    m.includes('ehostunreach') ||
    m.includes('enetunreach') ||
    m.includes('enetdown') ||
    m.includes('fetch failed')
  );
}

/**
 * Transient HTTP *upstream* failure — a valid response from a gateway/proxy
 * (nginx, Cloudflare, a load balancer) that couldn't reach the real backend:
 * 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout. Distinct from
 * isConnectionError (socket/DNS level) because the HTTP round-trip *succeeded*
 * — so retrying next cycle is the right response, just like a network blip.
 * Reads the `status` attached at the fetch throw site, with a message/body
 * fallback for callers that don't set it.
 */
export function isUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as AnyErr).status;
  if (status === 502 || status === 503 || status === 504) return true;
  const m = haystack(error);
  return (
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504') ||
    m.includes('bad gateway') ||
    m.includes('service unavailable') ||
    m.includes('gateway timeout')
  );
}

/** Authentication failure — terminal until the user re-enters credentials. */
export function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as AnyErr;
  if (e.textCode === 'AUTHENTICATIONFAILED') return true;
  if (e.source === 'authentication') return true;
  // A connect that could not MINT a bearer because the OAuth session is
  // revoked/expired never reaches the server, so none of the substrings below
  // appear — yet it is terminal in exactly the sense this latch exists for:
  // retrying re-runs the identical rejection. Without this, a revoked refresh
  // token left the reconnect ladder dialling forever, replaying a dead token at
  // the token endpoint hundreds of times a minute (observed 2026-09-08).
  //
  // Delegated to isTerminalOAuthError rather than matched on text, because the
  // distinction that matters is by ERROR CODE: a refresh cut short by a closing
  // laptop lid or a network blip must NOT latch this, or a sleeping machine
  // would stop reconnecting until the user signed in again.
  if (isOAuthTokenError(error)) return isTerminalOAuthError(error);
  const m = haystack(error);
  return (
    m.includes('invalid credentials') ||
    m.includes('authentication failed') ||
    m.includes('authenticationfailed') ||
    m.includes('login failed') ||
    m.includes('bad credentials') ||
    m.includes('app password') ||
    // ImapFlow could not agree on ANY SASL mechanism: it has a token but the
    // server advertises no AUTH=XOAUTH2/OAUTHBEARER, or a password but no
    // AUTH=PLAIN/LOGIN. Terminal in exactly the same way — retrying re-runs the
    // identical capability check — so it must stop the reconnect ladder and
    // surface re-authentication rather than spin forever.
    m.includes('unsupported authentication mechanism')
  );
}

/**
 * Per-account connection-cap violation (e.g. Gmail's ~15 simultaneous
 * connections). Retrying immediately just adds another connect against a
 * saturated cap — the caller must back off and shrink concurrency instead.
 */
export function isQuotaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const m = haystack(error);
  return (
    m.includes('too many simultaneous connections') ||
    m.includes('connection limit') ||
    m.includes('maximum number of connections') ||
    m.includes('overquota')
  );
}

/**
 * Server-requested throttling / rate limit. ImapFlow parses the throttle
 * response, waits out the server's suggested delay internally, then rejects
 * with `code === 'ETHROTTLE'` and `throttleReset` (ms). We honor that instead
 * of retrying blindly.
 */
export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as AnyErr;
  if (e.code === 'ETHROTTLE') return true;
  const m = haystack(error);
  return (
    m.includes('throttled') ||
    m.includes('throttle') ||
    m.includes('backoff') ||
    m.includes('rate limit') ||
    m.includes('try again later')
  );
}

/**
 * Server-suggested backoff delay in ms from a rate-limit error, if provided
 * (ImapFlow's `throttleReset`). Callers should add jitter and apply a sane cap.
 */
export function getSuggestedBackoffMs(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const reset = (error as AnyErr).throttleReset;
  return typeof reset === 'number' && reset > 0 ? reset : null;
}

/**
 * Human-readable one-line description of a (possibly network) error, unwrapping
 * undici's `error.cause`. A bare "fetch failed" tells you nothing; this surfaces
 * the real reason — ENOTFOUND (DNS/VPN), ECONNREFUSED (nothing listening),
 * ETIMEDOUT (firewall/proxy), or a TLS cert error — so failures are diagnosable
 * instead of opaque.
 */
export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as AnyErr;
  const cause = e.cause instanceof Error ? (e.cause as AnyErr) : undefined;
  const code = e.code || cause?.code || '';
  const causeMsg = cause?.message || '';
  const detail = [code, causeMsg].filter(Boolean).join(': ');
  return detail && detail !== e.message ? `${e.message} (${detail})` : e.message;
}
