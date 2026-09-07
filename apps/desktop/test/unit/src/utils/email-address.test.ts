import { describe, it, expect } from 'vitest';

import { parseAddressList, parseAddresses } from '../../../../src/utils/email-address';

describe('parseAddressList', () => {
  // The whole reason this uses the `email-addresses` parser instead of split(',')
  // is the quoted-name case below — a naive split turns one recipient into two
  // broken ones, which then bounces the send.
  it('does NOT split a quoted display name on its internal comma', () => {
    expect(parseAddressList('"Doe, John" <j@x.com>')).toEqual([{ name: 'Doe, John', address: 'j@x.com' }]);
  });

  it('parses a bare address with no display name', () => {
    expect(parseAddressList('a@x.com')).toEqual([{ name: null, address: 'a@x.com' }]);
  });

  it('parses a multi-recipient list, keeping order', () => {
    expect(parseAddressList('Advik <a@x.com>, b@x.com, "C, Jr." <c@x.com>')).toEqual([
      { name: 'Advik', address: 'a@x.com' },
      { name: null, address: 'b@x.com' },
      { name: 'C, Jr.', address: 'c@x.com' },
    ]);
  });

  it('flattens an RFC 5322 group syntax into its member addresses', () => {
    // "Team:a@x,b@x;" is legal in a To: header; the members must still appear
    // as individual recipients rather than being dropped.
    expect(parseAddressList('Team: a@x.com, b@x.com;')).toEqual([
      { name: null, address: 'a@x.com' },
      { name: null, address: 'b@x.com' },
    ]);
  });

  it('returns [] for empty / whitespace / nullish input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('falls back to a comma split when the input is not parseable as addresses', () => {
    // Real headers carry junk (an unquoted name with a stray comma, a
    // half-typed compose field). We must still show the user SOMETHING rather
    // than silently losing the recipients.
    const parsed = parseAddressList('not an address at all');
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed.every((p) => typeof p.address === 'string')).toBe(true);
  });

  it('never throws on hostile input', () => {
    for (const input of ['<<<>>>', '@', ',,,', '"unterminated <a@x.com>', 'a@'.repeat(50)]) {
      expect(() => parseAddressList(input)).not.toThrow();
    }
  });

  it('keeps a display name that is only whitespace as null (no blank name chip)', () => {
    expect(parseAddressList('"   " <a@x.com>')[0].name).toBeNull();
  });
});

describe('parseAddresses', () => {
  it('returns just the bare addresses', () => {
    expect(parseAddresses('Advik <a@x.com>, "Doe, John" <j@x.com>')).toEqual(['a@x.com', 'j@x.com']);
  });

  it('returns [] for empty input', () => {
    expect(parseAddresses(null)).toEqual([]);
  });
});
