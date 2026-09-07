import type { BodyStructure } from '../types/imap';

/**
 * Walk a bodystructure tree and return the IMAP MIME part number of the
 * attachment whose filename matches `filename` (case-insensitive), or null.
 * Prefers the Content-Disposition filename, falls back to the Content-Type
 * `name`. Used to fetch ONE attachment via BODY[part] instead of the whole
 * message. Pure + exported so the matching is unit-testable.
 */
export function findAttachmentPartByName(
  node: BodyStructure | undefined,
  filename: string,
): string | null {
  if (!node || !filename) return null;
  const want = filename.trim().toLowerCase();

  const walk = (n: BodyStructure): string | null => {
    const dispName = n.disposition?.params?.filename;
    const ctName = n.params?.name;
    const name = (dispName || ctName || '').trim().toLowerCase();
    if (name && name === want && n.part) return n.part;
    for (const child of n.parts || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };

  return walk(node);
}
