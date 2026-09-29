/**
 * Where a bubble the HOST built sorts, and how a message it recovered from a
 * quote is dated — by the library's own rules, imported rather than copied.
 *
 * The AI view puts bubbles it built itself (the first email's split parts)
 * between bubbles the library built (every other mail's Standard turns). If
 * the two sorted or dated differently, an AI-recovered message would land out
 * of order against the library's, or an unreadable date would scatter through
 * the thread instead of grouping at its end. So both rules come from
 * `@sarv-in/email-chat-view/transform` (`compareEpochMillis`, `quoteDate`);
 * this module only adapts them to what the host holds: stored dates in epoch
 * SECONDS on one side, the view's epoch MILLISECONDS on the other.
 */
import { compareEpochMillis, quoteDate, type ChatMessage } from '@sarv-in/email-chat-view/transform';

/**
 * Turns in the library's order: oldest first, unreadable (`NaN`) dates LAST,
 * and turns with equal dates kept in the order given (a stable sort, so the
 * caller's order is the tiebreak — as the library's scan order is its).
 * Returns a new array; the turns themselves are not copied.
 */
export function sortTurns<T extends Pick<ChatMessage, 'date'>>(turns: readonly T[]): T[] {
  return [...turns].sort((left, right) => compareEpochMillis(left.date, right.date));
}

/** What {@link clampQuoteDate} decides for one recovered quote. */
export interface ClampedQuoteDate {
  /** Epoch MILLISECONDS; `NaN` only when neither the quote nor its carrier had a readable date. */
  dateMs: number;
  /** True when the date was inferred from the carrier rather than read. */
  approx: boolean;
}

/**
 * Date a quote recovered from `carrierMillis`'s body, exactly as the library
 * dates the quotes IT recovers (`quoteDate`): a read date is believed unless
 * it is LATER than the mail quoting it (a message cannot be quoted before it
 * is written — a later date is a misread, usually day/month), and a missing
 * or refused date becomes the carrier's time moved back one millisecond per
 * quote level, marked approximate.
 *
 * @param readMillis - Epoch ms read for the quote (an attribution line, a
 *   model's echo of it), or `null`/`NaN` when none could be read.
 * @param carrierMillis - The carrier mail's send time in epoch ms (`NaN` when unreadable).
 * @param index - The quote's level in the carrier's body, 1 = the first quote
 *   beneath the carrier's own text, counting down the page (newest to oldest).
 */
export function clampQuoteDate(
  readMillis: number | null,
  carrierMillis: number,
  index: number,
): ClampedQuoteDate {
  // The library infers ONLY for `null`; a NaN read date would be returned as
  // the date, unmarked. An unreadable reading is no reading.
  const read = readMillis === null || Number.isNaN(readMillis) ? null : readMillis;
  const { date, approx } = quoteDate(read, carrierMillis, index);
  return { dateMs: date, approx };
}
