/**
 * HTML → readable plain text, in one place.
 *
 * Two callers need the same thing and used to configure `html-to-text` inline:
 * the body parser (an HTML-only mail has no text/plain part, so `cleanBody` —
 * which feeds the list snippet and every AI prompt — would otherwise be stored
 * EMPTY) and contact signature mining (raw HTML scrapes numeric junk out of
 * attributes, so it converts to text first).
 *
 * `html-to-text` rather than a regex or the Markdown converter: tag-stripping by
 * regex mangles real-world marketing HTML, and Markdown keeps `![](…)` image and
 * link URLs — a tracking pixel then becomes the first 2 KB of the snippet.
 * `html-to-text` drops images and renders block structure as newlines.
 */
import { compile, type FormatCallback } from 'html-to-text';

import { MAX_HTML_PARSE_BYTES } from './mail-parse';

export interface HtmlToPlainTextOptions {
  /**
   * Keep each link's `href` in the output (`text [https://…]`). Off for
   * anything a human reads (snippets); on for mining, where a `mailto:`/`tel:`
   * href is itself a signal.
   */
  keepLinkHrefs?: boolean;
}

/**
 * Visible text of an HTML fragment. Never throws — returns `''` for empty,
 * non-string, or unconvertible input, because every caller is on a path where a
 * malformed body must not fail the whole message.
 *
 * Size-capped with the same {@link MAX_HTML_PARSE_BYTES} budget the mailparser
 * call sites use: bodies are attacker-controlled and conversion is synchronous
 * CPU work on the main thread.
 */
/**
 * One compiled converter per option set, built on first use. `convert()`
 * recompiles its selector tree on EVERY call — profiled at two thirds of the
 * time an unread review spends scanning 2,000 bodies — so compile once and reuse.
 */
const converters = new Map<boolean, (html: string) => string>();

/**
 * A table cell is a word boundary. `html-to-text` only lays out tables it is
 * told are data tables; every other `<td>`/`<th>` renders as bare inline text,
 * so a minified signature table (`<td>Arun</td><td>+91 98…</td>`) came out as
 * "Arun+91 98…" — a name glued to a number, which phone mining and snippets
 * then read as one word. Spaces added inline collapse like source whitespace:
 * an empty spacer cell adds nothing, and none survives at a line's edge.
 */
const formatTableCell: FormatCallback = (elem, walk, builder) => {
  builder.addInline(' ');
  walk(elem.children, builder);
  builder.addInline(' ');
};

function converterFor(keepLinkHrefs: boolean): (html: string) => string {
  const cached = converters.get(keepLinkHrefs);
  if (cached) return cached;
  const converter = compile({
    wordwrap: false,
    formatters: { tableCell: formatTableCell },
    selectors: [
      { selector: 'img', format: 'skip' },
      ...(keepLinkHrefs ? [] : [{ selector: 'a', options: { ignoreHref: true } }]),
      // Each row on its own line, its cells on that line (see formatTableCell).
      { selector: 'tr', format: 'block', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
      { selector: 'td', format: 'tableCell' },
      { selector: 'th', format: 'tableCell' },
    ],
  });
  converters.set(keepLinkHrefs, converter);
  return converter;
}

export function htmlToPlainText(html: string, options: HtmlToPlainTextOptions = {}): string {
  if (typeof html !== 'string' || html.trim() === '') return '';
  const capped = html.length > MAX_HTML_PARSE_BYTES ? html.slice(0, MAX_HTML_PARSE_BYTES) : html;
  try {
    return converterFor(options.keepLinkHrefs === true)(capped).trim();
  } catch {
    return '';
  }
}

/**
 * Repaired `clean_body` for a row that stored it EMPTY while the raw body was
 * downloaded fine — the HTML-only-mail bug above, for rows written before the
 * parser fix. Returns `null` when there is nothing to repair (clean_body already
 * has text) or nothing to repair FROM (no raw body, or a raw body with no
 * readable text at all, e.g. an image-only mail), so the caller can skip the
 * write instead of churning a fat row for no gain.
 *
 * Pure: the caller owns the read and the write.
 */
export function repairedCleanBody(
  cleanBody: string | null | undefined,
  rawBody: string | null | undefined,
): string | null {
  if (typeof cleanBody === 'string' && cleanBody.trim() !== '') return null;
  if (typeof rawBody !== 'string' || rawBody.trim() === '') return null;
  const text = htmlToPlainText(rawBody);
  return text === '' ? null : text;
}

/**
 * The slice of an oversized body worth converting when mining a signature.
 *
 * Mining used to keep the LAST `budget` characters, on the reasoning that a
 * signature is the last thing in a message. That holds for a first message and
 * is false for a reply: mail clients top-post, so the new text — and the
 * sender's OWN signature under it — sits at the TOP, with the quoted chain
 * below. Slicing from the end of a long reply thread therefore discarded the
 * one signature that belongs to the sender and kept whoever's signature ended
 * the quoted chain, which is how a frequent correspondent can put their mobile
 * in every mail they send and still show no number on their contact card.
 *
 * So take BOTH ends, half the budget each. The cut points move to the nearest
 * tag boundary so neither piece begins or ends inside a tag — a half-tag's
 * leftover attributes convert to visible words, which is exactly the numeric
 * junk converting-before-mining exists to avoid.
 *
 * The two pieces are joined by a separator that SURVIVES conversion (a `<br>`
 * for HTML, a blank line otherwise): butted together, the last digits of the
 * head and the first digits of the tail would read as one number that no one
 * ever wrote.
 *
 * Pure. Returns the input unchanged when it already fits.
 */
export function htmlMiningWindow(html: string, budget: number): string {
  if (typeof html !== 'string' || html === '') return '';
  if (budget <= 0 || html.length <= budget) return html;

  const half = Math.floor(budget / 2);

  // Head: drop a trailing partial tag (a `<` with no `>` after it).
  let head = html.slice(0, half);
  const lastOpen = head.lastIndexOf('<');
  if (lastOpen > head.lastIndexOf('>')) head = head.slice(0, lastOpen);

  // Tail: drop a leading partial tag (a `>` that closes a tag opened before
  // the cut, i.e. one that arrives before any `<` of our own).
  let tail = html.slice(-half);
  const firstOpen = tail.indexOf('<');
  const firstClose = tail.indexOf('>');
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) tail = tail.slice(firstClose + 1);

  return `${head}${html.includes('<') ? '\n<br>\n' : '\n\n'}${tail}`;
}
