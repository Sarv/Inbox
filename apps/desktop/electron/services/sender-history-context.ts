import type { SenderSignals } from '@sarvinbox/core';

import type { UnreadReviewBehaviorSignals } from './inbox-assistant-review-behavior';

/** Both AI paths use the named mailbox's durable human-action evidence. */
export function readCategorizationSenderHistory(senders: string[], query: {
  legacy(senders: string[]): Record<string, Partial<SenderSignals>>;
  human(senders: string[]): Record<string, UnreadReviewBehaviorSignals>;
}): Record<string, SenderSignals> {
  const addresses = [...new Set(senders.filter(value => typeof value === 'string' && value.length <= 254)
    .map(value => value.trim().toLowerCase()).filter(value => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(value)))].slice(0, 1000);
  const result: Record<string, SenderSignals> = {};
  for (let offset = 0; offset < addresses.length; offset += 100) {
    const chunk = addresses.slice(offset, offset + 100);
    let legacy: Record<string, Partial<SenderSignals>> = {};
    let human: Record<string, UnreadReviewBehaviorSignals> = {};
    try { legacy = query.legacy(chunk); } catch { /* Relationship context is optional. */ }
    try { human = query.human(chunk); } catch { /* Missing evidence stays explicitly unavailable. */ }
    for (const sender of chunk) {
      result[sender] = {
        tier: 'unknown', receivedCount: 0, sentToCount: 0, repliedCount: 0, readCount: 0, deletedCount: 0,
        isVip: false, isFavorite: false, isBlocked: false, ...legacy[sender],
        // Presence is intentional: the core prompt must not fall back to old
        // mixed-source percentages when durable human history is unavailable.
        humanBehavior: human[sender] ?? null,
      };
    }
  }
  return result;
}
