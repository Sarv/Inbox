/**
 * What an OAuth grant actually came back with, versus what was asked for.
 *
 * WHY THIS EXISTS: the granted scope set was never recorded anywhere. When the
 * Sarv catalog started answering 403 on `/oauth/v1/llm/*`, there was no way to
 * tell from the log whether the token had simply never been granted `llm:view`,
 * or had been granted it and lost it on a later refresh — the two have
 * completely different fixes (re-authorize vs a server-side grant), and the
 * symptom is identical: AI silently off, mail syncing fine.
 *
 * Both helpers are order- and duplicate-insensitive: an authorization server is
 * free to return the same grant in a different order, and that is not a change.
 */

/** Normalize a scope list for comparison — trimmed, de-duplicated, sorted. */
function normalize(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

/**
 * Scopes present in `previous` but absent from `next`.
 *
 * A non-empty result on a refresh is a NARROWING grant: the account kept
 * working for whatever the remaining scopes cover (mail) and quietly lost the
 * rest (AI). Empty for an unchanged or widened grant.
 */
export function scopesLost(previous: readonly string[], next: readonly string[]): string[] {
  const kept = new Set(normalize(next));
  return normalize(previous).filter((scope) => !kept.has(scope));
}

/**
 * Scopes requested at `/authorize` that the server did not grant.
 *
 * Servers may drop an unknown or disallowed scope silently rather than failing
 * the request, so "sign-in worked" is not evidence the token can do everything
 * the app asked for.
 */
export function scopesNotGranted(
  requested: readonly string[],
  granted: readonly string[],
): string[] {
  const has = new Set(normalize(granted));
  return normalize(requested).filter((scope) => !has.has(scope));
}
