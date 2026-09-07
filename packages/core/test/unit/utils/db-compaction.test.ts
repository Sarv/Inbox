import { describe, it, expect } from 'vitest';

import {
  compactionEstimate,
  isCompactionWorthwhile,
  hasCompactionHeadroom,
} from '../../../src/utils/db-compaction';

/**
 * The arithmetic behind the "Compress database" button.
 *
 * What breaks if this file fails: the button either lies about how much it will
 * reclaim, offers a pointless minutes-long rebuild, or — worst — starts one on a
 * volume too full to hold the second copy VACUUM writes before it swaps. The
 * numbers here are what the user reads before agreeing to pause their mail sync.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('compactionEstimate', () => {
  // The real shape from the live Gmail account DB: 10.52 GB on disk of which
  // 8.72 GB is holes. If the arithmetic drifts, the user is told the wrong
  // saving and judges the rebuild on a false number.
  it('reports file, free and live bytes from the occupancy pragmas', () => {
    const estimate = compactionEstimate({
      pageSize: 4096,
      pageCount: 2_569_337,
      freelistCount: 2_128_481,
    });

    expect(estimate.fileBytes).toBe(4096 * 2_569_337);
    expect(estimate.freeBytes).toBe(4096 * 2_128_481);
    expect(estimate.liveBytes).toBe(4096 * (2_569_337 - 2_128_481));
    expect(estimate.freeRatio).toBeCloseTo(0.828, 3);
  });

  // The healthy account: zero free pages. A rebuild here would spend minutes to
  // reclaim nothing, so the estimate has to say so plainly.
  it('reports nothing reclaimable when the freelist is empty', () => {
    const estimate = compactionEstimate({ pageSize: 4096, pageCount: 144_750, freelistCount: 0 });

    expect(estimate.freeBytes).toBe(0);
    expect(estimate.freeRatio).toBe(0);
    expect(estimate.liveBytes).toBe(estimate.fileBytes);
  });

  // page_count and freelist_count are two separate pragma reads. A write landing
  // between them can make the free count the larger, and an unclamped subtraction
  // would hand the UI a NEGATIVE live size.
  it('clamps a freelist larger than the page count instead of going negative', () => {
    const estimate = compactionEstimate({ pageSize: 4096, pageCount: 100, freelistCount: 250 });

    expect(estimate.freeBytes).toBe(estimate.fileBytes);
    expect(estimate.liveBytes).toBe(0);
    expect(estimate.freeRatio).toBe(1);
  });

  // Pragma values arrive from SQL and can be null on a DB that failed to open.
  it.each([
    ['an empty database', { pageSize: 4096, pageCount: 0, freelistCount: 0 }],
    ['null counts', { pageSize: null as never, pageCount: null as never, freelistCount: null as never }],
    ['negative counts', { pageSize: -1, pageCount: -20, freelistCount: -5 }],
    ['NaN counts', { pageSize: NaN, pageCount: NaN, freelistCount: NaN }],
  ])('returns zeroes and never NaN for %s', (_case, stats) => {
    const estimate = compactionEstimate(stats);

    expect(estimate).toEqual({ fileBytes: 0, freeBytes: 0, liveBytes: 0, freeRatio: 0 });
  });
});

describe('isCompactionWorthwhile', () => {
  // Both conditions must hold. The ratio alone flags a 20 MB DB that is mostly
  // holes; the absolute size alone flags a perfectly healthy 40 GB one. Either
  // mistake offers the user a rebuild that cannot pay for itself.
  it.each([
    ['82% free of 10.5 GB (the real case)', 4096, 2_569_337, 2_128_481, true],
    ['a healthy DB with no free pages', 4096, 144_750, 0, false],
    ['90% free but only 18 MB — below the absolute floor', 4096, 5_000, 4_500, false],
    ['4 GB free but only 10% of a 40 GB file — below the ratio floor', 4096, 10_000_000, 1_000_000, false],
  ])('%s -> %s', (_case, pageSize, pageCount, freelistCount, expected) => {
    expect(isCompactionWorthwhile(compactionEstimate({ pageSize, pageCount, freelistCount })))
      .toBe(expected);
  });

  it('honours caller-supplied thresholds', () => {
    const estimate = compactionEstimate({ pageSize: 4096, pageCount: 5_000, freelistCount: 4_500 });

    expect(isCompactionWorthwhile(estimate)).toBe(false);
    expect(isCompactionWorthwhile(estimate, { minFreeBytes: 1 * MB })).toBe(true);
  });

  // Exactly at the threshold must count as worthwhile, or a DB parked on the
  // boundary can never be compacted.
  it('treats the thresholds as inclusive', () => {
    const estimate = { fileBytes: 400 * MB, freeBytes: 100 * MB, liveBytes: 300 * MB, freeRatio: 0.25 };

    expect(isCompactionWorthwhile(estimate)).toBe(true);
  });
});

describe('hasCompactionHeadroom', () => {
  // VACUUM writes a COMPLETE second copy before swapping, so the peak need is the
  // CURRENT file size — not the post-compaction size. Sizing this off the live
  // bytes would green-light a rebuild that runs the volume out of space midway.
  it('requires room for a full second copy plus margin', () => {
    const fileBytes = 10 * GB;

    expect(hasCompactionHeadroom(fileBytes, 75 * GB)).toBe(true);
    expect(hasCompactionHeadroom(fileBytes, 12 * GB)).toBe(true);
    expect(hasCompactionHeadroom(fileBytes, 11 * GB)).toBe(false); // 10 GB + 20% = 12 GB
    expect(hasCompactionHeadroom(fileBytes, 2 * GB)).toBe(false);  // post-VACUUM size is NOT the bar
  });

  it('accepts a caller-supplied margin', () => {
    expect(hasCompactionHeadroom(10 * GB, 10 * GB, 1.0)).toBe(true);
    expect(hasCompactionHeadroom(10 * GB, 10 * GB, 1.5)).toBe(false);
  });

  // statfs can fail or report nonsense; the safe answer is "no room", never a
  // rebuild started on an unknown volume.
  it.each([
    ['unreadable free space', 10 * GB, NaN],
    ['negative free space', 10 * GB, -1],
    ['no free space', 10 * GB, 0],
  ])('refuses on %s', (_case, fileBytes, freeDisk) => {
    expect(hasCompactionHeadroom(fileBytes, freeDisk)).toBe(false);
  });

  // A zero-byte file needs nothing; this must not divide-by-zero into a refusal
  // that makes the button permanently dead on a fresh install.
  it('allows a zero-byte database', () => {
    expect(hasCompactionHeadroom(0, 0)).toBe(true);
  });
});
