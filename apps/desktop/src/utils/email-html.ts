/**
 * Apply a trailing-only trim to a string, bounded to a fixed tail window so it
 * stays linear no matter how large the input is.
 *
 * Trailing "dead space" (whitespace / &nbsp; / empty <p>/<div>/<br>) only ever
 * lives at the very END of an email body, but the anchored `…$` regexes used to
 * strip it are ~O(window) per call — so run against a full body they degrade to
 * O(n^2): an unbounded trailing-trim measured ~200ms at 36KB and ~3.5s at 200KB,
 * stalling whichever thread runs it (render or extraction). Capping the scanned
 * region to a tail window keeps every pass linear.
 *
 * `peel` MUST strip only from the end and return the rest unchanged. Only the
 * suffix is removed here, so `head + peeledTail` reconstructs the input exactly
 * — verified stable even when a tag straddles the window boundary. 8KB is far
 * larger than any real trailing empty-tag nest; if the whole window turns out
 * to be dead space we drop it and continue, so correctness never depends on the
 * window size.
 */
export function trimTrailingWindowed(
  input: string,
  peel: (tail: string) => string,
  windowSize = 8192,
): string {
  let out = input;
  for (;;) {
    if (out.length <= windowSize) return peel(out);
    const splitAt = out.length - windowSize;
    const trimmedTail = peel(out.slice(splitAt));
    if (trimmedTail === '') { out = out.slice(0, splitAt); continue; }
    return out.slice(0, splitAt) + trimmedTail;
  }
}

/**
 * A DESIGNED email (marketing / transactional / notification) carries a
 * `<style>` block, layout tables, `role=presentation`, or `bgcolor` — it owns
 * its own bespoke layout. Unwrapping its structure, stripping "signature"/banner
 * blocks, or normalizing fonts turns it into a wireframe / truncates it, so it
 * must be rendered VERBATIM. Shared by the chat bubbles (ChatView) and the
 * deterministic splitter (conversation-heuristic), which both need to leave
 * designed emails untouched. Pure/regex — safe in any renderer context.
 */
export function htmlLooksDesigned(html: string | null | undefined): boolean {
  if (!html) return false;
  // Structural markers (marketing/transactional templates).
  if (/<style[\s>]/i.test(html)) return true;
  if (/role=["']presentation["']/i.test(html)) return true;
  if (/\bbgcolor=/i.test(html)) return true;
  if ((html.match(/<table/gi)?.length ?? 0) >= 2) return true;
  // Embedded images (logo/banner/button graphics) — hand-written mail rarely
  // carries any; AI-extracted markdown never does.
  if ((html.match(/<img\b/gi)?.length ?? 0) >= 1) return true;
  // INLINE-styled template: a CTA button styled with a background, or several
  // elements each carrying a style= attribute (callout boxes, dividers, chips).
  // This is what distinguishes a designed notification that uses inline styles
  // only (no <style>/table) from a plain hand-written reply — normalizing it
  // would flatten its buttons/boxes. AI-extracted markdown has NO inline styles,
  // so its tables still get the styledTables border help.
  if (/<a\b[^>]*\sstyle=["'][^"']*(background|padding|border-radius)/i.test(html)) return true;
  if ((html.match(/\bstyle\s*=/gi)?.length ?? 0) >= 4) return true;
  return false;
}

/** A `<p>`/`<div>` holding nothing but whitespace, `&nbsp;` and `<br>`. */
const EMPTY_BLOCK_RE = /<(p|div)\b(?![^>]*\sstyle\s*=)[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/\1>/gi;
/**
 * Placeholder standing in for a removed empty block. An HTML comment because it
 * survives every intermediate regex untouched, renders as nothing if anything
 * ever leaks it through, and cannot collide with body text.
 */
const EMPTY_MARK = '<!--sarv-blank-->';
/** A RUN of adjacent placeholders (whatever whitespace sits between them). */
const EMPTY_RUN_RE = /(?:<!--sarv-blank-->\s*)+/g;

/**
 * Collapse EXCESSIVE vertical whitespace in an email body while leaving the
 * sender's real formatting alone.
 *
 * Some senders (and most Word/Outlook round-trips) stack five or ten empty
 * paragraphs and `<br>` runs between lines, which the raw single-email view
 * renders faithfully as a screenful of nothing. This trims a RUN of blank lines
 * down to one and a `<br>` run down to two — a deliberate blank line still
 * shows, a wall of them does not.
 *
 * Deliberately conservative in two ways, because this runs on bodies we
 * otherwise render verbatim:
 *   • blocks carrying a `style=` attribute are never touched — a `<div>` with
 *     an explicit height is a marketing template's SPACER, not stray blankness;
 *   • callers skip designed bodies entirely (see {@link htmlLooksDesigned}).
 */
export function collapseExcessBlankSpace(html: string): string {
  if (!html) return html;
  // Empty blocks nest (`<div><div></div></div>`), so peel a few times — the
  // inner match leaves a marker that stops the outer from matching in one pass.
  let out = html;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = out.replace(EMPTY_BLOCK_RE, EMPTY_MARK);
    if (next === out) break;
    out = next;
  }
  // A run of blank blocks — however deep — becomes ONE blank line.
  out = out.replace(EMPTY_RUN_RE, '<br>');
  // Explicit `<br>` runs: three or more is padding, two is a paragraph break.
  return out.replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>');
}

/**
 * Assemble the final outgoing HTML: the user's (already email-converted) body,
 * then the signature, then any quoted trail. The signature is passed VERBATIM —
 * it must NOT go through convertToEmailHtml or the TipTap editor, or its pasted
 * table/flex layout is destroyed (that's the whole point of keeping it separate,
 * exactly like the quoted trail). Signature sits before the quote (Gmail-style).
 */
export function assembleOutgoingHtml(
  bodyHtml: string,
  signatureHtml: string,
  quotedHtml = '',
): string {
  const sig = signatureHtml ? `<br>${signatureHtml}` : '';
  return `${bodyHtml}${sig}${quotedHtml}`;
}

/**
 * Convert TipTap HTML to email-friendly HTML with inline styles.
 * Email clients like Gmail strip CSS classes, so we need inline styles.
 */
export function convertToEmailHtml(html: string): string {
    let emailHtml = html;

    // Remove all class attributes (email clients ignore them)
    emailHtml = emailHtml.replace(/\s+class="[^"]*"/g, '');

    // Style lists inline so email clients (which strip external CSS) render the
    // bullets/numbers. TipTap emits bare <ul>/<ol>/<li>; give them a marker, a
    // left gutter for it, and modest spacing. (Previously these were FLATTENED to
    // <p>, which silently dropped every bullet/number the user added.) The <li>'s
    // inner <p> gets its margins zeroed so marker + text stay on one line.
    emailHtml = emailHtml.replace(/<ul(\s[^>]*)?>/gi, '<ul style="margin: 0 0 10px; padding-left: 24px; list-style-type: disc;">');
    emailHtml = emailHtml.replace(/<ol(\s[^>]*)?>/gi, '<ol style="margin: 0 0 10px; padding-left: 24px; list-style-type: decimal;">');
    emailHtml = emailHtml.replace(/<li(\s[^>]*)?>/gi, '<li style="margin: 0 0 4px;">');

    // Add inline styles to paragraphs
    emailHtml = emailHtml.replace(/<p>/g, '<p style="margin: 0 0 10px 0;">');

    // Style blockquotes for email
    emailHtml = emailHtml.replace(
        /<blockquote>/g,
        '<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">'
    );

    // Style code blocks
    emailHtml = emailHtml.replace(
        /<pre>/g,
        '<pre style="background-color: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto;">'
    );
    emailHtml = emailHtml.replace(
        /<code>/g,
        '<code style="background-color: #f4f4f4; padding: 2px 4px; border-radius: 2px; font-family: monospace;">'
    );

    // Style links
    emailHtml = emailHtml.replace(
        /<a /g,
        '<a style="color: #0066cc; text-decoration: underline;" '
    );

    // Style headings
    emailHtml = emailHtml.replace(/<h1>/g, '<h1 style="margin: 0 0 10px 0; font-size: 24px; font-weight: bold;">');
    emailHtml = emailHtml.replace(/<h2>/g, '<h2 style="margin: 0 0 10px 0; font-size: 20px; font-weight: bold;">');
    emailHtml = emailHtml.replace(/<h3>/g, '<h3 style="margin: 0 0 10px 0; font-size: 16px; font-weight: bold;">');

    // Style horizontal rules
    emailHtml = emailHtml.replace(/<hr>/g, '<hr style="border: none; border-top: 1px solid #ccc; margin: 10px 0;">');
    emailHtml = emailHtml.replace(/<hr\/>/g, '<hr style="border: none; border-top: 1px solid #ccc; margin: 10px 0;">');

    // Preserve whitespace/tabs - convert tabs to non-breaking spaces
    emailHtml = emailHtml.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');

    return emailHtml;
}
