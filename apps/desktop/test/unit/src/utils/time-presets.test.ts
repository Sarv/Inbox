import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  customDateTime,
  customDateTimeError,
  dateInputValue,
  earliestTimeFor,
  futureCustomDraft,
  sendLaterPresets,
  snoozePresets,
  timeInputValue,
  toEpochSeconds,
} from '../../../../src/utils/time-presets';

// What breaks if this suite goes red: a message comes back — or goes out — at
// the wrong time, and nothing says so. The failures here are all off-by-one-day
// or off-by-a-timezone, which look right in the menu and wrong in the mailbox.

/** A fixed local Wednesday, 2026-09-23 14:20. */
const WEDNESDAY_AFTERNOON = new Date(2026, 8, 23, 14, 20, 37, 500);

describe('snoozePresets', () => {
  it('offers tomorrow, the weekend and next week, all in the morning', () => {
    const [tomorrow, weekend, nextWeek] = snoozePresets(WEDNESDAY_AFTERNOON);

    expect(tomorrow.time).toEqual(new Date(2026, 8, 24, 8, 0, 0, 0));
    expect(weekend.time).toEqual(new Date(2026, 8, 26, 9, 0, 0, 0));   // Saturday
    expect(nextWeek.time).toEqual(new Date(2026, 8, 30, 8, 0, 0, 0));  // +7 days
  });

  it('labels each row with the time it resolves to', () => {
    expect(snoozePresets(WEDNESDAY_AFTERNOON)[0]).toMatchObject({ label: 'Tomorrow', sublabel: 'Thu, 8:00 AM' });
  });

  // Regression: every preset must be strictly in the future, or the snooze
  // wakes the message up on the very next sweep and the reader never sees the
  // hour they asked for.
  it('never returns a time in the past', () => {
    const lateSaturday = new Date(2026, 8, 26, 23, 55);
    for (const option of snoozePresets(lateSaturday)) {
      expect(option.time.getTime()).toBeGreaterThan(lateSaturday.getTime());
    }
  });
});

describe('sendLaterPresets', () => {
  it('offers later today rounded to the half hour, plus tomorrow and Monday', () => {
    const [laterToday, morning, afternoon, monday] = sendLaterPresets(WEDNESDAY_AFTERNOON);

    expect(laterToday.time).toEqual(new Date(2026, 8, 23, 17, 30, 0, 0)); // 14:20 + 3h → 17:30
    expect(morning.time).toEqual(new Date(2026, 8, 24, 8, 0, 0, 0));
    expect(afternoon.time).toEqual(new Date(2026, 8, 24, 13, 0, 0, 0));
    expect(monday.time).toEqual(new Date(2026, 8, 28, 8, 0, 0, 0));
  });

  // Regression: "Later today" at 22:40 would resolve to 01:40 TOMORROW. A mail
  // sent at 1am because the menu said "later today" is the exact mistake send
  // later exists to prevent.
  it('drops later today in the evening instead of silently meaning tomorrow', () => {
    const labels = sendLaterPresets(new Date(2026, 8, 23, 22, 40)).map((option) => option.label);
    expect(labels).not.toContain('Later today');
    expect(labels[0]).toBe('Tomorrow morning');
  });

  it('keeps later today on an exact half hour without pushing it on another 30 minutes', () => {
    expect(sendLaterPresets(new Date(2026, 8, 23, 9, 0, 0, 0))[0].time).toEqual(new Date(2026, 8, 23, 12, 0, 0, 0));
  });

  it('points Monday at the next one, never today, when asked on a Monday', () => {
    const monday = new Date(2026, 8, 28, 10, 0);
    const option = sendLaterPresets(monday).find((entry) => entry.label === 'Monday morning')!;
    expect(option.time).toEqual(new Date(2026, 9, 5, 8, 0, 0, 0));
  });

  it('never returns a time in the past', () => {
    for (const option of sendLaterPresets(WEDNESDAY_AFTERNOON)) {
      expect(option.time.getTime()).toBeGreaterThan(WEDNESDAY_AFTERNOON.getTime());
    }
  });
});

describe('toEpochSeconds', () => {
  it('converts to whole UTC seconds', () => {
    expect(toEpochSeconds(new Date(1_700_000_000_750))).toBe(1_700_000_000);
  });
});

describe('customDateTime', () => {
  it('reads the date and time inputs as one local time', () => {
    expect(customDateTime('2026-09-23', '17:45')).toEqual(new Date(2026, 8, 23, 17, 45, 0, 0));
  });

  it('defaults a missing time to midnight', () => {
    expect(customDateTime('2026-09-23', '')).toEqual(new Date(2026, 8, 23, 0, 0, 0, 0));
  });

  // Regression: an Invalid Date becomes NaN epoch seconds, which stores a row
  // that no drain will ever pick up — a message that silently never sends.
  it('returns null rather than an unusable date', () => {
    expect(customDateTime('', '09:00')).toBeNull();
    expect(customDateTime('not-a-date', '09:00')).toBeNull();
    expect(customDateTime('2026-09-23', 'half past')).toBeNull();
  });
});

describe('dateInputValue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: toISOString().split('T')[0] is the UTC day. Late in the evening
  // east of UTC that is TOMORROW, so the date input's own minimum excluded the
  // day the user was standing in.
  it('gives the local day, not the UTC one', () => {
    const lateEvening = new Date(2026, 8, 23, 23, 30);
    expect(dateInputValue(lateEvening)).toBe('2026-09-23');
  });
});

describe('timeInputValue', () => {
  it('gives the local 24-hour clock an <input type="time"> reads', () => {
    expect(timeInputValue(new Date(2026, 8, 23, 9, 5))).toBe('09:05');
    expect(timeInputValue(WEDNESDAY_AFTERNOON)).toBe('14:20');
  });
});

describe('earliestTimeFor', () => {
  // Regression: without this the time input let the reader step BACK to the
  // morning on a date of today, and the menu offered to send mail in the past.
  it('bounds today by the current minute', () => {
    expect(earliestTimeFor('2026-09-23', WEDNESDAY_AFTERNOON)).toBe('14:20');
  });

  it('leaves any later day unbounded', () => {
    expect(earliestTimeFor('2026-09-24', WEDNESDAY_AFTERNOON)).toBeUndefined();
    expect(earliestTimeFor('', WEDNESDAY_AFTERNOON)).toBeUndefined();
  });
});

describe('customDateTimeError', () => {
  // Regression: a past delivery time is queued as "scheduled" and the very next
  // drain sends it — the message leaves immediately, which is the opposite of
  // what Send later was asked to do.
  it('refuses a time earlier today', () => {
    expect(customDateTimeError('2026-09-23', '09:02', WEDNESDAY_AFTERNOON)).toContain('already passed');
  });

  it('refuses a day before today', () => {
    expect(customDateTimeError('2026-09-20', '23:59', WEDNESDAY_AFTERNOON)).toContain('already passed');
  });

  // The current minute is not "later" — it is now, and would go out at once.
  it('refuses the moment it already is', () => {
    expect(customDateTimeError('2026-09-23', '14:20', new Date(2026, 8, 23, 14, 20, 0, 0))).not.toBeNull();
  });

  it('accepts a minute from now, and any later day', () => {
    expect(customDateTimeError('2026-09-23', '14:21', WEDNESDAY_AFTERNOON)).toBeNull();
    expect(customDateTimeError('2026-09-24', '00:00', WEDNESDAY_AFTERNOON)).toBeNull();
  });

  it('names an unparseable pair instead of letting NaN through', () => {
    expect(customDateTimeError('not-a-date', '09:00', WEDNESDAY_AFTERNOON)).toBe('Enter a valid date and time.');
  });

  // An untouched field must not shout: nothing is chosen yet, and the Schedule
  // button is disabled on its own.
  it('says nothing about an empty date', () => {
    expect(customDateTimeError('', '09:00', WEDNESDAY_AFTERNOON)).toBeNull();
  });
});

describe('futureCustomDraft', () => {
  it('opens an untouched pick on tomorrow morning', () => {
    expect(futureCustomDraft('', '', WEDNESDAY_AFTERNOON)).toEqual({ date: '2026-09-24', time: '09:00' });
  });

  it('keeps a pick that is still in the future, to the exact minute typed', () => {
    expect(futureCustomDraft('2026-09-23', '14:21', WEDNESDAY_AFTERNOON)).toEqual({ date: '2026-09-23', time: '14:21' });
    expect(futureCustomDraft('2026-10-02', '06:07', WEDNESDAY_AFTERNOON)).toEqual({ date: '2026-10-02', time: '06:07' });
  });

  // Regression: preserve a pick across a closed menu and it can lapse while the
  // menu is shut. Offering it again leaves Schedule greyed out with nothing
  // saying why, so a lapsed pick moves to the next half hour instead.
  it('moves a lapsed pick to the next half hour', () => {
    expect(futureCustomDraft('2026-09-23', '14:00', WEDNESDAY_AFTERNOON)).toEqual({ date: '2026-09-23', time: '14:30' });
    expect(futureCustomDraft('2026-09-20', '08:00', WEDNESDAY_AFTERNOON)).toEqual({ date: '2026-09-23', time: '14:30' });
  });

  // On the half hour exactly, the "next" half hour is the one after — returning
  // the current minute would hand back a time that is already not in the future.
  it('moves on from a clock sitting exactly on the half hour', () => {
    expect(futureCustomDraft('2026-09-23', '09:00', new Date(2026, 8, 23, 14, 30, 0, 0)))
      .toEqual({ date: '2026-09-23', time: '15:00' });
  });

  // Late enough in the evening the next half hour is tomorrow, and the date has
  // to roll with it or the refreshed pick is in the past again.
  it('rolls into tomorrow when the next half hour is past midnight', () => {
    expect(futureCustomDraft('2026-09-23', '10:00', new Date(2026, 8, 23, 23, 45)))
      .toEqual({ date: '2026-09-24', time: '00:00' });
  });
});
