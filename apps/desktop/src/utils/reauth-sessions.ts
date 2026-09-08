/**
 * The renderer's view of which OAuth accounts need the user to sign in again.
 *
 * Kept as pure list transforms rather than logic inside the banner component,
 * so the rules that decide what is shown — and, more importantly, when it stops
 * being shown — are unit-testable without a DOM. The component only renders
 * whatever these functions return.
 *
 * The list arrives two ways and both must agree: pulled once on mount (for a
 * failure that happened while nothing was listening) and pushed as it happens.
 * A pull that lands after a push must therefore not resurrect an entry the push
 * already resolved, which is why merging is explicit here.
 */

/** Mirrors the main process's ReauthRequirement; `since` is UTC ISO-8601. */
export interface ReauthSession {
  provider: string;
  email: string;
  reason: string;
  since: string;
}

const sameAccount = (a: { provider: string; email: string }, b: { provider: string; email: string }): boolean =>
  a.provider === b.provider && a.email === b.email;

/**
 * Add a session, or refresh the reason on one already listed.
 *
 * Never duplicates an account: the scheduler stops retrying after it gives up,
 * but a re-auth that fails again would otherwise stack a second identical row.
 * The original `since` is kept so the banner doesn't claim the problem is newer
 * than it is.
 */
export function addReauthSession(sessions: ReauthSession[], entry: ReauthSession): ReauthSession[] {
  const existing = sessions.find((s) => sameAccount(s, entry));
  if (!existing) return [...sessions, entry];
  return sessions.map((s) =>
    sameAccount(s, entry) ? { ...s, reason: entry.reason } : s,
  );
}

/** Drop a session that has been resolved (signed in again, or removed). */
export function removeReauthSession(
  sessions: ReauthSession[],
  account: { provider: string; email: string },
): ReauthSession[] {
  return sessions.filter((s) => !sameAccount(s, account));
}

/**
 * Fold a pulled snapshot into what we already hold.
 *
 * The snapshot is authoritative about accounts it names, but must not undo a
 * resolution that arrived while it was in flight — so entries already dropped
 * locally are only re-added if the main process still lists them, and locally
 * known entries keep their reason. Ordering follows the snapshot (oldest
 * failure first) with any push-only entries appended.
 */
export function mergeReauthSnapshot(
  sessions: ReauthSession[],
  snapshot: ReauthSession[],
): ReauthSession[] {
  const merged = snapshot.map((fromMain) => {
    const local = sessions.find((s) => sameAccount(s, fromMain));
    return local ? { ...fromMain, reason: local.reason } : fromMain;
  });
  const pushedSince = sessions.filter(
    (s) => !snapshot.some((fromMain) => sameAccount(fromMain, s)),
  );
  return [...merged, ...pushedSince];
}

/**
 * The session for a given account, if it needs re-authentication.
 *
 * Matched on provider AND email, case-insensitively: the settings list stores
 * the address as the user typed it while the token store holds whatever the
 * provider returned, and the same address can legitimately be signed in on two
 * providers. Matching on email alone would light up the wrong row.
 */
export function findReauthSession(
  sessions: ReauthSession[],
  account: { provider?: string | null; email?: string | null },
): ReauthSession | undefined {
  const email = (account.email ?? '').toLowerCase();
  if (!email) return undefined;
  return sessions.find(
    (s) =>
      s.email.toLowerCase() === email &&
      // An account row with no recorded provider (a plain IMAP account, or one
      // saved before the provider was tracked) still matches on address —
      // better a banner on the right account than none at all.
      (!account.provider || s.provider === account.provider),
  );
}

/**
 * One line of banner copy for however many accounts are affected.
 *
 * Naming the account matters — with several signed in, "your session expired"
 * leaves the user guessing which mailbox stopped syncing.
 */
export function describeReauthSessions(sessions: ReauthSession[]): string {
  if (sessions.length === 0) return '';
  if (sessions.length === 1) return `Your session for ${sessions[0].email} has expired.`;
  if (sessions.length === 2) {
    return `Your sessions for ${sessions[0].email} and ${sessions[1].email} have expired.`;
  }
  return `Your sessions for ${sessions[0].email} and ${sessions.length - 1} other accounts have expired.`;
}
