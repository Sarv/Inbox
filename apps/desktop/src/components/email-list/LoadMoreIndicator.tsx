import { Loader2 } from 'lucide-react';

import type { LoadMoreIndicatorProps } from './types';

export function LoadMoreIndicator({
  displayEmailsCount,
  conversationCount,
  localTotal,
  serverTotal,
  hasMoreEmails,
  loadingMoreEmails,
  onLoadMore,
}: LoadMoreIndicatorProps) {
  const moreInLocalDb = localTotal > displayEmailsCount;
  const moreOnServer = serverTotal > localTotal;
  // Rows are grouped into conversations, so lead with that count — otherwise
  // "16 of 16 emails" next to 4 visible rows reads as a mismatch.
  const convLabel = `${conversationCount} conversation${conversationCount === 1 ? '' : 's'}`;
  // The "X of Y" fraction only means something while there's more to load.
  // Once everything is loaded it's a redundant "3 of 3" that competes with the
  // per-conversation counts, so collapse it to a plain loaded count. (The email
  // count is scoped to THIS view and deliberately won't sum to the per-row
  // conversation counts — those span all folders.)
  const emailLabel = moreInLocalDb || moreOnServer
    ? `${displayEmailsCount} of ${localTotal} emails`
    : `${displayEmailsCount} email${displayEmailsCount === 1 ? '' : 's'}`;

  return (
    <div className="py-6 flex flex-col items-center gap-2">
      <span className="px-4 py-2 text-xs text-muted-foreground bg-muted/30 rounded-full">
        {convLabel} · {emailLabel}
        {moreOnServer && ` (${serverTotal} on server)`}
      </span>
      {(hasMoreEmails || moreInLocalDb || moreOnServer) && (
        <button
          onClick={onLoadMore}
          disabled={loadingMoreEmails}
          className="px-4 py-2 text-xs text-primary hover:bg-accent rounded-full border border-primary/30"
        >
          {loadingMoreEmails ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {moreOnServer && !moreInLocalDb ? 'Fetching from server...' : 'Loading...'}
            </span>
          ) : moreInLocalDb ? (
            `Load more (${localTotal - displayEmailsCount} remaining)`
          ) : (
            `Fetch more from server (${serverTotal - localTotal} available)`
          )}
        </button>
      )}
      {!hasMoreEmails && !moreInLocalDb && !moreOnServer && (
        <span className="text-xs text-muted-foreground">All emails loaded</span>
      )}
    </div>
  );
}
