/**
 * Signal 1: Engagement Depth
 *
 * Not just "read/unread" — analyzes the ACTION SEQUENCE to determine
 * if the user actually cares about emails from this sender.
 *
 * read + replied = HIGH engagement
 * read + deleted in <5s = NOISE (curiosity read)
 * read + kept 3+ days = procrastinating but important
 * unread 7+ days = doesn't care
 */

import type { EngagementSignal, EngagementPattern, SenderHistoricalStats } from './types';

export function computeEngagementDepth(
  senderStats: SenderHistoricalStats,
  isCurrentEmailRead: boolean,
  emailAgeSec: number,
): EngagementSignal {
  const total = Math.max(1, senderStats.totalFromSender);
  const readThenDeletedFastCount = senderStats.readThenDeletedFast;
  const readThenRepliedCount = senderStats.readThenReplied;
  const readThenStarredCount = 0; // TODO: track
  const readAndKeptCount = senderStats.readAndKept;
  const readAndArchivedCount = senderStats.readAndArchived;
  const unreadOldCount = senderStats.unreadOld;

  // Determine dominant pattern for this sender
  const patterns: { pattern: EngagementPattern; count: number; score: number }[] = [
    { pattern: 'read_replied', count: readThenRepliedCount, score: 0.95 },
    { pattern: 'read_starred', count: readThenStarredCount, score: 0.90 },
    { pattern: 'read_lingered', count: readAndKeptCount, score: 0.70 },
    { pattern: 'read_archived', count: readAndArchivedCount, score: 0.40 },
    { pattern: 'read_deleted_fast', count: readThenDeletedFastCount, score: 0.05 },
    { pattern: 'unread_old', count: unreadOldCount, score: 0.02 },
  ];

  // Sort by count descending to find dominant behavior
  patterns.sort((a, b) => b.count - a.count);
  const dominant = patterns[0];

  // If no history, use current email state
  if (dominant.count === 0) {
    if (!isCurrentEmailRead && emailAgeSec > 7 * 86400) {
      return { value: 0.05, confidence: 0.3, reasoning: 'Unread for 7+ days', pattern: 'unread_old' };
    }
    if (!isCurrentEmailRead) {
      return { value: 0.5, confidence: 0.1, reasoning: 'New unread email, no sender history', pattern: 'unknown' };
    }
    return { value: 0.5, confidence: 0.1, reasoning: 'Read but no pattern data', pattern: 'read_kept' };
  }

  // Confidence scales with data volume
  const confidence = Math.min(0.95, dominant.count / Math.max(10, total) + 0.2);

  // Weighted score: blend dominant pattern with overall engagement
  const replyRate = (readThenRepliedCount + readThenStarredCount) / total;
  const noiseRate = readThenDeletedFastCount / total;
  const blendedScore = dominant.score * 0.7 + (replyRate * 0.95 + (1 - noiseRate) * 0.3) * 0.3 / 1.25;

  const value = Math.max(0, Math.min(1, blendedScore));

  // Reasoning
  const parts: string[] = [];
  if (readThenRepliedCount > 0) parts.push(`replied ${readThenRepliedCount}x`);
  if (readThenDeletedFastCount > 0) parts.push(`quick-deleted ${readThenDeletedFastCount}x`);
  if (readAndKeptCount > 0) parts.push(`kept ${readAndKeptCount}x`);
  if (readAndArchivedCount > 0) parts.push(`archived ${readAndArchivedCount}x`);

  return {
    value,
    confidence,
    reasoning: parts.length > 0
      ? `Sender pattern: ${dominant.pattern} (${parts.join(', ')})`
      : `Pattern: ${dominant.pattern}`,
    pattern: dominant.pattern,
  };
}
