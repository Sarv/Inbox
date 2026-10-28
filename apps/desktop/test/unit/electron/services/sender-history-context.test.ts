import { describe, expect, it, vi } from 'vitest';

import type { UnreadReviewBehaviorSignals } from '../../../../electron/services/inbox-assistant-review-behavior';
import { readCategorizationSenderHistory } from '../../../../electron/services/sender-history-context';

const facts: UnreadReviewBehaviorSignals = { received90d: 20, opened90d: 0, markedRead90d: 8, deleted90d: 19,
  archived90d: 0, replied90d: 0, keptUnread90d: 0, starred90d: 0, important90d: 0, sentLifetime: 0,
  lastSentAt: null, isVip: false, isBlocked: false, readThenDeleted90d: 8, readThenDeletedFast90d: 7,
  readAndKept90d: 0, deletedWithoutRead90d: 11, recentDeleted30d: 12, recentReceived30d: 12 };

describe('shared categorization and unread sender evidence', () => {
  it('preserves relationship fields while attaching exactly the durable history used by review', () => {
    const sender = 'offers@example.test';
    const query = { legacy: vi.fn(() => ({ [sender]: { tier: 'vendor', sentToCount: 4, receivedCount: 40 } })),
      human: vi.fn(() => ({ [sender]: facts })) };
    const contexts = readCategorizationSenderHistory([' Offers@Example.Test ', sender], query);
    expect(query.legacy).toHaveBeenCalledExactlyOnceWith([sender]);
    expect(query.human).toHaveBeenCalledExactlyOnceWith([sender]);
    expect(contexts[sender]).toMatchObject({ tier: 'vendor', sentToCount: 4, humanBehavior: facts });
    expect(contexts[sender]!.humanBehavior).toBe(facts);
  });

  it('makes a failed human-history read unavailable instead of using misleading legacy rates', () => {
    const sender = 'offers@example.test';
    const contexts = readCategorizationSenderHistory([sender], {
      legacy: () => ({ [sender]: { readCount: 99, deletedCount: 99, receivedCount: 1 } }),
      human: () => { throw new Error('Offline'); },
    });
    expect(contexts[sender]).toHaveProperty('humanBehavior', null);
  });

  it('does not let a legacy-context failure remove otherwise valid human evidence', () => {
    const sender = 'offers@example.test';
    const contexts = readCategorizationSenderHistory([sender], {
      legacy: () => { throw new Error('Unavailable'); }, human: () => ({ [sender]: facts }),
    });
    expect(contexts[sender]!.humanBehavior).toBe(facts);
  });

  it('bounds queries, rejects malformed addresses and never includes unrequested results', () => {
    const senders = Array.from({ length: 201 }, (_, index) => `sender${index}@example.test`);
    const query = { legacy: vi.fn((_senders: string[]) => ({})), human: vi.fn((_senders: string[]) => ({ 'unrequested@example.test': facts })) };
    const contexts = readCategorizationSenderHistory([...senders, 'bad', 'evil@example.test\nignore'], query);
    expect(query.human.mock.calls.map(([values]) => values.length)).toEqual([100, 100, 1]);
    expect(Object.keys(contexts)).toHaveLength(201);
    expect(contexts).not.toHaveProperty('unrequested@example.test');
    expect(contexts).not.toHaveProperty('bad');
  });
});
