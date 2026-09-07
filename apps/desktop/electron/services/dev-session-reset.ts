/**
 * DEV-ONLY renderer session reset, with a deadline.
 *
 * In development the main window clears the Chromium HTTP cache + service-worker
 * storage before navigating to the vite dev server, so a stale bundle can never
 * shadow a fresh build. The catch: that clear used to GATE the `loadURL` call —
 * `Promise.all([clearCache, clearStorageData]).then(() => loadURL(...))`. The
 * window is created `show: false` and only shows on `ready-to-show`, which only
 * fires once a page loads. So if either clear never settles, `loadURL` is never
 * called, no renderer is ever spawned, and the app hangs at a window that never
 * appears — with NO error and NO log line. Observed for real: a startup that
 * logged `[Main] App initialization complete` and kept syncing mail happily
 * while the user stared at no UI, because `[Main] All caches cleared for
 * development` (44 startups in a row before it) never arrived.
 *
 * Hence the deadline. A stale cache is a survivable dev annoyance — one reload
 * fixes it. A window that never appears is indistinguishable from a crash. So
 * this NEVER rejects and NEVER hangs: it reports what happened and the caller
 * navigates regardless.
 *
 * The Electron `session` API calls are injected so the outcome table is
 * unit-testable without an Electron app instance (same split as
 * `single-instance.ts`).
 */

import { withTimeout, isTimeoutError } from '@sarvinbox/core';

/**
 * What happened to the dev cache reset. All three outcomes are non-fatal — the
 * caller must load the window in every case — but they're distinguished so the
 * log says whether the cache is actually clean:
 *
 * - `cleared`   — both clears completed; the renderer starts from a clean cache.
 * - `timed-out` — TRANSIENT: a clear was still running at the deadline. It may
 *                 yet finish in the background; the page loads against a
 *                 possibly-stale cache.
 * - `failed`    — PERMANENT: a clear rejected outright (session torn down, disk
 *                 error). Same handling, different cause.
 */
export type DevSessionResetOutcome = 'cleared' | 'timed-out' | 'failed';

/**
 * How long to wait for the dev cache clear before navigating anyway. Generous
 * relative to the real cost (normally single-digit milliseconds) so a merely
 * slow machine still gets a clean cache, but short enough that a wedged clear
 * costs a few seconds of startup instead of the whole session.
 */
export const DEV_SESSION_RESET_TIMEOUT_MS = 5000;

/**
 * Clear the dev renderer caches, bounded by `timeoutMs`.
 *
 * Resolves (never rejects) with the outcome, so the caller can unconditionally
 * proceed to `loadURL` from a single `.then()`.
 */
export async function resetDevSessionCaches(deps: {
  clearCache: () => Promise<unknown>;
  clearStorageData: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<DevSessionResetOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEV_SESSION_RESET_TIMEOUT_MS;
  try {
    // Start both clears before racing so they run concurrently, exactly as
    // before — the deadline covers the pair, not each one.
    await withTimeout(
      Promise.all([deps.clearCache(), deps.clearStorageData()]),
      timeoutMs,
      `dev session cache reset exceeded ${timeoutMs}ms`,
    );
    return 'cleared';
  } catch (err) {
    return isTimeoutError(err) ? 'timed-out' : 'failed';
  }
}

/**
 * The log line for an outcome. `cleared` keeps the exact historical wording —
 * it's the line to grep for when checking whether a dev startup got as far as
 * navigating (see the incident in this file's header).
 */
export function describeDevSessionReset(outcome: DevSessionResetOutcome): string {
  if (outcome === 'cleared') return '[Main] All caches cleared for development';
  const cause = outcome === 'timed-out'
    ? `did not finish within ${DEV_SESSION_RESET_TIMEOUT_MS}ms`
    : 'failed';
  return `[Main] Dev cache reset ${cause} — loading the window anyway (a stale cache is survivable; a window that never appears is not)`;
}
