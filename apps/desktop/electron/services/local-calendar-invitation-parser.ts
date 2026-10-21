import { createHash } from 'node:crypto';

import emailAddresses from 'email-addresses';
import ICAL from 'ical.js';

import type { LocalCalendarEvent } from '../../src/types/local-calendar';
import { validateTimeZone } from '../../src/utils/local-calendar';

import { parseLocalCalendarIcs, readLocalCalendarIcsTime } from './local-calendar-ics';

export class CalendarInvitationValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'CalendarInvitationValidationError'; }
}

export interface ParsedIncomingCalendarInvitation {
  method: 'REQUEST' | 'CANCEL';
  uid: string;
  organizer: string;
  organizerName?: string;
  accountEmail: string;
  addressed: boolean;
  sequence: number;
  dtstampMs: number;
  recurrenceStartMs?: number;
  recurrenceDate?: string;
  event?: LocalCalendarEvent;
  /** Canonical inert event, retained only for a later explicit RSVP. */
  replyTemplate: string;
  fingerprint: string;
}

export function invitationEmailAddress(value: string, label = 'email address'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\r\n]/.test(value) || value.includes('\u0000')) throw new Error(`Invalid invitation ${label}.`);
  const parsed = emailAddresses.parseOneAddress({ input: value.trim(), partial: false, strict: true });
  if (!parsed || parsed.type !== 'mailbox' || !parsed.address || parsed.address.length > 320 || !parsed.address.includes('@')) throw new Error(`Invalid invitation ${label}.`);
  return parsed.address.toLowerCase();
}

function calendarAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^mailto:/i.test(value) || /[?%]/.test(value)) throw new Error('Only direct email invitation participants are supported.');
  return invitationEmailAddress(value.slice(7), 'participant');
}

/** Strict main-process iTIP gate. This parses no attachments and performs no network I/O. */
function parseInvitation(input: { ics: string; fromAddress: string; accountEmail: string; calendarId: string; timeZone: string; now: number }): ParsedIncomingCalendarInvitation {
  if (typeof input.ics !== 'string' || Buffer.byteLength(input.ics, 'utf8') > 256 * 1024 || input.ics.includes('\u0000')) throw new Error('Meeting invitations must be smaller than 256 KB.');
  const accountEmail = invitationEmailAddress(input.accountEmail, 'recipient');
  const from = invitationEmailAddress(input.fromAddress, 'sender');
  validateTimeZone(input.timeZone);
  let root: InstanceType<typeof ICAL.Component>;
  try { root = new ICAL.Component(ICAL.parse(input.ics)); } catch { throw new Error('This is not a valid meeting invitation.'); }
  if (root.name !== 'vcalendar' || root.getFirstPropertyValue('version') !== '2.0' || root.getAllProperties('method').length !== 1) throw new Error('Meeting invitations require a version 2.0 calendar and one scheduling method.');
  const method = String(root.getFirstPropertyValue('method')).toUpperCase();
  if (method !== 'REQUEST' && method !== 'CANCEL') throw new Error('Only meeting requests and organizer cancellations can update the local calendar.');
  if (root.getAllSubcomponents().some(component => !['vevent', 'vtimezone'].includes(component.name))) throw new Error('This invitation contains unsupported calendar entries.');
  for (const zone of root.getAllSubcomponents('vtimezone')) validateTimeZone(String(zone.getFirstPropertyValue('tzid') ?? ''));
  const events = root.getAllSubcomponents('vevent');
  if (events.length !== 1) throw new Error('Only one meeting or series per invitation is supported.');
  const component = events[0]!;
  for (const name of ['uid', 'organizer', 'dtstamp']) if (component.getAllProperties(name).length !== 1) throw new Error(`The invitation requires exactly one ${name.toUpperCase()}.`);
  for (const name of ['sequence', 'recurrence-id', 'status', 'summary']) if (component.getAllProperties(name).length > 1) throw new Error(`The invitation contains multiple ${name.toUpperCase()} fields.`);
  const uid = component.getFirstPropertyValue('uid');
  if (typeof uid !== 'string' || !uid.trim() || uid.length > 500 || /[\r\n]/.test(uid) || uid.includes('\u0000')) throw new Error('The invitation needs a valid UID.');
  const organizerProperty = component.getFirstProperty('organizer')!;
  const organizer = calendarAddress(organizerProperty.getFirstValue());
  if (organizer !== from) throw new Error('The invitation organizer does not match the email sender. Forwarded or delegated invitations need manual review.');
  const sentBy = organizerProperty.getParameter('sent-by');
  if (sentBy !== undefined && calendarAddress(sentBy) !== organizer) throw new Error('Delegated meeting organizers are not supported automatically.');
  const cn = organizerProperty.getParameter('cn');
  const organizerName = typeof cn === 'string' && cn.trim() ? cn.trim().slice(0, 200) : undefined;
  const attendees = component.getAllProperties('attendee');
  if (attendees.length > 2000) throw new Error('This invitation contains too many participants.');
  const matches = attendees.filter(property => calendarAddress(property.getFirstValue()) === accountEmail);
  if (matches.length > 1) throw new Error('The invitation repeats the recipient identity.');
  const addressed = matches.length === 1;
  if (!addressed && (method === 'REQUEST' || attendees.length > 0)) throw new Error('This account is not an attendee of the invitation.');
  const sequence = component.hasProperty('sequence') ? component.getFirstPropertyValue('sequence') : 0;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0 || (sequence as number) > 2_147_483_647) throw new Error('Invalid invitation sequence.');
  const stampProperty = component.getFirstProperty('dtstamp')!;
  const stamp = stampProperty.getFirstValue();
  if (!(stamp instanceof ICAL.Time) || stamp.isDate || stamp.zone?.tzid !== 'UTC') throw new Error('Invitation DTSTAMP must be a UTC timestamp.');
  const dtstampMs = readLocalCalendarIcsTime(stampProperty, stamp, 'UTC').ms;
  if (dtstampMs < 0 || dtstampMs > input.now + 86_400_000) throw new Error('The invitation timestamp is invalid or too far in the future.');
  const recurrenceProperty = component.getFirstProperty('recurrence-id');
  let recurrenceStartMs: number | undefined;
  let recurrenceDate: string | undefined;
  if (recurrenceProperty) {
    if (recurrenceProperty.getParameter('range') || component.hasProperty('rrule')) throw new Error('Recurrence range changes are not supported automatically.');
    if (method === 'REQUEST') throw new Error('Updates to a single recurring occurrence are not supported automatically yet. Open the invitation to review it.');
    const value = recurrenceProperty.getFirstValue();
    if (!(value instanceof ICAL.Time)) throw new Error('Invalid recurring occurrence identifier.');
    const recurrence = readLocalCalendarIcsTime(recurrenceProperty, value, input.timeZone);
    recurrenceStartMs = recurrence.ms;
    if (recurrence.allDay) recurrenceDate = recurrence.date;
  }
  let event: LocalCalendarEvent | undefined;
  if (method === 'REQUEST') {
    const status = String(component.getFirstPropertyValue('status') ?? 'CONFIRMED').toUpperCase();
    if (!['CONFIRMED', 'TENTATIVE'].includes(status)) throw new Error('A meeting request cannot cancel an event; use an organizer cancellation.');
    // Alarm preferences and app-owned timezone metadata are never accepted from
    // a remote invitation. DTSTART/DTEND retain their standards-based timezone.
    component.removeAllSubcomponents('valarm');
    component.removeAllProperties('x-sarv-timezone');
    root.updatePropertyWithValue('method', 'PUBLISH');
    const parsed = parseLocalCalendarIcs(root.toString(), input.calendarId, input.now, input.timeZone);
    if (parsed.length !== 1 || parsed[0]!.exceptions.length) throw new Error('Unsupported recurring invitation changes.');
    event = parsed[0]!.event;
  }
  // A reply is reconstructed from an allowlist; no inbound alarms, URLs or
  // delegated attendees can become executable reply instructions.
  return { method, uid, organizer, ...(organizerName ? { organizerName } : {}), accountEmail, addressed, sequence: sequence as number, dtstampMs, ...(recurrenceStartMs === undefined ? {} : { recurrenceStartMs }), ...(recurrenceDate ? { recurrenceDate } : {}), ...(event ? { event } : {}), replyTemplate: component.toString(), fingerprint: createHash('sha256').update(input.ics).digest('hex') };
}

export function parseIncomingCalendarInvitation(input: Parameters<typeof parseInvitation>[0]): ParsedIncomingCalendarInvitation {
  try { return parseInvitation(input); }
  catch (cause) { throw new CalendarInvitationValidationError(cause instanceof Error ? cause.message : 'This meeting invitation is invalid.'); }
}
