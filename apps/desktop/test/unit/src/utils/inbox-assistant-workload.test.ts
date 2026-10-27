import { describe, expect, it } from 'vitest';

import type { InboxAssistantAIWorkload } from '../../../../src/types/inbox-assistant';
import { readInboxAssistantAIWorkload } from '../../../../src/utils/inbox-assistant-workload';

const workload: InboxAssistantAIWorkload = { operation: 'unread_review', conversationCount: 16, messageCount: 40,
  originalContentChars: 40_000, submittedContentChars: 20_000, reusedQuotedTurns: 8 };

describe('host unread-review workload metadata', () => {
  it('counts bounded behavior context separately and drops invalid optional metadata', () => {
    expect(readInboxAssistantAIWorkload({ ...workload, behaviorContextChars: 300 })).toEqual({ ...workload, behaviorContextChars: 300 });
    expect(readInboxAssistantAIWorkload({ ...workload, behaviorContextChars: -1 })).toEqual(workload);
    expect(readInboxAssistantAIWorkload({ ...workload, behaviorContextChars: 32_769 })).toEqual(workload);
  });

  it('copies only bounded numeric diagnostics and never retains supplied content', () => {
    expect(readInboxAssistantAIWorkload({ ...workload, body: 'private email', apiKey: 'private key' })).toEqual(workload);
    expect(readInboxAssistantAIWorkload(workload)).not.toBe(workload);
  });

  it.each([
    null, [], {}, { ...workload, operation: 'answer' }, { ...workload, conversationCount: 0 }, { ...workload, conversationCount: 17 },
    { ...workload, messageCount: 15 }, { ...workload, messageCount: 1_601 }, { ...workload, messageCount: 16.5 },
    { ...workload, originalContentChars: -1 }, { ...workload, originalContentChars: 192_001 },
    { ...workload, submittedContentChars: Infinity }, { ...workload, submittedContentChars: '20000' },
    { ...workload, submittedContentChars: 40_001 }, { ...workload, reusedQuotedTurns: NaN }, { ...workload, reusedQuotedTurns: 100_001 },
  ])('omits invalid optional diagnostics: %j', value => {
    expect(readInboxAssistantAIWorkload(value)).toBeUndefined();
  });
});
