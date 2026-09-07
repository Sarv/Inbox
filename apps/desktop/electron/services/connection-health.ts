/**
 * Per-connection instability tracker — the signal the bulk schedulers use to
 * BACK OFF while a connection is churning, so the app stops piling body-prefetch
 * / backfill work onto a socket the server keeps dropping (which both wastes the
 * work and can provoke the next `Unexpected close`).
 *
 * Keyed by the SyncEngine instance, NOT an account id: both the reconnect
 * handlers (sync-handlers) and the schedulers already hold the engine object, so
 * using it as the key avoids any account-id format mismatch between the two
 * sides. One engine per account → the map is bounded by account count.
 *
 * "Churn" is deliberately MULTIPLE incidents in a window, not a single drop: a
 * one-off reconnect (link blip, wake-from-sleep) must NOT throttle downloads —
 * the app should resume immediately, which is the whole point of the reconnect
 * kick. Only a repeatedly-dropping connection backs the bulk work off.
 */

/** Sliding window over which instability incidents are counted. */
export const INSTABILITY_WINDOW_MS = 90_000;
/** Incidents within the window before a connection counts as "churning". Two,
 *  so a single isolated drop never throttles — only a genuinely flapping link. */
export const INSTABILITY_MIN_INCIDENTS = 2;

type EngineKey = object;

const incidents = new Map<EngineKey, number[]>();

const prune = (times: number[], now: number): number[] =>
  times.filter((t) => now - t < INSTABILITY_WINDOW_MS);

/**
 * Record a connection-instability incident (a drop or a reconnect attempt) for
 * this engine. `now` is injectable for tests.
 */
export function markConnectionUnstable(engine: EngineKey | null | undefined, now: number = Date.now()): void {
  if (!engine) return;
  const times = prune(incidents.get(engine) ?? [], now);
  times.push(now);
  incidents.set(engine, times);
}

/**
 * True when this engine has had ≥ INSTABILITY_MIN_INCIDENTS incidents inside the
 * window — i.e. it's churning and bulk work should skip this tick. Prunes stale
 * entries as a side effect so a connection that has settled reads healthy again.
 */
export function isConnectionRecentlyUnstable(engine: EngineKey | null | undefined, now: number = Date.now()): boolean {
  if (!engine) return false;
  const times = prune(incidents.get(engine) ?? [], now);
  if (times.length === 0) incidents.delete(engine);
  else incidents.set(engine, times);
  return times.length >= INSTABILITY_MIN_INCIDENTS;
}

/** Test-only: clear all tracked instability. */
export function __resetConnectionHealth(): void { incidents.clear(); }
