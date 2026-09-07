/**
 * Signal 6: Temporal Patterns
 *
 * Email age (older unread = more urgent)
 * Sender burst (3+ emails in 1 hour = escalation)
 * Routine sender (daily reports = low urgency)
 * Outside business hours = might be urgent
 */

import type { TemporalSignal } from './types';

export function computeTemporalSignal(
  emailDate: number,
  nowSec: number,
  isRoutineSender: boolean,
  burstCount: number,
  _userPeakHours: number[],
): TemporalSignal {
  const emailAgeSec = Math.max(0, nowSec - emailDate);
  const emailHour = new Date(emailDate * 1000).getHours();

  // Business hours: 9-18 (configurable in future)
  const isOutsideBusinessHours = emailHour < 9 || emailHour >= 18;
  const isBurst = burstCount >= 3;

  let value = 0.5; // neutral default
  const reasons: string[] = [];

  // Age-based urgency: older unread = more urgent
  if (emailAgeSec < 3600) {
    // Less than 1 hour old — fresh, normal
    value = 0.5;
  } else if (emailAgeSec < 86400) {
    // 1-24 hours — mild urgency
    value = 0.55;
    reasons.push(`${Math.round(emailAgeSec / 3600)}h old`);
  } else if (emailAgeSec < 3 * 86400) {
    // 1-3 days — growing urgency
    value = 0.65;
    reasons.push(`${Math.round(emailAgeSec / 86400)}d old`);
  } else if (emailAgeSec < 7 * 86400) {
    // 3-7 days — significant
    value = 0.75;
    reasons.push(`${Math.round(emailAgeSec / 86400)}d old, getting stale`);
  } else {
    // 7+ days — very old
    value = 0.4; // Actually lower — if they didn't act in 7 days, maybe it's not important
    reasons.push(`${Math.round(emailAgeSec / 86400)}d old`);
  }

  // Burst: sender sent 3+ emails in last hour = escalation
  if (isBurst) {
    value = Math.min(1, value + 0.25);
    reasons.push(`burst: ${burstCount} emails in last hour`);
  }

  // Routine sender: daily reports at predictable time = low urgency
  if (isRoutineSender) {
    value = Math.max(0, value - 0.2);
    reasons.push('routine sender (predictable timing)');
  }

  // Outside business hours: could indicate urgency (working late)
  if (isOutsideBusinessHours && !isRoutineSender) {
    value = Math.min(1, value + 0.05);
    reasons.push('sent outside business hours');
  }

  const confidence = 0.5; // Temporal signals are moderate confidence

  return {
    value: Math.max(0, Math.min(1, value)),
    confidence,
    reasoning: reasons.length > 0 ? reasons.join(', ') : 'Normal timing',
    emailAgeSec,
    isRoutineSender,
    isBurstFromSender: isBurst,
    isOutsideBusinessHours,
  };
}
