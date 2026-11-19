import type { InboxAssistantExchange } from '../types/inbox-assistant';
import type { InboxAssistantReview } from '../types/inbox-assistant-actions';

/**
 * Which review cards in a conversation have been replaced by a later one.
 *
 * "Refresh review" (and asking the same thing again) does not revive a card: it
 * adds a fresh review further down the conversation. The earlier card stays
 * where it was, and once its time is up it can never change mail again. Left
 * as it is, it keeps offering the same disabled buttons and the same "Refresh
 * review", so the user refreshes a card that has already been refreshed.
 *
 * A later review replaces an earlier one when it covers the same mail: the
 * same kind of review, the same accounts, the same matching rule and the same
 * age cutoff. A review of other accounts or another phrase is a different
 * review, and never stands in for this one.
 */

function reviewTarget(review: InboxAssistantReview): string {
  return JSON.stringify([
    review.kind,
    review.accounts.map(account => account.id).sort(),
    review.scope ? [review.scope.field, review.scope.query] : null,
    review.dateFilter?.olderThanDays ?? null,
  ]);
}

/** Earlier exchange id → the id of the newest later exchange whose review covers the same mail. */
export function newerReviewExchangeIds(exchanges: readonly InboxAssistantExchange[]): Map<string, string> {
  const newest = new Map<string, string>();
  const replaced = new Map<string, string>();
  // Newest first, so every earlier card points at the latest review, not the next one.
  for (const exchange of [...exchanges].reverse()) {
    if (!exchange.review) continue;
    const target = reviewTarget(exchange.review);
    const newer = newest.get(target);
    if (newer) replaced.set(exchange.id, newer);
    // A batch row of an automatic run is collapsed and belongs to its run; an
    // unfinished or failed answer has no review to act on. Neither is a card
    // the user can be sent to.
    else if (!exchange.reviewBatch && (!exchange.status || exchange.status === 'completed')) newest.set(target, exchange.id);
  }
  return replaced;
}
