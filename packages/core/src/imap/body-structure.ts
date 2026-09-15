import type { BodyStructure } from '../types/imap';

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
 * Did a base64 decode COLLAPSE? True only when a part declares `base64`, the
 * bytes it was decoded from are known, and the decode produced under HALF of
 * them.
 *
 * A base64 decoder keeps only alphabet characters and stops at the first `=`, so
 * a part carrying raw text while claiming base64 collapses to junk —
 * `<p><span style=` decodes to SEVEN bytes. Genuine base64 decodes to about 75%
 * of what it was encoded as and never to under half, so healthy mail cannot trip
 * this.
 *
 * `encodedByteCount` is whatever honest measure of the pre-decode size the
 * caller has: the size the server declared in BODYSTRUCTURE, or — when that
 * cannot be trusted — the length of the part's raw body in the message source.
 * One predicate for both, so the two paths can never disagree about what counts
 * as broken.
 */
export function base64DecodeCollapsed(
  encoding: string | null | undefined,
  encodedByteCount: number,
  decodedLength: number,
): boolean {
  if ((encoding || '').toLowerCase() !== 'base64') return false;
  if (!(encodedByteCount > 0)) return false;
  return decodedLength * 2 < encodedByteCount;
}
