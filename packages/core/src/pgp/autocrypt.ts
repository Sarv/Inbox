// Autocrypt Level 1 headers (https://autocrypt.org/level1.html §2.1): the key
// a sender attaches to every message so correspondents can encrypt back
// without a keyserver.

export type AutocryptPreference = 'mutual' | 'nopreference';

export interface AutocryptHeader {
  addr: string;
  preferEncrypt: AutocryptPreference;
  /** The binary (unarmored) public key. */
  keydata: Buffer;
}

/**
 * Parse one `Autocrypt:` header value. Returns null for anything the spec says
 * to ignore: a missing `addr` or `keydata`, or an unknown attribute not marked
 * optional with a leading underscore (a "critical" attribute we do not
 * understand means we must not act on the header).
 */
export function parseAutocryptHeader(value: string): AutocryptHeader | null {
  const attributes = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      return eq < 0
        ? { name: part.toLowerCase(), value: '' }
        : { name: part.slice(0, eq).trim().toLowerCase(), value: part.slice(eq + 1).trim() };
    });
  const known = new Set(['addr', 'prefer-encrypt', 'keydata']);
  if (attributes.some((attr) => !known.has(attr.name) && !attr.name.startsWith('_'))) return null;
  const find = (name: string) => attributes.find((attr) => attr.name === name)?.value;
  const addr = find('addr')?.toLowerCase();
  const keydataText = find('keydata')?.replace(/\s+/g, '');
  if (!addr || !keydataText) return null;
  const keydata = Buffer.from(keydataText, 'base64');
  if (keydata.length === 0) return null;
  return {
    addr,
    preferEncrypt: find('prefer-encrypt')?.toLowerCase() === 'mutual' ? 'mutual' : 'nopreference',
    keydata,
  };
}

/**
 * Build the header value for our own outgoing mail. The key data is broken
 * with spaces every 72 characters so the header folds on the wire; base64
 * decoders ignore the whitespace, as the spec intends.
 */
export function buildAutocryptHeader(input: AutocryptHeader): string {
  const base64 = input.keydata.toString('base64');
  const folded = base64.match(/.{1,72}/g)?.join(' ') ?? base64;
  const preference = input.preferEncrypt === 'mutual' ? ' prefer-encrypt=mutual;' : '';
  return `addr=${input.addr.toLowerCase()};${preference} keydata=${folded}`;
}
