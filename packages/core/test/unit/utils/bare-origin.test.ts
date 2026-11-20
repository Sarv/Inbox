import { describe, expect, it } from 'vitest';

import { bareHttpOrigin, isBareOrigin } from '../../../src/utils/bare-origin';

/**
 * The one "an origin and nothing else" check, shared by the Sarv reputation
 * destination (where the user's Sarv bearer may go) and the antivirus scanner
 * address. Both compare or send by `URL.origin`, which silently drops
 * credentials, a path, a query and a fragment, so each of those must be
 * refused here or a crafted address compares equal to the allowed one.
 */
describe('bareHttpOrigin', () => {
  // Breaks: a plain origin (with or without its slash, any case, a port, a
  // trailing root dot, surrounding spaces) stops being accepted, so the Sarv
  // reputation service or a scanner is refused with a correct address.
  it('accepts an http(s) origin as typed, and returns it parsed', () => {
    expect(bareHttpOrigin('https://reputation.sarv.com')?.origin).toBe('https://reputation.sarv.com');
    expect(bareHttpOrigin('https://reputation.sarv.com/')?.origin).toBe('https://reputation.sarv.com');
    expect(bareHttpOrigin('  HTTPS://Reputation.Sarv.com:443/  ')?.origin).toBe('https://reputation.sarv.com');
    expect(bareHttpOrigin('https://reputation.sarv.com.:8443')?.host).toBe('reputation.sarv.com.:8443');
    expect(bareHttpOrigin('http://127.0.0.1:8080')?.origin).toBe('http://127.0.0.1:8080');
    // An empty query or fragment carries nothing.
    expect(bareHttpOrigin('https://reputation.sarv.com/?')?.origin).toBe('https://reputation.sarv.com');
    expect(bareHttpOrigin('https://reputation.sarv.com/#')?.origin).toBe('https://reputation.sarv.com');
  });

  // Breaks (token leak): `https://user:pw@<allowed>` has the allowed origin, so
  // without this it would be sent to; a path, query or fragment would be
  // dropped by the origin compare and the address read as something it is not.
  it.each([
    'https://user@reputation.sarv.com',
    'https://user:pw@reputation.sarv.com',
    'https://:pw@reputation.sarv.com',
    'https://reputation.sarv.com/v1',
    'https://reputation.sarv.com/v1/reputation/lookup',
    'https://reputation.sarv.com/..%2f..%2fevil',
    'https://reputation.sarv.com/?next=https://evil.example',
    'https://reputation.sarv.com/#frag',
  ])('refuses an address with more than an origin: %s', (value) => {
    expect(bareHttpOrigin(value)).toBeNull();
  });

  // Breaks: a non-web scheme, a non-string setting or garbage is treated as an
  // origin (or throws) instead of being refused.
  it.each([
    ['another scheme', 'ftp://reputation.sarv.com'],
    ['a file URL', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['not a URL', 'reputation.sarv.com'],
    ['empty', ''],
    ['blank', '   '],
    ['a number', 443],
    ['null', null],
    ['undefined', undefined],
    ['an object', { origin: 'https://reputation.sarv.com' }],
  ])('refuses %s', (_label, value) => {
    expect(bareHttpOrigin(value)).toBeNull();
  });

  // Breaks: a dot segment that resolves back to the root is read as a path and
  // a correct address refused (the parser resolves it before the check).
  it('judges the path after the parser has resolved dot segments', () => {
    expect(bareHttpOrigin('https://reputation.sarv.com/a/..')?.origin).toBe('https://reputation.sarv.com');
  });
});

describe('isBareOrigin', () => {
  // Breaks: a caller with its own scheme rule (the scanner's dev-only loopback
  // http) cannot reuse the component check, and copies it again.
  it('checks only the components, leaving the scheme to the caller', () => {
    expect(isBareOrigin(new URL('http://[::1]:8080/'))).toBe(true);
    expect(isBareOrigin(new URL('https://scanner.test'))).toBe(true);
    expect(isBareOrigin(new URL('https://user:secret@scanner.test'))).toBe(false);
    expect(isBareOrigin(new URL('https://scanner.test/v1'))).toBe(false);
    expect(isBareOrigin(new URL('https://scanner.test/?key=x'))).toBe(false);
    expect(isBareOrigin(new URL('https://scanner.test/#x'))).toBe(false);
  });
});
