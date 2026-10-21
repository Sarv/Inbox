import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { LocalCalendar, LocalCalendarAvailability, LocalCalendarAvailabilityRequest, LocalCalendarEvent, LocalCalendarEventInput, LocalCalendarOccurrence, LocalCalendarPreferences, LocalCalendarRange, LocalCalendarSnapshot } from '../../src/types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, localWeekDay, validateTimeZone, wallClockToInstant } from '../../src/utils/local-calendar';

import { getCoreDb } from './core-db';
import { exportLocalCalendarIcs, parseLocalCalendarIcs } from './local-calendar-ics';
import { boundedInteger, DAY_MS, defaultPreferences, MAX_OCCURRENCES, textValue, validateEvent, validatePreferences, validateRange } from './local-calendar-model';
import { expandLocalEvent } from './local-calendar-recurrence';

type DatabaseSource = Database.Database | (() => Database.Database);
type EventRow = { id: string; data: string; uid: string };
export interface LocalCalendarReminder { id: string; eventId: string; occurrenceId: string; title: string; startMs: number; timeZone: string }

/** App-level local data uses the encrypted core DB and never requires a mailbox. */
export class LocalCalendarService {
  private initialized: Database.Database | undefined;

  constructor(private readonly source: DatabaseSource = getCoreDb, private readonly clock: () => number = Date.now) {}

  private database(): Database.Database {
    const db = typeof this.source === 'function' ? this.source() : this.source;
    if (this.initialized === db) return db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_calendars (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_calendar_events (id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, parent_id TEXT, original_start INTEGER, uid TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS local_calendar_events_calendar ON local_calendar_events(calendar_id);
      CREATE INDEX IF NOT EXISTS local_calendar_events_parent ON local_calendar_events(parent_id);
      CREATE TABLE IF NOT EXISTS local_calendar_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_calendar_reminders (id TEXT PRIMARY KEY, delivered_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_calendar_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    db.transaction(() => {
      const seeded = db.prepare("SELECT value FROM local_calendar_meta WHERE key = 'initialized'").get();
      if (!seeded) {
        const calendar: LocalCalendar = { id: randomUUID(), name: 'My calendar', color: '#2563eb', provider: 'local', visible: true, blocksAvailability: true, isDefault: true };
        if (!db.prepare('SELECT id FROM local_calendars LIMIT 1').get()) db.prepare('INSERT INTO local_calendars(id, data) VALUES (?, ?)').run(calendar.id, JSON.stringify(calendar));
        db.prepare("INSERT INTO local_calendar_meta(key, value) VALUES ('initialized', '1')").run();
      }
      db.prepare('INSERT OR IGNORE INTO local_calendar_preferences(id, data) VALUES (1, ?)').run(JSON.stringify(defaultPreferences()));
    })();
    this.initialized = db;
    return db;
  }

  private calendars(): LocalCalendar[] {
    return (this.database().prepare('SELECT id, data FROM local_calendars ORDER BY id').all() as Array<{ id: string; data: string }>).map(row => {
      const calendar = JSON.parse(row.data) as LocalCalendar;
      if (!calendar || calendar.id !== row.id || calendar.provider !== 'local' || typeof calendar.visible !== 'boolean' || typeof calendar.blocksAvailability !== 'boolean' || typeof calendar.isDefault !== 'boolean' || typeof calendar.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(calendar.color)) throw new Error('A saved calendar is invalid. Availability could not be checked.');
      textValue(calendar.id, 'saved calendar identifier', 200, true);
      textValue(calendar.name, 'saved calendar name', 100, true);
      return calendar;
    }).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private preferences(): LocalCalendarPreferences {
    const row = this.database().prepare('SELECT data FROM local_calendar_preferences WHERE id = 1').get() as { data: string };
    return validatePreferences(JSON.parse(row.data) as LocalCalendarPreferences);
  }

  getPreferences(): LocalCalendarPreferences { return this.preferences(); }

  getCalendars(): LocalCalendar[] { return this.calendars(); }

  getEvent(id: string): LocalCalendarEvent | undefined {
    textValue(id, 'event identifier', 200, true);
    return this.events().find(event => event.id === id);
  }

  /** Organizer-authoritative replacement, used only by validated incoming invitations. */
  applyInvitationSeries(request: { eventId?: string; uid: string; event: LocalCalendarEventInput; excludedStarts?: number[] }): LocalCalendarEvent {
    this.requireCalendar(request.event?.calendarId);
    textValue(request.uid, 'invitation identifier', 500, true);
    const id = request.eventId ?? randomUUID();
    textValue(id, 'event identifier', 200, true);
    const previous = this.events().find(event => event.id === id);
    if (previous?.parentEventId) throw new Error('An invitation cannot replace a detached occurrence.');
    const event = validateEvent(request.event, id, this.clock());
    const excludedStarts = [...new Set(request.excludedStarts ?? [])];
    if (excludedStarts.length > 2000 || excludedStarts.some(start => !Number.isSafeInteger(start))) throw new Error('Too many or invalid invitation occurrence cancellations.');
    const budget = { remaining: 100_000 };
    for (const start of excludedStarts) if (!event.recurrence || !expandLocalEvent(event, { startMs: start, endMs: start + 1 }, true, budget).some(value => value.startMs === start)) throw new Error('A cancelled occurrence does not belong to this invitation.');
    if (excludedStarts.length) event.excludedStarts = excludedStarts;
    const db = this.database();
    db.transaction(() => {
      db.prepare('DELETE FROM local_calendar_events WHERE id = ? OR parent_id = ?').run(id, id);
      this.writeEvent(event, request.uid);
    })();
    return event;
  }


  private events(): LocalCalendarEvent[] {
    const rows = this.database().prepare('SELECT id, calendar_id, parent_id, original_start, data FROM local_calendar_events LIMIT 10001').all() as Array<{ id: string; calendar_id: string; parent_id: string | null; original_start: number | null; data: string }>;
    if (rows.length > 10_000) throw new Error('Too many saved calendar events to check safely.');
    return rows.map(row => {
      const stored = JSON.parse(row.data) as LocalCalendarEvent;
      if (!stored || stored.id !== row.id || stored.calendarId !== row.calendar_id || (stored.parentEventId ?? null) !== row.parent_id || (stored.originalStartMs ?? null) !== row.original_start || !Number.isSafeInteger(stored.updatedAt)) throw new Error('A saved calendar event is invalid. Availability could not be checked.');
      textValue(stored.id, 'saved event identifier', 200, true);
      // Corruption must fail availability rather than silently discard busy events.
      const event = validateEvent(stored, stored.id, stored.updatedAt);
      if (event.startMs !== stored.startMs || event.endMs !== stored.endMs) throw new Error('A saved all-day event is invalid. Availability could not be checked.');
      if (stored.excludedStarts !== undefined && (!Array.isArray(stored.excludedStarts) || stored.excludedStarts.some(start => !Number.isSafeInteger(start)))) throw new Error('A saved calendar exception is invalid.');
      if (stored.parentEventId && (!Number.isSafeInteger(stored.originalStartMs) || stored.recurrence)) throw new Error('A saved calendar exception is invalid.');
      return { ...event, ...(stored.excludedStarts ? { excludedStarts: stored.excludedStarts } : {}), ...(stored.parentEventId ? { parentEventId: stored.parentEventId, originalStartMs: stored.originalStartMs } : {}) };
    });
  }

  private requireCalendar(id: string): LocalCalendar {
    const calendar = this.calendars().find(value => value.id === id);
    if (!calendar) throw new Error('Calendar not found.');
    return calendar;
  }

  private writeEvent(event: LocalCalendarEvent, uid?: string): void {
    const db = this.database();
    const previous = db.prepare('SELECT uid FROM local_calendar_events WHERE id = ?').get(event.id) as { uid: string } | undefined;
    db.prepare(`INSERT INTO local_calendar_events(id, calendar_id, parent_id, original_start, uid, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id, parent_id=excluded.parent_id, original_start=excluded.original_start, uid=excluded.uid, data=excluded.data`)
      .run(event.id, event.calendarId, event.parentEventId ?? null, event.originalStartMs ?? null, uid ?? previous?.uid ?? `${event.id}@sarvinbox.local`, JSON.stringify(event));
  }

  private occurrences(range: LocalCalendarRange, calendarIds?: Set<string>): LocalCalendarOccurrence[] {
    validateRange(range);
    const budget = { remaining: 100_000 };
    const result = this.events().filter(event => !calendarIds || calendarIds.has(event.calendarId)).flatMap(event => expandLocalEvent(event, range, false, budget));
    if (result.length > MAX_OCCURRENCES) throw new Error('Too many calendar occurrences to check safely. Narrow the date range.');
    return result.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.occurrenceId.localeCompare(b.occurrenceId));
  }

  snapshot(range: LocalCalendarRange): LocalCalendarSnapshot {
    validateRange(range);
    return { calendars: this.calendars(), preferences: this.preferences(), occurrences: this.occurrences(range) };
  }

  saveCalendar(input: Omit<LocalCalendar, 'id' | 'provider'> & { id?: string }): LocalCalendar {
    const calendars = this.calendars();
    if (input.id && !calendars.some(value => value.id === input.id)) throw new Error('Calendar not found.');
    if (!/^#[0-9a-f]{6}$/i.test(input.color) || typeof input.visible !== 'boolean' || typeof input.blocksAvailability !== 'boolean' || typeof input.isDefault !== 'boolean') throw new Error('Invalid calendar settings.');
    const calendar: LocalCalendar = { id: input.id ?? randomUUID(), name: textValue(input.name, 'calendar name', 100, true), color: input.color, provider: 'local', visible: input.visible, blocksAvailability: input.blocksAvailability, isDefault: input.isDefault || calendars.length === 0 };
    const updated = [...calendars.filter(value => value.id !== calendar.id), calendar];
    if (calendar.isDefault) updated.forEach(value => { value.isDefault = value.id === calendar.id; });
    if (!updated.some(value => value.isDefault)) { calendar.isDefault = true; }
    const db = this.database();
    db.transaction(() => { updated.forEach(value => db.prepare('INSERT OR REPLACE INTO local_calendars(id, data) VALUES (?, ?)').run(value.id, JSON.stringify(value))); })();
    return calendar;
  }

  deleteCalendar(id: string): null {
    this.requireCalendar(id);
    const remaining = this.calendars().filter(calendar => calendar.id !== id);
    if (remaining.length && !remaining.some(calendar => calendar.isDefault)) remaining[0]!.isDefault = true;
    const db = this.database();
    db.transaction(() => {
      db.prepare('DELETE FROM local_calendar_events WHERE calendar_id = ? OR parent_id IN (SELECT id FROM local_calendar_events WHERE calendar_id = ?)').run(id, id);
      db.prepare('DELETE FROM local_calendars WHERE id = ?').run(id);
      remaining.forEach(value => db.prepare('UPDATE local_calendars SET data = ? WHERE id = ?').run(JSON.stringify(value), value.id));
    })();
    return null;
  }

  savePreferences(preferences: LocalCalendarPreferences): LocalCalendarPreferences {
    const value = validatePreferences(preferences);
    this.database().prepare('UPDATE local_calendar_preferences SET data = ? WHERE id = 1').run(JSON.stringify(value));
    return value;
  }

  saveEvent(input: LocalCalendarEventInput): LocalCalendarEvent {
    this.requireCalendar(input?.calendarId);
    const events = this.events();
    const selected = input.id ? events.find(event => event.id === input.id) : undefined;
    if (input.id && !selected) throw new Error('Event not found.');
    const master = selected?.parentEventId ? events.find(event => event.id === selected.parentEventId) : selected;
    if (selected?.parentEventId && !master) throw new Error('Recurring event not found.');
    const occurrenceStart = input.occurrenceStartMs ?? selected?.originalStartMs;
    if (input.scope === 'occurrence' && master?.recurrence) {
      if (input.calendarId !== master.calendarId) throw new Error('Move the whole series to change its calendar.');
      if (!Number.isSafeInteger(occurrenceStart) || !expandLocalEvent(master, { startMs: occurrenceStart!, endMs: occurrenceStart! + 1 }, true).some(value => value.startMs === occurrenceStart)) throw new Error('This occurrence does not belong to the series.');
      const existing = events.find(event => event.parentEventId === master.id && event.originalStartMs === occurrenceStart);
      const replacement: LocalCalendarEvent = { ...validateEvent({ ...input, recurrence: undefined }, existing?.id ?? randomUUID(), this.clock()), parentEventId: master.id, originalStartMs: occurrenceStart };
      const updated = { ...master, excludedStarts: [...new Set([...(master.excludedStarts ?? []), occurrenceStart!])], updatedAt: this.clock() };
      const db = this.database();
      db.transaction(() => { this.writeEvent(updated); this.writeEvent(replacement); })();
      return replacement;
    }
    const value = validateEvent(input, master?.id ?? input.id ?? randomUUID(), this.clock());
    if (master && (master.excludedStarts?.length || events.some(event => event.parentEventId === master.id))) {
      const ruleIdentity = (event: LocalCalendarEvent) => event.recurrence ? { ...event.recurrence, ...(event.recurrence.frequency === 'weekly' ? { weekDays: event.recurrence.weekDays ?? [localWeekDay(dateInTimeZone(event.startMs, event.timeZone))] } : {}) } : undefined;
      if (master.startMs !== value.startMs || master.timeZone !== value.timeZone || master.allDay !== value.allDay || JSON.stringify(ruleIdentity(master)) !== JSON.stringify(ruleIdentity(value))) throw new Error('This series has edited or deleted occurrences. Its start, timezone, all-day setting and recurrence cannot be changed together with those exceptions. Edit an individual occurrence or create a new series.');
    }
    if (master?.excludedStarts && value.recurrence) value.excludedStarts = master.excludedStarts;
    const db = this.database();
    db.transaction(() => {
      this.writeEvent(value);
      if (master && !value.recurrence) db.prepare('DELETE FROM local_calendar_events WHERE parent_id = ?').run(master.id);
      else if (master && master.calendarId !== value.calendarId) events.filter(event => event.parentEventId === master.id).forEach(event => this.writeEvent({ ...event, calendarId: value.calendarId, updatedAt: this.clock() }));
    })();
    return value;
  }

  deleteEvent(request: { id: string; scope?: 'series' | 'occurrence'; occurrenceStartMs?: number }): null {
    const events = this.events();
    const selected = events.find(event => event.id === request?.id);
    if (!selected) throw new Error('Event not found.');
    const master = selected.parentEventId ? events.find(event => event.id === selected.parentEventId) : selected;
    if (!master) throw new Error('Recurring event not found.');
    const db = this.database();
    if (request.scope === 'occurrence' && master.recurrence) {
      const start = request.occurrenceStartMs ?? selected.originalStartMs;
      if (!Number.isSafeInteger(start) || !expandLocalEvent(master, { startMs: start!, endMs: start! + 1 }, true).some(value => value.startMs === start)) throw new Error('This occurrence does not belong to the series.');
      db.transaction(() => {
        this.writeEvent({ ...master, excludedStarts: [...new Set([...(master.excludedStarts ?? []), start!])], updatedAt: this.clock() });
        db.prepare('DELETE FROM local_calendar_events WHERE parent_id = ? AND original_start = ?').run(master.id, start!);
      })();
    } else db.transaction(() => { db.prepare('DELETE FROM local_calendar_events WHERE id = ? OR parent_id = ?').run(master.id, master.id); })();
    return null;
  }

  availability(request: LocalCalendarAvailabilityRequest): LocalCalendarAvailability {
    validateRange(request);
    const preferences = this.preferences();
    const timeZone = validateTimeZone(request.timeZone ?? preferences.timeZone);
    const durationMinutes = boundedInteger(request.durationMinutes ?? preferences.durationMinutes, 1, 1440, 'Meeting duration');
    const limit = boundedInteger(request.limit ?? 3, 1, 20, 'Number of slots');
    const calendars = this.calendars().filter(calendar => calendar.blocksAvailability);
    const result: LocalCalendarAvailability = { startMs: request.startMs, endMs: request.endMs, checkedAt: this.clock(), timeZone, durationMinutes, calendarIds: calendars.map(calendar => calendar.id), calendarNames: calendars.map(calendar => calendar.name), scope: 'local-only', status: calendars.length ? 'ready' : 'no_calendars', slots: [] };
    if (!calendars.length) return result;
    const before = preferences.bufferBeforeMinutes * 60_000;
    const after = preferences.bufferAfterMinutes * 60_000;
    // Events just outside the requested window can overlap it through their buffers.
    const busyRange = { startMs: request.startMs - before, endMs: request.endMs + after };
    if (busyRange.endMs - busyRange.startMs > 400 * DAY_MS) throw new Error('Choose a shorter availability range to include meeting buffers.');
    const busy = this.occurrences(busyRange, new Set(calendars.map(calendar => calendar.id))).filter(value => value.event.busy && value.event.status !== 'cancelled');
    const earliest = Math.max(request.startMs, result.checkedAt + preferences.minimumNoticeMinutes * 60_000);
    const firstDate = dateInTimeZone(earliest, preferences.timeZone);
    const finalDate = dateInTimeZone(request.endMs, preferences.timeZone);
    const clockMinutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
    const exact = request.endMs - request.startMs === durationMinutes * 60_000;
    const precise = exact && (request.startMs % 60_000 !== 0 || request.endMs % 60_000 !== 0);
    const label = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(precise ? { second: '2-digit' as const } : {}), timeZoneName: 'short', hourCycle: 'h23' });
    const endLabel = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', ...(precise ? { second: '2-digit' as const } : {}), hourCycle: 'h23' });
    const inWorkingInterval = (startMs: number, endMs: number, localDate: string) => {
      const inWorkingHours = (instant: number) => {
        const wall = instantToWallClock(instant, preferences.timeZone);
        return wall.slice(0, 10) === localDate && wall.slice(11) >= preferences.workingStart && wall.slice(11) < preferences.workingEnd;
      };
      if (!inWorkingHours(startMs) || !inWorkingHours(endMs - 1)) return false;
      // A fall-back transition can leave and re-enter a working window even
      // when both endpoints fit. Working boundaries have minute precision, so
      // probing each minute keeps the complete interval inside working hours.
      for (let instant = Math.ceil(startMs / 60_000) * 60_000; instant < endMs; instant += 60_000) if (!inWorkingHours(instant)) return false;
      return true;
    };
    if (exact) {
      // A user-entered time (or send-time recheck) is an exact instant, not a
      // request to round up to the suggestion grid. Do not reconstruct it from
      // wall time: doing so would lose seconds and the later repeated DST hour.
      const startMs = request.startMs;
      const endMs = request.endMs;
      if (startMs < earliest || busy.some(value => value.startMs < endMs + after && value.endMs > startMs - before)) return result;
      const localDate = dateInTimeZone(startMs, preferences.timeZone);
      if (!preferences.workingDays.includes(localWeekDay(localDate))) return result;
      if (!inWorkingInterval(startMs, endMs, localDate)) return result;
      result.slots.push({ startMs, endMs, label: `${label.format(startMs)} – ${endLabel.format(endMs)}` });
      return result;
    }
    let candidateCount = 0;
    for (let date = firstDate; date <= finalDate && result.slots.length < limit; date = addLocalDays(date, 1)) {
      if (!preferences.workingDays.includes(localWeekDay(date))) continue;
      const workEnd = wallClockToInstant(`${date}T${preferences.workingEnd}`, preferences.timeZone);
      for (let minute = clockMinutes(preferences.workingStart); minute < clockMinutes(preferences.workingEnd); minute += preferences.slotIntervalMinutes) {
        if (++candidateCount > 30_000) throw new Error('Too many possible meeting slots to check safely. Narrow the availability range or increase the slot interval.');
        const wall = `${date}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        let startMs: number;
        try { startMs = wallClockToInstant(wall, preferences.timeZone); }
        catch (error) { if ((error as Error).message.includes('does not exist')) continue; throw error; }
        const endMs = startMs + durationMinutes * 60_000;
        if (startMs < earliest || endMs > request.endMs || endMs > workEnd || busy.some(value => value.startMs < endMs + after && value.endMs > startMs - before) || !inWorkingInterval(startMs, endMs, date)) continue;
        result.slots.push({ startMs, endMs, label: `${label.format(startMs)} – ${endLabel.format(endMs)}` });
        if (result.slots.length >= limit) break;
      }
    }
    return result;
  }

  importIcs(request: { calendarId: string; text: string }): { imported: number } {
    this.requireCalendar(request?.calendarId);
    const parsed = parseLocalCalendarIcs(request.text, request.calendarId, this.clock(), this.preferences().timeZone);
    const db = this.database();
    const previous = db.prepare('SELECT id, uid, data FROM local_calendar_events WHERE calendar_id = ? AND parent_id IS NULL').all(request.calendarId) as EventRow[];
    db.transaction(() => {
      for (const item of parsed) {
        const match = previous.find(event => event.uid === item.uid);
        const masterId = match?.id ?? item.event.id;
        if (match) db.prepare('DELETE FROM local_calendar_events WHERE id = ? OR parent_id = ?').run(masterId, masterId);
        this.writeEvent({ ...item.event, id: masterId }, item.uid);
        item.exceptions.forEach(exception => this.writeEvent({ ...exception, parentEventId: masterId }, item.uid));
      }
    })();
    return { imported: parsed.reduce((total, item) => total + 1 + item.exceptions.length, 0) };
  }

  exportIcs(request: { calendarId: string }): { text: string } {
    const calendar = this.requireCalendar(request?.calendarId);
    const rows = this.database().prepare('SELECT id, uid, data FROM local_calendar_events WHERE calendar_id = ?').all(calendar.id) as EventRow[];
    if (rows.length > 2000) throw new Error('This calendar is too large to export in one file.');
    return { text: exportLocalCalendarIcs(calendar, rows.map(row => ({ event: JSON.parse(row.data) as LocalCalendarEvent, uid: row.uid })), this.clock()) };
  }

  dueReminders(now = this.clock()): LocalCalendarReminder[] {
    if (!Number.isSafeInteger(now)) throw new Error('Invalid reminder time.');
    const range = { startMs: now - 30 * 60_000, endMs: now + 10080 * 60_000 + 1 };
    const db = this.database();
    const reminders: LocalCalendarReminder[] = [];
    for (const occurrence of this.occurrences(range)) {
      const event = occurrence.event;
      if (event.reminderMinutes === null || event.status === 'cancelled' || occurrence.endMs <= now) continue;
      const dueAt = occurrence.startMs - event.reminderMinutes * 60_000;
      if (dueAt > now || dueAt < now - 30 * 60_000) continue;
      const id = `${occurrence.occurrenceId}:${event.reminderMinutes}:${occurrence.startMs}`;
      if (!db.prepare('SELECT id FROM local_calendar_reminders WHERE id = ?').get(id)) reminders.push({ id, eventId: occurrence.eventId, occurrenceId: occurrence.occurrenceId, title: event.title, startMs: occurrence.startMs, timeZone: event.timeZone });
    }
    return reminders;
  }

  markReminderDelivered(id: string): void {
    textValue(id, 'reminder', 500, true);
    this.database().prepare('INSERT OR IGNORE INTO local_calendar_reminders(id, delivered_at) VALUES (?, ?)').run(id, this.clock());
  }
}

let singleton: LocalCalendarService | undefined;
export function getLocalCalendarService(): LocalCalendarService { return singleton ??= new LocalCalendarService(); }
