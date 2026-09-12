import { describe, it, expect } from 'vitest';

import { pageRange } from '../../../../../src/components/email-list/paginator-range';

const base = { page: 0, pageSize: 50, count: 50, total: 5000, hasMore: true, loading: false };

describe('pageRange', () => {
  // The house pattern. Every listing in the app reads "X–Y of N"; a listing that
  // drops the "of N" leaves the user with no idea how much mail is behind it.
  it('reads "X–Y of N" with thousands separators', () => {
    expect(pageRange(base).label).toBe('1–50 of 5,000');
    expect(pageRange({ ...base, page: 3 }).label).toBe('151–200 of 5,000');
  });

  // The "1–111 on a 100-row page" bug: a background refresh spliced rows the
  // page never asked for into the visible list, and the label grew with it.
  it('never lets the range leave the page window', () => {
    expect(pageRange({ ...base, pageSize: 100, count: 111, total: 1718 }).label).toBe('1–100 of 1,718');
    expect(pageRange({ ...base, pageSize: 100, count: 111, total: 1718 }).end).toBe(100);
  });

  // The last page is short — the range must shrink to the rows actually there,
  // not claim a full window.
  it('shortens the range on a partial last page', () => {
    expect(pageRange({ ...base, page: 2, count: 13, total: 113 }).label).toBe('101–113 of 113');
    expect(pageRange({ ...base, page: 2, count: 13, total: 113 }).canNext).toBe(false);
  });

  // Thread-collapsed sources page by a fixed number of threads but render fewer
  // rows; without the fixed window the label read "1–27 of 1,624".
  it('bases the range on the window, not the rows, for a fixed-window view', () => {
    expect(pageRange({ ...base, count: 27, total: 1624, fixedWindow: true }).label).toBe('1–50 of 1,624');
    // Clamped to the real total on the last page.
    expect(pageRange({ ...base, page: 32, count: 24, total: 1624, fixedWindow: true }).label).toBe('1,601–1,624 of 1,624');
  });

  // A total of 0 means "unknown", not "empty" — paging then follows hasMore.
  it('omits the "of N" when the total is unknown and gates next on hasMore', () => {
    expect(pageRange({ ...base, total: 0 }).label).toBe('1–50');
    expect(pageRange({ ...base, total: 0, hasMore: true }).canNext).toBe(true);
    expect(pageRange({ ...base, total: 0, hasMore: false }).canNext).toBe(false);
  });

  // An empty page must say so rather than showing "1–0"; mid-load it says so too.
  it('says "No messages" when empty, "Loading…" while fetching', () => {
    expect(pageRange({ ...base, count: 0, total: 0 }).label).toBe('No messages');
    expect(pageRange({ ...base, count: 0, total: 0, loading: true }).label).toBe('Loading…');
    expect(pageRange({ ...base, count: 0, total: 0 }).start).toBe(0);
  });

  // Prev/next must not fire a second fetch while one is in flight.
  it('disables both arrows while loading, and prev on the first page', () => {
    expect(pageRange({ ...base, loading: true }).canPrev).toBe(false);
    expect(pageRange({ ...base, loading: true }).canNext).toBe(false);
    expect(pageRange(base).canPrev).toBe(false);
    expect(pageRange({ ...base, page: 1 }).canPrev).toBe(true);
  });
});
