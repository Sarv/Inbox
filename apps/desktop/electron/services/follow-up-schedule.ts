/**
 * Pure rules for follow-up reminders — when one falls due, and what a checker
 * pass should do with it. No I/O here, so every rule is pinned by a unit test;
 * the checker (follow-up-checker.ts) and the send path only apply them.
 *
 * All times are unix epoch seconds (UTC).
 */
import type { FollowUp, SendFollowUpRequest } from '@sarvinbox/core';

/**
 * The earliest a reminder may fall due after the send. A custom date picked in
 * the past (or a send held in the outbox past its reminder) would otherwise
 * notify the moment the message leaves.
 */
export const MIN_FOLLOW_UP_DELAY_SECONDS = 60 * 60;

const isPositive = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * When the reminder for a message sent at `sentAt` falls due, or null when no
 * (usable) reminder was asked for. A relative delay counts from the actual
 * send, not from when the composer closed, so an outbox-delayed message still
 * gets its full "3 days". An absolute time wins over a delay.
 */
export function resolveFollowUpDueAt(
  request: SendFollowUpRequest | undefined,
  sentAt: number,
): number | null {
  if (!request) return null;
  const earliest = sentAt + MIN_FOLLOW_UP_DELAY_SECONDS;
  if (isPositive(request.at)) return Math.max(Math.floor(request.at), earliest);
  if (isPositive(request.afterSeconds)) return sentAt + Math.max(Math.floor(request.afterSeconds), MIN_FOLLOW_UP_DELAY_SECONDS);
  return null;
}

/**
 * What a checker pass does with an open reminder: end it when someone replied
 * (a reply ends it whether or not it was already due), mark it due when its
 * time passed unanswered, otherwise leave it alone.
 */
export function nextFollowUpStatus(
  followUp: Pick<FollowUp, 'status' | 'dueAt'>,
  { now, hasReply }: { now: number; hasReply: boolean },
): 'replied' | 'due' | null {
  if (followUp.status !== 'pending' && followUp.status !== 'due') return null;
  if (hasReply) return 'replied';
  if (followUp.status === 'pending' && now >= followUp.dueAt) return 'due';
  return null;
}
