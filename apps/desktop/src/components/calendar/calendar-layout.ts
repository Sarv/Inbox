import type { LocalCalendarOccurrence } from '../../types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, startOfLocalDate } from '../../utils/local-calendar';

export { monthDates as calendarMonthDates } from './calendar-view';

export function occurrenceOnDate(occurrence: LocalCalendarOccurrence, day: string, timeZone: string): boolean {
  const zone = occurrence.event.allDay ? occurrence.event.timeZone : timeZone;
  return dateInTimeZone(occurrence.startMs, zone) <= day
    && dateInTimeZone(Math.max(occurrence.startMs, occurrence.endMs - 1), zone) >= day;
}

export function wallMinute(ms: number, timeZone: string): number {
  const wall = instantToWallClock(ms, timeZone);
  return Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));
}

/** Labels describe this visible day's portion; the hover retains the complete event. */
export function calendarDayTime(occurrence: LocalCalendarOccurrence, day: string, timeZone: string) {
  const time = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone }).format(ms);
  const full = (ms: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: occurrence.event.allDay ? occurrence.event.timeZone : timeZone }).format(ms);
  const boundary = occurrence.event.allDay ? 0 : startOfLocalDate(day, timeZone);
  const continuesBefore = !occurrence.event.allDay && occurrence.startMs < boundary;
  const continuesAfter = !occurrence.event.allDay && occurrence.endMs > startOfLocalDate(addLocalDays(day, 1), timeZone);
  const startLabel = occurrence.event.allDay ? 'All day' : continuesBefore ? wallMinute(boundary, timeZone) === 0 ? '00:00' : time(boundary) : time(occurrence.startMs);
  const endLabel = occurrence.event.allDay ? '' : continuesAfter ? '24:00' : time(occurrence.endMs);
  const monthLabel = occurrence.event.allDay ? 'All day' : continuesBefore && continuesAfter ? 'Continues' : continuesBefore ? `Until ${endLabel}` : `${startLabel}${continuesAfter ? ' →' : ''}`;
  return { startLabel, endLabel, monthLabel, continuesBefore, continuesAfter, rangeLabel: occurrence.event.allDay ? 'All day' : `${startLabel} – ${endLabel}`, tooltip: `${full(occurrence.startMs)} – ${full(occurrence.endMs)}` };
}

export interface CalendarTimedSegment {
  occurrence: LocalCalendarOccurrence;
  startMinute: number;
  endMinute: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  column: number;
  columns: number;
}

/** Clip actual instants to real local-day boundaries before positioning in wall time. */
export function timedSegmentsForDate(occurrences: LocalCalendarOccurrence[], day: string, timeZone: string): CalendarTimedSegment[] {
  const boundary = startOfLocalDate(day, timeZone);
  const nextBoundary = startOfLocalDate(addLocalDays(day, 1), timeZone);
  if (nextBoundary <= boundary) return [];
  const segments = occurrences.filter(item => !item.event.allDay && item.startMs < nextBoundary && item.endMs > boundary).map(occurrence => {
    const start = Math.max(boundary, occurrence.startMs);
    const end = Math.min(nextBoundary, occurrence.endMs);
    const startMinute = wallMinute(start, timeZone);
    const wallEnd = end === nextBoundary ? 1440 : wallMinute(end, timeZone);
    // A clock fold can make the end's wall time equal to or earlier than its
    // start. Keep that real event visible; its printed times retain both offsets.
    const endMinute = Math.min(1440, wallEnd > startMinute ? wallEnd : startMinute + Math.max(1, (end - start) / 60_000));
    return { occurrence, startMinute, endMinute, continuesBefore: occurrence.startMs < boundary, continuesAfter: occurrence.endMs > nextBoundary, column: 0, columns: 1 };
  }).sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.occurrence.occurrenceId.localeCompare(b.occurrence.occurrenceId));

  // Pack connected visual overlaps into equal-width lanes. A minimum 28-minute
  // footprint also prevents short meetings from covering each other's labels.
  let group: CalendarTimedSegment[] = [];
  let groupEnd = -1;
  let laneEnds: number[] = [];
  const finish = () => { for (const segment of group) segment.columns = laneEnds.length; };
  for (const segment of segments) {
    if (segment.startMinute >= groupEnd) { finish(); group = []; laneEnds = []; groupEnd = -1; }
    const visualEnd = Math.min(1440, Math.max(segment.endMinute, segment.startMinute + 28));
    const available = laneEnds.findIndex(end => end <= segment.startMinute);
    segment.column = available < 0 ? laneEnds.length : available;
    laneEnds[segment.column] = visualEnd;
    group.push(segment);
    groupEnd = Math.max(groupEnd, visualEnd);
  }
  finish();
  return segments;
}
