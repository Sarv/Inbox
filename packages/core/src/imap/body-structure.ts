import type { BodyStructure } from '../types/imap';

/** Exact part handles keep attachments with identical names distinct. */
export function attachmentNodes(node: BodyStructure | undefined): BodyStructure[] {
  if (!node) return [];
  const own = node.part && (node.disposition?.type?.toLowerCase() === 'attachment' ||
    node.disposition?.params?.filename || node.params?.name) ? [node] : [];
  return [...own, ...(node.parts ?? []).flatMap(attachmentNodes)];
}

/**
 * Walk a bodystructure tree and return the NODE of the attachment whose filename
 * matches `filename` (case-insensitive), or null. Prefers the
 * Content-Disposition filename, falls back to the Content-Type `name`, and only
 * matches a node that carries a part number (the thing a BODY[part] fetch
 * needs). The node — not just its number — because its declared `encoding` and
 * `size` are what tell a caller whether the bytes it got back are plausible.
 */
export function findAttachmentNodeByName(
  node: BodyStructure | undefined,
  filename: string,
): BodyStructure | null {
  if (!node || !filename) return null;
  const want = filename.trim().toLowerCase();

  const walk = (n: BodyStructure): BodyStructure | null => {
    const dispName = n.disposition?.params?.filename;
    const ctName = n.params?.name;
    const name = (dispName || ctName || '').trim().toLowerCase();
    if (name && name === want && n.part) return n;
    for (const child of n.parts || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };

  return walk(node);
}

/**
 * The IMAP MIME part number of that same attachment, or null. Used to fetch ONE
 * attachment via BODY[part] instead of the whole message. Pure + exported so the
 * matching is unit-testable.
 */
export function findAttachmentPartByName(
  node: BodyStructure | undefined,
  filename: string,
): string | null {
  return findAttachmentNodeByName(node, filename)?.part ?? null;
}

/**
 * Did a base64 decode come back SHORT of anything genuine base64 produces? True
 * only when a part declares `base64`, the bytes it was decoded from are known,
 * and the decode is under 70% of them, less two bytes of padding.
 *
 * A base64 decoder silently drops every byte outside its alphabet, so a part
 * carrying raw text while claiming base64 decodes to junk built from its
 * letters alone. libbase64 up to 1.3.0 also stopped at the first `=`, which
 * collapsed `<p><span style=` to SEVEN bytes; 1.3.1 decodes every `=`-separated
 * segment (correct for mail that pads each line), so the same text now decodes
 * to just over HALF its length — 34 bytes from 64. An "under half" test stopped
 * seeing it, and the junk was served again.
 *
 * Genuine base64 decodes to 3/4 of its alphabet characters less at most two
 * bytes of padding, which with a line break every 76 characters is about 73%
 * of the part; any wrapping of 28 characters or more stays above the 70% line
 * at every size. Text decodes to 3/4 of its letters and digits, well under it.
 *
 * Shortness is grounds to LOOK at the part's raw bytes, not proof: genuine
 * base64 wrapped at under 28 characters a line dips below the line too. The
 * verdict is `misdeclaredBase64`, which needs those bytes. Callers that cannot
 * read them (the antivirus scan) treat a short decode as uninspectable.
 *
 * `encodedByteCount` is whatever honest measure of the pre-decode size the
 * caller has: the size the server declared in BODYSTRUCTURE, or — when that
 * cannot be trusted — the length of the part's raw body in the message source.
 * One predicate for every path, so they can never disagree about what counts
 * as suspect.
 */
export function base64DecodeShort(
  encoding: string | null | undefined,
  encodedByteCount: number,
  decodedLength: number,
): boolean {
  if ((encoding || '').toLowerCase() !== 'base64') return false;
  if (!(encodedByteCount > 0)) return false;
  // decoded < 0.7 × encoded − 2, in integers.
  return decodedLength * 10 < encodedByteCount * 7 - 20;
}

/** 1 for every byte a base64 encoder writes: its alphabet, `=` padding, CR, LF. */
const BASE64_OUTPUT_BYTES = (() => {
  const table = new Uint8Array(256);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = 1;
  return table;
})();

/**
 * How many bytes of `bytes` no base64 encoder writes — anything outside the
 * alphabet, `=` padding and line breaks. Spaces and tabs count: an encoder never
 * emits them, and in prose they are about one byte in six. A pure byte loop
 * rather than a library: "is this valid base64" validators reject on the first
 * stray byte, and the question here is how MANY there are.
 */
export function countNonBase64Bytes(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (BASE64_OUTPUT_BYTES[bytes[i]] === 0) count++;
  }
  return count;
}

/**
 * Does a part that declares `base64` actually carry something else? The verdict
 * that decides whether to serve a part's RAW bytes instead of its decode.
 *
 * Both halves must hold: the decode is short (`base64DecodeShort`), AND more
 * than one byte in ten of the raw part is a byte no base64 encoder writes
 * (`nonBase64Bytes`, from `countNonBase64Bytes`). Genuine base64 has none, bar
 * the odd trailing space a relay leaves on a line; HTML or prose mislabelled
 * base64 has a quarter or more in markup, punctuation and spaces. A short decode
 * of a part that IS base64 — a 10-byte file, an odd line length — keeps its
 * decode: serving the raw bytes there would hand the user base64 text.
 *
 * The byte count is what makes this independent of the decoder. The decode
 * length alone tracked one decoder's quirk and broke when libbase64 fixed it.
 */
export function misdeclaredBase64(
  encoding: string | null | undefined,
  encodedByteCount: number,
  decodedLength: number,
  nonBase64Bytes: number,
): boolean {
  if (!base64DecodeShort(encoding, encodedByteCount, decodedLength)) return false;
  return nonBase64Bytes * 10 > encodedByteCount;
}
