// Body compression for small-context LLMs.
//
// Different aggressiveness levels for different model context windows.
// gemma-4-26B-A4B (sarv-mati-flash) ships with --max-model-len 4096,
// which means a 12KB email body silently gets truncated to the LAST
// ~16KB chars before the model sees it — giving you garbled output
// from the deepest nested layer instead of the top.
//
// This module trades fidelity for fit. None of these compressors
// hallucinate; they only DROP content. Bodies stay verbatim where kept.

/** Rough byte→token estimate. 1 token ≈ 3-4 chars for English. */
export function estimateTokens(s) {
  return Math.ceil((s || '').length / 3.5);
}

// HTML -> text is the app's own conversion (`htmlToPlainText`, the same one
// that fills `cleanBody` for every AI prompt), loaded from the built core
// package through the light `extension-sdk-text` entry point. It used to be a
// chain of regex replacements here, and a regex is not an HTML parser: it
// decoded entities BEFORE stripping tags, so every "&lt;name@host&gt;" became
// a tag and the sender addresses vanished from the text the model was asked to
// ground `from_address` in; and `<script>...</script >` (a legal end tag) left
// its script in the body.
let htmlToPlainText;
try {
  ({ htmlToPlainText } = await import('../../packages/core/dist/extension-sdk-text.mjs'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  throw new Error(
    'packages/core is not built: run `pnpm build:core` first (compress.mjs reuses the app\'s HTML-to-text conversion from its dist).',
    { cause: error }
  );
}

/** A line made only of quote markers: an empty paragraph inside a blockquote. */
const isBlankQuotedLine = (line) => line.replaceAll('>', '').trim() === '';

/**
 * Drop everything that isn't text or a structural cue. Keeps:
 *   - Text content (verbatim, no paraphrase), entities decoded exactly once
 *   - Quote markers ("On X wrote:", "From: ... Sent: ...", "Forwarded message")
 *   - Blockquote indentation as "> " prefix on quoted lines ("> > " nested)
 *   - Email addresses, including the "<name@host>" form
 *
 * Drops:
 *   - Every tag, and the content of <head>, <style>, <script> and comments
 *     (MSO conditionals included); images
 *   - Blank lines, so the output stays compact
 *   - Sarv-specific signature boilerplate (toll-free, social icons, etc)
 *
 * The conversion is the app's, so its quirks are the app's too: headings come
 * back upper-cased, and adjacent table cells run together.
 *
 * @param {string} body The mail body.
 * @param {{ html?: boolean }} [options] `html: false` for a body that is
 *   ALREADY plain text (the DB's clean_body when there is no raw HTML): it is
 *   not parsed as HTML, which would join its lines and eat "<name@host>".
 * @returns {string} Plain text with `> ` prefixes for quoted blocks. About
 *   5-10x smaller than the HTML for typical emails.
 */
export function compressToPlainText(body, { html = true } = {}) {
  if (!body) return '';
  const text = html ? htmlToPlainText(body) : body;
  let result = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !isBlankQuotedLine(line))
    .join('\n');

  // Strip Sarv signature boilerplate that often clutters threads.
  const SIG_NOISE = [
    /www\.sarv\.com\s*\|\s*\+91-\d{4}-\d{4}-\d{2,}/gi,
    /\+91[\s-]\d{4}[\s-]?\d{3,}[\s-]?\d{0,}/gi,
    /1800-12345-6001/g,
    /Email Disclaimer\s*[–-]\s*[^:\n]{1,60}:[\s\S]*?explicitly stated\.?/gi,
    /Get\s*Outlook for iOS/gi,
  ];
  for (const rx of SIG_NOISE) result = result.replace(rx, '');

  return result.trim();
}

/**
 * Even more aggressive: drop the deepest N levels of quoted history
 * to fit in a tight context window. "On X wrote:" attribution lines
 * are kept (so the LLM still knows there WAS a deeper message), but
 * the body of those messages is dropped.
 *
 * Use when even the plain-text version is too big.
 */
export function compressTruncateDepth(plainText, maxDepth) {
  const lines = plainText.split('\n');
  const out = [];
  let truncated = false;
  for (const line of lines) {
    const m = line.match(/^(>\s)+/);
    const depth = m ? m[0].length / 2 : 0;
    if (depth > maxDepth) {
      truncated = true;
      continue;
    }
    out.push(line);
  }
  let result = out.join('\n');
  if (truncated) {
    result += `\n\n[deeper history truncated at depth ${maxDepth}]`;
  }
  return result;
}

/**
 * Smart fit: try plain-text. If still too big for budget, truncate
 * at decreasing depths until it fits. Returns the compressed body
 * AND the depth that was kept (for diagnostics).
 *
 * @param {string} html
 * @param {number} maxBodyChars
 * @param {{ html?: boolean }} [options] As for {@link compressToPlainText}.
 */
export function compressToFit(html, maxBodyChars, options = {}) {
  let body = compressToPlainText(html, options);
  if (body.length <= maxBodyChars) {
    return { body, finalDepth: -1, originalChars: html.length, compressedChars: body.length };
  }
  for (let depth = 8; depth >= 0; depth--) {
    const truncated = compressTruncateDepth(body, depth);
    if (truncated.length <= maxBodyChars) {
      return {
        body: truncated,
        finalDepth: depth,
        originalChars: html.length,
        compressedChars: truncated.length,
      };
    }
  }
  // Even depth=0 doesn't fit — hard truncate the top-level body.
  const top = compressTruncateDepth(body, 0);
  return {
    body: top.slice(0, maxBodyChars),
    finalDepth: 0,
    originalChars: html.length,
    compressedChars: maxBodyChars,
  };
}
