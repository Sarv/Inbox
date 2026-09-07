import { beforeEach, describe, expect, it, vi } from 'vitest';

// The watermark is the only thing standing between the app and a whole-mailbox
// thread repair on every launch (measured: ~26s of main-thread work, 0 emails
// retargeted, twice per launch because two schedulers each ran one). Every rule
// here exists because getting it wrong is silent: too-far-forward silently SKIPS
// mail, too-far-back silently brings the freeze back.

const meta = new Map<string, string>();
vi.mock('../../../../electron/services/core-db', () => ({
  getMeta: (key: string) => meta.get(key) ?? null,
  setMeta: (key: string, value: string | null) => {
    if (value == null) meta.delete(key); else meta.set(key, value);
  },
}));

import {
  INCREMENTAL_OVERLAP_SEC,
  THREADING_REPAIR_VERSION,
  recordThreadRepairPass,
  threadRepairWindowStart,
} from '../../../../electron/services/thread-repair-watermark';

const KEY = `threading-repair-scanned-through:v${THREADING_REPAIR_VERSION}:acct-1`;

beforeEach(() => { meta.clear(); });

describe('thread-repair watermark', () => {
  // Regression: a first run MUST be full. Returning a window here would leave the
  // pre-existing mailbox permanently un-repaired — fragmented threads forever.
  it('asks for a FULL pass until one has completed', () => {
    expect(threadRepairWindowStart('acct-1')).toBeUndefined();
  });

  it('then bounds the next pass to the last pass minus the overlap', () => {
    const startedAt = 1_780_315_200_000; // 2026-06-15T12:00:00Z

    recordThreadRepairPass('acct-1', startedAt);

    expect(meta.get(KEY)).toBe(String(startedAt / 1000));
    // Seconds, not milliseconds — `created_at` is unixepoch(). A ms value would be
    // decades in the future and match NOTHING, so the repair would keep "running"
    // while silently never fixing anything again.
    expect(threadRepairWindowStart('acct-1')).toBe(startedAt / 1000 - INCREMENTAL_OVERLAP_SEC);
  });

  // Regression: rows stored WHILE a pass was running may have been read before
  // their parent arrived. Stamping the finish time would put them behind the
  // window and they would never be reconsidered.
  it('records the pass START, so rows inserted mid-pass stay inside the next window', () => {
    const startedAt = 1_780_315_200_000;
    const finishedAt = startedAt + 26_500; // the measured 26.5s pass

    recordThreadRepairPass('acct-1', startedAt);

    const window = threadRepairWindowStart('acct-1') as number;
    expect(window).toBeLessThan(Math.floor(finishedAt / 1000));
  });

  // Regression: a stale or clock-skewed report must not rewind the watermark —
  // that would re-trigger the whole-mailbox pass this exists to prevent.
  it('only ever moves forward', () => {
    recordThreadRepairPass('acct-1', 2_000_000_000_000);
    recordThreadRepairPass('acct-1', 1_000_000_000_000); // earlier — ignored
    expect(meta.get(KEY)).toBe('2000000000');

    recordThreadRepairPass('acct-1', 2_000_000_060_000); // later — accepted
    expect(meta.get(KEY)).toBe('2000000060');
  });

  // Regression: trusting garbage could skip mail forever. A redundant full pass is
  // slow but correct, so anything unusable degrades to "full".
  it('treats an unusable stored value as never having run', () => {
    for (const bad of ['', 'not-a-number', '0', '-5', 'NaN']) {
      meta.set(KEY, bad);
      expect(threadRepairWindowStart('acct-1')).toBeUndefined();
    }
  });

  it('ignores a nonsensical pass time instead of writing it', () => {
    recordThreadRepairPass('acct-1', 0);
    recordThreadRepairPass('acct-1', Number.NaN);
    expect(meta.has(KEY)).toBe(false);
  });

  // Regression: a shared marker would let one account's pass declare the other's
  // mail already scanned — permanently skipping it.
  it('keeps accounts independent', () => {
    recordThreadRepairPass('acct-1', 1_780_315_200_000);
    expect(threadRepairWindowStart('acct-2')).toBeUndefined();
  });

  // Regression: when the resolver's rules improve, existing mail must be re-threaded
  // once. The version lives in the KEY so a bump expires every watermark — there is
  // no separate reset step that could be forgotten.
  it('expires the window when the resolver version changes', () => {
    meta.set('threading-repair-scanned-through:v1:acct-1', '1780315200');
    expect(threadRepairWindowStart('acct-1')).toBeUndefined();
  });

  it('clamps the window at zero rather than going negative', () => {
    recordThreadRepairPass('acct-1', 60_000); // 60s past the epoch
    expect(threadRepairWindowStart('acct-1')).toBe(0);
  });
});
