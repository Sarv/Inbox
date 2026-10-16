import { describe, expect, it } from 'vitest';

import {
  eventInterval,
  eventsOnDay,
  formatEventWhen,
  isAllDayLike,
  layoutTimedEvents,
  MIN_EVENT_MINUTES,
  monthGridDays,
  rangeTitle,
  shiftAnchor,
  shortWeekday,
  viewDays,
  visibleRange,
  weekDays,
} from '../../../../../src/components/calendar/calendar-dates';
import type { CalendarEvent } from '../../../../../src/components/calendar/calendar-types';

// Every date here is built in the LOCAL zone, and timed events carry the UTC
// instant of that local time — the shape the sync stores — so the suite means
// the same thing in any TZ the runner happens to be in.
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute);
const timed = (id: string, start: Date, end: Date, title = id): CalendarEvent => ({
  id, calendarId: 'cal-1', title, start: start.toISOString(), end: end.toISOString(), allDay: false,
});
const allDay = (id: string, start: string, end: string): CalendarEvent => ({
  id, calendarId: 'cal-1', title: id, start, end, allDay: true,
});
const ids = (events: Array<{ id: string } | { event: { id: string } }>) =>
  events.map((each) => ('event' in each ? each.event.id : each.id));

describe('view days', () => {
  // Regression: the month grid must always be six whole weeks starting on the
  // week's first day, or rows jump in height and weekday columns misalign.
  it('lays a month out as 42 days from the Sunday on or before the 1st', () => {
    const days = monthGridDays(at(15));
    expect(days).toHaveLength(42);
    expect(days[0]!.getDay()).toBe(0);
    expect(days[0]! <= at(1)).toBe(true);
    expect(days.some((day) => day.getMonth() === 9 && day.getDate() === 31)).toBe(true);
  });

  // Regression: the week view's columns are Sunday..Saturday around the anchor.
  it('gives the seven days of the anchor week, Sunday first', () => {
    const days = weekDays(at(15)); // Thursday
    expect(days.map((day) => day.getDate())).toEqual([11, 12, 13, 14, 15, 16, 17]);
  });

  // Regression: each mode lays out its own day count; day view is midnight-aligned.
  it('picks the day set per view', () => {
    expect(viewDays('month', at(15))).toHaveLength(42);
    expect(viewDays('week', at(15))).toHaveLength(7);
    expect(viewDays('day', at(15, 13))).toEqual([at(15)]);
  });

  // Regression: the range sent to the sync must cover the WHOLE visible grid,
  // end-exclusive, or the outside-month days and the last day render empty.
  it('reports the visible range end-exclusive', () => {
    expect(visibleRange('week', at(15))).toEqual({ start: at(11), end: at(18) });
    expect(visibleRange('day', at(15, 9))).toEqual({ start: at(15), end: at(16) });
    const month = visibleRange('month', at(15));
    expect(month.start).toEqual(monthGridDays(at(15))[0]);
    expect(month.end.getTime() - month.start.getTime()).toBeGreaterThanOrEqual(41 * 86_400_000);
  });

  // Regression: prev/next must move by the view's own length.
  it('steps the anchor by a month, week or day', () => {
    expect(shiftAnchor('month', at(15), 1)).toEqual(new Date(2026, 10, 15));
    expect(shiftAnchor('week', at(15), -1)).toEqual(at(8));
    expect(shiftAnchor('day', at(15), 1)).toEqual(at(16));
  });
});

describe('event placement', () => {
  // Regression: `new Date('2026-10-15')` is UTC midnight — west of Greenwich an
  // all-day event would land on the 14th. Dates must parse as LOCAL midnight.
  it('reads an all-day date as local midnight', () => {
    expect(eventInterval(allDay('a', '2026-10-15', '2026-10-16')).start).toEqual(at(15));
  });

  // Regression: a server end before its start would draw a negative block.
  it('clamps an end before the start to the start', () => {
    const { start, end } = eventInterval(timed('x', at(15, 10), at(15, 9)));
    expect(end).toEqual(start);
  });

  // Regression: all-day end is EXCLUSIVE — a one-day event must not also show
  // on the following day.
  it('puts an all-day event on its days only', () => {
    const event = allDay('a', '2026-10-15', '2026-10-17');
    expect(ids(eventsOnDay([event], at(14)))).toEqual([]);
    expect(ids(eventsOnDay([event], at(15)))).toEqual(['a']);
    expect(ids(eventsOnDay([event], at(16)))).toEqual(['a']);
    expect(ids(eventsOnDay([event], at(17)))).toEqual([]);
  });

  // Regression: an event ending exactly at midnight belongs to the day before only.
  it('does not spill an event that ends at midnight into the next day', () => {
    const event = timed('late', at(15, 22), at(16, 0));
    expect(ids(eventsOnDay([event], at(15)))).toEqual(['late']);
    expect(ids(eventsOnDay([event], at(16)))).toEqual([]);
  });

  // Regression: a zero-length event (a reminder) overlaps nothing, yet must show.
  it('keeps a zero-length event on its day', () => {
    expect(ids(eventsOnDay([timed('ping', at(15, 9), at(15, 9))], at(15)))).toEqual(['ping']);
  });

  // Regression: within a day, all-day events lead, then by start time.
  it('sorts all-day first, then by start, then longer first', () => {
    const events = [
      timed('late', at(15, 14), at(15, 15)),
      timed('early-short', at(15, 9), at(15, 9, 30)),
      allDay('holiday', '2026-10-15', '2026-10-16'),
      timed('early-long', at(15, 9), at(15, 11)),
    ];
    expect(ids(eventsOnDay(events, at(15)))).toEqual(['holiday', 'early-long', 'early-short', 'late']);
  });

  // Regression: a timed event that crosses midnight cannot be read as a block
  // running off the column; it belongs in the all-day row.
  it('treats a timed event crossing midnight as all-day-like', () => {
    expect(isAllDayLike(timed('overnight', at(15, 22), at(16, 2)))).toBe(true);
    expect(isAllDayLike(timed('meeting', at(15, 9), at(15, 10)))).toBe(false);
    expect(isAllDayLike(allDay('a', '2026-10-15', '2026-10-16'))).toBe(true);
  });
});

describe('layoutTimedEvents', () => {
  // Regression: blocks must sit at their real time — top/height in minutes.
  it('places a lone event at its time, full width', () => {
    expect(layoutTimedEvents([timed('a', at(15, 9, 30), at(15, 11))], at(15))).toEqual([
      expect.objectContaining({ top: 570, height: 90, column: 0, columns: 1 }),
    ]);
  });

  // Regression: overlapping events must sit side by side, not on top of each other.
  it('splits overlapping events into columns', () => {
    const layout = layoutTimedEvents([
      timed('a', at(15, 9), at(15, 11)),
      timed('b', at(15, 10), at(15, 12)),
      timed('c', at(15, 11), at(15, 12)),
    ], at(15));
    expect(layout.map(({ event, column, columns }) => [event.id, column, columns])).toEqual([
      ['a', 0, 2], ['b', 1, 2], ['c', 0, 2],
    ]);
  });

  // Regression: a later event that overlaps nothing keeps the full width
  // instead of inheriting an earlier group's narrow columns.
  it('gives a separate group its own column count', () => {
    const layout = layoutTimedEvents([
      timed('a', at(15, 9), at(15, 10)),
      timed('b', at(15, 9), at(15, 10)),
      timed('c', at(15, 14), at(15, 15)),
    ], at(15));
    expect(layout.find(({ event }) => event.id === 'c')).toMatchObject({ column: 0, columns: 1 });
  });

  // Regression: a tiny event still needs a clickable block, and one at 23:59
  // must not hang off the bottom of the grid.
  it('enforces a minimum height and keeps blocks inside the day', () => {
    const [block] = layoutTimedEvents([timed('tiny', at(15, 23, 59), at(15, 23, 59))], at(15));
    expect(block!.height).toBe(MIN_EVENT_MINUTES);
    expect(block!.top + block!.height).toBeLessThanOrEqual(24 * 60);
  });

  // Regression: all-day and overnight events go to the all-day row, not the grid.
  it('leaves all-day-like events out of the hour grid', () => {
    const layout = layoutTimedEvents([
      allDay('holiday', '2026-10-15', '2026-10-16'),
      timed('overnight', at(15, 22), at(16, 2)),
    ], at(15));
    expect(layout).toEqual([]);
  });

  // Regression: a day with no events lays out nothing (and does not throw).
  it('returns nothing for an empty day', () => {
    expect(layoutTimedEvents([], at(15))).toEqual([]);
  });
});

describe('labels', () => {
  // Regression: the toolbar heading must name the period the grid shows.
  it('titles each view', () => {
    expect(rangeTitle('month', at(15), 'en-US')).toBe('October 2026');
    expect(rangeTitle('week', at(15), 'en-US')).toMatch(/Oct 11\s*–\s*17, 2026/);
    expect(rangeTitle('day', at(15), 'en-US')).toBe('Thursday, October 15, 2026');
  });

  // Regression: weekday heads are the picker's two-letter form.
  it('shortens weekdays to two letters', () => {
    expect(shortWeekday(at(11), 'en-US')).toBe('Su');
  });

  // Regression: the detail panel says "all day" for one day, a range for many,
  // and never shows the exclusive end date.
  it('describes when an event is', () => {
    expect(formatEventWhen(allDay('a', '2026-10-15', '2026-10-16'), 'en-US')).toBe('Thu, Oct 15, 2026 (all day)');
    const multi = formatEventWhen(allDay('a', '2026-10-15', '2026-10-17'), 'en-US');
    expect(multi).toContain('15');
    expect(multi).toContain('16');
    expect(multi).not.toContain('17');
    expect(formatEventWhen(timed('t', at(15, 9, 30), at(15, 10)), 'en-US')).toMatch(/Thu, Oct 15, 9:30\s*–\s*10:00\s*AM/);
  });
});
