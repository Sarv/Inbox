import { ArrowLeft } from 'lucide-react';

import { Tooltip } from '../Tooltip';

import type { ListHeaderView } from './list-header-view';
import { Paginator } from './Paginator';

export type { ListHeaderView };
export { listHeaderTitle } from './list-header-view';

interface ListHeaderProps {
  /** What the reader is looking at: a folder, a section, a category, a view. */
  title: string;
  /** Renders a back button on the left when given (the section full-page view). */
  onBack?: () => void;
  /** Tooltip + aria-label for the back button. */
  backLabel?: string;
  /** 0-based current page. */
  page: number;
  /** Rows per page — always the view's own page size (getPageSizeForView). */
  pageSize: number;
  /** Rows actually on the current page. */
  count: number;
  /** "of N" denominator; 0 = unknown (prev/next gated by hasMore only). */
  total: number;
  hasMore: boolean;
  loading: boolean;
  onGoToPage: (page: number) => void;
  /** See Paginator: base "X–Y" on the page window, not the collapsed row count. */
  fixedWindow?: boolean;
}

/**
 * The one top bar every listing wears: title on the left, page indicator and
 * prev/next on the right, sticky to the top of the scroller.
 *
 * Single component on purpose. The section full-page view, "All Inboxes" and
 * the AI-category list each hand-rolled this same bar, so a plain folder (Sent,
 * a user folder) got no bar at all and the three copies drifted in what they
 * passed the Paginator. One header, one set of Paginator props, one place to
 * change the layout.
 */

export function ListHeader({
  title,
  onBack,
  backLabel = 'Back',
  page,
  pageSize,
  count,
  total,
  hasMore,
  loading,
  onGoToPage,
  fixedWindow = false,
}: ListHeaderProps) {
  return (
    <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-2 bg-muted border-b border-border">
      {onBack && (
        <Tooltip content={backLabel} delayMs={40}>
          <button
            onClick={onBack}
            className="p-1 hover:bg-accent rounded text-foreground"
            aria-label={backLabel}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        </Tooltip>
      )}
      {title && <span className="text-sm font-medium text-foreground">{title}</span>}
      <div className="ml-auto">
        <Paginator
          page={page}
          pageSize={pageSize}
          count={count}
          total={total}
          hasMore={hasMore}
          loading={loading}
          onGoToPage={onGoToPage}
          inline
          fixedWindow={fixedWindow}
        />
      </div>
    </div>
  );
}
