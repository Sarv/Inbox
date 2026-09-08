/**
 * Which OAuth accounts are currently waiting for the user to sign in again.
 *
 * The refresh scheduler already fires a native "Sign in again" notification
 * when a token can't be refreshed, but a notification is a MOMENT, not a state:
 * it can be suppressed by Focus mode, missed while the app is in the
 * background, absent entirely on a Linux box with no notification daemon, or
 * simply dismissed. Mail then stops arriving with nothing on screen to explain
 * why — the exact failure this registry exists to prevent.
 *
 * So the requirement is recorded here and PULLED by the renderer on mount, in
 * addition to being pushed. A window that opens after the failure (or reloads,
 * or was never listening) still learns about it.
 *
 * Deliberately in-memory: a session that needs re-auth will fail its very next
 * refresh after a restart and be recorded again within seconds, so persisting
 * it would only add a way for the banner to be WRONG (stale after the user
 * fixed the account elsewhere). Pure and dependency-free — no electron import —
 * so it unit-tests without a main process.
 */
import type { OAuthProviderId } from '@sarvinbox/core';

export interface ReauthRequirement {
  provider: OAuthProviderId;
  email: string;
  /** Why the refresh could not be recovered — shown in logs, not to the user. */
  reason: string;
  /** UTC ISO-8601. Rendered in the reader's zone by the renderer, never here. */
  since: string;
}

const requirements = new Map<string, ReauthRequirement>();

// Lower-cased so the account is ONE entry however it was spelled. The refresh
// scheduler reads addresses from the token store while the connect path reads
// them from the IMAP config, and a case difference between the two would let a
// gated account slip past the fast-fail check and resume hammering the token
// endpoint. The stored record keeps the original spelling for display.
const keyFor = (provider: OAuthProviderId, email: string): string =>
  `${provider}:${email.toLowerCase()}`;

/**
 * Record that an account needs interactive re-authentication.
 *
 * Returns true only the FIRST time for that account. Repeat failures update the
 * reason but keep the original `since` and report false, so a retry loop can't
 * re-notify or reset how long the banner says the account has been broken.
 */
export function markReauthRequired(
  provider: OAuthProviderId,
  email: string,
  reason: string,
  at: string = new Date().toISOString(),
): boolean {
  const key = keyFor(provider, email);
  const existing = requirements.get(key);
  requirements.set(key, {
    provider,
    email,
    reason,
    since: existing?.since ?? at,
  });
  return existing === undefined;
}

/**
 * Clear the requirement once the account works again (a successful refresh, a
 * fresh sign-in, or the account being removed).
 *
 * Returns whether anything was actually cleared, so callers only broadcast a
 * "resolved" event when there was something to resolve — a successful refresh
 * on a healthy account is the common case and must stay silent.
 */
/**
 * The pending requirement for one account, or undefined.
 *
 * Read on the token path (`getValidAccessToken`) to fail a refresh BEFORE it
 * reaches the network: once a session is known dead, every further POST is a
 * guaranteed rejection, and against a reuse detector replaying a spent token is
 * the very thing that keeps the family revoked.
 */
export function getReauthRequirement(
  provider: OAuthProviderId,
  email: string,
): ReauthRequirement | undefined {
  return requirements.get(keyFor(provider, email));
}

export function clearReauthRequired(provider: OAuthProviderId, email: string): boolean {
  return requirements.delete(keyFor(provider, email));
}

/** Every account currently needing re-authentication, oldest failure first. */
export function listReauthRequired(): ReauthRequirement[] {
  return [...requirements.values()].sort((a, b) => a.since.localeCompare(b.since));
}

/** Drop all state (scheduler shutdown, and test isolation). */
export function clearAllReauthRequired(): void {
  requirements.clear();
}
