// Per-account connection back-off, shared by EVERY connect path (the active
// `imap:connect`, `imap:resetAndReconnect`, and background sync).
//
// Why this has to be shared: a server enforces a per-account simultaneous-
// connection cap (Gmail = 15/account) and reaps dropped sockets only GRADUALLY
// (minutes). Once the cap is saturated, retrying a connect does not free a slot —
// it adds another in-flight connect against the full cap, which keeps it
// saturated and PROLONGS the lockout. The fix is to park the account after a
// quota/timeout failure and refuse further connects until the window elapses so
// the server can reap the zombies. This used to live only in the background-sync
// handler, so the ACTIVE account's `imap:connect` (fired on every window focus /
// online event, plus a 3-connection pool init) kept re-hammering the saturated
// cap — the "Too many simultaneous connections" storm. One shared instance means
// the active and background paths honor the SAME window for the same account
// instead of each waiting out the other.
//
// Framework-agnostic and pure (no Electron/IPC deps, `now` is injectable) so it
// unit-tests directly.
import { isConnectTimeoutError, isQuotaError, isTimeoutError } from '@sarvinbox/core';

// Escalating quota back-off. The server's reaper frees slots gradually, so a flat
// park makes us miss the moment a slot opens (the account stays dark the whole
// window). Back off 45s -> 90s -> 3m -> 5m across CONSECUTIVE quota hits instead,
// resetting on the next successful connect — reconnect the moment a slot frees,
// but never hammer a saturated cap.
export const QUOTA_BACKOFF_BASE_MS = 45 * 1000;
export const QUOTA_BACKOFF_CAP_MS = 5 * 60 * 1000;
// A connect TIMEOUT is usually the same near-quota / saturated condition (the
// abandoned connect often lands as a "too many connections" moments later), so
// park the account too. The FIRST timeout uses a short window, since a plain
// network blip also times out and shouldn't lock the account out for minutes —
// but CONSECUTIVE timeouts prove sustained server-side throttling (Gmail slows
// the greeting for 10-15 min after connection churn), and a flat window just
// retries into the still-throttled cap every 2 min for hours (the 55-timeouts-in-
// 2-hours storm). So timeouts escalate on their OWN ladder (2m -> 4m -> 8m,
// capped), separate from the quota ladder so a couple of blips never inflate a
// real quota hit, and reset on the next successful connect via clear().
export const TIMEOUT_BACKOFF_MS = 2 * 60 * 1000;
export const TIMEOUT_BACKOFF_CAP_MS = 8 * 60 * 1000;

export type ParkReason = 'quota' | 'timeout' | null;

export interface ParkResult {
  /** What the failure was parked for, or null if the error is neither quota nor timeout (not parked). */
  reason: ParkReason;
  /** The back-off window applied, in ms (0 when not parked). */
  backoffMs: number;
  /** Consecutive-failure count on this reason's ladder for this account (1-based); 0 when not parked. */
  attempt: number;
}

export interface QuotaBackoff {
  /** Remaining park time for this account in ms (0 = free to connect now). */
  remainingMs(accountId: string | null | undefined, now?: number): number;
  /** Park the account if `error` is a quota or timeout failure. No-op otherwise. */
  parkOnError(accountId: string | null | undefined, error: unknown, now?: number): ParkResult;
  /** Clear the park + escalation after a successful connect (or manual recovery). */
  clear(accountId: string | null | undefined): void;
}

const NOT_PARKED: ParkResult = { reason: null, backoffMs: 0, attempt: 0 };

export function createQuotaBackoff(): QuotaBackoff {
  // accountId -> epoch-ms until which the account is parked.
  const backoffUntil = new Map<string, number>();
  // accountId -> consecutive quota-hit count, for the escalating quota window.
  const consecutiveQuota = new Map<string, number>();
  // accountId -> consecutive connect-timeout count, for the escalating timeout
  // window. Kept SEPARATE from the quota ladder so a couple of network blips
  // never push a real quota hit up its own ladder (and vice versa).
  const consecutiveTimeout = new Map<string, number>();
  // accountId -> the reason the account is CURRENTLY parked for. Used to coalesce
  // the thundering herd: several connect paths (active connect + reconnect +
  // pool init) fail within the same instant on the same account, and each used to
  // call parkOnError and advance the ladder — attempt 1 -> 2 -> 3 in one second,
  // jumping straight to a multi-minute lockout from a single real failure. A
  // repeat failure of the SAME reason while the account is STILL parked is part
  // of that one burst, not a genuine time-separated retry, so it must NOT escalate.
  const parkedReason = new Map<string, ParkReason>();

  // Shared doubling ladder: nth consecutive failure on a counter waits
  // base * 2^(n-1), clamped to cap. Reused by both the quota and timeout paths.
  const nextBackoff = (
    counters: Map<string, number>,
    accountId: string,
    baseMs: number,
    capMs: number,
  ): { backoffMs: number; attempt: number } => {
    const attempt = (counters.get(accountId) ?? 0) + 1;
    counters.set(accountId, attempt);
    return { backoffMs: Math.min(baseMs * 2 ** (attempt - 1), capMs), attempt };
  };

  return {
    remainingMs(accountId, now = Date.now()) {
      if (!accountId) return 0;
      const until = backoffUntil.get(accountId) ?? 0;
      return Math.max(0, until - now);
    },

    parkOnError(accountId, error, now = Date.now()) {
      if (!accountId) return NOT_PARKED;

      // Classify the failure first so we can coalesce a same-reason burst before
      // touching either ladder.
      const reason: ParkReason = isQuotaError(error)
        ? 'quota'
        : isTimeoutError(error) || isConnectTimeoutError(error)
          ? 'timeout'
          : null;
      if (reason === null) return NOT_PARKED;

      // Thundering-herd guard: if the account is ALREADY parked for this SAME
      // reason, this failure belongs to the burst that triggered the current park
      // (concurrent connect paths all failing at once), NOT a genuine retry after
      // the window elapsed. Return the park already in force WITHOUT advancing the
      // ladder, so one real failure can't jump attempt 1 -> 3 in a single second.
      // A genuine retry only fires after callers see remainingMs hit 0, at which
      // point the account is no longer parked and the ladder escalates as intended.
      // (A reason CHANGE — e.g. a timeout burst turning into a hard quota refusal —
      // is a stronger, distinct signal and is allowed through to its own ladder.)
      const parkedUntil = backoffUntil.get(accountId) ?? 0;
      if (now < parkedUntil && parkedReason.get(accountId) === reason) {
        const counters = reason === 'quota' ? consecutiveQuota : consecutiveTimeout;
        return { reason, backoffMs: parkedUntil - now, attempt: counters.get(accountId) ?? 1 };
      }

      // Classification above already resolved quota-before-timeout (a quota error
      // can also look transient), so a genuine escalation just follows the reason.
      if (reason === 'quota') {
        const { backoffMs, attempt } = nextBackoff(
          consecutiveQuota,
          accountId,
          QUOTA_BACKOFF_BASE_MS,
          QUOTA_BACKOFF_CAP_MS,
        );
        backoffUntil.set(accountId, now + backoffMs);
        parkedReason.set(accountId, 'quota');
        return { reason: 'quota', backoffMs, attempt };
      }
      // Our withTimeout timeouts AND ImapFlow's own connect/greeting/upgrade
      // timeouts ("Failed to establish connection in required time") both mean the
      // same thing here: a connect that hung, usually the near-saturated-cap
      // condition. ImapFlow's connect-phase timeout is the DOMINANT pool-drain
      // failure and does NOT satisfy isTimeoutError (it is not our TimeoutError),
      // so it must be checked explicitly or the pool's shared gate never closes.
      // reason === 'timeout': escalate on its OWN ladder — the first timeout stays
      // short (2m) so a plain blip doesn't lock the account out, but sustained
      // throttling backs off 2m -> 4m -> 8m instead of re-hammering a still-
      // throttled cap forever.
      const { backoffMs, attempt } = nextBackoff(
        consecutiveTimeout,
        accountId,
        TIMEOUT_BACKOFF_MS,
        TIMEOUT_BACKOFF_CAP_MS,
      );
      backoffUntil.set(accountId, now + backoffMs);
      parkedReason.set(accountId, 'timeout');
      return { reason: 'timeout', backoffMs, attempt };
    },

    clear(accountId) {
      if (!accountId) return;
      backoffUntil.delete(accountId);
      consecutiveQuota.delete(accountId);
      consecutiveTimeout.delete(accountId);
      parkedReason.delete(accountId);
    },
  };
}
