import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

import { Tooltip } from '../Tooltip';

import { pageRange, type PageRangeInput } from './paginator-range';

interface PaginatorProps extends PageRangeInput {
  onGoToPage: (page: number) => void;
  /** Render bare controls (no sticky footer wrapper) for embedding in a top bar. */
  inline?: boolean;
}

/**
 * Gmail-style page indicator + prev/next. Discrete pages REPLACE the visible
 * rows (see goToEmailPage), so the DOM never holds more than one page — no
 * unbounded infinite-scroll list that grows the DOM until it's unresponsive.
 *
 * The range math lives in `pageRange` (pure, unit-tested) so every listing in
 * the app reads "X–Y of N" the same way.
 */
export function Paginator({ page, pageSize, count, total, hasMore, loading, onGoToPage, inline = false, fixedWindow = false }: PaginatorProps) {
  const { label, canPrev, canNext } = pageRange({ page, pageSize, count, total, hasMore, loading, fixedWindow });

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
