import { describe, it, expect } from 'vitest';

import { MAX_ICS_CHARS, sanitizeIcsText } from '../../../src/utils/calendar';

// sanitizeIcsText is the single gate between an attacker-controlled
// `text/calendar` MIME part and (a) the DB column that stores it and (b) the
// renderer's ical.js parser. Both a resource-exhaustion guard and a "is this
// even an invite" guard — if it lets junk through, the parser runs on hostile
// input and the DB grows without bound.

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'SUMMARY:Standup', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

describe('sanitizeIcsText — accepts real invites', () => {
  it('returns a well-formed iCalendar object unchanged', () => {
    expect(sanitizeIcsText(ICS)).toBe(ICS);
  });

  // MIME parts routinely carry leading/trailing CRLF; trimming keeps the stored
  // value canonical so the same invite hashes/compares equal.
  it('trims surrounding whitespace', () => {
    expect(sanitizeIcsText(`\r\n  ${ICS}  \r\n`)).toBe(ICS);
  });

  // Some servers lowercase the property names; the guard must not reject a valid
  // invite over casing.
  it('accepts a lowercased BEGIN:VCALENDAR', () => {
    expect(sanitizeIcsText('begin:vcalendar\r\nend:vcalendar')).toBe('begin:vcalendar\r\nend:vcalendar');
  });

  it('accepts text exactly at the size cap', () => {
    const padded = `${ICS}\r\nX-PAD:${'x'.repeat(MAX_ICS_CHARS - ICS.length - 8)}`;
    expect(padded.length).toBe(MAX_ICS_CHARS);
    expect(sanitizeIcsText(padded)).toBe(padded);
  });
});

describe('sanitizeIcsText — rejects everything else', () => {
  it('rejects empty and whitespace-only text', () => {
    expect(sanitizeIcsText('')).toBeNull();
    expect(sanitizeIcsText('   \r\n\t ')).toBeNull();
  });

  it('rejects null, undefined and non-string values', () => {
    expect(sanitizeIcsText(null)).toBeNull();
    expect(sanitizeIcsText(undefined)).toBeNull();
    expect(sanitizeIcsText(42 as unknown as string)).toBeNull();
    expect(sanitizeIcsText({ toString: () => ICS } as unknown as string)).toBeNull();
    expect(sanitizeIcsText(Buffer.from(ICS) as unknown as string)).toBeNull();
  });

  // A part mislabelled text/calendar (or an HTML error page from a proxy) must not
  // reach the parser.
  it('rejects text that is not an iCalendar object', () => {
    expect(sanitizeIcsText('BEGIN:VEVENT\r\nSUMMARY:no calendar wrapper\r\nEND:VEVENT')).toBeNull();
    expect(sanitizeIcsText('<html><body>Not an invite</body></html>')).toBeNull();
    expect(sanitizeIcsText('just some words')).toBeNull();
  });

  // Resource-exhaustion guard: one hostile part must not bloat the DB or pin the
  // parser. Checked BEFORE the content sniff, so even a "valid" giant is rejected.
  it('rejects text over the size cap even when it looks like a real invite', () => {
    const huge = `${ICS}\r\nX-PAD:${'x'.repeat(MAX_ICS_CHARS)}`;
    expect(huge.length).toBeGreaterThan(MAX_ICS_CHARS);
    expect(sanitizeIcsText(huge)).toBeNull();
  });
});

describe('MAX_ICS_CHARS', () => {
  // Pinned because both the capture path and the renderer parser budget against
  // it; silently raising it re-opens the DoS window.
  it('is 256 K characters', () => {
    expect(MAX_ICS_CHARS).toBe(256 * 1024);
  });
});
