import { describe, expect, it } from 'vitest';

import { prepareCalendarFileImport } from '../../../../electron/services/calendar-file-import';

const file = (method: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:meeting', 'DTSTART:20261021T100000Z', 'DTEND:20261021T110000Z', 'ATTENDEE:mailto:person@example.com', 'ORGANIZER:mailto:host@example.com', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

describe('explicit calendar-file imports', () => {
  it('imports a meeting request as a passive local copy with no RSVP or remote alarm', () => {
    const result = prepareCalendarFileImport(file('REQUEST'));
    expect(result).toContain('METHOD:PUBLISH'); expect(result).toContain('UID:meeting'); expect(result).toContain('DTSTART:20261021T100000Z');
    expect(result).not.toMatch(/ATTENDEE|ORGANIZER|VALARM/);
  });
  it.each(['CANCEL', 'REPLY'])('does not let a %s file change a scheduled meeting', method => {
    expect(() => prepareCalendarFileImport(file(method))).toThrow('original email account');
  });
  it('preserves ordinary published calendars', () => {
    expect(prepareCalendarFileImport(file('PUBLISH'))).toContain('METHOD:PUBLISH');
  });
  it.each([null, 'not a calendar', `${file('PUBLISH')}${'x'.repeat(256 * 1024)}`, file('ADD')])('rejects malformed or unsupported files', value => {
    expect(() => prepareCalendarFileImport(value)).toThrow();
  });
});
