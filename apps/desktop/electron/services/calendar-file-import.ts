import ICAL from 'ical.js';

/** A user-imported file may make a local copy, but cannot act as an organizer. */
export function prepareCalendarFileImport(text: unknown): string {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 256 * 1024 || text.includes('\0')) throw new Error('Choose an iCalendar file smaller than 256 KB.');
  let calendar: ICAL.Component;
  try { calendar = new ICAL.Component(ICAL.parse(text)); } catch { throw new Error('This calendar file could not be read.'); }
  if (calendar.name !== 'vcalendar' || calendar.getAllProperties('method').length > 1) throw new Error('Choose a valid iCalendar document.');
  const method = String(calendar.getFirstPropertyValue('method') ?? 'PUBLISH').toUpperCase();
  if (method === 'CANCEL' || method === 'REPLY') throw new Error('Meeting responses and cancellations must arrive through the original email account to update a meeting.');
  if (method !== 'PUBLISH' && method !== 'REQUEST') throw new Error('This calendar file uses an unsupported scheduling method.');
  if (method === 'REQUEST') {
    calendar.updatePropertyWithValue('method', 'PUBLISH');
    for (const event of calendar.getAllSubcomponents('vevent')) {
      if (String(event.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') throw new Error('A cancelled invitation cannot be imported as a new appointment.');
      event.removeAllProperties('attendee');
      event.removeAllProperties('organizer');
      event.removeAllSubcomponents('valarm');
    }
  }
  return calendar.toString();
}
