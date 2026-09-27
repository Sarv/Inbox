import {
  addDays,
  addHours,
  addMinutes,
  format,
  isAfter,
  isBefore,
  nextMonday,
  nextSaturday,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
  startOfDay,
} from 'date-fns';

/**
 * The "pick a time" presets, in ONE place.
 *
 * Snooze and Send later ask the same question — when should this come back /
 * go out — and answered it with two copies of the same date arithmetic. They
 * are one module now so "tomorrow morning" cannot mean 8am in one menu and 9am
 * in the other.
 *
 * Everything here is pure and takes `now`, so the tests can pin the clock. The
 * times are LOCAL by construction (date-fns operates on the local zone) because
 * the reader means their own morning; only the epoch conversion at the boundary
 * is UTC.
 */
export interface TimePreset {
  /** Menu row, e.g. "Tomorrow morning". */
  label: string;
  /** The concrete time it resolves to, for the right-hand hint. */
  sublabel: string;
  time: Date;
}

/** Hours the presets use, named so the two menus can't drift apart. */
const MORNING_HOUR = 8;
const AFTERNOON_HOUR = 13;
const WEEKEND_HOUR = 9;
/** "Later today" is this far out… */
const LATER_TODAY_HOURS = 3;
/** …and past this hour there is no "later today" left worth offering. */
const LATEST_TODAY_HOUR = 20;

const atHour = (date: Date, hour: number): Date => setMinutes(setHours(startOfDay(date), hour), 0);

/** Next half hour on the clock — a delivery time of 14:30 reads as chosen, 14:27 as a bug. */
const roundUpToHalfHour = (date: Date): Date => {
  const overshoot = date.getMinutes() % 30;
  const rounded = overshoot === 0 ? date : addMinutes(date, 30 - overshoot);
  return setMilliseconds(setSeconds(rounded, 0), 0);
};

const preset = (label: string, time: Date, pattern: string): TimePreset => ({
  label,
  time,
  sublabel: format(time, pattern),
});

/** When a snoozed message should come back. */
export function snoozePresets(now: Date = new Date()): TimePreset[] {
  return [
    preset('Tomorrow', atHour(addDays(now, 1), MORNING_HOUR), 'EEE, h:mm a'),
    preset('This weekend', atHour(nextSaturday(now), WEEKEND_HOUR), 'EEE, h:mm a'),
    preset('Next week', atHour(addDays(now, 7), MORNING_HOUR), 'EEE, MMM d'),
  ];
}

/**
 * When a composed message should go out. "Later today" is dropped in the
 * evening: offering to send at 01:30 because it is 22:30 is not a choice
 * anybody means to make.
 */
export function sendLaterPresets(now: Date = new Date()): TimePreset[] {
  const laterToday = roundUpToHalfHour(addHours(now, LATER_TODAY_HOURS));
  const presets: TimePreset[] = [];
  if (isBefore(laterToday, atHour(now, LATEST_TODAY_HOUR))) {
    presets.push(preset('Later today', laterToday, 'h:mm a'));
  }
  presets.push(
    preset('Tomorrow morning', atHour(addDays(now, 1), MORNING_HOUR), 'EEE, h:mm a'),
    preset('Tomorrow afternoon', atHour(addDays(now, 1), AFTERNOON_HOUR), 'EEE, h:mm a'),
    preset('Monday morning', atHour(nextMonday(now), MORNING_HOUR), 'EEE, h:mm a'),
  );
  return presets;
}

/** UTC epoch SECONDS — what every storage and IPC boundary here takes. */
export const toEpochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * The `<input type="date">` + `<input type="time">` pair as one local Date.
 * Returns null for an incomplete or unparseable pair rather than an Invalid
 * Date, which would otherwise reach storage as NaN and schedule nothing.
 */
export function customDateTime(dateValue: string, timeValue: string): Date | null {
  if (!dateValue) return null;
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hours, minutes] = (timeValue || '00:00').split(':').map(Number);
  if ([year, month, day, hours, minutes].some((part) => !Number.isFinite(part))) return null;
  const parsed = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Today as `YYYY-MM-DD` in the reader's own zone, for a date input's `min`. */
export const dateInputValue = (date: Date): string => format(date, 'yyyy-MM-dd');

/** Local `HH:mm` — what an `<input type="time">` reads and writes. */
export const timeInputValue = (date: Date): string => format(date, 'HH:mm');

/**
 * The time input's own minimum: on today the reader cannot go back past the
 * current minute, on any later day the whole day is open. `undefined` (no `min`
 * attribute) rather than '00:00' so the control is unconstrained when it should
 * be.
 */
export function earliestTimeFor(dateValue: string, now: Date = new Date()): string | undefined {
  return dateValue === dateInputValue(now) ? timeInputValue(now) : undefined;
}

/**
 * Why a custom date/time cannot be scheduled, or null when it can.
 *
 * An empty date is "nothing chosen yet", not an error — the Schedule button is
 * disabled on its own, and an untouched field should not shout.
 */
export function customDateTimeError(
  dateValue: string,
  timeValue: string,
  now: Date = new Date(),
): string | null {
  if (!dateValue) return null;
  const chosen = customDateTime(dateValue, timeValue);
  if (!chosen) return 'Enter a valid date and time.';
  if (!isAfter(chosen, now)) return 'That time has already passed — pick a later one.';
  return null;
}

/** The hour an untouched custom pick opens on, the morning after today. */
const DEFAULT_CUSTOM_HOUR = 9;

/**
 * A custom date/time that is guaranteed to be in the future — the one the
 * reader already has when it still is, otherwise a fresh one.
 *
 * This is what keeps a PRESERVED pick from coming back stale: leave a composer
 * open across the five minutes you scheduled it for and reopen the menu, and
 * the fields must not still offer a moment that has been and gone (the Schedule
 * button would sit there disabled with no way to tell why). Nothing chosen yet
 * opens on tomorrow morning; something chosen and lapsed moves to the next half
 * hour, the nearest valid version of what was meant.
 */
export function futureCustomDraft(
  dateValue: string,
  timeValue: string,
  now: Date = new Date(),
): { date: string; time: string } {
  const chosen = customDateTime(dateValue, timeValue);
  if (chosen && isAfter(chosen, now)) return { date: dateValue, time: timeValue };
  if (!dateValue) {
    const tomorrow = atHour(addDays(now, 1), DEFAULT_CUSTOM_HOUR);
    return { date: dateInputValue(tomorrow), time: timeInputValue(tomorrow) };
  }
  // +1 minute first, so a clock sitting exactly on :00 or :30 still moves on.
  const soon = roundUpToHalfHour(addMinutes(now, 1));
  return { date: dateInputValue(soon), time: timeInputValue(soon) };
}
