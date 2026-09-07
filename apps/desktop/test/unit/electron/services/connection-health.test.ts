import { afterEach, describe, expect, it } from 'vitest';

import {
  markConnectionUnstable,
  isConnectionRecentlyUnstable,
  __resetConnectionHealth,
  INSTABILITY_WINDOW_MS,
  INSTABILITY_MIN_INCIDENTS,
} from '../../../../electron/services/connection-health';

// This gate decides whether bulk work (backfill / body-prefetch) piles onto a
// churning connection. Two failure modes to prevent: (a) throttling a healthy
// one-off reconnect (downloads would stall for no reason), and (b) NOT throttling
// a genuinely flapping server (we keep provoking drops). Each test names which.

const engineA = { id: 'A' };
const engineB = { id: 'B' };

afterEach(() => __resetConnectionHealth());

describe('connection-health churn gate', () => {
  // A single isolated drop must NOT count as churn — the reconnect kick should
  // resume downloads immediately, not wait.
  it('one incident is NOT churn (a one-off reconnect keeps downloading)', () => {
    markConnectionUnstable(engineA, 1_000);
    expect(isConnectionRecentlyUnstable(engineA, 1_100)).toBe(false);
  });

  // Two incidents inside the window IS churn → back off.
  it('reaches churn at INSTABILITY_MIN_INCIDENTS within the window', () => {
    markConnectionUnstable(engineA, 1_000);
    markConnectionUnstable(engineA, 2_000);
    expect(INSTABILITY_MIN_INCIDENTS).toBe(2);
    expect(isConnectionRecentlyUnstable(engineA, 2_500)).toBe(true);
  });

  // Incidents older than the window fall off — a connection that settled reads
  // healthy again so bulk work resumes on its own.
  it('incidents outside the window expire (settled connection reads healthy)', () => {
    markConnectionUnstable(engineA, 1_000);
    markConnectionUnstable(engineA, 2_000);
    // Both are now older than the window — nothing recent.
    const later = 2_000 + INSTABILITY_WINDOW_MS + 1;
    expect(isConnectionRecentlyUnstable(engineA, later)).toBe(false);
  });

  // A drop that recurs keeps the window sliding: the OLD one expires but the two
  // recent ones still count as churn.
  it('a fresh incident after an expiry still counts with another recent one', () => {
    markConnectionUnstable(engineA, 1_000);                              // will expire
    markConnectionUnstable(engineA, 1_000 + INSTABILITY_WINDOW_MS - 10); // recent
    markConnectionUnstable(engineA, 1_000 + INSTABILITY_WINDOW_MS + 5);  // recent
    // Evaluated just after the third: first has expired, last two are in-window.
    expect(isConnectionRecentlyUnstable(engineA, 1_000 + INSTABILITY_WINDOW_MS + 6)).toBe(true);
  });

  // Per-engine isolation: one account's churn must not throttle another's bulk work.
  it('tracks churn PER engine — accounts do not cross-contaminate', () => {
    markConnectionUnstable(engineA, 1_000);
    markConnectionUnstable(engineA, 2_000);
    expect(isConnectionRecentlyUnstable(engineA, 2_500)).toBe(true);
    expect(isConnectionRecentlyUnstable(engineB, 2_500)).toBe(false);
  });

  // Defensive: a null/undefined engine (nothing connected yet) is never "unstable"
  // and marking it is a no-op — must not throw on the scheduler hot path.
  it('null engine is safe: never unstable, marking is a no-op', () => {
    expect(() => markConnectionUnstable(null, 1_000)).not.toThrow();
    expect(isConnectionRecentlyUnstable(undefined, 1_000)).toBe(false);
  });
});
