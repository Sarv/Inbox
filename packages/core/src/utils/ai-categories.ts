/**
 * The AI's own category verdict, encoded for `emails.ai_categories`.
 *
 * WHY THIS EXISTS: the category-label mirror used to read an email's categories
 * back out of its TAG STRING. That string is a shared bucket — Gmail's
 * `\Important` label, the rule-based importance scorer and the user's manual
 * mark all write into it, and `important` is simultaneously a real AI category
 * slug. So a message Gmail had merely guessed at read back as an AI verdict and
 * got our own `Sarv Inbox/Important` label written onto it in the user's real
 * mailbox, which the label→category recovery then read back as a category. This
 * column breaks that loop by recording what the categorizer actually said,
 * separately from what anything else may have tagged.
 *
 * THREE STATES, and the difference between the last two is the whole point:
 *   null  — no verdict recorded (a pre-existing row, or the AI never ran).
 *           The mirror must do NOTHING: not apply, and above all not strip,
 *           since stripping would pull correct labels off every old message.
 *   []    — the AI ran and chose no category. The mirror SHOULD strip, because
 *           that is how a mail the AI cleared loses its now-stale label.
 *   [...] — the AI's categories, in the order it returned them.
 *
 * The `|a|b|` encoding and its `'||'` empty sentinel are reused from the tag
 * helpers rather than reinvented, so one delimiter rule governs both columns.
 */

import { buildTags, parseTags } from './tags';

/**
 * Encode a categorizer answer for storage. Order is preserved and duplicates are
 * collapsed; an empty answer becomes the `'||'` sentinel, never null, so "ran and
 * chose nothing" stays distinguishable from "never ran".
 */
export function encodeAiCategories(slugs: readonly string[]): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const slug of slugs) {
    const trimmed = (slug ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return buildTags(unique);
}

/**
 * Decode a stored verdict. Returns null for "no verdict recorded" — NULL from
 * the column, and also the empty string a legacy or partially-written row could
 * hold, because neither is evidence the AI chose nothing.
 */
export function decodeAiCategories(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  return parseTags(raw);
}

/**
 * The categories the mirror should apply, or null when it must not touch this
 * email's labels at all.
 *
 * `knownSlugs` filters the verdict down to categories this account actually
 * defines: a category the user deleted must not keep a label alive, and a slug
 * the model invented must never become a mailbox. Filtering can legitimately
 * empty a non-null verdict — that stays `[]` (strip), not null (skip), because
 * the AI did run.
 */
export function mirrorableCategories(
  raw: string | null | undefined,
  knownSlugs: ReadonlySet<string>,
): string[] | null {
  const verdict = decodeAiCategories(raw);
  if (verdict === null) return null;
  return verdict.filter((slug) => knownSlugs.has(slug));
}

/** What the label drain should do with one pending row. */
export type LabelDrainDecision =
  | { action: 'retire' }
  | { action: 'mirror'; categories: string[] };

/**
 * The drain's per-row policy, kept pure so it can be asserted without a mailbox.
 *
 * `retire` means flip `label_status` to 'done' WITHOUT touching the server: the
 * row has no recorded verdict, so we do not know what to apply and must not
 * strip. Retiring rather than skipping is deliberate — the drain re-selects the
 * same newest-first page every tick, so a row that is skipped in place is
 * re-selected forever and starves genuinely pending mail behind it.
 *
 * `mirror` carries the categories to reconcile, and an EMPTY list is a real
 * instruction: strip the stale account labels off mail the AI cleared.
 */
export function labelDrainDecision(
  raw: string | null | undefined,
  knownSlugs: ReadonlySet<string>,
): LabelDrainDecision {
  const categories = mirrorableCategories(raw, knownSlugs);
  return categories === null ? { action: 'retire' } : { action: 'mirror', categories };
}
