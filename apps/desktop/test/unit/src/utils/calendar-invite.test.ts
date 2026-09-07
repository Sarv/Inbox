import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { formatEventRange, isInviteCancelled, parseCalendarInvite } from '../../../../src/utils/calendar-invite';

/** Wrap VEVENT lines in a minimal, valid VCALENDAR envelope (CRLF, per RFC 5545). */
const cal = (...lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sarv Inbox//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');

const vevent = (...lines: string[]): string => cal('BEGIN:VEVENT', 'UID:uid-1', 'DTSTAMP:20260801T000000Z', ...lines, 'END:VEVENT');

// A real VTIMEZONE so the TZID test resolves through ical.js's zone handling
// rather than silently falling back to a floating (local) time.
const NY_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZNAME:EST',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700308T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZNAME:EDT',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

describe('parseCalendarInvite — the safety guard', () => {
  // The invite banner must never be able to break the detail view: every
  // rejected input has to come back as null, never a throw.
  it('returns null for absent / non-string input', () => {
    expect(parseCalendarInvite(null)).toBeNull();
    expect(parseCalendarInvite(undefined)).toBeNull();
    expect(parseCalendarInvite(123 as unknown as string)).toBeNull();
  });

  it('returns null for empty / whitespace-only text', () => {
    expect(parseCalendarInvite('')).toBeNull();
    expect(parseCalendarInvite('   \r\n  ')).toBeNull();
  });

  it('returns null when the text is not an iCalendar object at all', () => {
    expect(parseCalendarInvite('<html>just an email body</html>')).toBeNull();
  });

  it('returns null for an ICS above the 256K-char resource cap', () => {
    // Resource-exhaustion guard: a hostile/oversized part must not reach the parser.
    const huge = `BEGIN:VCALENDAR\r\nX-PAD:${'x'.repeat(256 * 1024)}\r\nEND:VCALENDAR`;
    expect(parseCalendarInvite(huge)).toBeNull();
  });

  it('accepts the BEGIN:VCALENDAR marker case-insensitively', () => {
    const lower = 'begin:vcalendar\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20260820T093000Z\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseCalendarInvite(lower)?.startMs).toBe(Date.UTC(2026, 7, 20, 9, 30));
  });

  it('returns null (not a throw) on structurally malformed ICS', () => {
    expect(parseCalendarInvite('BEGIN:VCALENDAR\r\nthis is not a property line')).toBeNull();
  });

  it('returns null when the calendar carries no VEVENT', () => {
    expect(parseCalendarInvite(cal('BEGIN:VTODO', 'UID:t1', 'END:VTODO'))).toBeNull();
  });

  it('returns null when the VEVENT has no DTSTART (nothing to show on a banner)', () => {
    expect(parseCalendarInvite(vevent('SUMMARY:No start'))).toBeNull();
  });
});

describe('parseCalendarInvite — field extraction', () => {
  it('parses a UTC-anchored meeting into absolute instants', () => {
    const invite = parseCalendarInvite(
      vevent('DTSTART:20260820T093000Z', 'DTEND:20260820T103000Z', 'SUMMARY:Sprint review', 'LOCATION:Meet link'),
    );
    expect(invite).toEqual({
      summary: 'Sprint review',
      startMs: Date.UTC(2026, 7, 20, 9, 30),
      endMs: Date.UTC(2026, 7, 20, 10, 30),
      isAllDay: false,
      location: 'Meet link',
      organizer: null,
      attendeeCount: 0,
      method: null,
      status: null,
    });
  });

  it('resolves a TZID DTSTART through its VTIMEZONE (not as floating local time)', () => {
    // 09:30 in New York on 2026-08-20 is EDT (UTC-4) → 13:30Z. If the zone were
    // ignored, the banner would show the meeting hours off for every attendee.
    const invite = parseCalendarInvite(
      cal(
        ...NY_VTIMEZONE,
        'BEGIN:VEVENT',
        'UID:uid-tz',
        'DTSTART;TZID=America/New_York:20260820T093000',
        'DTEND;TZID=America/New_York:20260820T103000',
        'SUMMARY:NY meeting',
        'END:VEVENT',
      ),
    );
    expect(invite?.startMs).toBe(Date.UTC(2026, 7, 20, 13, 30));
    expect(invite?.endMs).toBe(Date.UTC(2026, 7, 20, 14, 30));
    expect(invite?.isAllDay).toBe(false);
  });

  it('flags an all-day event and keeps DTEND exclusive as given', () => {
    // VALUE=DATE ⇒ isAllDay. The times land at LOCAL midnight (a floating date),
    // which is what makes the day label read correctly for the viewer.
    const invite = parseCalendarInvite(
      vevent('DTSTART;VALUE=DATE:20260820', 'DTEND;VALUE=DATE:20260821', 'SUMMARY:Company holiday'),
    );
    expect(invite?.isAllDay).toBe(true);
    expect(invite?.startMs).toBe(new Date(2026, 7, 20).getTime());
    expect(invite?.endMs).toBe(new Date(2026, 7, 21).getTime());
  });

  it('derives the end from DURATION when there is no DTEND', () => {
    const invite = parseCalendarInvite(vevent('DTSTART:20260820T093000Z', 'DURATION:PT45M'));
    expect(invite?.endMs).toBe(Date.UTC(2026, 7, 20, 10, 15));
  });

  it('prefers the organizer CN over the mailto address', () => {
    const invite = parseCalendarInvite(
      vevent('DTSTART:20260820T093000Z', 'ORGANIZER;CN=Advik Dutta:mailto:advik.d@sarv.com'),
    );
    expect(invite?.organizer).toBe('Advik Dutta');
  });

  it('falls back to the bare address (mailto: stripped) when there is no CN', () => {
    const invite = parseCalendarInvite(vevent('DTSTART:20260820T093000Z', 'ORGANIZER:mailto:advik.d@sarv.com'));
    expect(invite?.organizer).toBe('advik.d@sarv.com');
  });

  it('falls back to the address when CN is present but blank', () => {
    const invite = parseCalendarInvite(vevent('DTSTART:20260820T093000Z', 'ORGANIZER;CN="  ":mailto:a@b.com'));
    expect(invite?.organizer).toBe('a@b.com');
  });

  it('leaves the organizer null when the property carries no address at all', () => {
    // A bare `ORGANIZER:` line (some Exchange exports) must not render an empty
    // "Organised by" row.
    const invite = parseCalendarInvite(vevent('DTSTART:20260820T093000Z', 'ORGANIZER:'));
    expect(invite?.organizer).toBeNull();
  });

  it('counts every ATTENDEE property', () => {
    const invite = parseCalendarInvite(
      vevent(
        'DTSTART:20260820T093000Z',
        'ATTENDEE;CN=A:mailto:a@x.com',
        'ATTENDEE;CN=B:mailto:b@x.com',
        'ATTENDEE;CN=C:mailto:c@x.com',
      ),
    );
    expect(invite?.attendeeCount).toBe(3);
  });

  it('surfaces METHOD (calendar level) and STATUS (event level)', () => {
    const invite = parseCalendarInvite(
      cal('METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20260820T093000Z', 'STATUS:CONFIRMED', 'END:VEVENT'),
    );
    expect(invite?.method).toBe('REQUEST');
    expect(invite?.status).toBe('CONFIRMED');
  });

  it('nulls out blank free-text fields rather than rendering empty chrome', () => {
    const invite = parseCalendarInvite(vevent('DTSTART:20260820T093000Z', 'SUMMARY:', 'LOCATION:   '));
    expect(invite?.summary).toBeNull();
    expect(invite?.location).toBeNull();
  });

  it('length-caps an absurdly long summary with an ellipsis', () => {
    // Keeps one hostile invite from blowing out the banner layout.
    const invite = parseCalendarInvite(vevent('DTSTART:20260820T093000Z', `SUMMARY:${'S'.repeat(400)}`));
    expect(invite?.summary).toHaveLength(301); // 300 chars + '…'
    expect(invite?.summary?.endsWith('…')).toBe(true);
  });

  it('reads only the FIRST VEVENT of a multi-event calendar', () => {
    const invite = parseCalendarInvite(
      cal(
        'BEGIN:VEVENT',
        'UID:first',
        'DTSTART:20260820T093000Z',
        'SUMMARY:First',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:second',
        'DTSTART:20260821T093000Z',
        'SUMMARY:Second',
        'END:VEVENT',
      ),
    );
    expect(invite?.summary).toBe('First');
  });
});

describe('isInviteCancelled', () => {
  // Drives the struck-through "Cancelled" banner; both signals must count, and
  // matching has to be case-insensitive since providers differ.
  const base = { summary: null, startMs: 0, endMs: null, isAllDay: false, location: null, organizer: null, attendeeCount: 0 };

  it('is true for METHOD:CANCEL', () => {
    expect(isInviteCancelled({ ...base, method: 'CANCEL', status: null })).toBe(true);
    expect(isInviteCancelled({ ...base, method: 'cancel', status: null })).toBe(true);
  });

  it('is true for STATUS:CANCELLED', () => {
    expect(isInviteCancelled({ ...base, method: 'REQUEST', status: 'CANCELLED' })).toBe(true);
    expect(isInviteCancelled({ ...base, method: null, status: 'cancelled' })).toBe(true);
  });

  it('is false for a live invite and for absent fields', () => {
    expect(isInviteCancelled({ ...base, method: 'REQUEST', status: 'CONFIRMED' })).toBe(false);
    expect(isInviteCancelled({ ...base, method: null, status: null })).toBe(false);
  });
});

describe('formatEventRange', () => {
  // Wednesday 19 Aug 2026, 10:00 local. Frozen because dayLabel's Today/Tomorrow
  // come from date-fns isToday/isTomorrow, which read the SYSTEM clock (the `now`
  // argument only drives the weekday/dated branches) — so the clock must be
  // pinned for these to be deterministic.
  const NOW = new Date(2026, 7, 19, 10, 0, 0);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute).getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses the meridiem on the start time within one period', () => {
    // "3:00 – 4:00 PM", not "3:00 PM – 4:00 PM" — the compact Gmail style.
    expect(formatEventRange(at(20, 15), at(20, 16), false, NOW)).toBe('Tomorrow · 3:00 – 4:00 PM');
  });

  it('keeps both meridiems when the range crosses noon', () => {
    expect(formatEventRange(at(20, 11, 30), at(20, 13), false, NOW)).toBe('Tomorrow · 11:30 AM – 1:00 PM');
  });

  it('shows only the start time when there is no end', () => {
    expect(formatEventRange(at(19, 18), null, false, NOW)).toBe('Today · 6:00 PM');
  });

  it('labels a date 2-6 days out by weekday', () => {
    expect(formatEventRange(at(22, 9), at(22, 10), false, NOW)).toBe('Saturday · 9:00 – 10:00 AM');
  });

  it('labels a date a week or more out with an explicit date (same year: no year)', () => {
    expect(formatEventRange(at(27, 9), at(27, 10), false, NOW)).toBe('Thu, Aug 27 · 9:00 – 10:00 AM');
  });

  it('includes the year once the event falls outside the current year', () => {
    const nextYear = new Date(2027, 0, 5, 9, 0).getTime();
    expect(formatEventRange(nextYear, null, false, NOW)).toBe('Tue, Jan 5, 2027 · 9:00 AM');
  });

  it('labels a past event by date (negative day delta, not a weekday)', () => {
    expect(formatEventRange(at(10, 9), at(10, 10), false, NOW)).toBe('Mon, Aug 10 · 9:00 – 10:00 AM');
  });

  it('names both days when a timed event spans midnight', () => {
    expect(formatEventRange(at(20, 22), at(21, 1), false, NOW)).toBe('Tomorrow 10:00 PM – Friday 1:00 AM');
  });

  it('shows a single-day all-day event as just the day (exclusive DTEND collapsed)', () => {
    // The ICS all-day DTEND is exclusive, so start=20th / end=21st is ONE day —
    // rendering "20 – 21" would tell the user the wrong thing.
    expect(formatEventRange(at(20, 0), at(21, 0), true, NOW)).toBe('Tomorrow');
  });

  it('shows a multi-day all-day event through its INCLUSIVE last day', () => {
    // start=20th, exclusive end=23rd ⇒ last day is the 22nd (a Saturday).
    expect(formatEventRange(at(20, 0), at(23, 0), true, NOW)).toBe('Tomorrow – Saturday');
  });

  it('shows just the day for an all-day event with no end', () => {
    expect(formatEventRange(at(20, 0), null, true, NOW)).toBe('Tomorrow');
  });

  it('defaults `now` to the current clock when omitted', () => {
    expect(formatEventRange(at(22, 9), at(22, 10), false)).toBe('Saturday · 9:00 – 10:00 AM');
  });
});
