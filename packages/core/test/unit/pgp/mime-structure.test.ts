import { describe, expect, it } from 'vitest';

import {
  decodeTransferEncoding,
  detectInlinePgp,
  detectPgpMime,
  parseMimeEntity,
  splitHeaderBody,
  splitMultipartBody,
} from '../../../src/pgp/mime-structure';

const crlf = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'latin1');

describe('splitHeaderBody', () => {
  // Breaks: the header block would swallow the body (or vice versa) and every
  // PGP part would be read from the wrong offset.
  it('splits at the first CRLF blank line and keeps the blank line with the headers', () => {
    const { headerBytes, body } = splitHeaderBody(crlf(['A: 1', 'B: 2', '', 'body', '', 'more']));
    expect(headerBytes.toString()).toBe('A: 1\r\nB: 2\r\n\r\n');
    expect(body.toString()).toBe('body\r\n\r\nmore');
  });

  // Breaks: a message a server delivered with bare LF endings would read as all header.
  it('accepts bare-LF messages', () => {
    const { headerBytes, body } = splitHeaderBody(Buffer.from('A: 1\n\nbody\r\n\r\nx'));
    expect(headerBytes.toString()).toBe('A: 1\n\n');
    expect(body.toString()).toBe('body\r\n\r\nx');
  });

  // Breaks: an entity with no body made the reader throw instead of returning empty.
  it('treats input with no blank line as headers only', () => {
    const { headerBytes, body } = splitHeaderBody(Buffer.from('A: 1'));
    expect(headerBytes.toString()).toBe('A: 1');
    expect(body.length).toBe(0);
  });
});

describe('splitMultipartBody', () => {
  // Breaks: the signed part would carry the delimiter's CRLF, and every valid
  // PGP/MIME signature would read as forged.
  it('returns each part byte-exact, without the CRLF that belongs to the delimiter', () => {
    const body = crlf(['preamble', '--B', 'P: 1', '', 'one', '--B', 'two', '--B--', 'epilogue']);
    const parts = splitMultipartBody(body, 'B');
    expect(parts.map((part) => part.toString())).toEqual(['P: 1\r\n\r\none', 'two']);
  });

  // Breaks: a line in a part that merely CONTAINS the boundary text would cut the part short.
  it('only honours a delimiter at the start of a line', () => {
    const body = crlf(['--B', 'text mentioning --B inline', '--B--']);
    expect(splitMultipartBody(body, 'B').map(String)).toEqual(['text mentioning --B inline']);
  });

  // Breaks: bare-LF transport would leave a stray CR, or eat a real character.
  it('handles bare-LF delimiters', () => {
    const parts = splitMultipartBody(Buffer.from('--B\none\n--B\ntwo\n--B--\n'), 'B');
    expect(parts.map(String)).toEqual(['one', 'two']);
  });

  // Breaks: a truncated message (no closing delimiter) must not invent a part.
  it('drops an unterminated trailing part', () => {
    expect(splitMultipartBody(crlf(['--B', 'one', '--B', 'cut off']), 'B').map(String)).toEqual(['one']);
  });
});

describe('decodeTransferEncoding', () => {
  // Breaks: a base64-wrapped ciphertext or signature part would be fed to openpgp still encoded.
  it('decodes base64, ignoring line breaks', () => {
    const encoded = Buffer.from('aGVs\r\nbG8=');
    expect(decodeTransferEncoding(encoded, 'base64').toString()).toBe('hello');
  });

  // Breaks: quoted-printable armor would keep its soft line breaks and `=3D` escapes.
  it('decodes quoted-printable, soft breaks and underscores included', () => {
    expect(decodeTransferEncoding(Buffer.from('a=3Db_c=\r\nd'), 'quoted-printable').toString()).toBe('a=b_cd');
  });

  // Breaks: 7bit/8bit/unknown bodies must pass through untouched.
  it('passes identity encodings through', () => {
    const body = Buffer.from('as is');
    expect(decodeTransferEncoding(body, '7bit')).toBe(body);
    expect(decodeTransferEncoding(body, '')).toBe(body);
  });
});

describe('parseMimeEntity', () => {
  // Breaks: missing Content-Type must default the way RFC 2045 says (text/plain).
  it('defaults to text/plain and lower-cases parameters', () => {
    expect(parseMimeEntity(Buffer.from('X: 1\r\n\r\nbody')).contentType).toBe('text/plain');
    const entity = parseMimeEntity(crlf(['Content-Type: Multipart/Signed; Protocol="X"; BOUNDARY=b', '', '']));
    expect(entity.contentType).toBe('multipart/signed');
    expect(entity.params).toMatchObject({ protocol: 'X', boundary: 'b' });
  });
});

describe('detectPgpMime', () => {
  const withType = (contentType: string) => crlf([`Content-Type: ${contentType}`, '', 'x']);

  // Breaks: encrypted mail would keep rendering as an "encrypted.asc" attachment.
  it('recognises RFC 3156 encrypted and signed messages', () => {
    expect(detectPgpMime(withType('multipart/encrypted; protocol="application/pgp-encrypted"; boundary=b'))).toBe(
      'encrypted',
    );
    expect(detectPgpMime(withType('multipart/signed; protocol="application/pgp-signature"; boundary=b'))).toBe(
      'signed',
    );
  });

  // Breaks: an S/MIME signed message would be handed to the OpenPGP verifier and read as forged.
  it('ignores S/MIME and ordinary multiparts', () => {
    expect(detectPgpMime(withType('multipart/signed; protocol="application/pkcs7-signature"; boundary=b'))).toBeNull();
    expect(detectPgpMime(withType('multipart/mixed; boundary=b'))).toBeNull();
    expect(detectPgpMime(withType('text/plain'))).toBeNull();
  });
});

describe('detectInlinePgp', () => {
  // Breaks: inline PGP (mailing lists, older clients) would show as armor soup.
  it('finds clearsigned and encrypted armor in text', () => {
    expect(detectInlinePgp('hi\n-----BEGIN PGP SIGNED MESSAGE-----\n')).toBe('inline-signed');
    expect(detectInlinePgp('-----BEGIN PGP MESSAGE-----')).toBe('inline-encrypted');
    expect(detectInlinePgp('no armor here')).toBeNull();
  });
});
