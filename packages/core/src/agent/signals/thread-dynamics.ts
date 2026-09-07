/**
 * Signal 3: Thread Dynamics
 *
 * User started thread = ownership
 * 5+ participants, user rarely replies = observer
 * 2 participants, back-and-forth = active relationship
 * Thread stalled with no conclusion = may need intervention
 * User's name mentioned in body = needs attention
 */

import type { ThreadSignal, ThreadRole, ThreadStats } from './types';

export function computeThreadDynamics(
  threadStats: ThreadStats | null,
  emailBody: string,
  userName: string,
  _isCurrentEmailInThread: boolean,
): ThreadSignal {
  // Single email, not a thread
  if (!threadStats || threadStats.totalMessages <= 1) {
    const mentioned = isNameMentioned(emailBody, userName);
    return {
      value: mentioned ? 0.6 : 0.4,
      confidence: 0.3,
      reasoning: mentioned ? 'Single email, user mentioned by name' : 'Single email (not a thread)',
      role: mentioned ? 'mentioned' : 'single',
      participantCount: 1,
      userReplyCountInThread: 0,
      threadLength: 1,
      isStalled: false,
    };
  }

  const { participantCount, userMessageCount, totalMessages, userStarted, lastActivityAt } = threadStats;
  const userParticipationRate = totalMessages > 0 ? userMessageCount / totalMessages : 0;
  const mentioned = isNameMentioned(emailBody, userName);
  const now = Math.floor(Date.now() / 1000);
  const staleDays = (now - lastActivityAt) / 86400;

  // Determine role
  let role: ThreadRole;
  let value: number;
  let reasoning: string;

  if (userStarted) {
    role = 'initiator';
    value = 0.8;
    reasoning = `User started this thread (${totalMessages} messages, ${participantCount} participants)`;
  } else if (participantCount === 2 && userMessageCount > 0) {
    role = 'direct_participant';
    value = 0.75;
    reasoning = `Direct conversation (${totalMessages} messages back-and-forth)`;
  } else if (participantCount >= 5 && userParticipationRate < 0.1) {
    role = 'observer';
    value = mentioned ? 0.55 : 0.15;
    reasoning = mentioned
      ? `Team thread (${participantCount} people), user is observer but mentioned by name`
      : `Team loop (${participantCount} people), user rarely contributes`;
  } else if (participantCount >= 3 && userParticipationRate >= 0.15) {
    role = 'active_group';
    value = 0.65;
    reasoning = `Active group thread (${participantCount} people, user contributed ${userMessageCount}x)`;
  } else if (userMessageCount === 0 && !userStarted) {
    role = mentioned ? 'mentioned' : 'late_addition';
    value = mentioned ? 0.6 : 0.25;
    reasoning = mentioned
      ? 'User mentioned by name but hasn\'t replied yet'
      : `Added to thread but hasn't contributed (${totalMessages} messages)`;
  } else {
    role = 'active_group';
    value = 0.5;
    reasoning = `Thread with ${participantCount} participants, user contributed ${userMessageCount}x`;
  }

  // Stalled thread detection: many messages, no activity in 3+ days, no resolution
  const isStalled = totalMessages >= 5 && staleDays > 3 && userMessageCount > 0;
  if (isStalled) {
    value = Math.min(1, value + 0.1);
    reasoning += ' — thread may be stalled, needs attention';
  }

  const confidence = Math.min(0.9, totalMessages >= 5 ? 0.7 : totalMessages >= 2 ? 0.5 : 0.3);

  return {
    value: Math.max(0, Math.min(1, value)),
    confidence,
    reasoning,
    role,
    participantCount,
    userReplyCountInThread: userMessageCount,
    threadLength: totalMessages,
    isStalled,
  };
}

function isNameMentioned(body: string, userName: string): boolean {
  if (!userName || userName.length < 2) return false;
  const lower = body.toLowerCase().replace(/<[^>]+>/g, '');
  const nameParts = userName.toLowerCase().split(/\s+/);
  // Check if first name or full name appears
  return nameParts.some(part => part.length >= 2 && lower.includes(part));
}
