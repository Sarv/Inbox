import type { InboxAssistantAIWorkload } from '../types/inbox-assistant';

/** Optional diagnostic metadata must never invalidate legacy usage or invent token counts. */
export function readInboxAssistantAIWorkload(value: unknown): InboxAssistantAIWorkload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const count = (field: string, maximum: number, minimum = 0): boolean => typeof row[field] === 'number'
    && Number.isSafeInteger(row[field]) && (row[field] as number) >= minimum && (row[field] as number) <= maximum;
  if (row.operation !== 'unread_review' || !count('conversationCount', 16, 1) || !count('messageCount', 1_600, 1)
    || !count('originalContentChars', 192_000) || !count('submittedContentChars', 192_000) || !count('reusedQuotedTurns', 100_000)
    || (row.messageCount as number) < (row.conversationCount as number)
    || (row.submittedContentChars as number) > (row.originalContentChars as number)) return undefined;
  return { operation: 'unread_review', conversationCount: row.conversationCount as number, messageCount: row.messageCount as number,
    originalContentChars: row.originalContentChars as number, submittedContentChars: row.submittedContentChars as number,
    reusedQuotedTurns: row.reusedQuotedTurns as number,
    ...(count('behaviorContextChars', 32_768) ? { behaviorContextChars: row.behaviorContextChars as number } : {}) };
}
