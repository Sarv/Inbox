import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the isolated calendar fixture database.'); } }));

import { expandLocalEvent } from '../../../../electron/services/local-calendar-recurrence';
import { LocalCalendarService } from '../../../../electron/services/local-calendar-service';
import type { LocalCalendarEventInput, LocalCalendarPreferences } from '../../../../src/types/local-calendar';
import { wallClockToInstant } from '../../../../src/utils/local-calendar';

const at = (text: string) => Date.parse(text.endsWith('Z') ? text : `${text}Z`);
const range = (start = '2026-01-05T00:00', end = '2026-01-10T00:00') => ({ startMs: at(start), endMs: at(end) });
let db: Database.Database;
let service: LocalCalendarService;
let calendarId: string;
let now: number;

function event(overrides: Partial<LocalCalendarEventInput> = {}): LocalCalendarEventInput {
  return { calendarId, title: 'Private meeting', description: 'Confidential financial details', location: 'Private room', startMs: at('2026-01-05T10:00'), endMs: at('2026-01-05T11:00'), timeZone: 'UTC', allDay: false, busy: true, status: 'confirmed', reminderMinutes: null, ...overrides };
}
function preferences(overrides: Partial<LocalCalendarPreferences> = {}): LocalCalendarPreferences {
  return { timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0, slotIntervalMinutes: 30, ...overrides };
}
function ics(events: string[]): string { return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fixture//EN', ...events, 'END:VCALENDAR'].join('\r\n'); }
function vevent(extra: string[] = [], uid = 'fixture-uid'): string {
  return ['BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Imported meeting', 'DTSTART:20260105T100000Z', 'DTEND:20260105T110000Z', ...extra, 'END:VEVENT'].join('\r\n');
}

beforeEach(() => {
  db = new Database(':memory:'); now = at('2026-01-05T08:00'); service = new LocalCalendarService(db, () => now);
  calendarId = service.snapshot(range()).calendars[0]!.id;
  service.savePreferences(preferences());
});
afterEach(() => db.close());

describe('durable local calendar management', () => {
  it('creates one default independently of mail and preserves deletion across restart', () => {
    expect(service.snapshot(range()).calendars).toHaveLength(1);
    service.deleteCalendar(calendarId);
    service = new LocalCalendarService(db, () => now);
    expect(service.snapshot(range()).calendars).toEqual([]);
    expect(service.availability(range()).status).toBe('no_calendars');
  });
  it('persists events, calendars, preferences and reminder receipts in a restarted file DB', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-local-calendar-'));
    const path = join(directory, 'core-fixture.db');
    try {
      let disk = new Database(path);
      let original = new LocalCalendarService(disk, () => now);
      const localId = original.snapshot(range()).calendars[0]!.id;
      original.savePreferences(preferences({ timeZone: 'Asia/Kolkata' }));
      const saved = original.saveEvent(event({ calendarId: localId, reminderMinutes: 120 }));
      const reminder = original.dueReminders(now)[0]!;
      original.markReminderDelivered(reminder.id);
      disk.close(); disk = new Database(path); original = new LocalCalendarService(disk, () => now);
      expect(original.snapshot(range()).occurrences[0]!.event.id).toBe(saved.id);
      expect(original.getPreferences().timeZone).toBe('Asia/Kolkata');
      expect(original.dueReminders(now)).toEqual([]);
      disk.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('moves the default and removes the deleted calendar events', () => {
    const second = service.saveCalendar({ name: 'Personal', color: '#123456', visible: true, blocksAvailability: false, isDefault: true });
    expect(service.snapshot(range()).calendars.find(value => value.id === calendarId)?.isDefault).toBe(false);
    service.saveEvent(event({ calendarId: second.id }));
    service.deleteCalendar(second.id);
    expect(service.snapshot(range()).occurrences).toEqual([]);
    expect(service.snapshot(range()).calendars[0]!.isDefault).toBe(true);
  });
  it('rejects malformed events and unsupported input without changing saved events', () => {
    service.saveEvent(event());
    expect(() => service.saveEvent(event({ endMs: at('2026-01-05T09:00') }))).toThrow();
    expect(() => service.saveEvent(event({ calendarId: 'missing' }))).toThrow('Calendar not found');
    expect(() => service.savePreferences(preferences({ workingEnd: '08:00' }))).toThrow();
    expect(() => service.snapshot({ startMs: 0, endMs: 401 * 86400000 })).toThrow('400 days');
    expect(service.snapshot(range()).occurrences).toHaveLength(1);
  });
});

describe('local recurrence and exceptions', () => {
  it('keeps daily meetings at the same local hour across DST', () => {
    service.saveEvent(event({ timeZone: 'America/New_York', startMs: wallClockToInstant('2026-03-07T09:00', 'America/New_York'), endMs: wallClockToInstant('2026-03-07T10:00', 'America/New_York'), recurrence: { frequency: 'daily', interval: 1, count: 3 } }));
    expect(service.snapshot(range('2026-03-07T00:00', '2026-03-11T00:00')).occurrences.map(value => new Date(value.startMs).toISOString())).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z', '2026-03-09T13:00:00.000Z']);
  });
  it('skips a nonexistent DST recurrence rather than moving the meeting', () => {
    service.saveEvent(event({ timeZone: 'America/New_York', startMs: wallClockToInstant('2026-03-07T02:30', 'America/New_York'), endMs: wallClockToInstant('2026-03-07T03:30', 'America/New_York'), recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    expect(service.snapshot(range('2026-03-07T00:00', '2026-03-11T00:00')).occurrences.map(value => new Date(value.startMs).toISOString())).toEqual(['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
  });
  it('counts weekly weekdays and intervals consistently', () => {
    service.saveEvent(event({ recurrence: { frequency: 'weekly', interval: 2, weekDays: [1, 3], count: 4 } }));
    expect(service.snapshot(range('2026-01-01T00:00', '2026-02-01T00:00')).occurrences.map(value => new Date(value.startMs).toISOString().slice(0, 10))).toEqual(['2026-01-05', '2026-01-07', '2026-01-19', '2026-01-21']);
  });
  it('skips missing month days and respects an inclusive until date', () => {
    service.saveEvent(event({ startMs: at('2026-01-31T10:00'), endMs: at('2026-01-31T11:00'), recurrence: { frequency: 'monthly', interval: 1, until: '2026-05-31' } }));
    expect(service.snapshot(range('2026-01-01T00:00', '2026-07-01T00:00')).occurrences.map(value => new Date(value.startMs).toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });
  it('keeps all-day end dates exclusive through a 23-hour day', () => {
    service.saveEvent(event({ allDay: true, timeZone: 'America/New_York', startDate: '2026-03-08', endDate: '2026-03-09', recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    const occurrences = service.snapshot(range('2026-03-07T00:00', '2026-03-11T00:00')).occurrences;
    expect(occurrences.map(value => (value.endMs - value.startMs) / 3600000)).toEqual([23, 24]);
    expect(occurrences[0]!.event.endDate).toBe('2026-03-09');
  });
  it('keeps all-day recurrence/import working through a midnight transition and skips nonexistent whole dates', () => {
    service.saveEvent(event({ allDay: true, timeZone: 'America/Santiago', startDate: '2026-09-05', endDate: '2026-09-06', recurrence: { frequency: 'daily', interval: 1, count: 3 } }));
    const occurrences = service.snapshot(range('2026-09-04T00:00', '2026-09-09T00:00')).occurrences;
    expect(occurrences).toHaveLength(3);
    expect(occurrences.map(value => (value.endMs - value.startMs) / 3600000)).toEqual([24, 23, 24]);
    expect(service.exportIcs({ calendarId }).text).toContain('DTSTART;VALUE=DATE:20260905');
    expect(() => service.saveEvent(event({ allDay: true, timeZone: 'Pacific/Apia', startDate: '2011-12-30', endDate: '2011-12-31' }))).toThrow('does not exist');
    service.saveEvent(event({ allDay: true, timeZone: 'Pacific/Apia', startDate: '2011-12-29', endDate: '2011-12-30', recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    expect(service.snapshot(range('2011-12-28T00:00', '2012-01-02T00:00')).occurrences.map(value => new Date(value.startMs).toISOString())).toEqual(['2011-12-29T10:00:00.000Z', '2011-12-30T10:00:00.000Z']);
  });
  it('edits and deletes only the chosen instance, retaining the original identity', () => {
    const series = service.saveEvent(event({ recurrence: { frequency: 'daily', interval: 1, count: 3 } }));
    const replacement = service.saveEvent(event({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-01-06T10:00'), title: 'Rescheduled', startMs: at('2026-01-08T12:00'), endMs: at('2026-01-08T13:00') }));
    expect(replacement.parentEventId).toBe(series.id);
    let occurrences = service.snapshot(range()).occurrences;
    expect(occurrences.map(value => value.startMs)).toEqual([at('2026-01-05T10:00'), at('2026-01-07T10:00'), at('2026-01-08T12:00')]);
    expect(occurrences[2]!.eventId).toBe(series.id);
    service.deleteEvent({ id: replacement.id, scope: 'occurrence' });
    occurrences = service.snapshot(range()).occurrences;
    expect(occurrences).toHaveLength(2);
    service.deleteEvent({ id: series.id, scope: 'series' });
    expect(service.snapshot(range()).occurrences).toEqual([]);
  });
  it('moves a series and its overrides together and rejects fake instances', () => {
    const series = service.saveEvent(event({ recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    expect(() => service.deleteEvent({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-02-06T10:00') })).toThrow('does not belong');
    service.saveEvent(event({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-01-06T10:00'), startMs: at('2026-01-06T12:00'), endMs: at('2026-01-06T13:00') }));
    const second = service.saveCalendar({ name: 'Second', color: '#111111', visible: true, blocksAvailability: true, isDefault: false });
    service.saveEvent({ ...series, calendarId: second.id });
    expect(service.snapshot(range()).occurrences.every(value => value.event.calendarId === second.id)).toBe(true);
  });
  it('checks old uncounted series within a bounded window without replaying their history', () => {
    const saved = service.saveEvent(event({ startMs: at('1900-01-01T10:00'), endMs: at('1900-01-01T11:00'), recurrence: { frequency: 'weekly', interval: 2, weekDays: [1, 3] } }));
    const occurrences = expandLocalEvent(saved, range('2026-01-12T00:00', '2026-01-17T00:00'), false, { remaining: 20 });
    expect(occurrences.map(value => new Date(value.startMs).toISOString())).toEqual(['2026-01-12T10:00:00.000Z', '2026-01-14T10:00:00.000Z']);
    expect(service.availability({ startMs: at('2026-01-12T10:00'), endMs: at('2026-01-12T11:00') }).slots).toEqual([]);
  });
  it('does not revive expired COUNT or UNTIL series when querying a later window', () => {
    service.saveEvent(event({ startMs: at('1900-01-01T10:00'), endMs: at('1900-01-01T11:00'), recurrence: { frequency: 'daily', interval: 1, count: 3 } }));
    service.saveEvent(event({ startMs: at('1900-01-01T10:00'), endMs: at('1900-01-01T11:00'), recurrence: { frequency: 'daily', interval: 1, until: '1900-01-03' } }));
    expect(service.snapshot(range()).occurrences).toEqual([]);
  });
  it('retains overlapping long occurrences when fast-forwarding an uncounted series', () => {
    const saved = service.saveEvent(event({ startMs: at('1900-01-01T10:00'), endMs: at('1900-01-06T10:00'), recurrence: { frequency: 'monthly', interval: 1 } }));
    expect(expandLocalEvent(saved, range('2026-01-05T00:00', '2026-01-06T00:00'), false, { remaining: 20 }).map(value => value.startMs)).toEqual([at('2026-01-01T10:00')]);
  });
  it('keeps exceptions intact when rejecting identity-changing series edits, while allowing safe changes', () => {
    const series = service.saveEvent(event({ recurrence: { frequency: 'daily', interval: 1, count: 3 } }));
    service.saveEvent(event({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-01-06T10:00'), startMs: at('2026-01-06T12:00'), endMs: at('2026-01-06T13:00') }));
    const before = service.snapshot(range());
    for (const change of [
      { startMs: at('2026-01-05T11:00'), endMs: at('2026-01-05T12:00') },
      { timeZone: 'Asia/Kolkata' },
      { allDay: true, startDate: '2026-01-05', endDate: '2026-01-06' },
      { recurrence: { frequency: 'daily' as const, interval: 2, count: 3 } },
      { recurrence: undefined },
    ]) {
      expect(() => service.saveEvent({ ...series, ...change })).toThrow('edited or deleted occurrences');
      expect(service.snapshot(range())).toEqual(before);
    }
    service.saveEvent({ ...series, title: 'Updated series', location: 'New room', endMs: at('2026-01-05T11:30') });
    const after = service.snapshot(range()).occurrences;
    expect(after).toHaveLength(3);
    expect(after[0]!.event.title).toBe('Updated series');
    expect(after[1]!.startMs).toBe(at('2026-01-06T12:00'));
    expect(after[1]!.endMs).toBe(at('2026-01-06T13:00'));
    expect(after[2]!.endMs).toBe(at('2026-01-07T11:30'));
  });
});

describe('availability uses local data without disclosing private event content', () => {
  it('checks an exact off-grid meeting without rounding while wider windows keep the suggestion grid', () => {
    service.savePreferences(preferences({ slotIntervalMinutes: 15 }));
    const exact = service.availability({ ...range('2026-01-05T15:10', '2026-01-05T15:40'), durationMinutes: 30 });
    expect(exact.slots).toHaveLength(1);
    expect(exact.slots[0]).toMatchObject({ startMs: at('2026-01-05T15:10'), endMs: at('2026-01-05T15:40') });
    const wider = service.availability({ ...range('2026-01-05T15:10', '2026-01-05T16:10'), durationMinutes: 30 });
    expect(wider.slots[0]!.startMs).toBe(at('2026-01-05T15:15'));
    expect(wider.slots.every(slot => slot.startMs % (15 * 60000) === 0)).toBe(true);
  });
  it('rejects exact off-grid meetings that conflict with busy events or their proposed-meeting buffers', () => {
    const request = { ...range('2026-01-05T15:10', '2026-01-05T15:40'), durationMinutes: 30 };
    const busy = service.saveEvent(event({ startMs: at('2026-01-05T15:30'), endMs: at('2026-01-05T16:00') }));
    expect(service.availability(request).slots).toEqual([]);
    service.saveEvent({ ...busy, startMs: at('2026-01-05T14:45'), endMs: at('2026-01-05T15:05') });
    service.savePreferences(preferences({ bufferBeforeMinutes: 15 }));
    expect(service.availability(request).slots).toEqual([]);
    service.saveEvent({ ...busy, startMs: at('2026-01-05T15:45'), endMs: at('2026-01-05T16:00') });
    service.savePreferences(preferences({ bufferAfterMinutes: 10 }));
    expect(service.availability(request).slots).toEqual([]);
    service.savePreferences(preferences());
    expect(service.availability(request).slots).toHaveLength(1);
  });
  it('rejects exact times outside working hours, on nonworking days, or before minimum notice', () => {
    expect(service.availability(range('2026-01-05T08:55', '2026-01-05T09:25')).slots).toEqual([]);
    expect(service.availability(range('2026-01-05T16:45', '2026-01-05T17:15')).slots).toEqual([]);
    expect(service.availability(range('2026-01-10T15:10', '2026-01-10T15:40')).slots).toEqual([]);
    service.savePreferences(preferences({ minimumNoticeMinutes: 30 }));
    now = at('2026-01-05T15:00');
    expect(service.availability(range('2026-01-05T15:10', '2026-01-05T15:40')).slots).toEqual([]);
  });
  it('preserves exact seconds and the later DST fold while checking working hours in the saved timezone', () => {
    service.savePreferences(preferences({ timeZone: 'America/New_York', workingDays: [0], workingStart: '01:00', workingEnd: '03:00' }));
    const request = { ...range('2026-11-01T06:15:30', '2026-11-01T06:45:30'), durationMinutes: 30, timeZone: 'America/New_York' };
    const available = service.availability(request);
    expect(available.slots).toHaveLength(1);
    expect(available.slots[0]).toMatchObject({ startMs: request.startMs, endMs: request.endMs });
    expect(available.slots[0]!.label).toContain('01:15:30');
    expect(available.slots[0]!.label).toMatch(/EST|GMT-5/);
    service.savePreferences(preferences({ timeZone: 'America/New_York', workingDays: [0], workingStart: '01:30', workingEnd: '03:00' }));
    expect(service.availability(request).slots).toEqual([]);
    expect(service.availability({ ...range('2026-11-01T05:45', '2026-11-01T06:15'), durationMinutes: 30 }).slots).toEqual([]);
  });
  it('keeps every instant of wider-window suggestions inside working hours across fall-back', () => {
    service.savePreferences(preferences({ timeZone: 'America/New_York', workingDays: [0], workingStart: '01:30', workingEnd: '03:00', durationMinutes: 60, slotIntervalMinutes: 30 }));
    const available = service.availability({ ...range('2026-11-01T05:00', '2026-11-01T08:00'), durationMinutes: 60 });
    // First-fold 01:30 -> second-fold 01:30 passes an endpoint-only check but
    // spends half an hour at 01:00–01:29, outside the chosen working hours.
    expect(available.slots.map(slot => ({ startMs: slot.startMs, endMs: slot.endMs }))).toEqual([{ startMs: at('2026-11-01T07:00'), endMs: at('2026-11-01T08:00') }]);
    const slot = available.slots[0]!;
    expect(service.availability({ startMs: slot.startMs, endMs: slot.endMs, durationMinutes: 60 }).slots[0]).toMatchObject({ startMs: slot.startMs, endMs: slot.endMs });
  });
  it('blocks hidden busy calendars, with buffers, and produces three deterministic slots', () => {
    const calendar = service.snapshot(range()).calendars[0]!;
    service.saveCalendar({ ...calendar, visible: false });
    service.savePreferences(preferences({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }));
    service.saveEvent(event());
    const available = service.availability(range('2026-01-05T09:00', '2026-01-05T13:00'));
    expect(available.slots.map(value => value.startMs)).toEqual([at('2026-01-05T09:00'), at('2026-01-05T11:30'), at('2026-01-05T12:00')]);
    expect(JSON.stringify(available)).not.toContain('Private meeting');
    expect(JSON.stringify(available)).not.toContain('Confidential');
    expect(available).toEqual(service.availability(range('2026-01-05T09:00', '2026-01-05T13:00')));
  });
  it('ignores cancelled and transparent events but includes tentative busy meetings', () => {
    service.saveEvent(event({ startMs: at('2026-01-05T09:00'), endMs: at('2026-01-05T09:30'), status: 'cancelled' }));
    service.saveEvent(event({ startMs: at('2026-01-05T09:30'), endMs: at('2026-01-05T10:00'), busy: false }));
    service.saveEvent(event({ startMs: at('2026-01-05T10:00'), endMs: at('2026-01-05T11:00'), status: 'tentative' }));
    expect(service.availability(range('2026-01-05T09:00', '2026-01-05T12:00')).slots.map(value => value.startMs)).toEqual([at('2026-01-05T09:00'), at('2026-01-05T09:30'), at('2026-01-05T11:00')]);
  });
  it('honors working timezone, days, notice and requested display timezone', () => {
    service.savePreferences(preferences({ timeZone: 'Asia/Kolkata', minimumNoticeMinutes: 60 }));
    now = at('2026-01-05T04:00');
    const available = service.availability({ ...range('2026-01-05T00:00', '2026-01-06T00:00'), timeZone: 'America/New_York' });
    expect(available.slots[0]!.startMs).toBe(at('2026-01-05T05:00'));
    expect(available.slots[0]!.label).toMatch(/00:00 (?:EST|GMT-5)/);
    expect(service.availability(range('2026-01-10T00:00', '2026-01-12T00:00')).slots).toEqual([]);
  });
  it('applies asymmetric buffers around the proposed meeting, including busy events outside the range', () => {
    service.saveEvent(event());
    service.savePreferences(preferences({ bufferBeforeMinutes: 15, bufferAfterMinutes: 0, slotIntervalMinutes: 15 }));
    expect(service.availability({ ...range('2026-01-05T09:30', '2026-01-05T10:00'), limit: 1 }).slots[0]!.startMs).toBe(at('2026-01-05T09:30'));
    expect(service.availability({ ...range('2026-01-05T11:00', '2026-01-05T12:00'), limit: 1 }).slots[0]!.startMs).toBe(at('2026-01-05T11:15'));
    service.savePreferences(preferences({ bufferBeforeMinutes: 0, bufferAfterMinutes: 15, slotIntervalMinutes: 15 }));
    expect(service.availability({ ...range('2026-01-05T09:30', '2026-01-05T10:30'), limit: 1 }).slots).toEqual([]);
    expect(service.availability({ ...range('2026-01-05T11:00', '2026-01-05T12:00'), limit: 1 }).slots[0]!.startMs).toBe(at('2026-01-05T11:00'));
    service.saveEvent(event({ startMs: at('2026-01-05T08:30'), endMs: at('2026-01-05T09:00') }));
    service.savePreferences(preferences({ bufferBeforeMinutes: 15, bufferAfterMinutes: 0, slotIntervalMinutes: 15 }));
    expect(service.availability({ ...range('2026-01-05T09:00', '2026-01-05T10:00'), limit: 1 }).slots[0]!.startMs).toBe(at('2026-01-05T09:15'));
  });
  it('returns no_calendars when every calendar is excluded and throws on unreadable data', () => {
    const calendar = service.snapshot(range()).calendars[0]!;
    service.saveCalendar({ ...calendar, blocksAvailability: false });
    expect(service.availability(range())).toMatchObject({ status: 'no_calendars', slots: [] });
    service.saveCalendar({ ...calendar, blocksAvailability: true });
    const saved = service.saveEvent(event());
    db.prepare('UPDATE local_calendar_events SET data = ? WHERE id = ?').run('{invalid', saved.id);
    expect(() => service.availability(range())).toThrow();
  });
  it('rejects malformed persisted calendar settings rather than silently skipping busy data', () => {
    const calendar = service.snapshot(range()).calendars[0]!;
    service.saveEvent(event());
    service.saveCalendar({ name: 'Other calendar', color: '#123456', visible: true, blocksAvailability: true, isDefault: false });
    const corrupt: Partial<typeof calendar> = { ...calendar }; delete corrupt.blocksAvailability;
    db.prepare('UPDATE local_calendars SET data = ? WHERE id = ?').run(JSON.stringify(corrupt), calendar.id);
    expect(() => service.availability(range())).toThrow('saved calendar is invalid');
  });
});

describe('calendar ICS import/export', () => {
  it('imports atomically, updates the same UID and round-trips Unicode fields', () => {
    expect(service.importIcs({ calendarId, text: ics([vevent()]) })).toEqual({ imported: 1 });
    service.importIcs({ calendarId, text: ics([vevent()]) });
    expect(service.snapshot(range()).occurrences).toHaveLength(1);
    const value = service.snapshot(range()).occurrences[0]!.event;
    service.saveEvent({ ...value, title: '会议, café; planning '.repeat(8), description: 'Line one\nSecond; line, slash\\' });
    const exported = service.exportIcs({ calendarId }).text;
    expect(exported.split('\r\n').every(line => Buffer.byteLength(line) <= 75)).toBe(true);
    const second = service.saveCalendar({ name: 'Imported copy', color: '#123456', visible: true, blocksAvailability: true, isDefault: false });
    service.importIcs({ calendarId: second.id, text: exported });
    const copied = service.snapshot(range()).occurrences.find(item => item.event.calendarId === second.id)!.event;
    expect(copied.title).toBe('会议, café; planning '.repeat(8).trim());
    expect(copied.description).toBe('Line one\nSecond; line, slash\\');
  });
  it('round-trips recurrence deletion and moved occurrence exceptions', () => {
    const series = service.saveEvent(event({ recurrence: { frequency: 'daily', interval: 1, count: 4 }, reminderMinutes: 15 }));
    service.deleteEvent({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-01-06T10:00') });
    service.saveEvent(event({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-01-07T10:00'), startMs: at('2026-01-07T12:00'), endMs: at('2026-01-07T13:00') }));
    const text = service.exportIcs({ calendarId }).text;
    expect(text).toContain('EXDATE:20260106T100000Z');
    expect(text).toContain('RECURRENCE-ID:20260107T100000Z');
    const other = service.saveCalendar({ name: 'Round trip', color: '#111111', visible: true, blocksAvailability: true, isDefault: false });
    service.importIcs({ calendarId: other.id, text });
    const occurrences = service.snapshot(range()).occurrences.filter(item => item.event.calendarId === other.id);
    expect(occurrences.map(item => item.startMs)).toEqual([at('2026-01-05T10:00'), at('2026-01-07T12:00'), at('2026-01-08T10:00')]);
  });
  it('imports IANA timezones without relying on machine timezone or ICAL global timezone registration', () => {
    const text = ics([['BEGIN:VEVENT', 'UID:ny-dst', 'SUMMARY:DST', 'DTSTART;TZID=America/New_York:20260307T090000', 'DTEND;TZID=America/New_York:20260307T100000', 'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT'].join('\r\n')]);
    service.importIcs({ calendarId, text });
    expect(service.snapshot(range('2026-03-07T00:00', '2026-03-11T00:00')).occurrences.map(item => item.startMs)).toEqual([at('2026-03-07T14:00'), at('2026-03-08T13:00'), at('2026-03-09T13:00')]);
    expect(service.exportIcs({ calendarId }).text).toContain('DTSTART;TZID=America/New_York:20260307T090000');
  });
  it('keeps all-day DATE values exclusive on import and export', () => {
    service.importIcs({ calendarId, text: ics([['BEGIN:VEVENT', 'UID:allday', 'SUMMARY:Day off', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260107', 'END:VEVENT'].join('\r\n')]) });
    expect(service.snapshot(range()).occurrences[0]!.event).toMatchObject({ allDay: true, startDate: '2026-01-05', endDate: '2026-01-07' });
    expect(service.exportIcs({ calendarId }).text).toContain('DTEND;VALUE=DATE:20260107');
  });
  it('preserves exact later-fold instants and duration on ICS round-trip', () => {
    const original = service.saveEvent(event({ timeZone: 'America/New_York', startMs: at('2026-11-01T06:30'), endMs: at('2026-11-01T07:30') }));
    const text = service.exportIcs({ calendarId }).text;
    expect(text).toContain('DTSTART:20261101T063000Z');
    expect(text).toContain('DTEND:20261101T073000Z');
    const other = service.saveCalendar({ name: 'Fold copy', color: '#111111', visible: true, blocksAvailability: true, isDefault: false });
    service.importIcs({ calendarId: other.id, text });
    const copied = service.snapshot(range('2026-11-01T00:00', '2026-11-02T00:00')).occurrences.find(value => value.event.calendarId === other.id)!.event;
    expect(copied).toMatchObject({ startMs: original.startMs, endMs: original.endMs, timeZone: original.timeZone });
  });
  it('fails explicitly for a recurring start in the later fold instead of exporting a changed series', () => {
    service.saveEvent(event({ timeZone: 'America/New_York', startMs: at('2026-11-01T06:30'), endMs: at('2026-11-01T07:30'), recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    expect(() => service.exportIcs({ calendarId })).toThrow('later repeated DST hour');
    expect(service.snapshot(range('2026-11-01T00:00', '2026-11-03T00:00')).occurrences).toHaveLength(2);
  });
  it.each(['RRULE:FREQ=YEARLY', 'RRULE:FREQ=MONTHLY;BYDAY=1MO', 'RRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU', 'RDATE:20260106T100000Z'])('rejects unsupported %s atomically', rule => {
    expect(() => service.importIcs({ calendarId, text: ics([vevent([], 'valid'), vevent([rule], 'invalid')]) })).toThrow();
    expect(service.snapshot(range()).occurrences).toEqual([]);
  });
  it('rejects unknown timezone, floating timed events and orphan recurrence exceptions', () => {
    expect(() => service.importIcs({ calendarId, text: ics([vevent().replace('DTSTART:20260105T100000Z', 'DTSTART;TZID=Custom/Unknown:20260105T100000')]) })).toThrow('Unsupported timezone');
    expect(() => service.importIcs({ calendarId, text: ics([vevent().replace('DTSTART:20260105T100000Z', 'DTSTART:20260105T100000')]) })).toThrow('Floating');
    expect(() => service.importIcs({ calendarId, text: ics([vevent(['RECURRENCE-ID:20260105T100000Z'])]) })).toThrow('orphan');
    expect(service.snapshot(range()).occurrences).toEqual([]);
  });
});

describe('durable reminders', () => {
  it('delivers only due reminders within thirty minutes and never repeats a recorded delivery', () => {
    service.saveEvent(event({ reminderMinutes: 15, recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    now = at('2026-01-05T09:40'); expect(service.dueReminders()).toEqual([]);
    now = at('2026-01-05T09:50');
    const due = service.dueReminders(); expect(due).toHaveLength(1);
    expect(due[0]!.occurrenceId).toContain(String(at('2026-01-05T10:00')));
    service.markReminderDelivered(due[0]!.id);
    service = new LocalCalendarService(db, () => now);
    expect(service.dueReminders()).toEqual([]);
    now = at('2026-01-06T09:50'); expect(service.dueReminders()).toHaveLength(1);
  });
  it('does not notify cancelled, expired or stale catch-up events', () => {
    service.saveEvent(event({ reminderMinutes: 15, status: 'cancelled' }));
    service.saveEvent(event({ reminderMinutes: 120 }));
    now = at('2026-01-05T09:50'); expect(service.dueReminders()).toEqual([]);
    now = at('2026-01-05T12:00'); expect(service.dueReminders()).toEqual([]);
  });
  it('reminds again after an instance is moved, while title changes do not repeat delivered reminders', () => {
    const series = service.saveEvent(event({ reminderMinutes: 15, recurrence: { frequency: 'daily', interval: 1, count: 2 } }));
    now = at('2026-01-06T09:50');
    service.markReminderDelivered(service.dueReminders()[0]!.id);
    service.saveEvent({ ...series, title: 'New title' });
    expect(service.dueReminders()).toEqual([]);
    service.saveEvent(event({ id: series.id, scope: 'occurrence', occurrenceStartMs: at('2026-01-06T10:00'), startMs: at('2026-01-06T12:00'), endMs: at('2026-01-06T13:00'), reminderMinutes: 15 }));
    now = at('2026-01-06T11:50');
    expect(service.dueReminders()).toHaveLength(1);
    expect(service.dueReminders()[0]!.startMs).toBe(at('2026-01-06T12:00'));
    expect(service.dueReminders()[0]!.occurrenceId).toBe(`${series.id}:${at('2026-01-06T10:00')}`);
  });
});
