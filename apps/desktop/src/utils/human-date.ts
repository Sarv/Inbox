import * as chrono from 'chrono-node';

/**
 * Parse a human-written date string — an email attribution line, a
 * forwarded/original-message header, or an LLM-echoed date — into unix SECONDS.
 *
 * Uses chrono-node's DAY-FIRST (en.GB) locale so ambiguous numeric dates like
 * "07/08/2026" resolve as 7 Aug (DD/MM) — the convention these mailboxes use —
 * instead of the US MM/DD that `Date.parse` / `new Date()` / DEFAULT chrono
 * force (that bias is what turned a 7-Aug mail into "Jul 8" in the conversation
 * view). Unambiguous shapes — textual months ("Jul 9, 2026"), or a leading
 * number > 12 ("4/17/2026") — parse identically either way, so nothing US-style
 * regresses.
 *
 * `refDate` anchors any relative expressions ("yesterday", "2 days ago") that
 * occasionally survive into a quote. Returns null when nothing date-like is
 * found — callers treat null (or 0) as "date unknown".
 *
 * THE single day-first parser on the app side: the AI conversation extractor
 * (conversation-service) reads it. The deterministic split reads the identical
 * rules from `email-chat-view`'s `parseHumanDate`, so the two views can never
 * disagree on a date again.
 */
export function parseHumanDateToEpochSec(
  raw: string | undefined | null,
  refDate?: Date,
): number | null {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  try {
    const d = chrono.en.GB.parseDate(s, refDate);
    return d ? Math.floor(d.getTime() / 1000) : null;
  } catch {
    return null;
  }
}
