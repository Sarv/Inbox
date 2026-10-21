import type { LocalCalendarEvent, LocalCalendarEventInput, LocalCalendarPreferences, LocalCalendarRange, LocalCalendarRecurrence } from '../../src/types/local-calendar';
import { dateInTimeZone, localDateDifference, localWeekDay, startOfLocalDate, validLocalDate, validateTimeZone } from '../../src/utils/local-calendar';

export const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 400;
export const MAX_OCCURRENCES = 10_000;

export function validateRange(range: LocalCalendarRange): LocalCalendarRange {
  if (!range || !Number.isSafeInteger(range.startMs) || !Number.isSafeInteger(range.endMs) || range.endMs <= range.startMs || range.endMs - range.startMs > MAX_RANGE_DAYS * DAY_MS) throw new Error('Choose a calendar range of at most 400 days.');
  return range;
}

export function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value as number;
}

export function textValue(value: unknown, name: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || value.includes('\u0000')) throw new Error(`Enter a valid ${name}.`);
  return value.trim();
}

export function defaultPreferences(): LocalCalendarPreferences {
  return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 30, slotIntervalMinutes: 15 };
}

export function validatePreferences(value: LocalCalendarPreferences): LocalCalendarPreferences {
  validateTimeZone(value?.timeZone);
  if (!Array.isArray(value.workingDays) || value.workingDays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(value.workingDays).size !== value.workingDays.length) throw new Error('Choose valid working days.');
  const validTime = (time: string) => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!validTime(value.workingStart) || !validTime(value.workingEnd) || value.workingEnd <= value.workingStart) throw new Error('Working hours must end after they start on the same day.');
  return { timeZone: value.timeZone, workingDays: [...value.workingDays].sort(), workingStart: value.workingStart, workingEnd: value.workingEnd,
    durationMinutes: boundedInteger(value.durationMinutes, 1, 1440, 'Meeting duration'),
    bufferBeforeMinutes: boundedInteger(value.bufferBeforeMinutes, 0, 1440, 'Buffer before'), bufferAfterMinutes: boundedInteger(value.bufferAfterMinutes, 0, 1440, 'Buffer after'),
    minimumNoticeMinutes: boundedInteger(value.minimumNoticeMinutes, 0, 525600, 'Minimum notice'), slotIntervalMinutes: boundedInteger(value.slotIntervalMinutes, 1, 1440, 'Slot interval') };
}

export function validateRecurrence(value: LocalCalendarRecurrence | undefined, startDate: string): LocalCalendarRecurrence | undefined {
  if (value === undefined) return undefined;
  if (!value || !['daily', 'weekly', 'monthly'].includes(value.frequency)) throw new Error('This recurrence is not supported.');
  const interval = boundedInteger(value.interval, 1, 366, 'Recurrence interval');
  const result: LocalCalendarRecurrence = { frequency: value.frequency, interval };
  if (value.count !== undefined) result.count = boundedInteger(value.count, 1, MAX_OCCURRENCES, 'Recurrence count');
  if (value.until !== undefined) {
    if (!validLocalDate(value.until) || value.until < startDate) throw new Error('The last recurrence date must be on or after the event starts.');
    result.until = value.until;
  }
  if (result.count !== undefined && result.until !== undefined) throw new Error('Choose either a recurrence count or an end date.');
  if (value.weekDays !== undefined) {
    if (value.frequency !== 'weekly' || !Array.isArray(value.weekDays) || value.weekDays.length === 0 || value.weekDays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(value.weekDays).size !== value.weekDays.length) throw new Error('Choose valid weekly recurrence days.');
    result.weekDays = [...value.weekDays].sort();
  }
  return result;
}

export function validateEvent(value: LocalCalendarEventInput, id: string, updatedAt: number): LocalCalendarEvent {
  if (!value || typeof value !== 'object') throw new Error('Enter an event.');
  const timeZone = validateTimeZone(value.timeZone);
  if (typeof value.allDay !== 'boolean' || typeof value.busy !== 'boolean' || !['confirmed', 'tentative', 'cancelled'].includes(value.status)) throw new Error('Invalid event status.');
  let startMs = value.startMs;
  let endMs = value.endMs;
  if (value.allDay) {
    if (!value.startDate || !value.endDate || !validLocalDate(value.startDate) || !validLocalDate(value.endDate) || value.endDate <= value.startDate || localDateDifference(value.startDate, value.endDate) > 366) throw new Error('All-day events need a start date and a later exclusive end date.');
    startMs = startOfLocalDate(value.startDate, timeZone);
    endMs = startOfLocalDate(value.endDate, timeZone);
    if (dateInTimeZone(startMs, timeZone) !== value.startDate) throw new Error('The all-day start date does not exist in this timezone.');
  }
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs || endMs - startMs > 367 * DAY_MS) throw new Error('The event must end after it starts and last at most one year.');
  const recurrence = validateRecurrence(value.recurrence, value.allDay ? value.startDate! : dateInTimeZone(startMs, timeZone));
  if (recurrence?.frequency === 'weekly' && recurrence.weekDays && !recurrence.weekDays.includes(localWeekDay(dateInTimeZone(startMs, timeZone)))) throw new Error('The start date must match one of the weekly recurrence days.');
  return { id, calendarId: textValue(value.calendarId, 'calendar', 200, true), title: textValue(value.title, 'event title', 300, true), description: textValue(value.description, 'description', 30_000), location: textValue(value.location, 'location', 2000),
    timeZone, allDay: value.allDay, startMs, endMs, busy: value.busy, status: value.status,
    reminderMinutes: value.reminderMinutes === null ? null : boundedInteger(value.reminderMinutes, 0, 10080, 'Reminder'),
    ...(value.allDay ? { startDate: value.startDate, endDate: value.endDate } : {}), ...(recurrence ? { recurrence } : {}), updatedAt };
}
