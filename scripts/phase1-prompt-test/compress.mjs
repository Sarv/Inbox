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

// Sentinels that mark blockquote open/close boundaries while the HTML is
// flattened to text. U+0001 (SOH) never occurs in real mail bodies, so it
// cannot collide with content. Spelled as an escape so this file stays plain
// UTF-8 text (a literal control byte made `file` classify it as binary "data").
const SENTINEL = '\u0001';
const OPENQ = `${SENTINEL}OPENQ${SENTINEL}`;
const CLOSEQ = `${SENTINEL}CLOSEQ${SENTINEL}`;

/**
 * Drop everything that isn't text or a structural cue. Keeps:
 *   • Text content (verbatim, no paraphrase)
 *   • Quote markers ("On X wrote:", "From: ... Sent: ...", "Forwarded message")
 *   • Blockquote indentation as "> " prefix on quoted lines
 *   • Email addresses (already in source)
 *
 * Drops:
 *   • All HTML tags (kept as text only)
 *   • Inline styles, classes, ids, font-family / color / etc
 *   • Tables → rendered as text rows
 *   • Repeated whitespace
 *   • Sarv-specific signature blocks (toll-free, social icons, etc)
 *
 * Output is plain text with `> ` prefixes for quoted blocks. About
 * 5-10× smaller than the HTML for typical emails.
 */
export function compressToPlainText(html) {
  let s = html || '';
  if (!s) return '';

  // Decode common HTML entities first so we don't lose them when stripping tags.
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/g, "'");

  // Strip MSO conditionals, comments, style/script blocks, head, etc.
  s = s.replace(/<!--\[if[^]*?<!\[endif\]-->/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

  // Drop images entirely (the LLM can't see them).
  s = s.replace(/<img[^>]*\/?>/gi, '');

  // Track blockquote depth for "> " prefixing.
  // Replace <blockquote> open with marker, </blockquote> with end marker,
  // then we'll process line-by-line.
  s = s.replace(/<blockquote[^>]*>/gi, OPENQ);
  s = s.replace(/<\/blockquote>/gi, CLOSEQ);

  // <br>, </p>, </div>, </tr> become newlines so we get per-line text.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  // Cells separated by tab so a flattened table is at least readable
  s = s.replace(/<\/td>/gi, '\t');

  // Strip every remaining tag (keeping text content).
  s = s.replace(/<[^>]+>/g, '');

  // Collapse runs of spaces/tabs.
  s = s.replace(/[ \t]+/g, ' ');
  // Trim each line.
  s = s.split('\n').map(line => line.trim()).join('\n');
  // Collapse 3+ blank lines.
  s = s.replace(/\n{3,}/g, '\n\n');

  // Now apply blockquote prefixes. Walk lines, track depth.
  const lines = s.split('\n');
  const out = [];
  let depth = 0;
  for (const line of lines) {
    // Markers may appear mid-line if a blockquote opens/closes inline.
    // Process them in order.
    let rest = line;
    while (rest.length > 0) {
      const open = rest.indexOf(OPENQ);
      const close = rest.indexOf(CLOSEQ);
      const next = (open === -1) ? close : (close === -1) ? open : Math.min(open, close);
      if (next === -1) {
        const text = rest.trim();
        if (text) out.push('> '.repeat(depth) + text);
        break;
      }
      const before = rest.slice(0, next).trim();
      if (before) out.push('> '.repeat(depth) + before);
      if (rest.charAt(next) === SENTINEL && rest.startsWith(OPENQ, next)) {
        depth++;
        rest = rest.slice(next + OPENQ.length);
      } else {
        depth = Math.max(0, depth - 1);
        rest = rest.slice(next + CLOSEQ.length);
      }
    }
  }
  // Drop empty lines created by stripping.
  let result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

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
 */
export function compressToFit(html, maxBodyChars) {
  let body = compressToPlainText(html);
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
