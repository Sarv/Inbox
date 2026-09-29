/**
 * Where somebody else's email begins — `@sarv-in/mailguard/quote` now.
 *
 * The markers and the cut were written here, for two callers that must not
 * drift apart: signature mining (which otherwise attributes the quoted
 * sender's phone number to whoever forwarded it) and bulk-mail classification
 * (which otherwise condemns a human reply for the tracking links of the
 * newsletter quoted underneath it — the longer the thread, the more certain
 * the misfire). The library had grown its own list for a third caller, the
 * spam scorer, so the two were folded into one corpus there and this module
 * became the seam. A marker list in two places is the worst kind of
 * duplication: both copies keep returning a plausible string while they drift.
 *
 * Imported from the `/quote` subpath, NOT the package root, and that is
 * load-bearing: `bulk-mail.ts` imports this module and is aliased straight
 * into the renderer bundle (see `apps/desktop/vite/renderer-aliases.ts`), so
 * whatever it imports, the browser imports. The root entry pulls in the
 * scorer's address parser and freemail corpus — the latter a CommonJS array
 * with no default export, which the Vite dev server serves unconverted and
 * which blanks the window. `/quote` is zero-dependency by contract, and the
 * library has a test that keeps it that way.
 *
 * WHAT CHANGED IN THE FOLD: the cut now also fires on an attribution that
 * opens with a name rather than "On", and it no longer fires on a bare
 * `From:` line or a five-character underscore rule — both of which appear in
 * ordinary prose and directly above the signature this strip exists to keep.
 * `stripQuotedTail` still leaves the signature in place; the library's
 * `ownWords` is the same cut with the sign-off removed, which is what a
 * scorer wants and what a contact miner must never be given.
 */
import { QUOTE_MARKERS } from '@sarv-in/mailguard/quote';

import { htmlToPlainText } from './html-text';
import { MAX_HTML_PARSE_BYTES } from './mail-parse';

export { QUOTE_MARKERS, stripQuotedTail } from '@sarv-in/mailguard/quote';

/**
 * The library's markers that open an ATTRIBUTION — "On … wrote:", "Am …
 * schrieb", "-----Original Message-----", Outlook's `From:`/`Sent:` block — as
 * GLOBAL clones, so every occurrence can be found (the library's own are
 * deliberately stateless, non-global). Two are left out, each for a reason:
 *
 *   * the `>` prefix: it marks every LINE of a quote, not the start of one, so
 *     counting it would count lines. Nesting depth is measured separately.
 *   * the long underscore rule: Outlook draws it directly above the `From:`
 *     block that is already counted, and a user's own separator above a
 *     signature would otherwise read as a quoted message.
 *
 * Picked out by what they MATCH rather than by their source text, so a
 * re-worded pattern upstream keeps its classification.
 */
const ATTRIBUTION_MARKERS: readonly RegExp[] = QUOTE_MARKERS
  .filter((marker) => !marker.test('> quoted line') && !marker.test('_'.repeat(30)))
  .map((marker) => new RegExp(marker.source, `${marker.flags.replace('g', '')}g`));

/**
 * Two attribution hits this many lines apart (or closer) are ONE quoted
 * message: Outlook's "-----Original Message-----" sits directly above its
 * `From:`/`Sent:` block, and Apple's "Begin forwarded message:" directly above
 * its own — or one blank line above, when the client (or the HTML converter,
 * for `<p>…</p><p>…</p>`) puts them in separate paragraphs.
 *
 * Lines are counted with every RUN of blank lines taken as one, so extra
 * vertical space is layout rather than distance, while a single blank line —
 * the `>` line between two short replies in a Gmail chain — still separates.
 * Measured from the first hit of a group, not chained, so a dense run of short
 * replies still counts per message.
 */
const SAME_ATTRIBUTION_WINDOW_LINES = 2;

/** Leading `>` depth of one line (`> > x` and `>> x` are both 2), and the text after it. */
function splitQuotePrefix(line: string): { depth: number; rest: string } {
  let depth = 0;
  let restStart = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '>') {
      depth += 1;
      restStart = i + 1;
    } else if (ch !== ' ' && ch !== '\t') {
      break;
    }
  }
  return depth === 0 ? { depth, rest: line } : { depth, rest: line.slice(restStart).trimStart() };
}

/** Index of the line containing `offset`, given each line's start offset (ascending). */
function lineIndexAt(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** A marker hit as the lines its VISIBLE text spans (see `SAME_ATTRIBUTION_WINDOW_LINES`). */
interface MarkerHit {
  start: number;
  end: number;
}

/**
 * Count attribution GROUPS — one per quoted message. A hit belongs to the
 * current group when either
 *
 *   * it OVERLAPS the lines the group's text covers: several markers matched
 *     the same attribution with different extents. `^On\b…wrote:` may start
 *     at a line of the reply's own prose ("On it!", "On Monday we…") and run
 *     down to the real attribution a few lines below, where the
 *     address-and-`wrote:` marker also fires — one attribution, however far
 *     the prose line sits above it; or
 *   * it STARTS within `SAME_ATTRIBUTION_WINDOW_LINES` of the group's first
 *     hit: a second marker of the same attribution on a nearby line (a
 *     separator and its header block).
 *
 * A hit joined for nearness does NOT widen the lines the group covers. The
 * case-insensitive `On <weekday>…wrote:` marker also fires inside prose ("we
 * meet on Friday") and runs to the NEXT attribution's `wrote:`; letting that
 * span extend the group would swallow a genuine second quoted message.
 */
function countAttributionGroups(hits: MarkerHit[]): number {
  hits.sort((a, b) => a.start - b.start || a.end - b.end);
  let groups = 0;
  let anchor = Number.NEGATIVE_INFINITY;
  let reach = Number.NEGATIVE_INFINITY;
  for (const hit of hits) {
    if (hit.start <= reach) {
      reach = Math.max(reach, hit.end);
    } else if (hit.start > anchor + SAME_ATTRIBUTION_WINDOW_LINES) {
      groups += 1;
      anchor = hit.start;
      reach = hit.end;
    }
  }
  return groups;
}

/**
 * How many earlier messages a body QUOTES, estimated from its text alone — the
 * fallback for when the chat view's structural split finds no quoted turns
 * (plain-text mail, a client whose HTML it does not recognise) but the mail
 * plainly carries a looped-in history.
 *
 *   * Distinct ATTRIBUTIONS (the library's {@link QUOTE_MARKERS} corpus, see
 *     `ATTRIBUTION_MARKERS`). Each hit is placed by the lines its VISIBLE text
 *     spans — the markers open with `^\s*`, so under `/m` a raw match starts
 *     on the blank line above a separator — and hits of one attribution are
 *     merged (see `countAttributionGroups`). So Outlook's separator plus its
 *     `From:` block is one message whether or not a blank line parts them,
 *     and a reply whose own text has a line starting "On" is not counted twice.
 *   * For PLAIN TEXT only, the deepest `>` nesting too, which is how a
 *     plain-text chain shows how many messages it holds; the larger reading
 *     wins. HTML's nesting is NOT read: a converted `<blockquote>` is as often
 *     formatting (Gmail's "Indent more", a pasted block) as a quote, and this
 *     runs precisely when the structural split, which does understand quote
 *     blockquotes, found none — so an HTML nest with no attribution is
 *     counted as 0, and an HTML chain is counted by its attributions.
 *
 * Attribution markers run on the text with each line's `>` prefix removed, so
 * an attribution INSIDE a quote ("> On Mon, … wrote:") is still found.
 *
 * `format` must say what the body is. Plain text is never run through the
 * HTML converter: that collapses newlines, which erases both the `>` structure
 * and every line-anchored marker.
 *
 * An estimate, never a parse: prose that happens to end in "<address> wrote:"
 * reads as an attribution (the library's known limitation), and a chain that
 * a converter flattened onto one line reads as one message. Never throws;
 * returns 0 for an empty body.
 */
export function quoteMarkerCount(body: string | null | undefined, format: 'html' | 'text'): number {
  if (typeof body !== 'string' || body.trim() === '') return 0;
  const text = format === 'html' ? htmlToPlainText(body) : body.slice(0, MAX_HTML_PARSE_BYTES);
  if (!text) return 0;

  let deepest = 0;
  const lineStarts: number[] = [];
  // Per raw line, its distance index: runs of blank lines count as one line
  // (see SAME_ATTRIBUTION_WINDOW_LINES).
  const distanceLine: number[] = [];
  const dequoted: string[] = [];
  let offset = 0;
  let distance = -1;
  let previousBlank = false;
  for (const line of text.split(/\r?\n/)) {
    const { depth, rest } = splitQuotePrefix(line);
    if (depth > deepest) deepest = depth;
    const blank = rest.trim() === '';
    if (!(blank && previousBlank)) distance += 1;
    previousBlank = blank;
    lineStarts.push(offset);
    distanceLine.push(distance);
    dequoted.push(rest);
    offset += rest.length + 1;
  }
  const flat = dequoted.join('\n');
  const lineAt = (at: number): number => distanceLine[lineIndexAt(lineStarts, at)];

  const hits: MarkerHit[] = [];
  for (const marker of ATTRIBUTION_MARKERS) {
    for (const match of flat.matchAll(marker)) {
      const { index } = match;
      const matched = match[0];
      // Every marker needs visible characters, so both trims leave some.
      const first = index + (matched.length - matched.trimStart().length);
      const last = index + matched.trimEnd().length - 1;
      hits.push({ start: lineAt(first), end: lineAt(last) });
    }
  }

  const attributions = countAttributionGroups(hits);
  return format === 'text' ? Math.max(attributions, deepest) : attributions;
}
