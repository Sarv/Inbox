/**
 * The HTML transforms that keep an email from fetching anything when it is
 * shown: in the reading pane's frame (buildSrcdoc) and in the print document.
 * Pure string transforms — the email's bytes are kept as they are wherever
 * nothing is removed — and each linear: a crafted email must not freeze the
 * window.
 */

/**
 * `html.replace(re, fn)` for a pattern that can only match text ending in a
 * closing tag that starts with `close` (e.g. `</style` for `<style …>…</style >`),
 * applied ONLY up to the end of the last such tag.
 *
 * Identical result: no match can start after the last closing tag, because it
 * would need one later. And it is what keeps the pattern linear: on a run of
 * unclosed openers (`<style><style>…`) every attempt in the tail used to scan
 * to the end of the input and fail — quadratic, and a frozen window for one
 * crafted email.
 */
export function replaceUpToLastClose(
  html: string,
  close: string,
  re: RegExp,
  fn: (match: string, ...groups: string[]) => string,
): string {
  const end = html.toLowerCase().lastIndexOf(close);
  if (end < 0) return html;
  const gt = html.indexOf('>', end + close.length - 1);
  const cut = gt < 0 ? html.length : gt + 1;
  return html.slice(0, cut).replace(re, fn) + html.slice(cut);
}

/**
 * Drop every complete `<script …>` opener (up to its first `>`) left in `html`
 * — a self-closed or unpaired one. A split, not a regex replace, like
 * {@link escapeDroppedTags}, which must run after it: dropping a tag can splice
 * the text around it into a new `<script`.
 */
function dropScriptOpeners(html: string): string {
  const parts = html.split('<');
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const gt = parts[i].indexOf('>');
    out += /^script\b/i.test(parts[i]) && gt >= 0 ? parts[i].slice(gt + 1) : `<${parts[i]}`;
  }
  return out;
}

/**
 * A `link`, `iframe` or `frame` start tag right after a `<`: the name ends at
 * whitespace, `/` or `>`.
 */
const HINT_OR_FRAME_TAG = /^(?:link|i?frame)(?=[\s/>]|$)/i;

/**
 * Drop every `<link …>`, `<iframe …>` and `<frame …>` tag (up to its first
 * `>`), whatever its attributes.
 *
 * Why every link: a `dns-prefetch` hint makes Chromium resolve its host the
 * moment the email is shown — and DNS prefetching is outside the frame's CSP.
 * Checked against Electron's network log: `rel="alternate dns-prefetch"`,
 * `rel=" dns-prefetch"` and `rel="&#100;ns-prefetch"` all resolve, and none
 * matched the old rel list. A tracker with its own DNS learns that the email
 * was opened, and from where, with remote images blocked. An email frame has
 * no use for any `<link>`: stylesheets, preloads and icons are all refused or
 * meaningless in it.
 *
 * Why every frame: an `<iframe srcdoc="&lt;link rel=dns-prefetch …&gt;">`
 * carries the hint ENTITY-ENCODED — no `<link` in the email's text for the
 * drop to see — and Chromium decodes it into a live link in the nested
 * document (resolved in the same network log, nested twice too). The frame's
 * CSP never covered about:srcdoc; src frames it does refuse. An email has no
 * use for a nested frame either. (Dropping the opener leaves its content, once
 * inert raw text, as markup — which this same sweep and the CSP then govern.)
 *
 * A split, not a regex replace, like the script passes. Dropping a tag can
 * splice the text around it into a new one (`<lin<link>k …>`), so
 * {@link escapeDroppedTags} runs after every drop.
 */
function dropHintAndFrameTags(html: string): string {
  const parts = html.split('<');
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const gt = parts[i].indexOf('>');
    out += HINT_OR_FRAME_TAG.test(parts[i]) && gt >= 0 ? parts[i].slice(gt + 1) : `<${parts[i]}`;
  }
  return out;
}

/**
 * Escape the `<` of every `<script` / `</script` / `<link` / `<iframe` /
 * `<frame` left in `html` to `&lt;`, so none can open (or close) one. Runs
 * once, after EVERY drop: each drop can splice the text around it into a new
 * tag of any of these kinds (`<scr<link>ipt>`, `<li<script>nk>`), and escaping
 * cannot create one. A split, not a regex replace: one linear pass, and every
 * `<` is checked against what actually follows it.
 */
function escapeDroppedTags(html: string): string {
  const parts = html.split('<');
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out += (/^\/?script\b/i.test(parts[i]) || HINT_OR_FRAME_TAG.test(parts[i]) ? '&lt;' : '<') + parts[i];
  }
  return out;
}

/**
 * Strip resource references that cause blocking network fetches
 * inside the iframe. Designed marketing emails frequently pull custom
 * fonts (\`@font-face\` from CDN), external stylesheets, preloads, and
 * tracking pixels — most of which CORS-fail from \`about:srcdoc\`
 * origin and stall the render until the browser times out. Removing
 * them up front makes paint instant; the email falls back to our
 * system font and renders with whatever inline CSS it shipped.
 *
 * What we keep: inline \`<style>\` rules that aren't \`@font-face\`, and
 * inline images already converted to data URIs by image-cache.
 *
 * What we drop:
 *   - \`@font-face { ... }\` blocks and \`@import url(...)\` lines inside <style>
 *   - everything stripActiveContent drops: scripts, every \`<link>\`, and
 *     nested frames
 */
export function stripBlockingResources(html: string): string {
  let out = html;

  // 1. Inline <style>: drop @font-face blocks + @import lines, and neutralize
  //    dark-mode media queries.
  out = replaceUpToLastClose(out, '</style', /<style\b[^<>]*>([\s\S]*?)<\/style\b[^<>]*>/gi, (_, css) => {
    const cleaned = css
      // @font-face { ... } — handle nested braces minimally; one level is enough for fonts.
      .replace(/@font-face\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '')
      // @import url(...); or @import "...";
      .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*[^;]*;?/g, '')
      // Neutralize `@media (prefers-color-scheme: dark)` blocks. The iframe
      // inherits the OS colour-scheme preference, so an email's dark-mode CSS
      // (Google Calendar invites, marketing mail) fires even when the app is in
      // light mode — rendering the message on a black background. Appending an
      // always-false condition makes the query never match, so the email falls
      // back to its default (light) design, matching how Gmail renders it.
      .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(prefers-color-scheme: dark) and (max-width: 0px)');
    return `<style>${cleaned}</style>`;
  });

  // 2. Scripts, links and nested frames.
  return stripActiveContent(out);
}

/**
 * The part of the strip that keeps an email from running, hinting or nesting
 * anything — without touching its styles. The print document uses it alone:
 * its paper copy keeps the email's own `<style media=…>` and embedded fonts.
 *
 * `<script>…</script>` blocks go first — the sandbox blocks execution, but the
 * parser still spends time tokenizing them and can stall on src= fetches. The
 * parser also ends a script at `</script >` or `</script foo>`. Deleting tags
 * can splice the text around them into a new `<script` (`<scr<script>
 * </script>ipt>`), and an opener with a `<` inside an attribute matches
 * neither pattern — so the sweep that follows drops or escapes the rest.
 */
export function stripActiveContent(html: string): string {
  return sweepActiveTags(
    replaceUpToLastClose(html, '</script', /<script\b[^<>]*>[\s\S]*?<\/script\b[^<>]*>/gi, () => ''),
  );
}

/**
 * Drop every script opener, every `<link>` (resource hints — dns-prefetch is
 * outside the CSP — and stylesheets alike) and every nested frame, then
 * escape whatever a drop spliced into a new one. stripActiveContent ends with
 * it, and any later transform that deletes markup must run it again before
 * the HTML is shown: deleting `<o:p>` or an attribute can splice
 * `<li<o:p>nk …>` into a live link just as these drops can.
 */
export function sweepActiveTags(html: string): string {
  return escapeDroppedTags(dropHintAndFrameTags(dropScriptOpeners(html)));
}
