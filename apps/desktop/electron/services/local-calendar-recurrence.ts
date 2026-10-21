import type { LocalCalendarEvent, LocalCalendarOccurrence, LocalCalendarRange } from '../../src/types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, localDateDifference, localWeekDay, startOfLocalDate, wallClockToInstant } from '../../src/utils/local-calendar';

import { MAX_OCCURRENCES, validateRange } from './local-calendar-model';

const MAX_EXPANSION_STEPS = 50_000;
export interface LocalCalendarExpansionBudget { remaining: number }

/** RFC invalid monthly dates and nonexistent DST wall times are skipped, not moved. */
export function expandLocalEvent(event: LocalCalendarEvent, range: LocalCalendarRange, includeExcluded = false, budget?: LocalCalendarExpansionBudget): LocalCalendarOccurrence[] {
  validateRange(range);
  const result: LocalCalendarOccurrence[] = [];
  const append = (startMs: number, endMs: number) => {
    if (startMs < range.endMs && endMs > range.startMs && (includeExcluded || !event.excludedStarts?.includes(startMs))) {
      result.push({ occurrenceId: `${event.parentEventId ?? event.id}:${event.originalStartMs ?? startMs}`, eventId: event.parentEventId ?? event.id, startMs, endMs, event });
      if (result.length > MAX_OCCURRENCES) throw new Error('Too many calendar occurrences to check safely. Narrow the date range.');
    }
  };
  const rule = event.recurrence;
  if (!rule) { append(event.startMs, event.endMs); return result; }
  const anchor = event.allDay ? event.startDate! : dateInTimeZone(event.startMs, event.timeZone);
  const endDate = addLocalDays(dateInTimeZone(range.endMs, event.timeZone), 1);
  const anchorWeekStart = addLocalDays(anchor, -((localWeekDay(anchor) + 6) % 7));
  const clock = instantToWallClock(event.startMs, event.timeZone).slice(11);
  const seconds = ((event.startMs % 60_000) + 60_000) % 60_000;
  const daySpan = event.allDay ? localDateDifference(event.startDate!, event.endDate!) : 0;
  let matched = 0;
  let steps = 0;
  // Uncounted rules have no historical ordinal to preserve. Start near the
  // requested window so importing a long-running series cannot replay years
  // of timezone conversions on the main thread. Include long overlapping
  // events and a margin for offset changes. COUNT rules still count from DTSTART.
  const overlapStart = dateInTimeZone(range.startMs - (event.endMs - event.startMs) - 3 * 86_400_000, event.timeZone);
  const firstDate = rule.count === undefined && overlapStart > anchor ? overlapStart : anchor;
  for (let date = firstDate; date <= endDate; date = addLocalDays(date, 1)) {
    if (budget && --budget.remaining < 0) throw new Error('Too many calendar dates to check safely. Narrow the range or shorten old recurring series.');
    if (++steps > MAX_EXPANSION_STEPS) throw new Error('Recurring event history is too long to check safely. Shorten or replace the series.');
    if (rule.until && date > rule.until) break;
    const days = localDateDifference(anchor, date);
    const months = (Number(date.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + Number(date.slice(5, 7)) - Number(anchor.slice(5, 7));
    const matches = rule.frequency === 'daily' ? days % rule.interval === 0
      : rule.frequency === 'weekly' ? Math.floor(localDateDifference(anchorWeekStart, date) / 7) % rule.interval === 0 && (rule.weekDays ?? [localWeekDay(anchor)]).includes(localWeekDay(date))
        : months % rule.interval === 0 && date.slice(8) === anchor.slice(8);
    if (!matches) continue;
    let startMs: number;
    let endMs: number;
    try {
      // Preserve the exact first instant when it was entered in the later DST fold.
      startMs = date === anchor ? event.startMs : event.allDay ? startOfLocalDate(date, event.timeZone) : wallClockToInstant(`${date}T${clock}`, event.timeZone) + seconds;
      if (event.allDay && dateInTimeZone(startMs, event.timeZone) !== date) continue;
      endMs = event.allDay ? startOfLocalDate(addLocalDays(date, daySpan), event.timeZone) : startMs + event.endMs - event.startMs;
    } catch (error) {
      if ((error as Error).message.includes('does not exist')) continue;
      throw error;
    }
    matched++;
    if (matched > MAX_OCCURRENCES) throw new Error('Recurring event history is too long to check safely. Shorten or replace the series.');
    append(startMs, endMs);
    if (rule.count !== undefined && matched >= rule.count) break;
  }
  return result;
}
