import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import ICAL from 'ical.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use an isolated invitation database.'); } }));

import { CalendarInvitationValidationError, LocalCalendarInvitationService } from '../../../../electron/services/local-calendar-invitations';
import { LocalCalendarService } from '../../../../electron/services/local-calendar-service';

const NOW = Date.parse('2026-01-05T08:00Z');
const range = { startMs: Date.parse('2026-01-05T00:00Z'), endMs: Date.parse('2026-01-12T00:00Z') };
let db: Database.Database;
let calendar: LocalCalendarService;
let invitations: LocalCalendarInvitationService;
function ics(options: { method?: string; sequence?: number; stamp?: string; uid?: string; organizer?: string; attendee?: string | null; extra?: string[]; times?: string[] } = {}) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fixture//EN', `METHOD:${options.method ?? 'REQUEST'}`, 'BEGIN:VEVENT', `UID:${options.uid ?? 'meeting-uid'}`, `DTSTAMP:${options.stamp ?? '20260105T070000Z'}`, `SEQUENCE:${options.sequence ?? 0}`, `ORGANIZER;CN=Organizer:mailto:${options.organizer ?? 'organizer@example.com'}`,
    ...(options.attendee === null ? [] : [`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${options.attendee ?? 'me@example.com'}`]), 'SUMMARY:Team planning', ...(options.times ?? ['DTSTART:20260105T100000Z', 'DTEND:20260105T110000Z']), ...(options.extra ?? []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
function ingest(emailId = 'email-1', text = ics(), overrides = {}) { return invitations.ingest({ accountId: 'account-1', accountEmail: 'me@example.com', fromAddress: 'Organizer <organizer@example.com>', emailId, ics: text, ...overrides }); }
function lookup(emailId = 'email-1') { return invitations.lookup({ accountId: 'account-1', emailId }); }

beforeEach(() => {
  db = new Database(':memory:'); calendar = new LocalCalendarService(db, () => NOW); invitations = new LocalCalendarInvitationService(db, () => NOW);
  calendar.savePreferences({ ...calendar.getPreferences(), timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', minimumNoticeMinutes: 0, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 });
});
afterEach(() => db.close());

describe('validated incoming iTIP invitations', () => {
  it('adds a tentative busy meeting once and links duplicate delivery emails without duplicates', () => {
    const added = ingest(); expect(added.status).toBe('added');
    expect(added.invitation).toMatchObject({ organizer: 'organizer@example.com', accountEmail: 'me@example.com', response: 'needs-action', cancelled: false });
    expect(calendar.snapshot(range).occurrences[0]!.event).toMatchObject({ title: 'Team planning', status: 'tentative', busy: true, reminderMinutes: null });
    expect(ingest().status).toBe('unchanged'); expect(ingest('duplicate-copy').status).toBe('unchanged');
    expect(lookup('duplicate-copy')?.id).toBe(lookup()?.id); expect(calendar.snapshot(range).occurrences).toHaveLength(1);
    expect(calendar.availability({ startMs: Date.parse('2026-01-05T10:00Z'), endMs: Date.parse('2026-01-05T10:30Z') }).slots).toEqual([]);
  });

  it.each([
    { name: 'organizer does not match From', text: ics({ organizer: 'imposter@example.com' }) },
    { name: 'recipient not listed', text: ics({ attendee: 'someoneelse@example.com' }) },
    { name: 'request lacks recipient', text: ics({ attendee: null }) },
    { name: 'not an iTIP request', text: ics({ method: 'PUBLISH' }) },
    { name: 'reply cannot mutate a meeting', text: ics({ method: 'REPLY' }) },
    { name: 'future timestamp', text: ics({ stamp: '20270105T070000Z' }) },
    { name: 'floating wall times', text: ics({ times: ['DTSTART:20260105T100000', 'DTEND:20260105T110000'] }) },
    { name: 'unsupported timezone', text: ics({ times: ['DTSTART;TZID=Custom/Zone:20260105T100000', 'DTEND;TZID=Custom/Zone:20260105T110000'] }) },
    { name: 'duplicate UID', text: ics({ extra: ['UID:different-uid'] }) },
    { name: 'unsupported recurrence', text: ics({ extra: ['RRULE:FREQ=YEARLY'] }) },
    { name: 'partial recurring request', text: ics({ extra: ['RECURRENCE-ID:20260106T100000Z'] }) },
    { name: 'range cancellation', text: ics({ method: 'CANCEL', extra: ['RECURRENCE-ID;RANGE=THISANDFUTURE:20260106T100000Z'] }) },
  ])('rejects $name before any calendar mutation', ({ text }) => {
    expect(() => ingest('bad', text)).toThrow(CalendarInvitationValidationError);
    expect(calendar.snapshot(range).occurrences).toEqual([]); expect(lookup('bad')).toBeNull();
  });

  it('does not accept a forwarded organizer invitation as a direct request', () => {
    expect(() => ingest('forwarded', ics(), { fromAddress: 'forwarder@example.com' })).toThrow('organizer does not match');
    expect(calendar.snapshot(range).occurrences).toEqual([]);
  });

  it('isolates identical UIDs by organizer and receiving account', () => {
    const first = ingest();
    const second = ingest('other-organizer', ics({ organizer: 'other@example.com' }), { fromAddress: 'other@example.com' });
    const third = ingest('other-account', ics(), { accountId: 'account-2' });
    expect(new Set([first.invitation.eventId, second.invitation.eventId, third.invitation.eventId]).size).toBe(3);
    expect(calendar.snapshot(range).occurrences).toHaveLength(3);
  });

  it('orders updates by SEQUENCE then DTSTAMP and keeps a stable local event id', () => {
    const added = ingest();
    const update = ics({ sequence: 1, stamp: '20260105T060000Z', times: ['DTSTART:20260105T120000Z', 'DTEND:20260105T130000Z'] });
    const updated = ingest('update', update); expect(updated.status).toBe('updated'); expect(updated.invitation.eventId).toBe(added.invitation.eventId);
    expect(ingest('old', ics({ stamp: '20260105T075900Z' })).status).toBe('stale');
    expect(lookup()?.startMs).toBe(Date.parse('2026-01-05T12:00Z'));
    const newerStamp = ics({ sequence: 1, stamp: '20260105T073000Z', times: ['DTSTART:20260105T140000Z', 'DTEND:20260105T150000Z'] });
    expect(ingest('newer-stamp', newerStamp).status).toBe('updated');
    expect(lookup('old')?.startMs).toBe(Date.parse('2026-01-05T14:00Z')); expect(calendar.snapshot(range).occurrences).toHaveLength(1);
  });

  it('does not overwrite an equal-version request with conflicting content', () => {
    ingest(); expect(ingest('conflict', ics({ times: ['DTSTART:20260105T160000Z', 'DTEND:20260105T170000Z'] })).status).toBe('stale');
    expect(lookup()?.startMs).toBe(Date.parse('2026-01-05T10:00Z'));
  });

  it('records cancellation before the request, suppresses stale requests and allows a genuinely newer organizer revision', () => {
    expect(ingest('cancel-first', ics({ method: 'CANCEL', sequence: 3, times: [] })).invitation.cancelled).toBe(true);
    expect(ingest('late-request', ics({ sequence: 2 })).status).toBe('stale'); expect(calendar.snapshot(range).occurrences).toEqual([]);
    expect(ingest('new-revision', ics({ sequence: 4 })).status).toBe('added'); expect(calendar.snapshot(range).occurrences).toHaveLength(1);
  });

  it('cancels an existing meeting without DTSTART/ATTENDEE, frees availability, and never revives it from an older request', () => {
    ingest(); const cancellation = ingest('cancel', ics({ method: 'CANCEL', sequence: 1, attendee: null, times: [] }));
    expect(cancellation.invitation.cancelled).toBe(true); expect(calendar.snapshot(range).occurrences[0]!.event).toMatchObject({ status: 'cancelled', busy: false });
    expect(calendar.availability({ startMs: Date.parse('2026-01-05T10:00Z'), endMs: Date.parse('2026-01-05T10:30Z') }).slots).toHaveLength(1);
    expect(ingest('late-original').status).toBe('stale'); expect(lookup()?.cancelled).toBe(true);
    expect(() => ingest('unknown-cancel', ics({ method: 'CANCEL', uid: 'unknown', attendee: null, times: [] }))).toThrow('must identify this account');
  });

  it('cancels only a recurrence-ID occurrence and rejects fake instances without cancelling the whole series', () => {
    ingest('series', ics({ extra: ['RRULE:FREQ=DAILY;COUNT=3'] }));
    const cancelled = ingest('cancel-instance', ics({ method: 'CANCEL', sequence: 1, extra: ['RECURRENCE-ID:20260106T100000Z'], times: [] }));
    expect(cancelled.status).toBe('cancelled'); expect(cancelled.invitation.occurrenceStartMs).toBe(Date.parse('2026-01-06T10:00Z'));
    expect(calendar.snapshot(range).occurrences.map(value => value.startMs)).toEqual([Date.parse('2026-01-05T10:00Z'), Date.parse('2026-01-07T10:00Z')]);
    expect(lookup('series')?.cancelled).toBe(false); expect(lookup('cancel-instance')?.cancelled).toBe(true);
    expect(() => ingest('fake-instance', ics({ method: 'CANCEL', sequence: 2, extra: ['RECURRENCE-ID:20260109T100000Z'], times: [] }))).toThrow('does not belong');
    expect(calendar.snapshot(range).occurrences).toHaveLength(2);
  });

  it('preserves an out-of-order occurrence cancellation when its older series request arrives later', () => {
    ingest('cancel-instance-first', ics({ method: 'CANCEL', sequence: 2, extra: ['RECURRENCE-ID:20260106T100000Z'], times: [] }));
    ingest('series-later', ics({ sequence: 1, extra: ['RRULE:FREQ=DAILY;COUNT=3'] }));
    expect(calendar.snapshot(range).occurrences).toHaveLength(2);
    expect(calendar.snapshot(range).occurrences.some(value => value.startMs === Date.parse('2026-01-06T10:00Z'))).toBe(false);
  });

  it('uses the series timezone for an all-day recurrence-ID cancellation', () => {
    const times = ['DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106'];
    calendar.savePreferences({ ...calendar.getPreferences(), timeZone: 'Asia/Kolkata' });
    ingest('all-day-series', ics({ times, extra: ['RRULE:FREQ=DAILY;COUNT=3'] }));
    calendar.savePreferences({ ...calendar.getPreferences(), timeZone: 'UTC' });
    ingest('all-day-cancel', ics({ method: 'CANCEL', sequence: 1, times: [], extra: ['RECURRENCE-ID;VALUE=DATE:20260106'] }));
    expect(calendar.snapshot(range).occurrences.map(value => value.startMs)).not.toContain(Date.parse('2026-01-05T18:30Z'));
  });

  it('keeps an all-day cancellation date stable if display preferences change before the series arrives', () => {
    ingest('date-cancel-first', ics({ method: 'CANCEL', sequence: 2, times: [], extra: ['RECURRENCE-ID;VALUE=DATE:20260106'] }));
    calendar.savePreferences({ ...calendar.getPreferences(), timeZone: 'Asia/Kolkata' });
    ingest('date-series-later', ics({ sequence: 1, times: ['DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106'], extra: ['RRULE:FREQ=DAILY;COUNT=3'] }));
    expect(calendar.snapshot(range).occurrences.some(value => value.startMs === Date.parse('2026-01-05T18:30Z'))).toBe(false);
    expect(lookup('date-cancel-first')?.occurrenceStartMs).toBe(Date.parse('2026-01-05T18:30Z'));
    expect(ingest('date-cancel-first', ics({ method: 'CANCEL', sequence: 2, times: [], extra: ['RECURRENCE-ID;VALUE=DATE:20260106'] })).status).toBe('unchanged');
  });

  it('does not overwrite an existing event or revision if updating the invitation metadata fails', () => {
    ingest(); const original = lookup();
    db.exec("CREATE TRIGGER fail_invitation_metadata BEFORE INSERT ON local_calendar_invitations BEGIN SELECT RAISE(ABORT, 'fixture metadata failure'); END;");
    expect(() => ingest('update-fails', ics({ sequence: 1, times: ['DTSTART:20260105T120000Z', 'DTEND:20260105T130000Z'] }))).toThrow('fixture metadata failure');
    expect(lookup()).toEqual(original); expect(lookup('update-fails')).toBeNull(); expect(calendar.snapshot(range).occurrences[0]!.startMs).toBe(Date.parse('2026-01-05T10:00Z'));
  });

  it('fails closed on corrupt persisted identity and cannot point an invitation at an unrelated local event', () => {
    const created = ingest();
    const row = db.prepare('SELECT data FROM local_calendar_invitations WHERE id = ?').get(created.invitation.id) as { data: string };
    const data = JSON.parse(row.data);
    db.prepare('UPDATE local_calendar_invitations SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, accountEmail: 'not an email' }), created.invitation.id);
    expect(() => lookup()).toThrow('Saved invitation identity is invalid');
    db.prepare('UPDATE local_calendar_invitations SET data = ? WHERE id = ?').run(row.data, created.invitation.id);
    db.prepare('UPDATE local_calendar_events SET uid = ? WHERE id = ?').run('unrelated-event', created.invitation.eventId);
    expect(() => invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' })).toThrow('different calendar event');
  });

  it('does not import remote reminders or app-specific timezone overrides', () => {
    const result = ingest('remote-extra', ics({ extra: ['X-SARV-TIMEZONE:Asia/Tokyo', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'DESCRIPTION:Remote reminder', 'END:VALARM'] }));
    expect(result.event).toMatchObject({ timeZone: 'UTC', reminderMinutes: null });
  });

  it('keeps a missing destination calendar retryable and accepts the same email after a calendar is created', () => {
    for (const value of calendar.getCalendars()) calendar.deleteCalendar(value.id);
    let cause: unknown; try { ingest(); } catch (error) { cause = error; }
    expect(cause).toBeInstanceOf(Error); expect(cause).not.toBeInstanceOf(CalendarInvitationValidationError);
    expect((cause as Error).message).toContain('Create a local calendar'); expect(lookup()).toBeNull();
    calendar.saveCalendar({ name: 'Meetings', color: '#2563eb', visible: true, blocksAvailability: true, isDefault: true });
    expect(ingest().status).toBe('added'); expect(calendar.snapshot(range).occurrences).toHaveLength(1);
  });

  it('rolls back the invitation link and event when persistence fails', () => {
    db.exec("CREATE TRIGGER fail_invitation BEFORE INSERT ON local_calendar_events BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;");
    expect(() => ingest()).toThrow('fixture write failure'); expect(lookup()).toBeNull(); expect(calendar.snapshot(range).occurrences).toEqual([]);
    db.exec('DROP TRIGGER fail_invitation'); expect(ingest().status).toBe('added');
  });

  it('persists links, response metadata and tombstones across a real database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-invitation-')); const path = join(directory, 'core.db');
    try {
      let disk = new Database(path); let service = new LocalCalendarInvitationService(disk, () => NOW);
      service.ingest({ accountId: 'a', accountEmail: 'me@example.com', fromAddress: 'organizer@example.com', emailId: 'cancel', ics: ics({ method: 'CANCEL', sequence: 2, times: [] }) });
      disk.close(); disk = new Database(path); service = new LocalCalendarInvitationService(disk, () => NOW);
      expect(service.lookup({ accountId: 'a', emailId: 'cancel' })?.cancelled).toBe(true);
      expect(service.ingest({ accountId: 'a', accountEmail: 'me@example.com', fromAddress: 'organizer@example.com', emailId: 'old', ics: ics() }).status).toBe('stale'); disk.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('explicit local invitation responses', () => {
  it('prepares an organizer-only standards REPLY without changing local state or sending', () => {
    ingest(); const prepared = invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' });
    expect(prepared.organizer).toBe('organizer@example.com'); expect(prepared.accountEmail).toBe('me@example.com');
    const reply = new ICAL.Component(ICAL.parse(prepared.replyIcs)); const event = reply.getFirstSubcomponent('vevent')!;
    expect(reply.getFirstPropertyValue('method')).toBe('REPLY'); expect(event.getFirstPropertyValue('uid')).toBe('meeting-uid'); expect(event.getFirstPropertyValue('sequence')).toBe(0);
    expect(event.getAllProperties('attendee')).toHaveLength(1); expect(event.getFirstProperty('attendee')?.getFirstValue()).toBe('mailto:me@example.com'); expect(event.getFirstProperty('attendee')?.getParameter('partstat')).toBe('ACCEPTED');
    expect(lookup()?.response).toBe('needs-action'); expect(calendar.snapshot(range).occurrences[0]!.event.status).toBe('tentative');
  });

  it('emits exact UTC reply times for an IANA recurring meeting without redefining its recurrence or requiring missing timezone definitions', () => {
    ingest('ny-series', ics({ times: ['DTSTART;TZID=America/New_York:20260308T090000', 'DTEND;TZID=America/New_York:20260308T100000'], extra: ['RRULE:FREQ=WEEKLY;COUNT=3'] }));
    const prepared = invitations.prepareResponse({ accountId: 'account-1', emailId: 'ny-series', response: 'tentative' });
    const root = new ICAL.Component(ICAL.parse(prepared.replyIcs)); const event = root.getFirstSubcomponent('vevent')!;
    const start = event.getFirstPropertyValue('dtstart') as ICAL.Time;
    expect(start.zone.tzid).toBe('UTC'); expect(start.toUnixTime() * 1000).toBe(Date.parse('2026-03-08T13:00Z'));
    expect(event.hasProperty('rrule')).toBe(false); expect(root.getAllSubcomponents('vtimezone')).toHaveLength(0);
    expect(event.getFirstProperty('attendee')?.getParameter('partstat')).toBe('TENTATIVE');
  });

  it('keeps all-day reply dates exclusive and retains original requested times after a local-only calendar edit', () => {
    const result = ingest('all-day', ics({ times: ['DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260107'] }));
    const scheduled = calendar.getEvent(result.invitation.eventId!)!;
    calendar.saveEvent({ ...scheduled, startDate: '2026-01-06', endDate: '2026-01-08' });
    const prepared = invitations.prepareResponse({ accountId: 'account-1', emailId: 'all-day', response: 'accepted' });
    const root = new ICAL.Component(ICAL.parse(prepared.replyIcs)); const event = root.getFirstSubcomponent('vevent')!;
    expect((event.getFirstPropertyValue('dtstart') as ICAL.Time).toString()).toBe('2026-01-05');
    expect((event.getFirstPropertyValue('dtend') as ICAL.Time).toString()).toBe('2026-01-07');
  });

  it.each(['accepted', 'tentative', 'declined'] as const)('commits %s after root confirms enqueue/delivery and projects availability status', response => {
    ingest(); const prepared = invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response });
    const result = invitations.commitResponse(prepared); expect(result.response).toBe(response);
    const event = calendar.snapshot(range).occurrences[0]!.event;
    expect(event.status).toBe(response === 'accepted' ? 'confirmed' : response === 'declined' ? 'cancelled' : 'tentative'); expect(event.busy).toBe(response !== 'declined');
    expect(() => invitations.commitResponse(prepared)).toThrow('invitation changed');
  });

  it('does not mark an old RSVP against a newer organizer update or cancellation', () => {
    ingest(); const prepared = invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' });
    ingest('update', ics({ sequence: 1 })); expect(() => invitations.commitResponse(prepared)).toThrow('invitation changed');
    const newer = invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' });
    ingest('cancel', ics({ method: 'CANCEL', sequence: 2, times: [] })); expect(() => invitations.commitResponse(newer)).toThrow('invitation changed');
    expect(() => invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' })).toThrow('cancelled');
  });

  it('retains the chosen response through a newer series update', () => {
    ingest(); invitations.commitResponse(invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'declined' }));
    ingest('update', ics({ sequence: 1 })); expect(lookup()?.response).toBe('declined'); expect(calendar.snapshot(range).occurrences[0]!.event).toMatchObject({ status: 'cancelled', busy: false });
  });
});


describe('send-time RSVP revision guard', () => {
  function guard() {
    const added = ingest();
    return { accountId: 'account-1', accountEmail: 'me@example.com', invitationId: added.invitation.id, sequence: added.invitation.sequence, dtstampMs: added.invitation.dtstampMs, organizer: 'organizer@example.com', deliveryToken: invitations.reserveResponseDelivery({ invitationId: added.invitation.id, versionToken: added.invitation.versionToken }) };
  }

  it('permits the current invitation before and after its local response is queued', () => {
    const request = guard();
    expect(() => invitations.assertResponseDelivery(request)).not.toThrow();
    invitations.commitResponse(invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' }));
    expect(() => invitations.assertResponseDelivery(request)).not.toThrow();
  });

  it('rejects an older queued RSVP after either a higher sequence or newer timestamp', () => {
    const request = guard();
    ingest('newer-stamp', ics({ stamp: '20260105T073000Z' }));
    expect(() => invitations.assertResponseDelivery(request)).toThrow(CalendarInvitationValidationError);
    const current = lookup()!;
    ingest('newer-sequence', ics({ sequence: 1, stamp: '20260105T060000Z' }));
    expect(() => invitations.assertResponseDelivery({ ...request, sequence: current.sequence, dtstampMs: current.dtstampMs })).toThrow('invitation changed');
  });

  it('rejects cancelled or deleted meetings before SMTP', () => {
    const request = guard();
    ingest('cancelled', ics({ method: 'CANCEL', sequence: 1, times: [] }));
    expect(() => invitations.assertResponseDelivery(request)).toThrow('cancelled');
    const replacement = ingest('recreated', ics({ sequence: 2 })).invitation;
    calendar.deleteEvent({ id: replacement.eventId! });
    expect(() => invitations.assertResponseDelivery({ ...request, sequence: replacement.sequence, dtstampMs: replacement.dtstampMs })).toThrow('invitation changed');
  });

  it.each([
    { accountId: 'another-account' },
    { accountEmail: 'someone-else@example.com' },
    { organizer: 'another-organizer@example.com' },
  ])('rejects a foreign account or changed sender/recipient identity: %j', overrides => {
    const request = guard();
    expect(() => invitations.assertResponseDelivery({ ...request, ...overrides })).toThrow(CalendarInvitationValidationError);
  });

  it('does not silently send when the saved request no longer identifies this recipient', () => {
    const request = guard();
    const row = db.prepare('SELECT data FROM local_calendar_invitations WHERE id = ?').get(request.invitationId) as { data: string };
    const data = JSON.parse(row.data); const component = new ICAL.Component(ICAL.parse(data.replyTemplate));
    component.removeAllProperties('attendee'); data.replyTemplate = component.toString();
    db.prepare('UPDATE local_calendar_invitations SET data = ? WHERE id = ?').run(JSON.stringify(data), request.invitationId);
    expect(() => invitations.assertResponseDelivery(request)).toThrow('recipient no longer matches');
  });

  it('keeps persistence failures distinct from permanent invitation validation failures', () => {
    const request = guard(); db.exec('DROP TABLE local_calendar_invitations');
    let cause: unknown; try { invitations.assertResponseDelivery(request); } catch (error) { cause = error; }
    expect(cause).toBeInstanceOf(Error); expect(cause).not.toBeInstanceOf(CalendarInvitationValidationError);
  });

  it('asks for a fresh decision when a higher-sequence reschedule changes meeting times', () => {
    ingest(); invitations.commitResponse(invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' }));
    const updated = ingest('rescheduled', ics({ sequence: 1, times: ['DTSTART:20260105T120000Z', 'DTEND:20260105T130000Z'] }));
    expect(updated.invitation.response).toBe('needs-action'); expect(updated.event).toMatchObject({ status: 'tentative', busy: true });
  });

  it('retains the chosen response for a higher-sequence metadata update despite local-only date edits', () => {
    const original = ingest(); invitations.commitResponse(invitations.prepareResponse({ accountId: 'account-1', emailId: 'email-1', response: 'accepted' }));
    const event = calendar.getEvent(original.invitation.eventId!)!;
    calendar.saveEvent({ ...event, startMs: event.startMs + 3_600_000, endMs: event.endMs + 3_600_000 });
    const updated = ingest('metadata-update', ics({ sequence: 1 }).replace('SUMMARY:Team planning', 'SUMMARY:Team planning agenda updated'));
    expect(updated.invitation.response).toBe('accepted'); expect(updated.event).toMatchObject({ status: 'confirmed', busy: true });
  });
});


describe('durable RSVP delivery reservations', () => {
  const responseRequest = { accountId: 'account-1', emailId: 'email-1', response: 'accepted' as const };
  const deliveryRequest = (prepared: ReturnType<LocalCalendarInvitationService['prepareResponse']>, deliveryToken: string) => ({ accountId: prepared.accountId, accountEmail: prepared.accountEmail, invitationId: prepared.invitationId, organizer: prepared.organizer, sequence: prepared.invitation.sequence, dtstampMs: prepared.invitation.dtstampMs, deliveryToken });

  it('reserves without changing participation or invalidating the commit guard', () => {
    ingest(); const prepared = invitations.prepareResponse(responseRequest);
    const token = invitations.reserveResponseDelivery(prepared);
    expect(token).toBeTruthy(); expect(lookup()?.response).toBe('needs-action'); expect(lookup()?.versionToken).toBe(prepared.versionToken);
    const committed = invitations.commitResponse(prepared); expect(committed.response).toBe('accepted');
    expect(() => invitations.assertResponseDelivery(deliveryRequest(prepared, token))).not.toThrow();
  });

  it('prevents an older queued acceptance from retrying after a later decline at the same organizer revision', () => {
    ingest(); const accepted = invitations.prepareResponse(responseRequest);
    const acceptedToken = invitations.reserveResponseDelivery(accepted); invitations.commitResponse(accepted);
    const declined = invitations.prepareResponse({ ...responseRequest, response: 'declined' });
    const declinedToken = invitations.reserveResponseDelivery(declined); invitations.commitResponse(declined);
    expect(accepted.invitation.sequence).toBe(declined.invitation.sequence); expect(accepted.invitation.dtstampMs).toBe(declined.invitation.dtstampMs);
    expect(() => invitations.assertResponseDelivery(deliveryRequest(accepted, acceptedToken))).toThrow('newer RSVP choice replaced');
    expect(() => invitations.assertResponseDelivery(deliveryRequest(declined, declinedToken))).not.toThrow();
    expect(lookup()?.response).toBe('declined');
  });

  it('rejects stale and cancelled reservation requests without replacing a valid reservation', () => {
    ingest(); const original = invitations.prepareResponse(responseRequest);
    const originalToken = invitations.reserveResponseDelivery(original);
    ingest('update', ics({ sequence: 1 }));
    expect(() => invitations.reserveResponseDelivery(original)).toThrow('invitation changed');
    const updated = invitations.prepareResponse(responseRequest); const updatedToken = invitations.reserveResponseDelivery(updated);
    expect(updatedToken).not.toBe(originalToken);
    ingest('cancel', ics({ method: 'CANCEL', sequence: 2, times: [] }));
    expect(() => invitations.reserveResponseDelivery(updated)).toThrow('invitation changed');
  });

  it('preserves only the latest reservation and chosen participation across a file database restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inbox-rsvp-token-')); const path = join(directory, 'core.db');
    try {
      let disk = new Database(path); let service = new LocalCalendarInvitationService(disk, () => NOW);
      service.ingest({ accountId: 'account-1', accountEmail: 'me@example.com', fromAddress: 'organizer@example.com', emailId: 'email-1', ics: ics() });
      const old = service.prepareResponse(responseRequest); const oldToken = service.reserveResponseDelivery(old); service.commitResponse(old);
      const latest = service.prepareResponse({ ...responseRequest, response: 'declined' }); const latestToken = service.reserveResponseDelivery(latest); service.commitResponse(latest);
      disk.close(); disk = new Database(path); service = new LocalCalendarInvitationService(disk, () => NOW);
      expect(() => service.assertResponseDelivery(deliveryRequest(old, oldToken))).toThrow('newer RSVP choice replaced');
      expect(() => service.assertResponseDelivery(deliveryRequest(latest, latestToken))).not.toThrow();
      expect(service.lookup(responseRequest)?.response).toBe('declined'); disk.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
