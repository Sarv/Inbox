// libqp ships no types. Referenced here, not only via core's tsconfig, because
// storage-node type-checks this file from source with its own config.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/vendor/libqp.d.ts" />

// Byte-exact reading of the top level of a MIME message, for OpenPGP.
//
// mailparser decodes everything and throws the wire bytes away, but a detached
// PGP/MIME signature (RFC 3156 §5) is computed over the EXACT bytes of the
// signed part, headers included — decode and re-encode them and the signature
// no longer verifies. So this reads the message the way the RFC defines it:
// header block, blank line, then body parts separated by `--boundary` lines
// (RFC 2046 §5.1.1), keeping every part's bytes untouched. It deliberately
// handles one level only; the PGP structures live at the top of the message.
//
// No OpenPGP code is imported here, so detection stays cheap enough to run on
// every body that is parsed.

import { Headers } from '@zone-eu/mailsplit';
import libmime from 'libmime';
import { decode as decodeQuotedPrintable } from 'libqp';

export interface MimeEntity {
  /** The header block, including the blank line that ends it. */
  headerBytes: Buffer;
  body: Buffer;
  headers: Headers;
  /** Lower-cased media type, e.g. `multipart/signed`. `text/plain` when absent. */
  contentType: string;
  /** Content-Type parameters, keys lower-cased. */
  params: Record<string, string>;
  /** Lower-cased Content-Transfer-Encoding, `''` when the entity declares none. */
  transferEncoding: string;
}

/** The PGP shapes we recognise. `null` from detection means "not PGP". */
export type PgpKind = 'encrypted' | 'signed' | 'inline-encrypted' | 'inline-signed';

const CRLF_CRLF = Buffer.from('\r\n\r\n');
const LF_LF = Buffer.from('\n\n');

/** Split an entity at the first empty line. A message with no body is all header. */
export function splitHeaderBody(raw: Buffer): { headerBytes: Buffer; body: Buffer } {
  const crlf = raw.indexOf(CRLF_CRLF);
  const lf = raw.indexOf(LF_LF);
  // Whichever blank line comes FIRST ends the headers; a bare-LF message can
  // still carry a CRLF pair further down inside its body.
  const candidates = [
    crlf >= 0 ? { at: crlf, len: CRLF_CRLF.length } : null,
    lf >= 0 ? { at: lf, len: LF_LF.length } : null,
  ].filter((c): c is { at: number; len: number } => c !== null);
  if (candidates.length === 0) return { headerBytes: raw, body: Buffer.alloc(0) };
  const first = candidates.reduce((a, b) => (b.at < a.at ? b : a));
  const end = first.at + first.len;
  return { headerBytes: raw.subarray(0, end), body: raw.subarray(end) };
}

export function parseMimeEntity(raw: Buffer): MimeEntity {
  const { headerBytes, body } = splitHeaderBody(raw);
  const headers = new Headers(headerBytes);
  const parsed = libmime.parseHeaderValue(headers.getFirst('content-type') || 'text/plain');
  const params = Object.fromEntries(
    Object.entries(parsed.params ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return {
    headerBytes,
    body,
    headers,
    contentType: (parsed.value || 'text/plain').trim().toLowerCase(),
    params,
    transferEncoding: headers.getFirst('content-transfer-encoding').trim().toLowerCase(),
  };
}

/**
 * The body parts of a multipart body, byte-exact. Per RFC 2046 the CRLF that
 * precedes a delimiter line belongs to the delimiter, not to the part, so it is
 * stripped from each part — that is what makes the first part of a
 * multipart/signed message the same bytes the sender signed.
 */
export function splitMultipartBody(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const delimiter = `--${boundary}`;
  const parts: Buffer[] = [];
  let cursor = -1;
  let searchFrom = 0;
  for (;;) {
    const at = findDelimiterLine(text, delimiter, searchFrom);
    if (at < 0) break;
    if (cursor >= 0) {
      // `at` is past the previous delimiter line, so text[at - 1] is its '\n'.
      const partEnd = text[at - 2] === '\r' ? at - 2 : at - 1;
      parts.push(Buffer.from(text.slice(cursor, Math.max(cursor, partEnd)), 'latin1'));
    }
    const lineEnd = text.indexOf('\n', at);
    const isClose = text.startsWith(`${delimiter}--`, at);
    if (isClose || lineEnd < 0) break;
    cursor = lineEnd + 1;
    searchFrom = cursor;
  }
  return parts;
}

/** A delimiter only counts at the start of a line (RFC 2046 §5.1.1). */
function findDelimiterLine(text: string, delimiter: string, from: number): number {
  let at = text.indexOf(delimiter, from);
  while (at >= 0) {
    if (at === 0 || text[at - 1] === '\n') return at;
    at = text.indexOf(delimiter, at + delimiter.length);
  }
  return -1;
}

/** Undo the transfer encoding of an entity body. */
export function decodeTransferEncoding(body: Buffer, encoding: string): Buffer {
  if (encoding === 'base64') return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body.toString('latin1'));
  return body;
}

const ARMOR_MESSAGE = '-----BEGIN PGP MESSAGE-----';
const ARMOR_SIGNED = '-----BEGIN PGP SIGNED MESSAGE-----';

/**
 * Which PGP shape a raw message has, from its top-level structure alone. The
 * RFC 3156 shapes need the declared protocol as well as the media type, so an
 * S/MIME `multipart/signed` is not mistaken for a PGP one.
 */
export function detectPgpMime(raw: Buffer): PgpKind | null {
  const top = parseMimeEntity(raw);
  const protocol = (top.params.protocol ?? '').toLowerCase();
  if (top.contentType === 'multipart/encrypted' && protocol === 'application/pgp-encrypted') {
    return 'encrypted';
  }
  if (top.contentType === 'multipart/signed' && protocol === 'application/pgp-signature') {
    return 'signed';
  }
  return null;
}

/** Inline ("traditional") PGP inside a plain-text body. */
export function detectInlinePgp(text: string): PgpKind | null {
  if (text.includes(ARMOR_SIGNED)) return 'inline-signed';
  if (text.includes(ARMOR_MESSAGE)) return 'inline-encrypted';
  return null;
}
