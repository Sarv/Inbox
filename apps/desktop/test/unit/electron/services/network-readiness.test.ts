import { describe, expect, it, vi } from 'vitest';

/**
 * The post-wake network gate.
 *
 * A wake's first 1-3 seconds have an associated interface but no working DNS.
 * Firing an OAuth refresh into that window is how a rotating refresh token gets
 * spent for nothing. This waits for the link — but it is a WAIT, never a veto:
 * `net.isOnline()` reports link state, not reachability, so one false negative
 * must never be allowed to stop mail permanently.
 */

const h = vi.hoisted(() => ({ net: { isOnline: undefined as undefined | (() => boolean) } }));
vi.mock('electron', () => ({ net: h.net }));

import {
  NETWORK_POLL_MS,
  waitForNetworkReady,
} from '../../../../electron/services/network-readiness';

/** A deterministic clock + sleep so the poll loop runs with no real time. */
const fakeClock = () => {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => nowMs,
    sleep: async (ms: number) => { sleeps.push(ms); nowMs += ms; },
  };
};

describe('waitForNetworkReady', () => {
  // The common case: already online. Adding latency to every refresh would be a
  // self-inflicted regression on a machine that never slept.
  it('returns immediately when the link is already up', async () => {
    const clock = fakeClock();
    const isOnline = vi.fn(() => true);

    await expect(waitForNetworkReady(5_000, { ...clock, isOnline })).resolves.toBe(true);
    expect(clock.sleeps).toHaveLength(0);
    expect(isOnline).toHaveBeenCalledTimes(1);
  });

  // Outside a real Electron main process there is no `net` to ask. Unknown is
  // not offline — stalling here would hang every refresh in tests and tooling.
  it('treats an unavailable net API as "go ahead", never as offline', async () => {
    const clock = fakeClock();

    await expect(waitForNetworkReady(5_000, { ...clock, isOnline: () => null })).resolves.toBe(true);
    expect(clock.sleeps).toHaveLength(0);
  });

  // The reason this exists: proceed as soon as the link is genuinely back,
  // rather than sitting out the full timeout.
  it('resolves as soon as the link comes back, without waiting out the timeout', async () => {
    const clock = fakeClock();
    let calls = 0;
    const isOnline = () => { calls += 1; return calls > 2; }; // offline, offline, up

    await expect(waitForNetworkReady(5_000, { ...clock, isOnline })).resolves.toBe(true);
    expect(clock.sleeps).toEqual([NETWORK_POLL_MS, NETWORK_POLL_MS]);
  });

  // A link state that never resolves must not become an infinite wait — the
  // caller is holding a refresh open behind this.
  it('gives up after the timeout and reports false rather than blocking forever', async () => {
    const clock = fakeClock();

    await expect(waitForNetworkReady(1_000, { ...clock, isOnline: () => false })).resolves.toBe(false);
    // 1000ms / 250ms polls — bounded, and it stopped at the deadline.
    expect(clock.sleeps).toHaveLength(4);
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
  });

  // The production wiring — real `net.isOnline`, real timers — has to work too,
  // or the whole gate is only ever exercised through its test seams.
  it('polls Electron and the real clock when given no injected deps', async () => {
    let calls = 0;
    h.net.isOnline = () => { calls += 1; return calls > 1; }; // offline, then up

    await expect(waitForNetworkReady(2_000)).resolves.toBe(true);
    expect(calls).toBe(2); // one probe + one poll, ~250ms apart
    h.net.isOnline = undefined;
  });

  // A zero/elapsed budget must still answer, not divide-by-zero into a poll
  // loop: callers pass a configured timeout that could legitimately be tiny.
  it('answers without polling when there is no time budget at all', async () => {
    const clock = fakeClock();

    await expect(waitForNetworkReady(0, { ...clock, isOnline: () => false })).resolves.toBe(false);
    expect(clock.sleeps).toHaveLength(0);
  });
});
