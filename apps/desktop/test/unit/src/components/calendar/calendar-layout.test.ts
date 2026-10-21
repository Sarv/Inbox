import { describe, expect, it } from 'vitest';

import { calendarDayTime, calendarMonthDates, occurrenceOnDate, timedSegmentsForDate } from '../../../../../src/components/calendar/calendar-layout';
import type { LocalCalendarOccurrence } from '../../../../../src/types/local-calendar';

function occurrence(id: string, start: string, end: string, allDay = false, timeZone = 'UTC'): LocalCalendarOccurrence {
  const startMs = Date.parse(start); const endMs = Date.parse(end);
  return { occurrenceId: `${id}:${startMs}`, eventId: id, startMs, endMs, event: { id, calendarId: 'work', title: id, description: '', location: '', startMs, endMs, allDay, timeZone, busy: true, status: 'confirmed', reminderMinutes: null, updatedAt: startMs } };
}

describe('calendar canvas layout', () => {
  it('uses four, five or six Monday-first weeks, including every date exactly once', () => {
    for (const [date, days] of [['2021-02-12', 28], ['2026-10-21', 35], ['2026-08-12', 42]] as const) {
      const dates = calendarMonthDates(date);
      expect(dates).toHaveLength(days); expect(new Set(dates).size).toBe(days);
      expect(new Date(`${dates[0]}T12:00Z`).getUTCDay()).toBe(1);
      expect(dates).toContain(`${date.slice(0, 7)}-01`);
    }
  });

  it('positions an event in the display timezone and clips multi-day events at midnight', () => {
    const local = occurrence('late', '2026-10-20T19:00Z', '2026-10-20T20:00Z');
    expect(timedSegmentsForDate([local], '2026-10-21', 'Asia/Kolkata')[0]).toMatchObject({ startMinute: 30, endMinute: 90, continuesBefore: false, continuesAfter: false });
    expect(timedSegmentsForDate([local], '2026-10-20', 'Asia/Kolkata')).toEqual([]);
    const overnight = occurrence('overnight', '2026-10-21T22:30Z', '2026-10-22T02:00Z');
    expect(timedSegmentsForDate([overnight], '2026-10-21', 'UTC')[0]).toMatchObject({ startMinute: 1350, endMinute: 1440, continuesAfter: true });
    expect(timedSegmentsForDate([overnight], '2026-10-22', 'UTC')[0]).toMatchObject({ startMinute: 0, endMinute: 120, continuesBefore: true });
  });

  it('packs connected overlaps into lanes and gives adjacent meetings their full width', () => {
    const a = occurrence('a', '2026-10-21T09:00Z', '2026-10-21T10:00Z');
    const b = occurrence('b', '2026-10-21T09:30Z', '2026-10-21T10:30Z');
    const c = occurrence('c', '2026-10-21T10:00Z', '2026-10-21T11:00Z');
    expect(timedSegmentsForDate([c, a, b], '2026-10-21', 'UTC').map(item => [item.column, item.columns])).toEqual([[0, 2], [1, 2], [0, 2]]);
    expect(timedSegmentsForDate([a, c], '2026-10-21', 'UTC').map(item => item.columns)).toEqual([1, 1]);
  });

  it('also separates short event labels which overlap visually', () => {
    const a = occurrence('a', '2026-10-21T09:00Z', '2026-10-21T09:01Z');
    const b = occurrence('b', '2026-10-21T09:10Z', '2026-10-21T09:11Z');
    expect(timedSegmentsForDate([a, b], '2026-10-21', 'UTC').map(item => item.columns)).toEqual([2, 2]);
  });

  it('keeps all-day dates in the event timezone and out of the timed grid', () => {
    const holiday = occurrence('holiday', '2026-10-20T18:30Z', '2026-10-21T18:30Z', true, 'Asia/Kolkata');
    expect(occurrenceOnDate(holiday, '2026-10-21', 'UTC')).toBe(true);
    expect(occurrenceOnDate(holiday, '2026-10-20', 'UTC')).toBe(false);
    expect(occurrenceOnDate(holiday, '2026-10-22', 'UTC')).toBe(false);
    expect(timedSegmentsForDate([holiday], '2026-10-21', 'UTC')).toEqual([]);
  });

  it('labels an overnight continuation by its visible day and preserves the original dates in hover text', () => {
    const night = occurrence('night', '2026-10-21T22:00Z', '2026-10-22T01:30Z');
    const original = structuredClone(night);
    const end = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(night.endMs);
    expect(calendarDayTime(night, '2026-10-21', 'UTC')).toMatchObject({ endLabel: '24:00', continuesBefore: false, continuesAfter: true });
    const next = calendarDayTime(night, '2026-10-22', 'UTC');
    expect(next).toMatchObject({ startLabel: '00:00', endLabel: end, monthLabel: `Until ${end}`, continuesBefore: true, continuesAfter: false, rangeLabel: `00:00 – ${end}` });
    expect(next.tooltip).toContain('21'); expect(next.tooltip).toContain('22');
    expect(calendarDayTime(occurrence('long', '2026-10-20T22:00Z', '2026-10-23T01:30Z'), '2026-10-22', 'UTC').monthLabel).toBe('Continues');
    expect(night).toEqual(original);
  });

  it('keeps a fall-back fold visible with positive bounds and handles midnight gaps/skipped dates', () => {
    const fold = occurrence('fold', '2026-11-01T05:30Z', '2026-11-01T06:15Z');
    const segment = timedSegmentsForDate([fold], '2026-11-01', 'America/New_York')[0]!;
    expect(segment.startMinute).toBe(90); expect(segment.endMinute).toBe(135);
    const gap = occurrence('gap', '2026-09-06T04:00Z', '2026-09-06T05:00Z');
    expect(timedSegmentsForDate([gap], '2026-09-06', 'America/Santiago')[0]).toMatchObject({ startMinute: 60, endMinute: 120 });
    expect(timedSegmentsForDate([occurrence('skip', '2011-12-29T00:00Z', '2012-01-01T00:00Z')], '2011-12-30', 'Pacific/Apia')).toEqual([]);
  });
});
