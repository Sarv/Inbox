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
 *  - TRANSIENT failures the server ANSWERED (5xx / rate-limit) retry with linear
 *    backoff; after `MAX_TRANSIENT_FAILURES` in a row we give up and ask for
 *    re-login too (something is persistently wrong).
 *  - UNREACHABLE (DNS/refused/no route) is not counted at all. We never spoke to
 *    the server, so it tells us nothing about the session; it retries with the
 *    same backoff, forever, and can never trigger a re-login. Counting it signed
 *    users out over a Wi-Fi blip at wake.
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

import { createLogger, isOAuthServerUnreachableError } from '@sarvinbox/core';
import type { OAuthProviderId } from '@sarvinbox/core';
import { Notification, powerMonitor } from 'electron';

import { getMainWindow } from '../shared';

import {
  getValidAccessToken,
  msUntilRefresh,
  isTerminalOAuthError,
  isAccountGoneError,
  isRefreshDeferredError,
} from './oauth-service';
import { listAccounts, getAccount } from './oauth-token-store';
import {
  markReauthRequired,
  clearReauthRequired,
  clearAllReauthRequired,
} from './reauth-registry';

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
// Re-check interval while the machine is asleep. Timers are frozen during
// sleep, so in practice this fires on the next wake — a dark wake defers again
// (costing one log line), a real wake refreshes.
const DEFERRED_RETRY_MS = 60_000;

const timers = new Map<string, NodeJS.Timeout>();
const failCounts = new Map<string, number>();
// Consecutive "could not reach the server" attempts, kept SEPARATE from
// failCounts: it drives backoff only and never escalates to a re-login. Sharing
// one counter would let a run of network outages leave the account one ordinary
// 5xx away from being signed out.
const unreachableCounts = new Map<string, number>();
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
function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (!win) return; // No window yet — the renderer pulls the state on mount.
  try {
    win.webContents.send(channel, payload);
  } catch (err) {
    logger.warn(`[OAuthRefresh] could not deliver ${channel} to the renderer:`, err);
  }
}

function notifyReauthRequired(provider: OAuthProviderId, email: string, reason: string): void {
  logger.error(`[OAuthRefresh] ${provider}:${email} needs re-login — ${reason}`);

  // Record it FIRST, and unconditionally. Everything below is a delivery
  // attempt that can fail silently (no window yet, notifications unsupported,
  // Focus mode); the registry is what a renderer mounting later can still ask.
  const isNew = markReauthRequired(provider, email, reason);

  // Push to any window that IS listening so the in-app banner appears at the
  // moment mail stops syncing. This does NOT navigate — being yanked out of
  // whatever you were doing is worse than a banner you can act on when ready.
  sendToRenderer('oauth:reauth-required', { provider, email, reason });

  // Only the first failure of an episode gets a native toast. The retry loop is
  // stopped by the caller, but an account that fails, is re-authed and fails
  // again should not queue a second toast for a state already on screen.
  if (!isNew) return;

  // The native notification is the ASK, and the only channel that works when
  // the app is in the background. Routing into Settings → Accounts happens
  // solely when the user CLICKS it — an explicit, opt-in navigation.
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
          sendToRenderer('oauth:reauth-open-settings', { provider, email, reason });
        }
      });
      n.show();
    }
  } catch (err) {
    logger.warn('[OAuthRefresh] failed to show re-login notification:', err);
  }
}

/**
 * An account is healthy again — drop the requirement and tell the renderer so
 * the banner disappears without the user having to reload. Silent when nothing
 * was pending, which is the overwhelmingly common case.
 */
function resolveReauth(provider: OAuthProviderId, email: string): void {
  if (!clearReauthRequired(provider, email)) return;
  logger.info(`[OAuthRefresh] ${provider}:${email} no longer needs re-login`);
  sendToRenderer('oauth:reauth-resolved', { provider, email });
}

async function runRefresh(provider: OAuthProviderId, email: string): Promise<void> {
  const key = keyFor(provider, email);
  try {
    // forceRefresh: we're firing AT the due-point, so refresh unconditionally
    // and persist the new token. Single-flight in getValidAccessToken dedupes
    // with any connect refreshing at the same instant.
    await getValidAccessToken(provider, email, true);
    failCounts.delete(key);
    unreachableCounts.delete(key);
    resolveReauth(provider, email);
    logger.info(`[OAuthRefresh] proactively refreshed ${provider}:${email}`);
    await scheduleAccount(provider, email); // reschedule off the fresh token
  } catch (err) {
    // Account was removed mid-flight → just stop; nothing to re-auth.
    if (isAccountGoneError(err)) {
      clearTimer(key);
      failCounts.delete(key);
      unreachableCounts.delete(key);
      resolveReauth(provider, email); // nothing left to sign in to
      return;
    }
    // Deferred because the system is suspended: NOT a failure. Counting it
    // would march an asleep laptop toward MAX_TRANSIENT_FAILURES and fire a
    // "sign in again" notification for a session that is perfectly healthy —
    // so re-arm and leave the failure count untouched.
    if (isRefreshDeferredError(err)) {
      logger.info(
        `[OAuthRefresh] ${provider}:${email} deferred while suspended — re-checking after wake`,
      );
      armTimer(key, DEFERRED_RETRY_MS, () => void runRefresh(provider, email));
      return;
    }
    // Could not REACH the token endpoint (DNS, refused, no route): like the
    // suspend case above, this says nothing about the credentials, so it must
    // not march the account toward MAX_TRANSIENT_FAILURES. A dark-waking laptop
    // retries before Wi-Fi has reassociated, and five of those in a row latched
    // a healthy session into REAUTH_REQUIRED — after which the fast-fail gate in
    // getValidAccessToken refuses every later attempt WITHOUT trying, so the
    // account stays locked out even once the network is back. One session's log
    // had 81 ENOTFOUND against a server that was up and answering throughout.
    //
    // Backoff still applies, on its own counter: an unreachable server should be
    // retried patiently and forever, never escalated. Reaching the server again
    // — with any answer, even a rejection — hands the verdict back to the
    // classifiers below.
    if (isOAuthServerUnreachableError(err)) {
      const n = (unreachableCounts.get(key) ?? 0) + 1;
      unreachableCounts.set(key, n);
      const delay = Math.min(RETRY_BASE_MS * n, RETRY_MAX_MS);
      logger.warn(
        `[OAuthRefresh] cannot reach the OAuth server for ${provider}:${email} `
        + `(attempt ${n}) — retry in ${delay / 1000}s, session left signed in: ${(err as Error).message}`,
      );
      armTimer(key, delay, () => { void runRefresh(provider, email); });
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
      unreachableCounts.delete(key);
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
  unreachableCounts.clear();
  clearAllReauthRequired();
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
  // Clear the requirement even when the scheduler is not running: the sign-in
  // that just succeeded is exactly what the banner was asking for.
  resolveReauth(provider, email);
  if (!started) return; // startOAuthRefreshScheduler() will pick it up
  failCounts.delete(keyFor(provider, email));
  void scheduleAccount(provider, email);
}

/** An account signed out / removed → cancel its refresh. */
export function unscheduleOAuthAccount(provider: OAuthProviderId, email: string): void {
  const key = keyFor(provider, email);
  clearTimer(key);
  failCounts.delete(key);
  resolveReauth(provider, email); // removed account → the banner must go too
}
