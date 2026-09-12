/**
 * The "X–Y of N" range a paginated listing shows, and whether prev/next are
 * live. Pure so it can be unit-tested without rendering: the label is the one
 * thing every listing in the app shares, and a wrong range reads to the user as
 * missing or invented mail.
 */
export interface PageRangeInput {
  /** 0-based current page. */
  page: number;
  /** Rows per page. */
  pageSize: number;
  /** Rows actually on the current page. */
  count: number;
  /** "of N" denominator; 0 = unknown. */
  total: number;
  /** A next page exists (used only when the total is unknown). */
  hasMore: boolean;
  loading: boolean;
  /**
   * Base the range on the fixed page window (pageSize) instead of the rows
   * actually rendered. Use when the source pages by a fixed number of units
   * (e.g. the section full-page view fetches pageSize THREADS/page) but
   * client-side thread-merging collapses them into fewer visible rows — without
   * this the label reads "1–27 of 1624" instead of the true "1–50 of 1624".
   */
  fixedWindow?: boolean;
}

export interface PageRange {
  start: number;
  end: number;
  label: string;
  canPrev: boolean;
  canNext: boolean;
}

export function pageRange({ page, pageSize, count, total, hasMore, loading, fixedWindow = false }: PageRangeInput): PageRange {
  const hasRows = count > 0;
  const start = hasRows ? page * pageSize + 1 : 0;
  // The range can never leave the page window. With a fixed window the last row
  // is the window edge (clamped to the real total); otherwise it's the rows
  // rendered, itself capped at pageSize — a background refresh that spliced in
  // rows the page never asked for used to read "1–111" on a 100-row page.
  const end = fixedWindow && total > 0
    ? Math.min((page + 1) * pageSize, total)
    : page * pageSize + Math.min(count, pageSize);

  const label = hasRows
    ? `${start.toLocaleString()}–${end.toLocaleString()}${total > 0 ? ` of ${total.toLocaleString()}` : ''}`
    : (loading ? 'Loading…' : 'No messages');

  return {
    start,
    end,
    label,
    canPrev: page > 0 && !loading,
    canNext: !loading && (total > 0 ? end < total : hasMore),
  };
}
