// Pure date maths for the Calendar screen: which days a view shows, which
// events fall on a day, and where a timed event sits in the day's column.
//
// Everything works in the reader's LOCAL zone — the grid is the reader's days —
// while the events themselves are stored as UTC instants (see calendar-types).

import {
  addDays,
  addMonths,
  addWeeks,
  differenceInMinutes,
  isSameDay,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';

import type { CalendarEvent, CalendarViewMode } from './calendar-types';

/** Sunday, matching the design system's date picker (`Su Mo Tu …`). */
export const WEEK_STARTS_ON = 0;

export const MINUTES_PER_DAY = 24 * 60;

/** A timed event shorter than this still gets a clickable block. */
export const MIN_EVENT_MINUTES = 15;

const range = (count: number) => Array.from({ length: count }, (_unused, index) => index);

/** The 42 days (six full weeks) a month grid shows around `anchor`'s month. */
export function monthGridDays(anchor: Date): Date[] {
  const first = startOfWeek(startOfMonth(anchor), { weekStartsOn: WEEK_STARTS_ON });
  return range(42).map((offset) => addDays(first, offset));
}

/** The seven days of `anchor`'s week. */
export function weekDays(anchor: Date): Date[] {
  const first = startOfWeek(anchor, { weekStartsOn: WEEK_STARTS_ON });
  return range(7).map((offset) => addDays(first, offset));
}

/** The days a view lays out, in order. */
export function viewDays(view: CalendarViewMode, anchor: Date): Date[] {
  if (view === 'month') return monthGridDays(anchor);
  if (view === 'week') return weekDays(anchor);
  return [startOfDay(anchor)];
}

/**
 * The instant range a view covers, `end` exclusive. This is what the sync asks
 * the API for, so the whole visible grid — outside-month days included — has
 * its events.
 */
export function visibleRange(view: CalendarViewMode, anchor: Date): { start: Date; end: Date } {
  const days = viewDays(view, anchor);
  return { start: days[0]!, end: addDays(days[days.length - 1]!, 1) };
}

/** The anchor one view-length forwards (`step` 1) or back (`step` -1). */
export function shiftAnchor(view: CalendarViewMode, anchor: Date, step: 1 | -1): Date {
  if (view === 'month') return addMonths(anchor, step);
  if (view === 'week') return addWeeks(anchor, step);
  return addDays(anchor, step);
}

/**
 * An event's start and end as Dates. `parseISO` reads a bare date as LOCAL
 * midnight (unlike `new Date('2026-10-15')`, which is UTC midnight and lands
 * on the previous day west of Greenwich). An end before the start is clamped
 * to the start rather than producing a negative-length block.
 */
export function eventInterval(event: CalendarEvent): { start: Date; end: Date } {
  const start = parseISO(event.start);
  const end = parseISO(event.end);
  return { start, end: end < start ? start : end };
}

/**
 * Whether an event belongs in the all-day row rather than the hour grid:
 * all-day events, and timed ones that cross midnight (a block that runs off the
 * bottom of one column cannot be read).
 */
export function isAllDayLike(event: CalendarEvent): boolean {
  if (event.allDay) return true;
  const { start, end } = eventInterval(event);
  return differenceInMinutes(end, startOfDay(start)) > MINUTES_PER_DAY;
}

/** Earlier first; at the same start, all-day first, then the longer one. */
function compareEvents(left: CalendarEvent, right: CalendarEvent): number {
  const leftInterval = eventInterval(left);
  const rightInterval = eventInterval(right);
  return (
    leftInterval.start.getTime() - rightInterval.start.getTime() ||
    Number(isAllDayLike(right)) - Number(isAllDayLike(left)) ||
    rightInterval.end.getTime() - leftInterval.end.getTime() ||
    left.title.localeCompare(right.title)
  );
}

/**
 * The events that touch `day`, sorted. An event touches a day when it overlaps
 * [midnight, next midnight); a zero-length event touches the day it starts on.
 */
export function eventsOnDay(events: readonly CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = startOfDay(day);
  const dayEnd = addDays(dayStart, 1);
  return events
    .filter((event) => {
      const { start, end } = eventInterval(event);
      if (start.getTime() === end.getTime()) return isSameDay(start, dayStart);
      return start < dayEnd && end > dayStart;
    })
    .sort(compareEvents);
}

export interface PositionedEvent {
  event: CalendarEvent;
  /** Minutes from the day's midnight to the top of the block. */
  top: number;
  /** Block height in minutes (never below MIN_EVENT_MINUTES). */
  height: number;
  /** Zero-based column within its group of overlapping events. */
  column: number;
  /** How many columns that group needs. */
  columns: number;
}

interface Placement {
  event: CalendarEvent;
  top: number;
  bottom: number;
}

/** Splits placements (sorted by top) into runs whose blocks overlap. */
function overlapGroups(placements: readonly Placement[]): Placement[][] {
  return placements.reduce<{ groups: Placement[][]; groupBottom: number }>(
    ({ groups, groupBottom }, placement) => {
      const startsNewGroup = groups.length === 0 || placement.top >= groupBottom;
      const nextGroups = startsNewGroup
        ? [...groups, [placement]]
        : [...groups.slice(0, -1), [...groups[groups.length - 1]!, placement]];
      const nextBottom = startsNewGroup ? placement.bottom : Math.max(groupBottom, placement.bottom);
      return { groups: nextGroups, groupBottom: nextBottom };
    },
    { groups: [], groupBottom: 0 },
  ).groups;
}

/** Greedy columns: each block takes the first column whose last block has ended. */
function assignColumns(group: readonly Placement[]): PositionedEvent[] {
  const { placed, columnBottoms } = group.reduce<{ placed: Array<Placement & { column: number }>; columnBottoms: number[] }>(
    (state, placement) => {
      const free = state.columnBottoms.findIndex((bottom) => bottom <= placement.top);
      const column = free === -1 ? state.columnBottoms.length : free;
      const columnBottoms = [...state.columnBottoms];
      columnBottoms[column] = placement.bottom;
      return { placed: [...state.placed, { ...placement, column }], columnBottoms };
    },
    { placed: [], columnBottoms: [] },
  );
  return placed.map(({ event, top, bottom, column }) => ({
    event,
    top,
    height: bottom - top,
    column,
    columns: columnBottoms.length,
  }));
}

/**
 * Where each of `day`'s timed events sits in the hour grid. Overlapping events
 * share the width side by side; a group that does not overlap the next keeps
 * the full width.
 */
export function layoutTimedEvents(events: readonly CalendarEvent[], day: Date): PositionedEvent[] {
  const dayStart = startOfDay(day);
  const placements = eventsOnDay(events, day)
    .filter((event) => !isAllDayLike(event))
    .map((event) => {
      const { start, end } = eventInterval(event);
      const top = Math.min(Math.max(differenceInMinutes(start, dayStart), 0), MINUTES_PER_DAY - MIN_EVENT_MINUTES);
      const rawBottom = Math.min(differenceInMinutes(end, dayStart), MINUTES_PER_DAY);
      return { event, top, bottom: Math.max(rawBottom, top + MIN_EVENT_MINUTES) };
    })
    .sort((left, right) => left.top - right.top || right.bottom - left.bottom);
  return overlapGroups(placements).flatMap(assignColumns);
}

/**
 * The toolbar heading for a view: "October 2026", "Oct 11 – 17, 2026",
 * "Thursday, October 15, 2026". Locale `undefined` = the reader's own.
 */
export function rangeTitle(view: CalendarViewMode, anchor: Date, locale?: string): string {
  if (view === 'month') {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(anchor);
  }
  if (view === 'week') {
    const days = weekDays(anchor);
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' })
      .formatRange(days[0]!, days[6]!);
  }
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(anchor);
}

/** Two-letter weekday heads, as in the design system's picker (`Su Mo …`). */
export function shortWeekday(day: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(day).slice(0, 2);
}

/** "9:30 AM" (or "09:30", per locale) for a timed event's start. */
export function formatEventTime(date: Date, locale?: string): string {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The When line in the event panel: "Thu, Oct 15, 9:30 – 10:00 AM",
 * "Thu, Oct 15 (all day)", or a range across days.
 */
export function formatEventWhen(event: CalendarEvent, locale?: string): string {
  const { start, end } = eventInterval(event);
  if (event.allDay) {
    const dateFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const lastDay = addDays(end, -1);
    return lastDay <= start ? `${dateFormat.format(start)} (all day)` : dateFormat.formatRange(start, lastDay);
  }
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).formatRange(start, end);
}
