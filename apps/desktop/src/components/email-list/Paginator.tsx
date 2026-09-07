import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { Tooltip } from '../Tooltip';

interface PaginatorProps {
  /** 0-based current page. */
  page: number;
  /** Rows per page. */
  pageSize: number;
  /** Rows actually on the current page. */
  count: number;
  /** "of N" denominator; 0 = unknown (prev/next gated by hasMore only). */
  total: number;
  /** A next page exists (used when total is unknown, e.g. unified/AI views). */
  hasMore: boolean;
  loading: boolean;
  onGoToPage: (page: number) => void;
  /** Render bare controls (no sticky footer wrapper) for embedding in a top bar. */
  inline?: boolean;
  /**
   * Base the "X–Y" range on the fixed page window (pageSize) instead of the
   * count of rows actually rendered. Use when the source pages by a fixed number
   * of units (e.g. the section full-page view fetches pageSize THREADS/page) but
   * client-side thread-merging collapses them into fewer visible rows — without
   * this the label reads "1–27 of 1624" instead of the true "1–50 of 1624".
   */
  fixedWindow?: boolean;
}

/**
 * Gmail-style page indicator + prev/next. Discrete pages REPLACE the visible
 * rows (see goToEmailPage), so the DOM never holds more than one page — no
 * unbounded infinite-scroll list that grows the DOM until it's unresponsive.
 */
export function Paginator({ page, pageSize, count, total, hasMore, loading, onGoToPage, inline = false, fixedWindow = false }: PaginatorProps) {
  const hasRows = count > 0;
  const start = hasRows ? page * pageSize + 1 : 0;
  // With a fixed window, the last row of the page is the window edge (clamped to
  // the real total), not the collapsed on-screen row count.
  const end = fixedWindow && total > 0
    ? Math.min((page + 1) * pageSize, total)
    : page * pageSize + count;
  const canPrev = page > 0 && !loading;
  const canNext = !loading && (total > 0 ? end < total : hasMore);

  const label = count > 0
    ? `${start.toLocaleString()}–${end.toLocaleString()}${total > 0 ? ` of ${total.toLocaleString()}` : ''}`
    : (loading ? 'Loading…' : 'No messages');

  return (
    <div className={inline
      ? 'flex items-center justify-end gap-1 text-xs text-muted-foreground'
      : 'sticky bottom-0 z-10 flex items-center justify-end gap-1 border-t border-border bg-muted/70 backdrop-blur px-3 py-1.5 text-xs text-muted-foreground'}>
      <span className="tabular-nums mr-1">{label}</span>
      <Tooltip content="Newer" delayMs={40}>
        <button
          onClick={() => onGoToPage(page - 1)}
          disabled={!canPrev}
          aria-label="Newer"
          className={`p-1 rounded ${canPrev ? 'hover:bg-accent text-foreground' : 'opacity-40 cursor-default'}`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </Tooltip>
      <Tooltip content="Older" delayMs={40}>
        <button
          onClick={() => onGoToPage(page + 1)}
          disabled={!canNext}
          aria-label="Older"
          className={`p-1 rounded ${canNext ? 'hover:bg-accent text-foreground' : 'opacity-40 cursor-default'}`}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </Tooltip>
    </div>
  );
}
