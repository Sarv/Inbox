import { describe, it, expect } from 'vitest';

import { normalizePhoneToE164, normalizePhones } from '../../../src/contact-enrichment/phone-normalizer';

// Phone normalization backs contact-identity dedup: "+91 98765 43210",
// "9876543210" and "(+91)-98765 43210" must collapse to one E.164 string, while
// a bare FOREIGN number must NOT be mis-prefixed to the default country (which
// would corrupt dedup). Regressions here silently merge or split contacts.

describe('normalizePhoneToE164', () => {
  it('collapses varied formats of the same Indian mobile to one E.164 value', () => {
    const forms = ['+91 98765 43210', '(+91)-98765 43210', '+919876543210'];
    const out = forms.map((f) => normalizePhoneToE164(f));
    expect(new Set(out)).toEqual(new Set(['+919876543210']));
  });

  it('treats a BARE national number as the default country', () => {
    expect(normalizePhoneToE164('9876543210', 'IN')).toBe('+919876543210');
  });

  it('honors an explicit international prefix over the default country', () => {
    expect(normalizePhoneToE164('+1 415 555 2671', 'IN')).toBe('+14155552671');
  });

  it('rejects a bare number that is not a plausible number for the default country', () => {
    // A too-short bare number can't be a valid IN number, so it's dropped rather
    // than mis-prefixed. (Note: a bare number IS assumed to be in defaultCountry —
    // callers must pass the account's region so foreign bare numbers aren't a risk.)
    expect(normalizePhoneToE164('12345', 'IN')).toBeNull();
  });

  it('returns null for empty or junk input (never throws)', () => {
    expect(normalizePhoneToE164('')).toBeNull();
    expect(normalizePhoneToE164('not a phone')).toBeNull();
    expect(normalizePhoneToE164('12')).toBeNull();
  });
});

describe('normalizePhones (batch)', () => {
  it('dedupes format variants and preserves first-seen order, dropping unparseable', () => {
    const out = normalizePhones([
      '+91 98765 43210',      // -> +919876543210
      'not a phone',          // dropped
      '+1 415 555 2671',      // -> +14155552671
      '(+91) 98765 43210',    // dup of the first -> dropped
    ], 'IN');
    expect(out).toEqual(['+919876543210', '+14155552671']);
  });

  it('returns [] for an all-junk list', () => {
    expect(normalizePhones(['', 'abc', '12'], 'IN')).toEqual([]);
  });
});
