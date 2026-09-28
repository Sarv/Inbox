import { describe, expect, it } from 'vitest';

import {
  MIN_FOLLOW_UP_DELAY_SECONDS,
  nextFollowUpStatus,
  resolveFollowUpDueAt,
} from '../../../../electron/services/follow-up-schedule';

// The two rules every follow-up reminder rests on: WHEN it falls due, and what
// a checker pass does to it. Wrong here means a reminder that fires the moment
// the mail leaves, never fires, or nags about a conversation that answered.

const SENT = 1_790_000_000;
const DAY = 86_400;

describe('resolveFollowUpDueAt', () => {
  // "3 days" counts from the real send, so an outbox-held message keeps its full delay.
  it('adds a relative delay to the send time', () => {
    expect(resolveFollowUpDueAt({ afterSeconds: 3 * DAY }, SENT)).toBe(SENT + 3 * DAY);
  });

  // A picked date is honoured as-is and wins over a delay sent alongside it.
  it('uses an absolute time and prefers it over a delay', () => {
    expect(resolveFollowUpDueAt({ at: SENT + 2 * DAY + 0.7, afterSeconds: DAY }, SENT)).toBe(SENT + 2 * DAY);
  });

  // A date in the past (or a send held past it) must not notify on send.
  it('never falls due sooner than the minimum delay after sending', () => {
    expect(resolveFollowUpDueAt({ at: SENT - DAY }, SENT)).toBe(SENT + MIN_FOLLOW_UP_DELAY_SECONDS);
    expect(resolveFollowUpDueAt({ afterSeconds: 60 }, SENT)).toBe(SENT + MIN_FOLLOW_UP_DELAY_SECONDS);
  });

  // No request, or garbage from a stale outbox payload, records no reminder.
  it.each([undefined, {}, { at: 0 }, { afterSeconds: -5 }, { at: Number.NaN }, { afterSeconds: Infinity }])(
    'asks for no reminder given %j',
    (request) => {
      expect(resolveFollowUpDueAt(request, SENT)).toBeNull();
    },
  );
});

describe('nextFollowUpStatus', () => {
  const pending = { status: 'pending' as const, dueAt: SENT + DAY };

  // A reply ends the reminder, before or after it fell due.
  it('ends an open reminder that got a reply', () => {
    expect(nextFollowUpStatus(pending, { now: SENT, hasReply: true })).toBe('replied');
    expect(nextFollowUpStatus({ ...pending, status: 'due' }, { now: SENT + 2 * DAY, hasReply: true })).toBe('replied');
  });

  // Unanswered at its time: due. Before its time: untouched.
  it('marks an unanswered reminder due only once its time passes', () => {
    expect(nextFollowUpStatus(pending, { now: SENT + DAY - 1, hasReply: false })).toBeNull();
    expect(nextFollowUpStatus(pending, { now: SENT + DAY, hasReply: false })).toBe('due');
  });

  // An already-due reminder stays due without re-notifying every minute.
  it('leaves a due reminder alone while still unanswered', () => {
    expect(nextFollowUpStatus({ ...pending, status: 'due' }, { now: SENT + 9 * DAY, hasReply: false })).toBeNull();
  });

  // Dismissed or replied reminders are final.
  it.each(['dismissed', 'replied'] as const)('never changes a %s reminder', (status) => {
    expect(nextFollowUpStatus({ status, dueAt: SENT }, { now: SENT + DAY, hasReply: true })).toBeNull();
  });
});
