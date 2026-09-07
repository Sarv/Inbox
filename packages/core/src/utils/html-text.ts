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
import { convert } from 'html-to-text';

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
export function htmlToPlainText(html: string, options: HtmlToPlainTextOptions = {}): string {
  if (typeof html !== 'string' || html.trim() === '') return '';
  const capped = html.length > MAX_HTML_PARSE_BYTES ? html.slice(0, MAX_HTML_PARSE_BYTES) : html;
  try {
    return convert(capped, {
      wordwrap: false,
      selectors: [
        { selector: 'img', format: 'skip' },
        ...(options.keepLinkHrefs ? [] : [{ selector: 'a', options: { ignoreHref: true } }]),
      ],
    }).trim();
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
