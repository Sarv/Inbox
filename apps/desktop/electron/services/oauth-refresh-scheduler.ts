/**
 * Proactive OAuth access-token refresh scheduler (main process).
 *
 * The lazy gate in `getValidAccessToken` only refreshes a token when something
 * ASKS for one (a connect via `resolveBearer`, a renderer API call). That's
 * enough while connections are active, but a long idle with no calls lets the
 * token age until the next use. This scheduler adds the PUSH half: per OAuth
 * account, a timer fires at the token's due-point (~`REFRESH_AT_FRACTION` of
 * its lifetime, or the 5-min hard floor — whichever is earlier), force-
 * refreshes, persists the new token to the store, and reschedules off the fresh
 * `exp`. So the token stays warm independent of connection activity.
 *
 * Reliability rules (tokens are load-bearing — an expired one is useless):
 *  - The lazy gate remains a backstop; single-flight collapses a scheduler
 *    refresh racing a connect into ONE network call.
 *  - A TERMINAL failure (refresh token revoked/expired — `invalid_grant` etc.)
 *    can't be fixed by retrying, so we STOP hammering it and ask the user to
 *    sign in again immediately.
 *  - TRANSIENT failures (network / 5xx / rate-limit) retry with linear backoff;
 *    after `MAX_TRANSIENT_FAILURES` in a row we give up and ask for re-login too
 *    (something is persistently wrong).
 *  - On system RESUME (laptop woke from sleep — timers were paused and the token
 *    likely expired) we re-evaluate every account so it refreshes promptly
 *    instead of waiting out a stale timer.
 *
 * Honest limitation: this runs on the JS event loop. A synchronous op that
 * blocks the loop DELAYS the timer (doesn't skip it) and also blocks the
 * refresh HTTP call — no JS-scheduled work runs during a blocked loop. The
 * `REFRESH_AT_FRACTION` buffer absorbs modest delays and the lazy gate covers a
 * late fire; true immunity would need a worker thread (overkill here).
 */
import { Notification, powerMonitor } from 'electron';

import { createLogger } from '@sarvinbox/core';
import type { OAuthProviderId } from '@sarvinbox/core';

import { getMainWindow } from '../shared';
import { listAccounts, getAccount } from './oauth-token-store';
import {
  getValidAccessToken,
  msUntilRefresh,
  isTerminalOAuthError,
  isAccountGoneError,
} from './oauth-service';

const logger = createLogger('oauth-refresh-scheduler');

// Never busy-loop on an already-overdue token; cap a single wait so a very
// long-lived token still gets periodic re-evaluation (and never approaches
// setTimeout's ~24.8-day 32-bit ceiling).
const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6h
// Transient-failure backoff: nth failure waits n * base, capped.
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 10 * 60 * 1000; // 10 min
const MAX_TRANSIENT_FAILURES = 5;

const timers = new Map<string, NodeJS.Timeout>();
const failCounts = new Map<string, number>();
let started = false;
let resumeHandler: (() => void) | null = null;

const keyFor = (provider: OAuthProviderId, email: string): string =>
  `${provider}:${email.toLowerCase()}`;

function clearTimer(key: string): void {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
}

function armTimer(key: string, delayMs: number, fn: () => void): void {
  clearTimer(key);
  const t = setTimeout(fn, delayMs);
  t.unref?.(); // never keep the app alive for a pending refresh
  timers.set(key, t);
}

/**
 * Ask the user to sign in again for an account whose token can't be refreshed.
 * Fires a native OS notification (the guaranteed channel — works even if the
 * renderer isn't listening) AND emits `oauth:reauth-required` so the UI can
 * surface a banner / route to Accounts. Fires once per episode (the caller
 * stops the retry loop first), so it never spams.
 */
function notifyReauthRequired(provider: OAuthProviderId, email: string, reason: string): void {
  logger.error(`[OAuthRefresh] ${provider}:${email} needs re-login — ${reason}`);
  // The native notification is the ASK. We route into Settings → Accounts only
  // when the user CLICKS it (opt-in) — auto-navigating on the failure itself
  // would yank them out of whatever they're doing.
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Sign in again',
        body: `Your session for ${email} expired. Open Sarv Inbox and sign in again to keep mail syncing.`,
        silent: false,
      });
      n.on('click', () => {
        const win = getMainWindow();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.focus();
          try { win.webContents.send('oauth:reauth-required', { provider, email, reason }); } catch { /* ignore */ }
        }
      });
      n.show();
    }
  } catch (err) {
    logger.warn('[OAuthRefresh] failed to show re-login notification:', err);
  }
}

async function runRefresh(provider: OAuthProviderId, email: string): Promise<void> {
  const key = keyFor(provider, email);
  try {
    // forceRefresh: we're firing AT the due-point, so refresh unconditionally
    // and persist the new token. Single-flight in getValidAccessToken dedupes
    // with any connect refreshing at the same instant.
    await getValidAccessToken(provider, email, true);
    failCounts.delete(key);
    logger.info(`[OAuthRefresh] proactively refreshed ${provider}:${email}`);
    await scheduleAccount(provider, email); // reschedule off the fresh token
  } catch (err) {
    // Account was removed mid-flight → just stop; nothing to re-auth.
    if (isAccountGoneError(err)) {
      clearTimer(key);
      failCounts.delete(key);
      return;
    }
    const terminal = isTerminalOAuthError(err);
    const n = (failCounts.get(key) ?? 0) + 1;
    failCounts.set(key, n);

    if (terminal || n >= MAX_TRANSIENT_FAILURES) {
      // Dead refresh token, or persistently failing — retrying won't help.
      // Stop the loop and ask the user to sign in again.
      clearTimer(key);
      failCounts.delete(key);
      notifyReauthRequired(
        provider,
        email,
        terminal ? (err as Error).message : `${n} consecutive refresh failures — ${(err as Error).message}`,
      );
      return;
    }

    // Transient and under the cap → retry with linear backoff.
    const delay = Math.min(RETRY_BASE_MS * n, RETRY_MAX_MS);
    logger.warn(
      `[OAuthRefresh] transient refresh failure ${n}/${MAX_TRANSIENT_FAILURES} for ${provider}:${email} — retry in ${delay / 1000}s: ${(err as Error).message}`,
    );
    armTimer(key, delay, () => { void runRefresh(provider, email); });
  }
}

/**
 * (Re)schedule the next proactive refresh for ONE account off its current
 * token. A token due beyond MAX_DELAY_MS is re-evaluated (not refreshed) at the
 * cap. No-op-safe when the account is gone.
 */
export async function scheduleAccount(provider: OAuthProviderId, email: string): Promise<void> {
  const key = keyFor(provider, email);
  const account = await getAccount(provider, email);
  if (!account) {
    clearTimer(key);
    return;
  }
  const due = msUntilRefresh(account);
  if (due > MAX_DELAY_MS) {
    // Too far out for one timer — wake at the cap and re-evaluate (no refresh).
    armTimer(key, MAX_DELAY_MS, () => { void scheduleAccount(provider, email); });
    return;
  }
  // due <= 0 (already overdue) → refresh promptly (clamped to MIN, never a busy
  // loop; the success path yields a fresh, not-overdue token).
  armTimer(key, Math.max(MIN_DELAY_MS, due), () => { void runRefresh(provider, email); });
}

/** Re-evaluate every signed-in account (start, and on system resume). */
async function rescheduleAll(): Promise<void> {
  const accounts = await listAccounts();
  for (const a of accounts) await scheduleAccount(a.provider, a.email);
  return;
}

/** Arm refresh timers for every signed-in OAuth account. Idempotent. */
export async function startOAuthRefreshScheduler(): Promise<void> {
  if (started) return;
  started = true;
  // Laptop woke from sleep: timers were frozen and tokens may have expired.
  // Re-evaluate all accounts so they refresh promptly instead of waiting out a
  // stale timer or the next connect.
  resumeHandler = () => {
    logger.info('[OAuthRefresh] system resume — re-evaluating token refreshes');
    void rescheduleAll();
  };
  // `powerMonitor` is a normal ESM import (a `require()` here would be undefined
  // in an ESM context and the ReferenceError would silently disable resume
  // handling). Still guard the VALUE: it is absent in a headless/non-Electron
  // context, and `resume` is only emitted on macOS/Windows.
  if (typeof powerMonitor?.on === 'function') {
    try {
      powerMonitor.on('resume', resumeHandler);
    } catch (err) {
      logger.warn('[OAuthRefresh] could not subscribe to power resume — tokens refresh on their timers only:', err);
    }
  } else {
    logger.warn('[OAuthRefresh] powerMonitor unavailable — post-sleep token re-evaluation is disabled');
  }
  try {
    const accounts = await listAccounts();
    for (const a of accounts) await scheduleAccount(a.provider, a.email);
    logger.info(`[OAuthRefresh] scheduler started for ${accounts.length} account(s)`);
  } catch (err) {
    logger.error('[OAuthRefresh] start failed:', err);
  }
}

/** Cancel all refresh timers (teardown / quit). */
export function stopOAuthRefreshScheduler(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  failCounts.clear();
  if (resumeHandler) {
    if (typeof powerMonitor?.removeListener === 'function') {
      try {
        powerMonitor.removeListener('resume', resumeHandler);
      } catch (err) {
        logger.warn('[OAuthRefresh] could not remove the power resume listener:', err);
      }
    }
    resumeHandler = null;
  }
  started = false;
}

/** An account signed in / re-authed → (re)arm its refresh and clear failures. */
export function rescheduleOAuthAccount(provider: OAuthProviderId, email: string): void {
  if (!started) return; // startOAuthRefreshScheduler() will pick it up
  failCounts.delete(keyFor(provider, email));
  void scheduleAccount(provider, email);
}

/** An account signed out / removed → cancel its refresh. */
export function unscheduleOAuthAccount(provider: OAuthProviderId, email: string): void {
  const key = keyFor(provider, email);
  clearTimer(key);
  failCounts.delete(key);
}
