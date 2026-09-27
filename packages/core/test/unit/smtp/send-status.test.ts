import { describe, expect, it } from 'vitest';

import { classifySend, isScheduled, nextDrainDelayMs, sendDeliveryTimeMs } from '../../../src/smtp/send-status';

// What breaks if this suite goes red: the Outbox tells the user the wrong thing
// about mail that hasn't left yet. A scheduled send shown as "queued" has no
// cancel affordance (it goes out at 2am anyway); a retry backoff shown as
// "scheduled" offers to move a delivery time that isn't one.

const NOW = 1_700_000_000;
const later = NOW + 600;
const earlier = NOW - 600;

describe('classifySend', () => {
  it('calls a dead-lettered send failed, whatever else the row says', () => {
    expect(classifySend({ status: 'failed', nextRetryAt: later, scheduledAt: later }, NOW)).toBe('failed');
  });

  it('calls a send the drain already owns sending', () => {
    expect(classifySend({ status: 'executing' }, NOW)).toBe('sending');
  });

  // Regression (behaviour CHANGED: append_pending used to read 'sending'): SMTP
  // has accepted this message — the recipient has it and the local Sent row is
  // written. Anything short of 'sent' puts a delivered mail in the queued list
  // with a Discard bin beside it.
  it('calls a send SMTP accepted sent, whatever is left to file', () => {
    expect(classifySend({ status: 'append_pending' }, NOW)).toBe('sent');
    expect(classifySend({ status: 'pending', smtpAccepted: true }, NOW)).toBe('sent');
  });

  // Acceptance outranks the dead-letter: after SMTP took the message, a failure
  // can only describe the Sent-folder copy, never the delivery.
  it('calls an accepted send sent even if the row says failed', () => {
    expect(classifySend({ status: 'failed', smtpAccepted: true }, NOW)).toBe('sent');
  });

  it('calls a send with no wait queued', () => {
    expect(classifySend({ status: 'pending', nextRetryAt: null }, NOW)).toBe('queued');
    expect(classifySend({ status: 'pending' }, NOW)).toBe('queued');
  });

  it('calls a wait that has elapsed queued — it is due, not waiting', () => {
    expect(classifySend({ status: 'pending', nextRetryAt: earlier, scheduledAt: earlier }, NOW)).toBe('queued');
    expect(classifySend({ status: 'pending', nextRetryAt: NOW, scheduledAt: NOW }, NOW)).toBe('queued');
  });

  it('calls a future wait the user chose scheduled', () => {
    expect(classifySend({ status: 'pending', nextRetryAt: later, scheduledAt: later }, NOW)).toBe('scheduled');
  });

  // Regression: an undo hold is a future next_retry_at too. Listing it under
  // Scheduled would offer Cancel/Reschedule for a message the composer still
  // owns, and the two would fight over the same row.
  it('calls a future wait with no chosen time waiting, not scheduled', () => {
    expect(classifySend({ status: 'pending', nextRetryAt: later, scheduledAt: null }, NOW)).toBe('waiting');
  });

  // Regression: the backoff after a failed schedule parks next_retry_at in the
  // future again. If a stale scheduled_at survived, the row must still read as
  // a retry — "Scheduled for 14:05" for a message that has already failed once
  // is a delivery promise the queue is not making.
  it('calls a retrying send waiting even with a scheduled_at left over', () => {
    expect(classifySend({ status: 'pending', nextRetryAt: later, scheduledAt: earlier, retryCount: 2 }, NOW)).toBe('waiting');
  });
});

describe('isScheduled', () => {
  it('is true only for a send the user can still cancel or move', () => {
    expect(isScheduled({ status: 'pending', nextRetryAt: later, scheduledAt: later }, NOW)).toBe(true);
    expect(isScheduled({ status: 'executing', nextRetryAt: later, scheduledAt: later }, NOW)).toBe(false);
    expect(isScheduled({ status: 'pending', nextRetryAt: later }, NOW)).toBe(false);
  });
});

describe('sendDeliveryTimeMs', () => {
  it('reports the wait in milliseconds, for rendering in the reader zone', () => {
    expect(sendDeliveryTimeMs({ status: 'pending', nextRetryAt: later, scheduledAt: later }, NOW)).toBe(later * 1000);
    expect(sendDeliveryTimeMs({ status: 'pending', nextRetryAt: later }, NOW)).toBe(later * 1000);
  });

  it('reports nothing when there is no future time to show', () => {
    expect(sendDeliveryTimeMs({ status: 'pending', nextRetryAt: null }, NOW)).toBeNull();
    expect(sendDeliveryTimeMs({ status: 'executing', nextRetryAt: later }, NOW)).toBeNull();
    expect(sendDeliveryTimeMs({ status: 'failed', nextRetryAt: later, scheduledAt: later }, NOW)).toBeNull();
  });
});

// What breaks if this block goes red: a message scheduled for 13:08 leaving at
// 13:08:59. The drain used to run only on a fixed 60s interval, so the delay
// between the time the user picked and the message going out was arbitrary.
describe('nextDrainDelayMs', () => {
  const nowMs = NOW * 1000;
  const scheduled = (at: number) => ({ status: 'pending', nextRetryAt: at, scheduledAt: at });

  it('wakes on the EARLIEST due time, a beat after it', () => {
    const delay = nextDrainDelayMs([scheduled(NOW + 300), scheduled(NOW + 42)], nowMs);
    expect(delay).toBe(42_000 + 500);
  });

  it('counts a retry backoff too — it is due work like any other', () => {
    const backoff = { status: 'pending', nextRetryAt: NOW + 10, retryCount: 3 };
    expect(nextDrainDelayMs([backoff], nowMs)).toBe(10_000 + 500);
  });

  it('falls back to the backstop interval when nothing is waiting', () => {
    expect(nextDrainDelayMs([], nowMs)).toBe(60_000);
    expect(nextDrainDelayMs([{ status: 'pending', nextRetryAt: null }], nowMs)).toBe(60_000);
  });

  it('never waits past the backstop, however far off the send is', () => {
    expect(nextDrainDelayMs([scheduled(NOW + 86_400)], nowMs)).toBe(60_000);
  });

  // Regression: a due-now row the drain CANNOT clear (SMTP offline, a deferred
  // Sent APPEND) would otherwise arm a 0ms timer, drain, find it still there
  // and re-arm — a spin that pegs a core. Due rows belong to the drain that is
  // already running, so they never set a wake-up.
  it('ignores rows that are already due, so the timer can never spin', () => {
    const due = { status: 'pending', nextRetryAt: NOW - 30, scheduledAt: NOW - 30 };
    const appendPending = { status: 'append_pending', nextRetryAt: null, smtpAccepted: true };
    expect(nextDrainDelayMs([due, appendPending], nowMs)).toBe(60_000);
  });

  it('ignores dead-lettered rows — nothing happens to them without the user', () => {
    expect(nextDrainDelayMs([{ status: 'failed', nextRetryAt: NOW + 5 }], nowMs)).toBe(60_000);
  });

  // The timer must not land before the due SECOND: getDueSends floors the clock,
  // so firing a millisecond early finds nothing and then waits out the whole
  // backstop — the exact 60s lateness this helper exists to remove.
  it('lands after the due second even mid-second', () => {
    expect(nextDrainDelayMs([scheduled(NOW + 1)], nowMs + 400)).toBe(600 + 500);
  });

  it('honours caller-supplied bounds', () => {
    expect(nextDrainDelayMs([scheduled(NOW + 5)], nowMs, { maxDelayMs: 2_000 })).toBe(2_000);
    expect(nextDrainDelayMs([scheduled(NOW + 5)], nowMs, { slackMs: 0 })).toBe(5_000);
  });
});
