/**
 * One HTTP request authenticated with an OAuth bearer, retried ONCE with a
 * freshly minted bearer when the server refuses the first one.
 *
 * Our local expiry estimate can be wrong — clock skew, a token revoked and
 * reissued server-side, or one that aged out while the app sat idle — so a
 * request can be answered 401 with a token we still believed valid. Forcing a
 * refresh and trying again makes that self-heal instead of failing the feature.
 * Exactly once: a second 401 means the fresh token is refused too, and is
 * returned to the caller as-is.
 *
 * Only 401 retries. A 403 from Sarv is a scope, role or CAI-account verdict
 * (`insufficient_scope`, `cai_account_required`, …) that a refreshed token —
 * which carries the same grant — cannot change, and `/oauth/v1/zones` answers
 * 403 on every lookup for an account with no organization, so retrying it
 * would force a token refresh on every boot for those users.
 *
 * Minting a bearer can fail on its own (no account, a revoked refresh token, the
 * OAuth server unreachable). That is reported as a `BearerUnavailableError`
 * carrying the token layer's error, so a caller can tell "we never sent the
 * request" from "the request failed".
 */

/** The one status that means "this bearer was refused — a fresh one may not be". */
const BEARER_REJECTED_STATUS = 401;

/** `code` of a `BearerUnavailableError`, readable without `instanceof`. */
export const BEARER_UNAVAILABLE = 'BEARER_UNAVAILABLE';

/** Minting the bearer failed, so nothing was sent. `cause` is the token layer's error. */
export class BearerUnavailableError extends Error {
  readonly code = BEARER_UNAVAILABLE;
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'BearerUnavailableError';
    this.cause = cause;
  }
}

/**
 * Whether `err` is a `BearerUnavailableError`. Checked by code, not
 * `instanceof`: core and the Electron main process are bundled separately, so
 * the same class can exist twice at runtime.
 */
export function isBearerUnavailableError(err: unknown): err is BearerUnavailableError {
  return (err as { code?: unknown } | null | undefined)?.code === BEARER_UNAVAILABLE;
}

/** Resolves a bearer; `forceRefresh` asks for a newly minted one. */
export type BearerResolver = (forceRefresh: boolean) => Promise<string>;

/** A blank bearer would go out as `Authorization: Bearer ` — refuse it here. */
async function mintBearer(resolveBearer: BearerResolver, forceRefresh: boolean): Promise<string> {
  let bearer: unknown;
  try {
    bearer = await resolveBearer(forceRefresh);
  } catch (err) {
    throw new BearerUnavailableError(err);
  }
  if (typeof bearer !== 'string' || bearer.trim() === '') {
    // EMPTY_STORED_TOKEN is the OAuth layer's own code for this, and it
    // classifies as terminal: only signing in again yields a usable token.
    throw new BearerUnavailableError(Object.assign(
      new Error('The sign-in returned an empty access token. Sign in again.'),
      { code: 'EMPTY_STORED_TOKEN' },
    ));
  }
  return bearer.trim();
}

/**
 * `send(bearer)`, and once more with a forced-fresh bearer if the answer is 401.
 * A `send` rejection (network, abort, a refused redirect) propagates untouched.
 */
export async function fetchWithBearerRetry(
  resolveBearer: BearerResolver,
  send: (bearer: string) => Promise<Response>,
): Promise<Response> {
  const first = await send(await mintBearer(resolveBearer, false));
  if (first.status !== BEARER_REJECTED_STATUS) return first;
  // Release the refused response's connection before the retry.
  try { await first.body?.cancel(); } catch { /* already consumed or closed */ }
  return send(await mintBearer(resolveBearer, true));
}
