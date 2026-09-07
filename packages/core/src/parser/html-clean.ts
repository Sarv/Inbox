// HTML cleaner for LLM input — main-process-safe (no DOMParser).
//
// The renderer's `cleanHtmlForAI` (in conversation-service) uses
// DOMParser, which isn't available in Node main. This module is its
// equivalent, built on the `sanitize-html` library (a battle-tested
// HTML tokenizer) instead of a hand-rolled regex chain. Output
// preserves enough HTML structure for the LLM to understand the email
// (paragraphs, lists, tables, links, emphasis) but strips all noise:
//
//   • <style> / <script> / <head> / <meta> / <link> / <title> blocks
//   • MSO conditional comments and other HTML comments
//   • <img> tags (signature logos, tracking pixels, inline base64
//     images that bloat the payload with no semantic value) — kept
//     content images become a short ` [image] ` marker
//   • All inline attributes EXCEPT href on <a> (color, font-family,
//     class, id, data-*, on* event handlers, MSO-specific markup)
//   • Repeated whitespace and empty leftover tags
//
// What's kept: text content, basic structural tags (p, br, div,
// span, h1-h6, ul/ol/li, table/tr/td, blockquote, pre, code, b,
// strong, i, em, a[href]). The LLM gets enough cues to understand
// "this is a list", "this is a quote", "this is a link" without
// drowning in CSS or base64.
//
// This is NOT a security boundary — it shapes email HTML for an LLM
// prompt. sanitize-html is used for its robust tokenizer, not as an
// XSS filter.

import sanitizeHtml from 'sanitize-html';

// Structural/text tags worth keeping so the LLM sees document shape.
// Everything not listed is discarded by sanitize-html (its text kept,
// except for `nonTextTags` below whose text is dropped too).
const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'blockquote', 'pre', 'code',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'mark',
  'sub', 'sup', 'small', 'hr', 'a',
];

/** Decode the most common HTML entities — exhaustive enough for emails. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => {
      const n = parseInt(code, 16);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return _m;
      try { return String.fromCodePoint(n); } catch { return _m; }
    })
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = parseInt(code, 10);
      if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return _m;
      try { return String.fromCodePoint(n); } catch { return _m; }
    });
}

/**
 * Turn a single `<img>` tag into either an empty string (tracker pixels
 * ≤2px or a known-tracker src) or a ` [image] ` text marker for content
 * images. Runs as a PRE-PASS before sanitize-html because the keep-vs-drop
 * decision needs the raw width/height/src attributes, which sanitize-html
 * would otherwise strip. The renderer pipeline
 * (compressHtmlToPlainTextForLLM in conversation-service) does the full
 * cache-ref dance with hashes; this main-process helper is used for
 * reply-draft context and summaries where the LLM doesn't echo an image
 * back, so a simple marker suffices.
 */
function replaceImages(s: string): string {
  return s.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    const w = attrs.match(/\bwidth\s*=\s*['"]?(\d+)/i);
    const h = attrs.match(/\bheight\s*=\s*['"]?(\d+)/i);
    if ((w && parseInt(w[1], 10) <= 2) || (h && parseInt(h[1], 10) <= 2)) return '';
    const srcMatch = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i)
      || attrs.match(/\bsrc\s*=\s*'([^']*)'/i)
      || attrs.match(/\bsrc\s*=\s*([^\s>]+)/i);
    const src = srcMatch?.[1] || '';
    if (!src) return '';
    if (/track\.|\/o\/\?|\/open\?|\/pixel|\/tracking|\/beacon|\/__track|sendclean|hs-analytics|mailchimp\.com\/track|sendgrid\.net\/wf|mailgun.*\/o\/|salesforce\.com\/servlet\/servlet\.ImageServer/i.test(src)) return '';
    return ' [image] ';
  });
}

export interface CleanEmailHtmlOptions {
  /** Truncate the output to this many characters. Default: no truncation. */
  maxLength?: number;
  /**
   * If true, drop <a> href values too — keep only the anchor text. Reduces
   * tokens further but loses the "where does this link go" signal.
   * Default: false (keep href, lets the LLM see suspicious URLs).
   */
  dropLinkHrefs?: boolean;
}

// Hard cap on the raw HTML we feed the cleaner. sanitize-html tokenizes the
// whole input synchronously, so an enormous marketing HTML body would
// otherwise stall the (main-process) call for many ms. The cleaned output is
// truncated to `maxLength` anyway, and the LLM only ever sees a small slice —
// so trimming the INPUT first bounds the work with no loss of useful signal.
const MAX_CLEAN_INPUT_CHARS = 200_000; // ~200 KB of HTML

/**
 * Clean an email's HTML body for an LLM prompt. See file header for
 * what's stripped vs kept.
 */
export function cleanEmailHtmlForLLM(html: string, options: CleanEmailHtmlOptions = {}): string {
  let s = html || '';
  if (!s) return '';
  if (s.length > MAX_CLEAN_INPUT_CHARS) s = s.slice(0, MAX_CLEAN_INPUT_CHARS);

  // 1. Pre-pass: collapse <img> tags into markers / drop trackers before
  //    sanitize-html strips the attributes we need to make that call.
  s = replaceImages(s);

  // 2. sanitize-html does the heavy lifting: it strips <style>/<script>/
  //    <head>/<title>/<noscript> (tag AND text via nonTextTags), drops
  //    <meta>/<link> and every other non-allowed tag, removes HTML comments
  //    (incl. MSO conditionals), and keeps only href on <a>.
  s = sanitizeHtml(s, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: options.dropLinkHrefs ? [] : ['href'] },
    nonTextTags: ['style', 'script', 'head', 'title', 'noscript'],
    disallowedTagsMode: 'discard',
  });

  // 3. Decode entities that sanitize-html re-encodes (&amp;, &nbsp;, …) so
  //    the LLM reads plain text.
  s = decodeEntities(s);

  // 4. Collapse whitespace. Keep paragraph-style breaks (blank lines)
  //    but compress runs of spaces and 3+ blank lines.
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/(\s*\n\s*){3,}/g, '\n\n');

  // 5. Iteratively strip empty tags left behind after sanitize
  //    (e.g. <span> </span> → "", <p></p> → ""). Capped to avoid
  //    pathological loops.
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(/<(\w+)>\s*<\/\1>/g, '');
    s = s.replace(/<(span|small)>([\s\S]*?)<\/\1>/gi, '$2');
    if (s === before) break;
  }

  // 6. Collapse runs of <br> (sanitize-html renders them as `<br />`).
  s = s.replace(/(<br\s*\/?>\s*){3,}/gi, '<br /><br />');

  // 7. Trim and optionally truncate.
  s = s.trim();
  if (options.maxLength && s.length > options.maxLength) {
    s = s.substring(0, options.maxLength);
  }
  return s;
}
