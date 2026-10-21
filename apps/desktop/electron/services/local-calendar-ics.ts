import { randomUUID } from 'node:crypto';

import ICAL from 'ical.js';

import type { LocalCalendar, LocalCalendarEvent, LocalCalendarEventInput, LocalCalendarRecurrence } from '../../src/types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, localWeekDay, startOfLocalDate, validLocalDate, validateTimeZone, wallClockToInstant } from '../../src/utils/local-calendar';

import { validateEvent } from './local-calendar-model';
import { expandLocalEvent } from './local-calendar-recurrence';

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;
export interface ImportedCalendarSeries { uid: string; event: LocalCalendarEvent; exceptions: LocalCalendarEvent[] }
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_ICS_BYTES = 2 * 1024 * 1024;

function timeValue(value: unknown): Time {
  if (!(value instanceof ICAL.Time)) throw new Error('The calendar contains an invalid date or time.');
  return value;
}

function dateText(value: Time): string {
  const date = `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
  if (!validLocalDate(date)) throw new Error('The calendar contains an invalid date.');
  return date;
}

export function readLocalCalendarIcsTime(property: Property, value: Time, defaultZone: string): { ms: number; timeZone: string; date: string; allDay: boolean } {
  const date = dateText(value);
  const parameter = property.getParameter('tzid');
  if (Array.isArray(parameter)) throw new Error('Multiple timezones are not supported.');
  const timeZone = value.isDate ? defaultZone : value.zone?.tzid === 'UTC' ? 'UTC' : typeof parameter === 'string' ? parameter : undefined;
  if (!timeZone) throw new Error('Floating event times are not supported. Include a timezone or use UTC.');
  validateTimeZone(timeZone);
  const wall = `${date}T${value.isDate ? '00:00' : `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`}`;
  if (value.second < 0 || value.second > 59) throw new Error('Leap seconds are not supported.');
  return { ms: value.isDate ? startOfLocalDate(date, timeZone) : wallClockToInstant(wall, timeZone) + value.second * 1000, timeZone, date, allDay: value.isDate };
}

function recurrence(component: Component, event: LocalCalendarEvent): LocalCalendarRecurrence | undefined {
  const properties = component.getAllProperties('rrule');
  if (properties.length > 1 || component.hasProperty('rdate') || component.hasProperty('exrule')) throw new Error('This calendar uses unsupported recurrence rules.');
  if (!properties.length) return undefined;
  const value = properties[0]!.getFirstValue();
  if (!(value instanceof ICAL.Recur)) throw new Error('Invalid recurrence rule.');
  const parts: Record<string, string> = Object.fromEntries(String(value.toString()).split(';').map(part => part.split('=')));
  if (Object.keys(parts).some(key => !['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST'].includes(key)) || (parts.WKST && parts.WKST !== 'MO')) throw new Error('This calendar uses unsupported recurrence rules.');
  const frequency = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' } as const)[parts.FREQ as 'DAILY' | 'WEEKLY' | 'MONTHLY'];
  if (!frequency) throw new Error('Only daily, weekly and monthly recurrence can be imported.');
  const rule: LocalCalendarRecurrence = { frequency, interval: Number(parts.INTERVAL ?? 1) };
  if (parts.COUNT) rule.count = Number(parts.COUNT);
  if (parts.BYDAY) {
    if (frequency !== 'weekly') throw new Error('Only plain weekly recurrence days are supported.');
    const days = parts.BYDAY.split(',').map(day => WEEKDAYS.indexOf(day));
    if (days.some(day => day < 0)) throw new Error('Ordinal recurrence days are not supported.');
    rule.weekDays = days;
  }
  if (parts.BYMONTHDAY && (frequency !== 'monthly' || parts.BYMONTHDAY !== dateInTimeZone(event.startMs, event.timeZone).slice(8).replace(/^0/, ''))) throw new Error('This monthly recurrence cannot be imported without changing its dates.');
  if (rule.weekDays && !rule.weekDays.includes(localWeekDay(dateInTimeZone(event.startMs, event.timeZone)))) throw new Error('The first event date must match its weekly recurrence days.');
  if (value.until) {
    if (value.until.isDate) {
      if (!event.allDay) throw new Error('Timed recurrence needs a UTC end time.');
      rule.until = dateText(value.until);
    } else {
      if (value.until.zone?.tzid !== 'UTC') throw new Error('Recurrence end times must use UTC.');
      const untilMs = value.until.toUnixTime() * 1000;
      const untilDate = dateInTimeZone(untilMs, event.timeZone);
      const clock = instantToWallClock(event.startMs, event.timeZone).slice(11);
      let lastStart: number;
      try { lastStart = wallClockToInstant(`${untilDate}T${clock}`, event.timeZone) + event.startMs % 60_000; }
      catch { lastStart = untilMs + 1; }
      rule.until = lastStart <= untilMs ? untilDate : addLocalDays(untilDate, -1);
    }
  }
  return rule;
}

function readEvent(component: Component, calendarId: string, now: number, defaultZone: string): LocalCalendarEvent {
  if (component.getAllProperties('dtstart').length !== 1 || component.getAllProperties('dtend').length > 1 || component.getAllProperties('duration').length > 1) throw new Error('The calendar contains an invalid event time.');
  const startProperty = component.getFirstProperty('dtstart')!;
  const ownZone = component.getFirstPropertyValue('x-sarv-timezone');
  const start = readLocalCalendarIcsTime(startProperty, timeValue(startProperty.getFirstValue()), typeof ownZone === 'string' ? ownZone : defaultZone);
  let endMs: number;
  let endDate: string | undefined;
  const endProperty = component.getFirstProperty('dtend');
  const duration = component.getFirstPropertyValue('duration');
  if (endProperty && duration) throw new Error('An event cannot contain both DTEND and DURATION.');
  if (endProperty) {
    const end = readLocalCalendarIcsTime(endProperty, timeValue(endProperty.getFirstValue()), start.timeZone);
    if (end.allDay !== start.allDay) throw new Error('An event mixes all-day and timed dates.');
    endMs = end.ms; endDate = end.date;
  } else if (duration instanceof ICAL.Duration) {
    if (duration.isNegative || duration.toSeconds() <= 0) throw new Error('Event duration must be positive.');
    const days = duration.weeks * 7 + duration.days;
    if (start.allDay) {
      if (duration.hours || duration.minutes || duration.seconds) throw new Error('All-day duration must use whole days.');
      endDate = addLocalDays(start.date, days); endMs = startOfLocalDate(endDate, start.timeZone);
    } else endMs = wallClockToInstant(`${addLocalDays(start.date, days)}T${instantToWallClock(start.ms, start.timeZone).slice(11)}`, start.timeZone) + start.ms % 60_000 + (duration.hours * 3600 + duration.minutes * 60 + duration.seconds) * 1000;
  } else if (start.allDay) { endDate = addLocalDays(start.date, 1); endMs = startOfLocalDate(endDate, start.timeZone); }
  else throw new Error('Timed events need an end time or duration.');
  const status = String(component.getFirstPropertyValue('status') ?? 'CONFIRMED').toLowerCase();
  const transparency = String(component.getFirstPropertyValue('transp') ?? 'OPAQUE');
  if (!['OPAQUE', 'TRANSPARENT'].includes(transparency)) throw new Error('Unsupported event transparency.');
  let reminderMinutes: number | null = null;
  const alarms = component.getAllSubcomponents('valarm');
  if (alarms.length > 1) throw new Error('Only one reminder per event is supported.');
  if (alarms.length) {
    const alarm = alarms[0]!;
    const triggerProperty = alarm.getFirstProperty('trigger');
    const trigger = triggerProperty?.getFirstValue();
    if (String(alarm.getFirstPropertyValue('action')) !== 'DISPLAY' || !(trigger instanceof ICAL.Duration) || (!trigger.isNegative && trigger.toSeconds() !== 0) || trigger.toSeconds() % 60 !== 0 || triggerProperty?.getParameter('related') === 'END' || alarm.hasProperty('repeat')) throw new Error('Only a single display reminder before the start is supported.');
    reminderMinutes = -trigger.toSeconds() / 60;
  }
  const input: LocalCalendarEventInput = { calendarId, title: String(component.getFirstPropertyValue('summary') ?? 'Untitled event'), description: String(component.getFirstPropertyValue('description') ?? ''), location: String(component.getFirstPropertyValue('location') ?? ''), startMs: start.ms, endMs, timeZone: typeof ownZone === 'string' ? validateTimeZone(ownZone) : start.timeZone, allDay: start.allDay, ...(start.allDay ? { startDate: start.date, endDate } : {}), busy: transparency !== 'TRANSPARENT', status: status as LocalCalendarEvent['status'], reminderMinutes };
  const base = validateEvent(input, randomUUID(), now);
  return validateEvent({ ...base, recurrence: recurrence(component, base) }, base.id, now);
}

export function parseLocalCalendarIcs(text: string, calendarId: string, now: number, defaultZone = 'UTC'): ImportedCalendarSeries[] {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES || text.includes('\u0000')) throw new Error('Import a calendar file smaller than 2 MB.');
  let root: Component;
  try { root = new ICAL.Component(ICAL.parse(text)); } catch { throw new Error('This is not a valid iCalendar file.'); }
  if (root.name !== 'vcalendar') throw new Error('Import a VCALENDAR file.');
  if (root.getFirstPropertyValue('method') && root.getFirstPropertyValue('method') !== 'PUBLISH') throw new Error('Meeting requests and cancellations cannot be imported as calendars.');
  if (root.getAllSubcomponents().some(component => !['vevent', 'vtimezone'].includes(component.name))) throw new Error('This file contains unsupported calendar entries.');
  const calendarZone = root.getFirstPropertyValue('x-wr-timezone');
  const timeZone = validateTimeZone(typeof calendarZone === 'string' ? calendarZone : defaultZone);
  root.getAllSubcomponents('vtimezone').forEach(component => validateTimeZone(String(component.getFirstPropertyValue('tzid') ?? '')));
  const components = root.getAllSubcomponents('vevent');
  if (!components.length || components.length > 2000) throw new Error('Import a calendar with between 1 and 2000 events.');
  const uidOf = (component: Component) => {
    const uid = component.getFirstPropertyValue('uid');
    if (typeof uid !== 'string' || !uid.trim() || uid.length > 500 || /[\r\n]/.test(uid) || uid.includes('\u0000') || component.getAllProperties('uid').length !== 1) throw new Error('Each event needs a valid unique UID.');
    return uid;
  };
  const series = new Map<string, ImportedCalendarSeries>();
  const budget = { remaining: 100_000 };
  for (const component of components.filter(value => !value.hasProperty('recurrence-id'))) {
    const uid = uidOf(component);
    if (series.has(uid)) throw new Error('The calendar contains duplicate event identifiers.');
    const event = readEvent(component, calendarId, now, timeZone);
    const excluded: number[] = [];
    for (const property of component.getAllProperties('exdate')) for (const value of property.getValues()) {
      const date = readLocalCalendarIcsTime(property, timeValue(value), event.timeZone);
      if (date.allDay !== event.allDay || !event.recurrence || !expandLocalEvent(event, { startMs: date.ms, endMs: date.ms + 1 }, true, budget).some(value => value.startMs === date.ms)) throw new Error('A recurrence exception does not match its series.');
      excluded.push(date.ms);
    }
    if (excluded.length) event.excludedStarts = [...new Set(excluded)];
    series.set(uid, { uid, event, exceptions: [] });
  }
  for (const component of components.filter(value => value.hasProperty('recurrence-id'))) {
    const parent = series.get(uidOf(component));
    const property = component.getFirstProperty('recurrence-id')!;
    if (!parent?.event.recurrence || property.getParameter('range') || component.hasProperty('rrule')) throw new Error('Unsupported or orphan recurrence exception.');
    const start = readLocalCalendarIcsTime(property, timeValue(property.getFirstValue()), parent.event.timeZone);
    if (start.allDay !== parent.event.allDay || !expandLocalEvent(parent.event, { startMs: start.ms, endMs: start.ms + 1 }, true, budget).some(value => value.startMs === start.ms) || parent.exceptions.some(value => value.originalStartMs === start.ms)) throw new Error('A recurrence exception does not match its series.');
    const event = readEvent(component, calendarId, now, timeZone);
    event.parentEventId = parent.event.id; event.originalStartMs = start.ms;
    parent.event.excludedStarts = [...new Set([...(parent.event.excludedStarts ?? []), start.ms])];
    parent.exceptions.push(event);
  }
  return [...series.values()];
}

function escapeText(value: string): string { return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
function utc(ms: number): string { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function compactDate(date: string): string { return date.replace(/-/g, ''); }
function timed(ms: number, timeZone: string): string {
  return instantToWallClock(ms, timeZone).replace(/[-:]/g, '') + String(new Date(ms).getUTCSeconds()).padStart(2, '0');
}
function dateProperty(name: string, ms: number, event: LocalCalendarEvent, date?: string): string {
  if (event.allDay) return `${name};VALUE=DATE:${compactDate(date ?? dateInTimeZone(ms, event.timeZone))}`;
  // Exact UTC instants preserve the later repeated hour. Only a recurring start
  // needs wall time so later occurrences continue to follow its IANA timezone.
  return event.timeZone === 'UTC' || !event.recurrence || name !== 'DTSTART' ? `${name}:${utc(ms)}` : `${name};TZID=${event.timeZone}:${timed(ms, event.timeZone)}`;
}

/** Fold by UTF-8 octets rather than JS characters, so non-ASCII titles survive. */
function fold(line: string): string {
  const lines: string[] = [];
  let current = '';
  let length = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (length + bytes > 75) { lines.push(current); current = ' '; length = 1; }
    current += character; length += bytes;
  }
  lines.push(current);
  return lines.join('\r\n');
}

export function exportLocalCalendarIcs(calendar: LocalCalendar, rows: Array<{ event: LocalCalendarEvent; uid: string }>, now: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sarv//Inbox Local Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escapeText(calendar.name)}`];
  const masters = new Map(rows.filter(row => !row.event.parentEventId).map(row => [row.event.id, row]));
  for (const row of rows.sort((a, b) => a.event.startMs - b.event.startMs || a.event.id.localeCompare(b.event.id))) {
    const event = row.event;
    if (!event.allDay && event.recurrence && wallClockToInstant(instantToWallClock(event.startMs, event.timeZone), event.timeZone) + event.startMs % 60_000 !== event.startMs) throw new Error('A recurring series starting in the later repeated DST hour cannot be exported without changing its recurrence. Move its start outside that repeated hour, or export individual events.');
    const parent = event.parentEventId ? masters.get(event.parentEventId) : undefined;
    if (event.parentEventId && !parent) throw new Error('Cannot export an orphan calendar exception.');
    lines.push('BEGIN:VEVENT', `UID:${escapeText(parent?.uid ?? row.uid)}`, `DTSTAMP:${utc(now)}`, `LAST-MODIFIED:${utc(event.updatedAt)}`, `SUMMARY:${escapeText(event.title)}`, `DESCRIPTION:${escapeText(event.description)}`, `LOCATION:${escapeText(event.location)}`, `STATUS:${event.status.toUpperCase()}`, `TRANSP:${event.busy ? 'OPAQUE' : 'TRANSPARENT'}`, `X-SARV-TIMEZONE:${event.timeZone}`,
      dateProperty('DTSTART', event.startMs, event, event.startDate), dateProperty('DTEND', event.endMs, event, event.endDate));
    if (parent) lines.push(dateProperty('RECURRENCE-ID', event.originalStartMs!, parent.event));
    if (event.recurrence) {
      const rule = event.recurrence;
      const parts = [`FREQ=${rule.frequency.toUpperCase()}`, `INTERVAL=${rule.interval}`];
      if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
      if (rule.until) parts.push(`UNTIL=${event.allDay ? compactDate(rule.until) : utc(startOfLocalDate(addLocalDays(rule.until, 1), event.timeZone) - 1000)}`);
      if (rule.weekDays) parts.push(`BYDAY=${rule.weekDays.map(day => WEEKDAYS[day]).join(',')}`);
      lines.push(`RRULE:${parts.join(';')}`);
      // Overrides already suppress their original start via RECURRENCE-ID.
      const overridden = new Set(rows.filter(value => value.event.parentEventId === event.id).map(value => value.event.originalStartMs));
      for (const start of event.excludedStarts ?? []) if (!overridden.has(start)) lines.push(dateProperty('EXDATE', start, event));
    }
    if (event.reminderMinutes !== null) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(event.title)}`, `TRIGGER:${event.reminderMinutes ? `-PT${event.reminderMinutes}M` : 'PT0M'}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const text = `${lines.map(fold).join('\r\n')}\r\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES) throw new Error('This calendar is too large to export in one file.');
  return text;
}
