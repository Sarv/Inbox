import { describe, expect, it } from 'vitest';

import type { InboxAssistantExchange } from '../../../../src/types/inbox-assistant';
import type { InboxAssistantReview } from '../../../../src/types/inbox-assistant-actions';
import { newerReviewExchangeIds } from '../../../../src/utils/inbox-assistant-newer-review';

const WORK = { id: 'work', email: 'owner@example.test' };
const OTHER = { id: 'other', email: 'other@example.test' };

function review(over: Partial<InboxAssistantReview> = {}): InboxAssistantReview {
  return { id: 'review', kind: 'uncategorized', createdAt: 1, expiresAt: 2, status: 'ready', accounts: [WORK], items: [], coverage: [], truncated: false, ...over };
}
function exchange(id: string, over: Partial<InboxAssistantExchange> = {}): InboxAssistantExchange {
  return { id, chatId: 'chat', question: 'Review my uncategorized unread emails.', accountIds: ['work'], createdAt: Number(id.replace(/\D/g, '')) || 0,
    answer: { text: '', sources: [], coverage: [], warnings: [] }, review: review({ id: `review-${id}` }), ...over };
}
const pairs = (exchanges: InboxAssistantExchange[]) => [...newerReviewExchangeIds(exchanges)];

describe('which review cards a later review has replaced', () => {
  // Breaks: an expired card that was refreshed keeps its dead buttons and its
  // own "Refresh review", so the user refreshes it again and again.
  it('points every earlier review of the same mail at the newest one', () => {
    expect(pairs([exchange('e1'), exchange('e2'), exchange('e3')])).toEqual([['e2', 'e3'], ['e1', 'e3']]);
  });

  // Breaks: the only review in a conversation is told a newer one exists, and
  // loses the "Refresh review" that is its one way forward.
  it('replaces nothing when a review has not been asked for again', () => {
    expect(pairs([exchange('e1')])).toEqual([]);
    expect(pairs([exchange('e1', { review: undefined }), exchange('e2')])).toEqual([]);
    expect(pairs([])).toEqual([]);
  });

  // Breaks: one account's review card sends the user to a review of a different
  // account (or of different mail) as if it were the same review, refreshed.
  it('never treats a review of other accounts, another kind, phrase or age cutoff as the same review', () => {
    const base = exchange('e1');
    const different: Array<Partial<InboxAssistantReview>> = [
      { accounts: [OTHER] },
      { accounts: [WORK, OTHER] },
      { kind: 'unread' },
      { kind: 'mark_read', scope: { field: 'any', query: 'Acme' } },
      { dateFilter: { olderThanDays: 15, before: 1_000 } },
    ];
    for (const over of different) expect(pairs([base, exchange('e2', { review: review({ id: 'later', ...over }) })]), JSON.stringify(over)).toEqual([]);
    const acme = exchange('e1', { review: review({ kind: 'mark_read', scope: { field: 'any', query: 'Acme' } }) });
    expect(pairs([acme, exchange('e2', { review: review({ kind: 'mark_read', scope: { field: 'any', query: 'Globex' } }) })])).toEqual([]);
    expect(pairs([acme, exchange('e2', { review: review({ kind: 'mark_read', scope: { field: 'subject', query: 'Acme' } }) })])).toEqual([]);
    expect(pairs([acme, exchange('e2', { review: review({ kind: 'mark_read', scope: { field: 'any', query: 'Acme' } }) })])).toEqual([['e1', 'e2']]);
  });

  // Breaks: the same two accounts listed in another order read as a different
  // review, and the refreshed card is not recognised.
  it('matches the same accounts whatever order they are listed in, and the same cutoff taken at a later moment', () => {
    const first = exchange('e1', { review: review({ accounts: [WORK, OTHER], dateFilter: { olderThanDays: 15, before: 1_000 } }) });
    const second = exchange('e2', { review: review({ accounts: [OTHER, WORK], dateFilter: { olderThanDays: 15, before: 9_000 } }) });
    expect(pairs([first, second])).toEqual([['e1', 'e2']]);
  });

  // Breaks: "Go to newer review" leads to a collapsed batch row of an automatic
  // run, or to an answer that failed or is still being prepared and has no card.
  it('sends the user only to a finished review card, never to a batch row or an unfinished answer', () => {
    const batch = exchange('e2', { reviewBatch: { runId: 'run', number: 1 } });
    expect(pairs([exchange('e1'), batch])).toEqual([]);
    for (const status of ['pending', 'running', 'failed', 'stopped'] as const) expect(pairs([exchange('e1'), exchange('e2', { status })]), status).toEqual([]);
    expect(pairs([exchange('e1'), exchange('e2', { status: 'completed' })])).toEqual([['e1', 'e2']]);
    // A batch row is itself replaced by a later card, and an earlier card skips over it.
    expect(pairs([exchange('e1'), batch, exchange('e3')])).toEqual([['e2', 'e3'], ['e1', 'e3']]);
    expect(pairs([exchange('e1'), exchange('e2'), exchange('e3', { reviewBatch: { runId: 'run', number: 1 } })])).toEqual([['e1', 'e2']]);
  });
});
