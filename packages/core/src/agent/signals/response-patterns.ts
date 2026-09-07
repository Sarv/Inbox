/**
 * Signal 2: Response Expectation
 *
 * TO: recipient = expected to respond
 * CC: recipient = FYI, usually no response expected
 * User always replies to this sender = strong signal
 * User never replies but reads = authority figure OR noise
 */

import type { ResponseSignal } from './types';

export function computeResponsePattern(
  recipientRole: 'to' | 'cc' | 'bcc',
  replyCount: number,
  totalFromSender: number,
  avgReplyTimeSec: number | null,
  neverReplied: boolean,
): ResponseSignal {
  const replyRate = totalFromSender > 0 ? replyCount / totalFromSender : 0;

  let value: number;
  let reasoning: string;

  if (recipientRole === 'cc') {
    // CC = usually low response expectation
    if (replyRate > 0.3) {
      // User actually replies to CC emails from this sender — unusual, high signal
      value = 0.5;
      reasoning = `CC recipient but user replies ${Math.round(replyRate * 100)}% of time`;
    } else {
      value = 0.15;
      reasoning = 'CC recipient — FYI, no response expected';
    }
  } else if (recipientRole === 'bcc') {
    value = 0.1;
    reasoning = 'BCC recipient — silent observer';
  } else {
    // TO: recipient
    if (neverReplied && totalFromSender >= 5) {
      // User consistently reads but never replies — could be authority figure or noise
      value = 0.3;
      reasoning = `Direct TO but user never replies (${totalFromSender} emails) — may be authority or noise`;
    } else if (replyRate > 0.5) {
      value = 0.9;
      reasoning = `Direct TO, user replies ${Math.round(replyRate * 100)}% of time`;
    } else if (replyRate > 0.2) {
      value = 0.65;
      reasoning = `Direct TO, user sometimes replies (${Math.round(replyRate * 100)}%)`;
    } else if (totalFromSender < 3) {
      // New sender, direct TO — default medium-high
      value = 0.6;
      reasoning = 'Direct TO from new/infrequent sender';
    } else {
      value = 0.35;
      reasoning = `Direct TO but low reply rate (${Math.round(replyRate * 100)}%)`;
    }
  }

  // Reply speed boost: fast replies = important sender
  if (avgReplyTimeSec !== null && avgReplyTimeSec < 3600 && recipientRole === 'to') {
    value = Math.min(1, value + 0.15);
    reasoning += ` — avg reply in ${Math.round(avgReplyTimeSec / 60)}min`;
  }

  const confidence = Math.min(0.95, totalFromSender >= 10 ? 0.8 : totalFromSender >= 3 ? 0.5 : 0.2);

  return {
    value: Math.max(0, Math.min(1, value)),
    confidence,
    reasoning,
    recipientRole,
    replyRate,
    avgReplyTimeSec,
    neverReplied,
  };
}
