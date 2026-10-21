import { createHash, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import ICAL from 'ical.js';

import type { LocalCalendarInvitation, LocalCalendarInvitationEmailRequest, LocalCalendarInvitationIngestInput, LocalCalendarInvitationIngestResult, LocalCalendarInvitationParticipation, LocalCalendarInvitationResponse, LocalCalendarInvitationResponseRequest, LocalCalendarPreparedInvitationResponse } from '../../src/types/calendar-invitations';
import type { LocalCalendarEvent } from '../../src/types/local-calendar';
import { addLocalDays, localDateDifference, startOfLocalDate, validLocalDate, validateTimeZone } from '../../src/utils/local-calendar';

import { getCoreDb } from './core-db';
import { parseLocalCalendarIcs } from './local-calendar-ics';
import { CalendarInvitationValidationError, invitationEmailAddress, parseIncomingCalendarInvitation, type ParsedIncomingCalendarInvitation } from './local-calendar-invitation-parser';
import { expandLocalEvent } from './local-calendar-recurrence';
import { LocalCalendarService } from './local-calendar-service';

export { CalendarInvitationValidationError } from './local-calendar-invitation-parser';
type DatabaseSource = Database.Database | (() => Database.Database);
interface Revision { sequence: number; dtstampMs: number }
interface StoredInvitation extends Revision {
  id: string; accountId: string; accountEmail: string; organizer: string; organizerName?: string; uid: string;
  eventId?: string; calendarId?: string; title: string; response: LocalCalendarInvitationParticipation;
  seriesCancelled: boolean; versionToken: string; deliveryToken?: string; fingerprint: string; replyTemplate: string; replyTimeZone?: string;
  method: 'REQUEST' | 'CANCEL' | null;
}
interface InvitationRow { id: string; account_id: string; organizer: string; uid: string; data: string }
interface SourceRow { invitation_id: string; original_start: number | null }
interface OccurrenceRow { original_start: number; original_date: string | null; sequence: number; dtstamp_ms: number; fingerprint: string }
const responses: LocalCalendarInvitationResponse[] = ['accepted', 'tentative', 'declined'];
const compare = (a: Revision, b: Revision) => a.sequence - b.sequence || a.dtstampMs - b.dtstampMs;
const validIdentifier = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\r\n]/.test(value) || value.includes('\u0000')) throw new CalendarInvitationValidationError(`Invalid invitation ${label}.`);
  return value;
};

/** Local-only iTIP state and calendar projection, in the encrypted app core DB. */
export class LocalCalendarInvitationService {
  private initialized: Database.Database | undefined;
  private readonly calendar: LocalCalendarService;
  constructor(private readonly source: DatabaseSource = getCoreDb, private readonly clock: () => number = Date.now) {
    this.calendar = new LocalCalendarService(source, clock);
  }

  private database(): Database.Database {
    const db = typeof this.source === 'function' ? this.source() : this.source;
    if (this.initialized === db) return db;
    // Initialize calendar tables on this same connection before nested atomic writes.
    this.calendar.getCalendars();
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_calendar_invitations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, organizer TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(account_id, organizer, uid));
      CREATE TABLE IF NOT EXISTS local_calendar_invitation_emails (account_id TEXT NOT NULL, email_id TEXT NOT NULL, invitation_id TEXT NOT NULL, original_start INTEGER, PRIMARY KEY(account_id, email_id));
      CREATE INDEX IF NOT EXISTS local_calendar_invitation_source ON local_calendar_invitation_emails(invitation_id);
      CREATE TABLE IF NOT EXISTS local_calendar_invitation_cancellations (invitation_id TEXT NOT NULL, original_start INTEGER NOT NULL, original_date TEXT, sequence INTEGER NOT NULL, dtstamp_ms INTEGER NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(invitation_id, original_start));
    `);
    const cancellationColumns = db.prepare('PRAGMA table_info(local_calendar_invitation_cancellations)').all() as Array<{ name: string }>;
    if (!cancellationColumns.some(column => column.name === 'original_date')) db.exec('ALTER TABLE local_calendar_invitation_cancellations ADD COLUMN original_date TEXT');
    this.initialized = db; return db;
  }

  private decode(row: InvitationRow | undefined): StoredInvitation | undefined {
    if (!row) return undefined;
    let value: StoredInvitation;
    try { value = JSON.parse(row.data) as StoredInvitation; } catch { throw new Error('Saved invitation data could not be read.'); }
    if (!value || value.id !== row.id || value.accountId !== row.account_id || value.organizer !== row.organizer || value.uid !== row.uid || !Number.isSafeInteger(value.sequence) || value.sequence < -1 || !Number.isSafeInteger(value.dtstampMs) || typeof value.seriesCancelled !== 'boolean' || typeof value.versionToken !== 'string' || !value.versionToken || typeof value.replyTemplate !== 'string' || typeof value.fingerprint !== 'string' || typeof value.title !== 'string' || !['needs-action', ...responses].includes(value.response) || !['REQUEST', 'CANCEL', null].includes(value.method)) throw new Error('Saved invitation data is invalid.');
    try {
      validIdentifier(value.id, 'identifier'); validIdentifier(value.accountId, 'account'); validIdentifier(value.uid, 'UID');
      if (invitationEmailAddress(value.organizer) !== value.organizer || invitationEmailAddress(value.accountEmail) !== value.accountEmail || value.sequence > 2_147_483_647 || value.dtstampMs < 0 || value.title.length > 300 || value.replyTemplate.length > 256 * 1024) throw new Error('Invalid saved identity.');
      if (value.deliveryToken !== undefined) validIdentifier(value.deliveryToken, 'response delivery token');
      if (value.eventId !== undefined) validIdentifier(value.eventId, 'event');
      if (value.calendarId !== undefined) validIdentifier(value.calendarId, 'calendar');
      if (value.replyTimeZone !== undefined) validateTimeZone(value.replyTimeZone);
    } catch { throw new Error('Saved invitation identity is invalid.'); }
    return value;
  }

  private byId(id: string): StoredInvitation | undefined { return this.decode(this.database().prepare('SELECT * FROM local_calendar_invitations WHERE id = ?').get(id) as InvitationRow | undefined); }
  private write(value: StoredInvitation): void {
    this.database().prepare('INSERT INTO local_calendar_invitations(id, account_id, organizer, uid, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, value.accountId, value.organizer, value.uid, JSON.stringify(value));
  }
  private linkedEvent(value: StoredInvitation): LocalCalendarEvent | undefined {
    if (!value.eventId) return undefined;
    const event = this.calendar.getEvent(value.eventId);
    const stored = this.database().prepare('SELECT uid FROM local_calendar_events WHERE id = ?').get(value.eventId) as { uid: string } | undefined;
    if (stored && stored.uid !== qualifiedUid(value)) throw new Error('The saved invitation points to a different calendar event.');
    return event;
  }
  private occurrences(id: string): OccurrenceRow[] {
    const rows = this.database().prepare('SELECT original_start, original_date, sequence, dtstamp_ms, fingerprint FROM local_calendar_invitation_cancellations WHERE invitation_id = ? LIMIT 2001').all(id) as OccurrenceRow[];
    if (rows.length > 2000 || rows.some(row => !Number.isSafeInteger(row.original_start) || (row.original_date !== null && !validLocalDate(row.original_date)) || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || !Number.isSafeInteger(row.dtstamp_ms))) throw new Error('Saved recurring invitation cancellations are invalid.');
    return rows;
  }
  private metadata(value: StoredInvitation, originalStart?: number): LocalCalendarInvitation {
    const event = this.linkedEvent(value);
    const cancellation = originalStart === undefined ? undefined : this.occurrences(value.id).find(row => row.original_start === originalStart);
    const actualStart = cancellation?.original_date && event?.allDay ? startOfLocalDate(cancellation.original_date, event.timeZone) : originalStart;
    const actualEnd = actualStart === undefined || !event ? event?.endMs : cancellation?.original_date && event.allDay ? startOfLocalDate(addLocalDays(cancellation.original_date, localDateDifference(event.startDate!, event.endDate!)), event.timeZone) : actualStart + event.endMs - event.startMs;
    return { id: value.id, accountId: value.accountId, accountEmail: value.accountEmail, uid: value.uid, organizer: value.organizer, ...(value.organizerName ? { organizerName: value.organizerName } : {}),
      ...(event ? { eventId: event.id, calendarId: event.calendarId, startMs: actualStart ?? event.startMs, endMs: actualEnd!, timeZone: event.timeZone, allDay: event.allDay } : {}),
      title: event?.title ?? value.title, recurrence: !!event?.recurrence || originalStart !== undefined, response: value.response, cancelled: value.seriesCancelled || !!cancellation,
      sequence: cancellation?.sequence ?? Math.max(0, value.sequence), dtstampMs: cancellation?.dtstamp_ms ?? value.dtstampMs, versionToken: value.versionToken, ...(originalStart === undefined ? {} : { occurrenceStartMs: actualStart }) };
  }

  lookup(request: LocalCalendarInvitationEmailRequest): LocalCalendarInvitation | null {
    validIdentifier(request?.accountId, 'account'); validIdentifier(request?.emailId, 'email');
    const row = this.database().prepare('SELECT invitation_id, original_start FROM local_calendar_invitation_emails WHERE account_id = ? AND email_id = ?').get(request.accountId, request.emailId) as SourceRow | undefined;
    if (!row) return null;
    if (row.original_start !== null && !Number.isSafeInteger(row.original_start)) throw new Error('The saved invitation occurrence link is invalid.');
    const value = this.byId(row.invitation_id);
    if (!value || value.accountId !== request.accountId) throw new Error('The saved invitation link is invalid.');
    return this.metadata(value, row.original_start ?? undefined);
  }

  ingest(input: LocalCalendarInvitationIngestInput): LocalCalendarInvitationIngestResult {
    validIdentifier(input?.accountId, 'account'); validIdentifier(input?.emailId, 'email');
    const calendars = this.calendar.getCalendars();
    const preferences = this.calendar.getPreferences();
    const preferredCalendar = calendars.find(value => value.isDefault) ?? calendars[0];
    const parsed = parseIncomingCalendarInvitation({ ...input, calendarId: preferredCalendar?.id ?? 'pending-invitation', timeZone: preferences.timeZone, now: this.clock() });
    const db = this.database();
    let current = this.decode(db.prepare('SELECT * FROM local_calendar_invitations WHERE account_id = ? AND organizer = ? AND uid = ?').get(input.accountId, parsed.organizer, parsed.uid) as InvitationRow | undefined);
    if (current && current.accountEmail !== parsed.accountEmail) throw new CalendarInvitationValidationError('This account identity has changed. Reconnect the original invitation account.');
    if (!parsed.addressed && !current) throw new CalendarInvitationValidationError('An unknown cancellation must identify this account as an attendee.');
    const source = db.prepare('SELECT invitation_id, original_start FROM local_calendar_invitation_emails WHERE account_id = ? AND email_id = ?').get(input.accountId, input.emailId) as SourceRow | undefined;
    const existingEvent = current ? this.linkedEvent(current) : undefined;
    // DATE recurrence identifiers use the invitation series' own zone, never the display zone.
    const invitation = parsed.recurrenceStartMs !== undefined && existingEvent && existingEvent.timeZone !== preferences.timeZone
      ? parseIncomingCalendarInvitation({ ...input, calendarId: existingEvent.calendarId, timeZone: existingEvent.timeZone, now: this.clock() }) : parsed;
    const sourceStart = current && invitation.recurrenceDate ? this.occurrences(current.id).find(row => row.original_date === invitation.recurrenceDate)?.original_start ?? invitation.recurrenceStartMs : invitation.recurrenceStartMs;
    if (source && (source.invitation_id !== current?.id || (source.original_start ?? undefined) !== sourceStart)) throw new CalendarInvitationValidationError('A saved email cannot change its invitation identity.');
    current ??= { id: randomUUID(), accountId: input.accountId, accountEmail: invitation.accountEmail, organizer: invitation.organizer, ...(invitation.organizerName ? { organizerName: invitation.organizerName } : {}), uid: invitation.uid, title: invitation.event?.title ?? 'Meeting invitation', response: 'needs-action', seriesCancelled: false, sequence: -1, dtstampMs: 0, versionToken: randomUUID(), fingerprint: '', replyTemplate: '', method: null };
    return db.transaction(() => {
      let status: LocalCalendarInvitationIngestResult['status'];
      let event: LocalCalendarEvent | undefined;
      if (invitation.recurrenceStartMs !== undefined) ({ status, event } = this.cancelOccurrence(current!, invitation, sourceStart!));
      else ({ status, event } = this.applyMaster(current!, invitation, existingEvent, preferredCalendar?.id));
      this.write(current!);
      db.prepare('INSERT OR IGNORE INTO local_calendar_invitation_emails(account_id, email_id, invitation_id, original_start) VALUES (?, ?, ?, ?)').run(input.accountId, input.emailId, current!.id, sourceStart ?? null);
      return { status, invitation: this.metadata(current!, sourceStart), ...(event ? { event } : {}) };
    })();
  }

  private cancelOccurrence(current: StoredInvitation, incoming: ParsedIncomingCalendarInvitation, storageStart: number): { status: LocalCalendarInvitationIngestResult['status']; event?: LocalCalendarEvent } {
    const start = incoming.recurrenceStartMs!;
    const cancellations = this.occurrences(current.id);
    const previous = cancellations.find(value => value.original_start === storageStart);
    const revision = previous ? { sequence: previous.sequence, dtstampMs: previous.dtstamp_ms } : undefined;
    if (current.seriesCancelled || compare(incoming, current) < 0 || (revision && compare(incoming, revision) < 0)) return { status: 'stale' };
    if (revision && compare(incoming, revision) === 0) return { status: previous!.fingerprint === incoming.fingerprint ? 'unchanged' : 'stale' };
    const event = this.linkedEvent(current);
    if (event && (!event.recurrence || !expandLocalEvent(event, { startMs: start, endMs: start + 1 }, true).some(value => value.startMs === start))) throw new CalendarInvitationValidationError('The cancelled occurrence does not belong to this recurring invitation.');
    if (!previous && cancellations.length >= 2000) throw new CalendarInvitationValidationError('This invitation has too many cancelled occurrences.');
    if (event) this.calendar.deleteEvent({ id: event.id, scope: 'occurrence', occurrenceStartMs: start });
    this.database().prepare('INSERT INTO local_calendar_invitation_cancellations(invitation_id, original_start, original_date, sequence, dtstamp_ms, fingerprint) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(invitation_id, original_start) DO UPDATE SET original_date=excluded.original_date, sequence=excluded.sequence, dtstamp_ms=excluded.dtstamp_ms, fingerprint=excluded.fingerprint').run(current.id, storageStart, incoming.recurrenceDate ?? null, incoming.sequence, incoming.dtstampMs, incoming.fingerprint);
    current.versionToken = randomUUID();
    return { status: 'cancelled', ...(event ? { event: this.calendar.getEvent(event.id)! } : {}) };
  }

  private applyMaster(current: StoredInvitation, incoming: ParsedIncomingCalendarInvitation, existingEvent: LocalCalendarEvent | undefined, preferredCalendarId: string | undefined): { status: LocalCalendarInvitationIngestResult['status']; event?: LocalCalendarEvent } {
    const order = compare(incoming, current);
    if (order < 0 || (order === 0 && current.method === 'CANCEL' && incoming.method !== 'CANCEL')) return { status: 'stale' };
    if (order === 0 && (incoming.method !== 'CANCEL' || current.method === 'CANCEL')) return { status: incoming.fingerprint === current.fingerprint ? 'unchanged' : 'stale' };
    let event: LocalCalendarEvent | undefined;
    const hadEvent = !!current.eventId;
    if (incoming.method === 'CANCEL') {
      if (existingEvent) event = this.calendar.saveEvent({ ...existingEvent, scope: 'series', status: 'cancelled', busy: false });
      current.seriesCancelled = true;
    } else {
      const calendarId = existingEvent?.calendarId ?? calendarsContain(this.calendar, current.calendarId) ?? preferredCalendarId;
      if (!calendarId) throw new Error('Create a local calendar before adding meeting invitations.');
      const value = incoming.event!;
      if (incoming.sequence > current.sequence && current.replyTemplate && scheduleIdentity(this.scheduledEvent(current)) !== scheduleIdentity(value)) current.response = 'needs-action';
      const excludedStarts = this.occurrences(current.id).filter(row => compare({ sequence: row.sequence, dtstampMs: row.dtstamp_ms }, incoming) >= 0)
        .map(row => row.original_date && value.allDay ? startOfLocalDate(row.original_date, value.timeZone) : row.original_start)
        .filter(start => value.recurrence && expandLocalEvent(value, { startMs: start, endMs: start + 1 }, true).some(item => item.startMs === start));
      event = this.calendar.applyInvitationSeries({ eventId: current.eventId, uid: qualifiedUid(current), event: { ...value, calendarId, ...participationState(current.response) }, excludedStarts });
      current.eventId = event.id; current.calendarId = event.calendarId; current.title = event.title; current.seriesCancelled = false; current.replyTemplate = incoming.replyTemplate; current.replyTimeZone = value.timeZone;
    }
    current.sequence = incoming.sequence; current.dtstampMs = incoming.dtstampMs; current.method = incoming.method; current.fingerprint = incoming.fingerprint; current.versionToken = randomUUID();
    if (incoming.organizerName) current.organizerName = incoming.organizerName;
    return { status: incoming.method === 'CANCEL' ? 'cancelled' : hadEvent ? 'updated' : 'added', ...(event ? { event } : {}) };
  }

  private scheduledEvent(current: StoredInvitation): LocalCalendarEvent {
    const root = new ICAL.Component(['vcalendar', [], []]);
    root.updatePropertyWithValue('version', '2.0'); root.updatePropertyWithValue('method', 'PUBLISH');
    root.addSubcomponent(new ICAL.Component(ICAL.parse(current.replyTemplate)));
    return parseLocalCalendarIcs(root.toString(), current.calendarId ?? 'invitation', this.clock(), current.replyTimeZone ?? 'UTC')[0]!.event;
  }

  /** A newer explicit decision supersedes older queued choices of the same organizer revision. */
  reserveResponseDelivery(request: { invitationId: string; versionToken: string }): string {
    validIdentifier(request?.invitationId, 'identifier'); validIdentifier(request?.versionToken, 'version');
    const db = this.database();
    return db.transaction(() => {
      const current = this.byId(request.invitationId);
      if (!current || current.versionToken !== request.versionToken || current.seriesCancelled || current.method !== 'REQUEST' || !this.linkedEvent(current)) throw new CalendarInvitationValidationError('The invitation changed before this RSVP could be prepared. Review its latest details.');
      const token = randomUUID();
      current.deliveryToken = token; this.write(current);
      return token;
    })();
  }

  /** Recheck durable RSVP intent immediately before SMTP, including after an offline retry. */
  assertResponseDelivery(request: { accountId: string; invitationId: string; sequence: number; dtstampMs: number; deliveryToken: string; organizer: string; accountEmail?: string }): void {
    validIdentifier(request?.accountId, 'account'); validIdentifier(request?.invitationId, 'identifier'); validIdentifier(request?.deliveryToken, 'response delivery token');
    if (!Number.isSafeInteger(request.sequence) || request.sequence < 0 || request.sequence > 2_147_483_647 || !Number.isSafeInteger(request.dtstampMs) || request.dtstampMs < 0) throw new CalendarInvitationValidationError('The queued RSVP has invalid invitation version information. Review the latest invitation before responding again.');
    const current = this.byId(request.invitationId);
    if (!current || current.accountId !== request.accountId) throw new CalendarInvitationValidationError('The queued RSVP does not belong to this account. Review the latest invitation before responding again.');
    if (current.deliveryToken !== request.deliveryToken) throw new CalendarInvitationValidationError('A newer RSVP choice replaced this queued response. Review the latest invitation if you want to respond again.');
    let organizer: string;
    let accountEmail: string | undefined;
    try { organizer = invitationEmailAddress(request.organizer); accountEmail = request.accountEmail === undefined ? undefined : invitationEmailAddress(request.accountEmail); }
    catch { throw new CalendarInvitationValidationError('The queued RSVP sender or organizer identity is invalid.'); }
    if (organizer !== current.organizer || (accountEmail !== undefined && accountEmail !== current.accountEmail)) throw new CalendarInvitationValidationError('The RSVP sender or organizer has changed. Review the latest invitation before responding again.');
    if (current.seriesCancelled || current.method !== 'REQUEST' || current.sequence !== request.sequence || current.dtstampMs !== request.dtstampMs || !this.linkedEvent(current)) throw new CalendarInvitationValidationError('The invitation changed or was cancelled before this RSVP could send. Review its latest details and respond again.');
    const template = new ICAL.Component(ICAL.parse(current.replyTemplate));
    const attendees = template.getAllProperties('attendee').filter(property => {
      const value = property.getFirstValue();
      if (typeof value !== 'string' || !/^mailto:/i.test(value)) return false;
      return invitationEmailAddress(value.slice(7)) === current.accountEmail;
    });
    if (attendees.length !== 1) throw new CalendarInvitationValidationError('The RSVP recipient no longer matches this invitation. Review its latest details.');
  }

  prepareResponse(request: LocalCalendarInvitationResponseRequest): LocalCalendarPreparedInvitationResponse {
    if (!responses.includes(request?.response)) throw new CalendarInvitationValidationError('Choose Accept, Tentative or Decline.');
    const metadata = this.lookup(request);
    if (!metadata) throw new CalendarInvitationValidationError('This email has no linked meeting invitation.');
    const current = this.byId(metadata.id)!;
    if (metadata.cancelled || metadata.occurrenceStartMs !== undefined || !metadata.eventId || !current.replyTemplate) throw new CalendarInvitationValidationError('This meeting is cancelled or unavailable and cannot receive an RSVP.');
    const template = new ICAL.Component(ICAL.parse(current.replyTemplate));
    const reply = new ICAL.Component(['vcalendar', [], []]);
    reply.updatePropertyWithValue('version', '2.0'); reply.updatePropertyWithValue('prodid', '-//Sarv//Inbox//EN'); reply.updatePropertyWithValue('method', 'REPLY');
    const scheduled = this.scheduledEvent(current);
    const component = new ICAL.Component('vevent');
    for (const name of ['uid', 'summary', 'location']) for (const property of template.getAllProperties(name)) component.addProperty(new ICAL.Property(property.toJSON()));
    // A whole-series REPLY identifies an existing schedule by UID; it does not
    // redefine RRULE. Exact UTC times therefore need no VTIMEZONE component.
    const dateTime = (ms: number, date?: string) => scheduled.allDay ? ICAL.Time.fromDateString(date!) : ICAL.Time.fromJSDate(new Date(ms), true);
    component.updatePropertyWithValue('dtstart', dateTime(scheduled.startMs, scheduled.startDate));
    component.updatePropertyWithValue('dtend', dateTime(scheduled.endMs, scheduled.endDate));
    component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(this.clock()), true));
    component.updatePropertyWithValue('sequence', current.sequence);
    component.updatePropertyWithValue('organizer', `mailto:${current.organizer}`);
    const attendee = new ICAL.Property('attendee'); attendee.setValue(`mailto:${current.accountEmail}`); attendee.setParameter('partstat', request.response.toUpperCase()); attendee.setParameter('rsvp', 'FALSE'); component.addProperty(attendee);
    reply.addSubcomponent(component);
    const title = current.title.replace(/[\r\n]+/g, ' ');
    return { invitation: metadata, invitationId: current.id, accountId: current.accountId, accountEmail: current.accountEmail, organizer: current.organizer, subject: `${request.response === 'accepted' ? 'Accepted' : request.response === 'declined' ? 'Declined' : 'Tentative'}: ${title}`, replyIcs: `${reply.toString()}\r\n`, response: request.response, versionToken: current.versionToken };
  }

  commitResponse(request: { invitationId: string; versionToken: string; response: LocalCalendarInvitationResponse }): LocalCalendarInvitation {
    validIdentifier(request?.invitationId, 'identifier'); validIdentifier(request?.versionToken, 'version');
    if (!responses.includes(request.response)) throw new CalendarInvitationValidationError('Choose Accept, Tentative or Decline.');
    const db = this.database();
    return db.transaction(() => {
      const current = this.byId(request.invitationId);
      if (!current || current.versionToken !== request.versionToken || current.seriesCancelled || !current.eventId) throw new CalendarInvitationValidationError('The invitation changed before the RSVP was saved. Review its latest details.');
      const event = this.linkedEvent(current);
      if (!event) throw new CalendarInvitationValidationError('This meeting is no longer on the calendar.');
      this.calendar.saveEvent({ ...event, scope: 'series', ...participationState(request.response) });
      current.response = request.response; current.versionToken = randomUUID(); this.write(current);
      return this.metadata(current);
    })();
  }
}

function qualifiedUid(value: Pick<StoredInvitation, 'accountId' | 'organizer' | 'uid'>): string { return `invitation-${createHash('sha256').update(`${value.accountId}\u0000${value.organizer}\u0000${value.uid}`).digest('hex')}@sarvinbox.local`; }
function scheduleIdentity(event: LocalCalendarEvent): string { return JSON.stringify({ ...(event.allDay ? { startDate: event.startDate, endDate: event.endDate } : { startMs: event.startMs, endMs: event.endMs }), allDay: event.allDay, recurrence: event.recurrence, ...(event.recurrence ? { timeZone: event.timeZone } : {}), excludedStarts: event.excludedStarts ?? [] }); }
function participationState(response: LocalCalendarInvitationParticipation): Pick<LocalCalendarEvent, 'status' | 'busy'> { return { status: response === 'declined' ? 'cancelled' : response === 'accepted' ? 'confirmed' : 'tentative', busy: response !== 'declined' }; }
function calendarsContain(calendar: LocalCalendarService, id: string | undefined): string | undefined { return id && calendar.getCalendars().some(value => value.id === id) ? id : undefined; }
let singleton: LocalCalendarInvitationService | undefined;
export function getLocalCalendarInvitationService(): LocalCalendarInvitationService { return singleton ??= new LocalCalendarInvitationService(); }
