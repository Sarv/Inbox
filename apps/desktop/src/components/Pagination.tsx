import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Tooltip } from './Tooltip';

interface PaginationProps {
  /** Total number of items across all pages. */
  total: number;
  /** Current page, 1-based. */
  page: number;
  /** Items per page. */
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** Selectable page sizes. Defaults to 20 / 50 / 100. */
  pageSizeOptions?: number[];
  /** Singular noun for the count text, e.g. "blocked sender" → "3 blocked senders". */
  itemLabel?: string;
}

/**
 * Reusable pagination bar: "X–Y of N items" on the left; page-size selector +
 * prev/next + "Page P of T" on the right. Fully controlled — the parent owns
 * page/pageSize state and does the actual data fetching.
 */
export function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
  itemLabel = 'item',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const label = total === 1 ? itemLabel : `${itemLabel}s`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <div className="tabular-nums">
        {total === 0 ? `No ${label}` : `${start}–${end} of ${total} ${label}`}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5">
          <span className="text-xs">Per page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="px-2 py-1 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            aria-label="Items per page"
          >
            {pageSizeOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <Tooltip content="Previous page" delayMs={40}>
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="p-1.5 rounded-md hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </Tooltip>
          <span className="text-xs tabular-nums px-1 whitespace-nowrap">
            Page {page} of {totalPages}
          </span>
          <Tooltip content="Next page" delayMs={40}>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="p-1.5 rounded-md hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
