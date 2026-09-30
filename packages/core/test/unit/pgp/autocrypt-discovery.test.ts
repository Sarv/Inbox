import { describe, expect, it } from 'vitest';

import { buildAutocryptHeader, parseAutocryptHeader } from '../../../src/pgp/autocrypt';
import { keyserverUrl, wkdUrls, zBase32Encode } from '../../../src/pgp/key-discovery';

describe('parseAutocryptHeader', () => {
  const keydata = Buffer.from('fake key bytes');

  // Breaks: keys offered by Autocrypt-capable clients (Delta Chat, K-9, Thunderbird) would be ignored.
  it('reads addr, prefer-encrypt and folded keydata', () => {
    const value = `addr=Bob@Example.com; prefer-encrypt=mutual; keydata=${keydata.toString('base64').replace(/(.{4})/g, '$1 \r\n ')}`;
    expect(parseAutocryptHeader(value)).toEqual({ addr: 'bob@example.com', preferEncrypt: 'mutual', keydata });
  });

  // Breaks: any other prefer-encrypt value must fall back to the neutral default.
  it('defaults prefer-encrypt to nopreference', () => {
    expect(parseAutocryptHeader(`addr=a@x.com; keydata=${keydata.toString('base64')}`)?.preferEncrypt).toBe(
      'nopreference',
    );
  });

  // Breaks: the spec forbids acting on a header with an unknown critical attribute.
  it('ignores headers with unknown critical attributes but accepts optional _ ones', () => {
    const base = `addr=a@x.com; keydata=${keydata.toString('base64')}`;
    expect(parseAutocryptHeader(`${base}; future-thing=1`)).toBeNull();
    expect(parseAutocryptHeader(`${base}; _extra=1`)).not.toBeNull();
    expect(parseAutocryptHeader(`${base}; _flag`)).not.toBeNull();
    expect(parseAutocryptHeader(`${base}; flag`)).toBeNull();
  });

  // Breaks: an incomplete header must not create a keyring entry.
  it('ignores headers missing addr or keydata', () => {
    expect(parseAutocryptHeader(`keydata=${keydata.toString('base64')}`)).toBeNull();
    expect(parseAutocryptHeader('addr=a@x.com')).toBeNull();
    expect(parseAutocryptHeader('addr=a@x.com; keydata=')).toBeNull();
    expect(parseAutocryptHeader('addr=a@x.com; keydata=!!!!')).toBeNull();
  });

  // Breaks: what we send must be readable by the same rules we read with.
  it('round-trips through buildAutocryptHeader, folding long key data', () => {
    const longKey = Buffer.alloc(300, 7);
    const header = buildAutocryptHeader({ addr: 'Me@X.com', preferEncrypt: 'mutual', keydata: longKey });
    expect(header.startsWith('addr=me@x.com; prefer-encrypt=mutual; keydata=')).toBe(true);
    expect(header).toContain(' ');
    expect(parseAutocryptHeader(header)).toEqual({ addr: 'me@x.com', preferEncrypt: 'mutual', keydata: longKey });
    expect(buildAutocryptHeader({ addr: 'a@x.com', preferEncrypt: 'nopreference', keydata: longKey })).not.toContain(
      'prefer-encrypt',
    );
  });
});

describe('WKD', () => {
  // Breaks: every WKD lookup would hit the wrong URL. Vector from
  // draft-koch-openpgp-webkey-service §3.1.
  it('matches the draft test vector', () => {
    expect(wkdUrls('Joe.Doe@Example.ORG')).toEqual({
      advanced: 'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
      direct: 'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    });
  });

  // Breaks: a malformed address must not produce a request to some unrelated host.
  it('returns null for addresses without a local part or domain', () => {
    expect(wkdUrls('nobody')).toBeNull();
    expect(wkdUrls('@x.com')).toBeNull();
    expect(wkdUrls('a@')).toBeNull();
  });

  // Breaks: the encoder's bit packing (the only hand-written part) drifts.
  it('z-base-32 encodes partial trailing groups', () => {
    expect(zBase32Encode(new Uint8Array([]))).toBe('');
    expect(zBase32Encode(new Uint8Array([0xff]))).toBe('9h');
  });
});

describe('keyserverUrl', () => {
  // Breaks: an address with special characters would build a broken or injectable path.
  it('lower-cases and URL-encodes the address', () => {
    expect(keyserverUrl(' Bob+tag@X.com ')).toBe('https://keys.openpgp.org/vks/v1/by-email/bob%2Btag%40x.com');
  });
});
