// Mojibake helpers — the Unicode replacement character (U+FFFD) is the tell-tale
// of a decode failure; legitimately decoded text never contains it. Kept here,
// dependency-free, so it's shared and unit-testable without importing the heavy
// (browser-coupled) conversation service.

/** The Unicode replacement character. */
export const REPLACEMENT_CHAR = '�';

/** True when a string carries U+FFFD, i.e. it was decoded from the wrong charset
 *  or from binary bytes (mojibake). Mirrors the body-reheal DB scan
 *  (`instr(clean_body, char(65533))`). */
export function hasReplacementChar(text: string | null | undefined): boolean {
  return !!text && text.includes(REPLACEMENT_CHAR);
}

/** A cached conversation bubble — just the fields the staleness check needs. */
export interface CachedBubbleLike {
  body: string;
  sourceEmailId: string;
}

/** A source email body — just the fields the staleness check needs. */
export interface SourceBodyLike {
  id: string;
  rawBody?: string | null;
  cleanBody?: string | null;
}

/**
 * The conversation extraction cache is keyed by email ID, NOT by body content —
 * so a bubble extracted from a body that was later repaired by the background
 * body-reheal (mojibake → clean re-fetch) keeps returning its stale, garbled text
 * on every reopen. This detects exactly that: a cached bubble carrying U+FFFD
 * whose SOURCE email body is now clean means the DB was healed after the cache was
 * written, so the cache is stale and must be re-extracted.
 *
 * Gated on the source being clean: if a body is STILL corrupt (heal pending or
 * unrepairable), this returns false so reopening a thread never churns the LLM on
 * a body that would just re-extract to the same garbage.
 */
export function cacheHasHealedMojibake(
  bubbles: CachedBubbleLike[],
  sources: SourceBodyLike[],
): boolean {
  const sourceById = new Map(sources.map((e) => [e.id, e]));
  return bubbles.some((m) => {
    if (!hasReplacementChar(m.body)) return false;
    const src = sourceById.get(m.sourceEmailId);
    if (!src) return false; // source gone — leave it to the normal backfill path
    return !hasReplacementChar(src.rawBody) && !hasReplacementChar(src.cleanBody);
  });
}
