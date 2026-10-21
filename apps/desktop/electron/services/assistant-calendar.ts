import { parse } from 'chrono-node';

import type { InboxAssistantChat } from '../../src/types/inbox-assistant';
import type { LocalCalendarAvailability, LocalCalendarAvailabilityRequest, LocalCalendarPreferences } from '../../src/types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, localDateDifference, localWeekDay, startOfLocalDate, validLocalDate, validateTimeZone, wallClockToInstant } from '../../src/utils/local-calendar';

export const MEETING_AVAILABILITY_MARKER = '[MEETING_AVAILABILITY]';
const MEETING = /\b(?:meet(?:ing)?s?|appointments?|availability|schedule|time slots?|video call|phone call|catch up)\b/i;
const minutes = 60_000;
const guidance = 'Choose an exact meeting date/time range in the meeting fields so availability can be checked accurately.';
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?';
const CLOCK = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)?)';
interface DateWindow { first: string; after: string; kind: 'week' | 'specific' }
interface ClockWindow { from: number; until?: number }
interface ScheduleParts { date?: DateWindow; weekDays?: number[]; times?: ClockWindow[]; duration?: number }

const ambiguous = (): never => { throw new Error(guidance); };
const wordDay = (text: string): number => DAY_NAMES.indexOf(text.toLowerCase().replace(/s$/, ''));
const wallText = (date: string, minute: number): string => `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

function instructionZone(text: string): string | undefined {
  const zones = text.match(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g) ?? [];
  if (new Set(zones).size > 1 || /\b(?:UTC|GMT)\s*[+-]\s*\d/i.test(text)) ambiguous();
  if (zones.length) return validateTimeZone(zones[0]!);
  if (/\b(?:IST|CST|EST|PST|EDT|PDT|CET|CEST|BST)\b/.test(text)) ambiguous();
  return /\b(?:UTC|GMT)\b/i.test(text) ? 'UTC' : undefined;
}

function durationParts(text: string): { text: string; duration?: number } {
  if (/\b(?:in|within)\s+\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)\b/i.test(text)) ambiguous();
  const found: number[] = [];
  let remaining = text.replace(/\bone(?:\s+|-)+and(?:\s+|-)+a(?:\s+|-)+half(?:\s+|-)+hours?\b/gi, () => { found.push(90); return ' '; });
  remaining = remaining.replace(/\b(?:half\s+(?:an?\s+)?hour|half-hour)\b/gi, () => { found.push(30); return ' '; });
  remaining = remaining.replace(/\b(?:(?:an?|one)\s+hour|two\s+hours)\b/gi, value => { found.push(/^two/i.test(value) ? 120 : 60); return ' '; });
  const numbers: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  remaining = remaining.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)[ -]+(minutes?|hours?)\b/gi, (_value, amount: string, unit: string) => { found.push(numbers[amount.toLowerCase()]! * (/^h/i.test(unit) ? 60 : 1)); return ' '; });
  remaining = remaining.replace(/\b(\d{1,4}(?:\.\d+)?)\s*-?\s*(minutes?|mins?|hours?|hrs?)\b/gi, (_value, amount: string, unit: string) => { found.push(Number(amount) * (/^h/i.test(unit) ? 60 : 1)); return ' '; });
  if (new Set(found).size > 1) ambiguous();
  const duration = found[0];
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 5 || duration > 480)) throw new Error('Choose a meeting duration between 5 and 480 minutes.');
  return { text: remaining, duration };
}

function clockMinute(value: string, inheritedMeridiem?: string): number {
  const normalized = value.toLowerCase().replace(/[.\s]/g, '');
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(normalized);
  if (!match) return ambiguous();
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3] ?? inheritedMeridiem;
  if (minute > 59 || hour > (meridiem ? 12 : 23) || (meridiem && hour < 1) || (!meridiem && !match[2] && hour >= 1 && hour <= 12)) ambiguous();
  return (meridiem ? hour % 12 + (meridiem === 'pm' ? 12 : 0) : hour) * 60 + minute;
}

function timeParts(text: string): { times?: ClockWindow[]; text: string } {
  let remaining = text.replace(/\bgood morning\b/gi, ' ').replace(/\bthis\s+(morning|afternoon|evening)\b/gi, 'today $1').replace(/\bnoon\b/gi, '12:00').replace(/\bmidnight\b/gi, '00:00');
  if (/\b(?:early|late)\s+(?:morning|afternoon|evening)|\b(?:around|about)\s+\d|\b(?:after|before)\s+lunch\b/i.test(remaining)) ambiguous();
  if (/\b(?:next\s+(?:morning|afternoon|evening)|tonight|nights?|breakfast|lunch|dinner)|\b(?:not|avoid|except)(?:\s+in)?(?:\s+the)?\s+(?:mornings?|afternoons?|evenings?)\b|\b(?:not|avoid|except)\s+(?:at\s+)?\d|\bno\s+(?:meetings?|appointments?|calls?)\s+(?:before|after)\b|\b(?:do not|don't|never)\s+(?:schedule|meet|book).{0,20}\b(?:before|after|at)\b/i.test(remaining)) ambiguous();
  if (/\b(?:at|before|after|around)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|lunch|breakfast|dinner)\b/i.test(remaining)) ambiguous();
  const dayParts = [...remaining.matchAll(/\b(mornings?|afternoons?|evenings?)\b/gi)].map(match => match[1]!.toLowerCase().replace(/s$/, ''));
  const parts = [...new Set(dayParts)].map(part => part === 'morning' ? { from: 9 * 60, until: 12 * 60 } : part === 'afternoon' ? { from: 12 * 60, until: 17 * 60 } : { from: 17 * 60, until: 21 * 60 });
  remaining = remaining.replace(/\b(?:mornings?|afternoons?|evenings?)\b/gi, ' ');
  const times: ClockWindow[] = [];
  const rangePattern = new RegExp(`\\b(?:between|from)\\s+(${CLOCK})\\s*(?:and|to|until|through|-)\\s*(${CLOCK})(?![\\d:])`, 'gi');
  remaining = remaining.replace(rangePattern, (_whole, first: string, last: string) => {
    const meridiem = (value: string) => /([ap])\.?m\.?\s*$/i.exec(value)?.[1]?.toLowerCase().concat('m');
    let from = clockMinute(first, meridiem(last));
    const until = clockMinute(last, meridiem(first));
    if (from >= until && !meridiem(first) && meridiem(last) === 'pm' && from >= 12 * 60) from -= 12 * 60;
    if (until <= from) ambiguous();
    times.push({ from, until }); return ' ';
  });
  // Bare ranges require a colon or meridiem on each side, so ISO dates are never clocks.
  const explicitClock = '(?:\\d{1,2}:\\d{2}\\s*(?:[ap]\\.?m\\.?)?|\\d{1,2}\\s*[ap]\\.?m\\.?)';
  remaining = remaining.replace(new RegExp(`\\b(${explicitClock})\\s*[-–]\\s*(${explicitClock})`, 'gi'), (_whole, first: string, last: string) => {
    const from = clockMinute(first); const until = clockMinute(last);
    if (until <= from) ambiguous(); times.push({ from, until }); return ' ';
  });
  remaining = remaining.replace(new RegExp(`\\b(no earlier than|no later than|not before|not after|after|before|at)\\s+(${CLOCK})(?![\\d:])`, 'gi'), (_whole, prefix: string, clock: string) => {
    const time = clockMinute(clock);
    times.push(/^(?:after|no earlier than|not before)$/i.test(prefix) ? { from: time, until: 1440 } : /^(?:before|no later than|not after)$/i.test(prefix) ? { from: 0, until: time } : { from: time });
    return ' ';
  });
  remaining = remaining.replace(new RegExp(`\\b(${explicitClock})`, 'gi'), (_whole, clock: string) => { times.push({ from: clockMinute(clock) }); return ' '; });
  if (times.length > 1 && !/\bor\b/i.test(text)) ambiguous();
  if (times.length && parts.length) {
    if (parts.length !== 1) ambiguous();
    const part = parts[0]!;
    for (const time of times) {
      if (time.until === undefined) { if (time.from < part.from || time.from >= part.until!) ambiguous(); }
      else { time.from = Math.max(time.from, part.from); time.until = Math.min(time.until, part.until!); if (time.until <= time.from) ambiguous(); }
    }
  }
  return { text: remaining, times: times.length ? times : parts.length ? parts : undefined };
}

function dateParts(text: string, timeZone: string, now: number): Pick<ScheduleParts, 'date' | 'weekDays'> {
  let remaining = text.replace(/\b[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?\b/g, ' ').replace(/\b(?:UTC|GMT)\b/gi, ' ');
  if (/\b(?:next|this)\s+(?:month|year)|\b(?:every|each)\s+(?:week|month|year)|\bweek\s+of\b|\bfortnight\b|\b(?:by|before|after|until)\s+(?:today|tomorrow|next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(remaining)) ambiguous();
  const today = dateInTimeZone(now, timeZone);
  const monday = addLocalDays(today, -((localWeekDay(today) + 6) % 7));
  let date: DateWindow | undefined;
  const week = /\bnext\s+(?:(two|2)\s+)?weeks?\b/i.exec(remaining);
  if (week) {
    const first = week[1] ? today : addLocalDays(monday, 7);
    date = { first, after: addLocalDays(first, week[1] ? 14 : 7), kind: 'week' };
    remaining = remaining.replace(week[0], ' ');
  } else if (/\bthis week\b/i.test(remaining)) {
    date = { first: today, after: addLocalDays(monday, 7), kind: 'week' };
    remaining = remaining.replace(/\bthis week\b/i, ' ');
  }
  const dayAfter = /\b(?:the\s+)?day after tomorrow\b/i.test(remaining);
  const tomorrow = /\btomorrow\b/i.test(remaining);
  const todayExplicit = /\btoday\b/i.test(remaining);
  if (Number(tomorrow) + Number(todayExplicit) > 1 || (date && (tomorrow || todayExplicit))) ambiguous();
  if (tomorrow || todayExplicit) {
    const first = addLocalDays(today, dayAfter ? 2 : tomorrow ? 1 : 0);
    date = { first, after: addLocalDays(first, 1), kind: 'specific' };
    remaining = remaining.replace(/\b(?:the\s+)?day after tomorrow\b|\btomorrow\b|\btoday\b/gi, ' ');
  }
  let weekDays: number[] | undefined;
  const excluded = [...remaining.matchAll(new RegExp(`\\b(?:except|not|avoid)\\s+(${DAY})\\b`, 'gi'))].map(match => wordDay(match[1]!));
  if (new RegExp(`\\b(?:except|not|avoid)\\s+(?:(?:next|this)\\s+)?${DAY}\\s+(?:and|or|nor)\\s+${DAY}\\b`, 'i').test(remaining)) ambiguous();
  if (new RegExp(`\\b(?:except|not|avoid)\\s+(?:next|this)\\s+${DAY}\\b`, 'i').test(remaining)) ambiguous();
  remaining = remaining.replace(new RegExp(`\\b(?:except|not|avoid)\\s+(${DAY})\\b`, 'gi'), ' ');
  const dayRange = new RegExp(`\\b(${DAY})\\s*(?:to|through|-)\\s*(${DAY})\\b`, 'i').exec(remaining);
  if (dayRange) {
    const first = (wordDay(dayRange[1]!) + 6) % 7; const last = (wordDay(dayRange[2]!) + 6) % 7;
    if (last < first) ambiguous();
    weekDays = Array.from({ length: last - first + 1 }, (_, index) => (first + index + 1) % 7);
    remaining = remaining.replace(dayRange[0], ' ');
  }
  const namedDays = [...remaining.matchAll(new RegExp(`\\b(${DAY})\\b`, 'gi'))].map(match => wordDay(match[1]!));
  if (namedDays.length) weekDays = [...new Set([...(weekDays ?? []), ...namedDays])];
  if (/\bweekdays\b/i.test(remaining)) weekDays = [1, 2, 3, 4, 5];
  if (/\bweekends?\b/i.test(remaining)) weekDays = [0, 6];
  if (excluded.length) weekDays = (weekDays ?? [0, 1, 2, 3, 4, 5, 6]).filter(day => !excluded.includes(day));
  if (weekDays?.length === 0) ambiguous();
  if (namedDays.length || dayRange || weekDays) {
    if (date?.kind === 'specific' && weekDays && !weekDays.includes(localWeekDay(date.first))) ambiguous();
    if (!date) {
      const explicitlyNext = new RegExp(`\\bnext\\s+${DAY}\\b`, 'i').test(remaining);
      date = { first: explicitlyNext && weekDays?.includes(localWeekDay(today)) ? addLocalDays(today, 1) : today, after: addLocalDays(today, explicitlyNext ? 8 : 7), kind: 'week' };
    }
    remaining = remaining.replace(new RegExp(`\\b(?:next|this)?\\s*(${DAY})\\b`, 'gi'), ' ').replace(/\bweekdays|weekends?\b/gi, ' ');
  }
  const wall = instantToWallClock(now, timeZone);
  const offset = (Date.parse(`${wall}:00Z`) - Math.floor(now / minutes) * minutes) / minutes;
  if (/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(remaining)) ambiguous();
  const parsed = parse(remaining, { instant: new Date(now), timezone: offset }, { forwardDate: true }).filter(value => value.start.isCertain('day') || value.start.isCertain('month') || value.start.isCertain('weekday'));
  if (parsed.length > 1 || (parsed.length && date)) ambiguous();
  if (parsed.length) {
    const part = parsed[0]!;
    if (!part.start.isCertain('day') && !part.start.isCertain('weekday')) ambiguous();
    const localDate = (value: typeof part.start) => `${value.get('year')}-${String(value.get('month')).padStart(2, '0')}-${String(value.get('day')).padStart(2, '0')}`;
    const first = localDate(part.start); const last = part.end ? localDate(part.end) : first;
    if (!validLocalDate(first) || !validLocalDate(last) || last < first) ambiguous();
    date = { first, after: addLocalDays(last, 1), kind: 'specific' };
  }
  if (!date && /\b(?:next|this|on|during|date|week|month|year)\s+(?:\d|week|month|year)|\b\d{4}-\d{2}-\d{2}\b/i.test(remaining)) ambiguous();
  return { date, weekDays };
}

function schedulingParts(text: string, zone: string, now: number): ScheduleParts {
  const duration = durationParts(text);
  const time = timeParts(duration.text);
  const date = dateParts(time.text, zone, now);
  if ((date.weekDays?.length ?? 0) > 1 && (time.times?.length ?? 0) > 1) ambiguous();
  return { ...date, times: time.times, duration: duration.duration };
}

export function isMeetingDraft(chat: InboxAssistantChat, instructions: string): boolean {
  return MEETING.test(instructions) || MEETING.test(chat.exchanges.at(-1)?.question ?? '');
}

/** Resolve only the latest user question and draft instructions, never source email content. */
export function meetingAvailabilityRequests(
  chat: InboxAssistantChat, instructions: string, preferences: LocalCalendarPreferences,
  explicit?: LocalCalendarAvailabilityRequest, now = Date.now(),
): LocalCalendarAvailabilityRequest[] | undefined {
  if (explicit) {
    const duration = explicit.durationMinutes ?? preferences.durationMinutes;
    if (!Number.isSafeInteger(explicit.startMs) || !Number.isSafeInteger(explicit.endMs) || explicit.endMs <= explicit.startMs || explicit.endMs - explicit.startMs > 400 * 86400000 || !Number.isInteger(duration) || duration < 5 || duration > 480) throw new Error(guidance);
    return [{ ...explicit, durationMinutes: duration, timeZone: validateTimeZone(explicit.timeZone ?? preferences.timeZone), limit: 3 }];
  }
  const latestQuestion = chat.exchanges.at(-1)?.question ?? '';
  const question = MEETING.test(latestQuestion) ? latestQuestion : '';
  if (!MEETING.test(instructions) && !question) return undefined;
  const zone = instructionZone(instructions) ?? instructionZone(question) ?? validateTimeZone(preferences.timeZone);
  const today = dateInTimeZone(now, zone);
  const original = schedulingParts(question, zone, now);
  const change = schedulingParts(instructions, zone, now);
  const durationMinutes = change.duration ?? original.duration ?? preferences.durationMinutes;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) throw new Error('Choose a meeting duration between 5 and 480 minutes.');
  let date = change.date ?? original.date ?? { first: today, after: addLocalDays(today, 7), kind: 'week' as const };
  let weekDays = change.weekDays ?? original.weekDays;
  if (change.date?.kind === 'specific' && !change.weekDays) weekDays = undefined;
  if (change.weekDays && !change.date && original.date?.kind === 'specific') date = { first: today, after: addLocalDays(today, 7), kind: 'week' };
  if (change.date?.kind === 'week' && !/\b(?:next|this)\s+week|\bnext\s+(?:two|2)\s+weeks/i.test(instructions) && original.date?.kind === 'week') {
    // A weekday-only instruction narrows an inherited explicit week instead of moving it.
    date = original.date;
  }
  const times = change.times ?? original.times;
  const days = localDateDifference(date.first, date.after);
  if (days <= 0 || days > 14) throw new Error(guidance);
  const range = (first: string, after: string) => ({ startMs: startOfLocalDate(first, zone), endMs: startOfLocalDate(after, zone), durationMinutes, timeZone: zone, limit: 3 });
  if (!times && !weekDays) {
    const request = range(date.first, date.after);
    if (request.endMs <= request.startMs) throw new Error('That local date does not exist. Choose another meeting date.');
    return [request];
  }
  const requests: LocalCalendarAvailabilityRequest[] = [];
  for (let localDate = date.first; localDate < date.after; localDate = addLocalDays(localDate, 1)) {
    if (weekDays && !weekDays.includes(localWeekDay(localDate))) continue;
    if (startOfLocalDate(localDate, zone) === startOfLocalDate(addLocalDays(localDate, 1), zone)) continue;
    for (const time of times ?? [{ from: 0, until: 1440 }]) {
      const startMs = time.from === 0 ? startOfLocalDate(localDate, zone) : wallClockToInstant(wallText(localDate, time.from), zone);
      const endMs = time.until === undefined ? startMs + durationMinutes * minutes : time.until === 1440 ? startOfLocalDate(addLocalDays(localDate, 1), zone) : wallClockToInstant(wallText(localDate, time.until), zone);
      if (endMs <= startMs || endMs - startMs < durationMinutes * minutes) throw new Error('The requested time window is shorter than the meeting duration.');
      requests.push({ startMs, endMs, durationMinutes, timeZone: zone, limit: 3 });
      if (requests.length > 14) throw new Error(guidance);
    }
  }
  if (!requests.length) throw new Error('Those date constraints contain no valid local meeting day. Choose another date range.');
  return requests;
}

/** Compatibility for callers that can only represent one contiguous date window. */
export function meetingAvailabilityRequest(...args: Parameters<typeof meetingAvailabilityRequests>): LocalCalendarAvailabilityRequest | undefined {
  const requests = meetingAvailabilityRequests(...args);
  if (requests && requests.length !== 1) throw new Error('This meeting needs several date windows. Choose an exact range in the meeting fields.');
  return requests?.[0];
}

export function meetingDraftInstructions(availability: LocalCalendarAvailability): string {
  return [
    'CALENDAR RULE: The app checked the selected local calendars. External services and recipient calendars were NOT checked. Do not book a meeting or claim recipient availability.',
    `Write the normal reply and place the literal ${MEETING_AVAILABILITY_MARKER} on its own line exactly once, before the closing/signature. The app replaces it with verified time options.`,
    'Do NOT propose, confirm or repeat scheduling dates/times elsewhere in the body. Do not turn a requested time in the email into a commitment. Keep all scheduling choices inside the placeholder.',
    `VERIFIED_LOCAL_AVAILABILITY_JSON: ${JSON.stringify({ checkedAt: availability.checkedAt, timeZone: availability.timeZone, durationMinutes: availability.durationMinutes, scope: availability.scope, slots: availability.slots })}`,
  ].join('\n');
}

export function insertVerifiedMeetingTimes(body: string, availability: LocalCalendarAvailability): string {
  if (availability.status !== 'ready') throw new Error('Select at least one calendar that blocks availability before drafting meeting times.');
  if (body.split(MEETING_AVAILABILITY_MARKER).length !== 2) throw new Error('The meeting draft did not preserve the verified availability placeholder. Please try again.');
  const surrounding = body.replace(MEETING_AVAILABILITY_MARKER, '');
  for (const paragraph of surrounding.split(/\n\s*\n/)) {
    const clock = /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*[ap]\.?m\.?|noon|midnight)\b/i.test(paragraph);
    const date = /\b(?:today|tomorrow|next week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/i.test(paragraph);
    const scheduling = MEETING.test(paragraph) || /\b(?:available|free|works?|join|connect|talk|book|confirm|(?:can|could)\s+(?:do|make)|how\s+about)\b/i.test(paragraph);
    const committed = /\b(?:booked|reserved|confirmed|scheduled|accepted)\b/i.test(paragraph) && /\b(?:meeting|appointment|time|slot|call)\b/i.test(paragraph);
    if (clock || (date && scheduling) || committed) {
      throw new Error('The AI included an unverified meeting time. Please prepare the draft again.');
    }
  }
  const paragraph = availability.slots.length
    ? `Would any of these times work for a ${availability.durationMinutes}-minute meeting (${availability.timeZone})?\n${availability.slots.map(slot => `• ${slot.label}`).join('\n')}\nPlease let me know which works for you.`
    : 'I could not find a suitable opening during that period. Could you suggest a few alternative times? I will confirm before we schedule the meeting.';
  return body.replace(MEETING_AVAILABILITY_MARKER, paragraph);
}

/** A proposal is a snapshot, not a reservation. Recheck its exact slots. */
export async function recheckMeetingAvailability(
  proposal: LocalCalendarAvailability,
  availability: (request: LocalCalendarAvailabilityRequest) => LocalCalendarAvailability | Promise<LocalCalendarAvailability>,
): Promise<void> {
  if (proposal.status !== 'ready') throw new Error('Calendar availability could not be verified. Check your calendar before proposing meeting times.');
  for (const slot of proposal.slots) {
    const fresh = await availability({ startMs: slot.startMs, endMs: slot.endMs, timeZone: proposal.timeZone, durationMinutes: proposal.durationMinutes, limit: 1 });
    if (fresh.status !== 'ready' || !fresh.slots.some(item => item.startMs === slot.startMs && item.endMs === slot.endMs)) {
      throw new Error('Your calendar changed while this draft was being prepared. Check availability again before proposing these times.');
    }
  }
}
