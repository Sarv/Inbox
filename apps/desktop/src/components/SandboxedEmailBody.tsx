import { ImageOff } from 'lucide-react';
import { useRef, useEffect, useMemo, useState } from 'react';

import { rememberSenderImagesAllowed, shouldAutoLoadRemoteImages } from '../store/helpers';
import { collapseExcessBlankSpace, htmlLooksDesigned, trimTrailingWindowed } from '../utils/email-html';
import { TABLE_SCROLL_CSS, wrapOverflowingTables } from '../utils/wide-table-scroll';

interface SandboxedEmailBodyProps {
  html: string;
  className?: string;
  /**
   * If true, render tables with visible borders + cell padding +
   * zebra rows. Used by Chat View bubbles where AI-extracted GFM
   * pipe tables would otherwise collapse to plain text columns.
   * Standard email view leaves it false so original-email tables
   * render with their own (or no) styling.
   */
  styledTables?: boolean;
  /**
   * If true, normalize typography and spacing aggressively:
   *   • Strip inline `font-size`, `font-family`, `line-height`,
   *     `margin`, `padding`, and `mso-*` declarations from style
   *     attributes.
   *   • Strip `class` attributes entirely.
   *   • Drop empty <p>/<div>/<span> and runs of redundant <br>.
   *
   * This is what Chat View wants — every bubble in the chat list
   * should share one font + one line-height regardless of which
   * sender ships which mail-client. Standard email view leaves this
   * OFF so single-email reads look identical to a raw mail viewer
   * — preserves the sender's font choices, paragraph rhythm,
   * intentional whitespace.
   */
  normalize?: boolean;
  /**
   * Make the iframe canvas TRANSPARENT (no forced white background) so whatever
   * is BEHIND the iframe shows through — e.g. a chat bubble's sender-color tint.
   * DECOUPLED from `normalize`: `normalize` also strips inline styles (which
   * would flatten a designed table's colors), whereas this only affects the
   * canvas background, so a designed email can keep its layout AND still show the
   * bubble tint. Text color stays theme-aware (light on dark) so it's readable on
   * either a light or dark bubble. Default false (opaque white canvas, as before).
   */
  transparentCanvas?: boolean;
  /**
   * Extra pixels added to the measured content height. The measurement
   * deliberately excludes trailing margins (no dead space in the read view), but
   * some embedded layouts (e.g. a signature's bottom row) sit flush and look
   * clipped. Callers that render such content can add a small buffer. Default 0
   * so the read view's exact fit is unchanged.
   */
  heightPadding?: number;
  /**
   * Block remote (http/https) images until the user opts in — the tracking-pixel
   * protection. Defaults to TRUE (the safe default for RECEIVED, untrusted mail).
   * Set FALSE for the user's OWN trusted content — signature previews, quoted
   * drafts, AI-polish previews — where their own logos must render immediately
   * and a "Load images" banner would be wrong.
   */
  blockRemoteImages?: boolean;
  /**
   * Whether this mail is eligible for auto-load under the 'safe' remote-image
   * mode (the default) — i.e. the AI gave it a real category other than
   * Promotional/Spam. Uncategorized, Promotional and Spam mail are NOT eligible
   * and stay behind the banner. Ignored in 'block'/'always' modes.
   */
  safeAutoLoad?: boolean;
  /**
   * The message's sender address. When the user manually loads images on this
   * message, the sender is remembered so their FUTURE mail auto-loads images —
   * and if they're already on that allowlist, this message auto-loads too.
   */
  senderAddress?: string;
}

/**
 * Build the theming CSS we inject into the iframe head. This is the
 * UA-style baseline (font, color, link color, blockquote treatment)
 * that the email's own CSS can override. Designed to be unobtrusive
 * — we set defaults but never use !important, so any rule the email
 * author wrote wins.
 */
function buildIframeCss(isDark: boolean, styledTables: boolean, normalize: boolean, transparentCanvas: boolean): string {
  // !important forces normalized typography across mismatched senders —
  // only applied when caller opts in (Chat View). Standard email view
  // keeps everything low-specificity so the email's own inline styles
  // win.
  const imp = normalize ? ' !important' : '';
  // The Standard single-email view (normalize=false) renders on a stable LIGHT
  // canvas like Gmail: email HTML is authored for a light background, so forcing
  // the app's dark theme onto it (transparent iframe → dark app bg shows
  // through, plus the message's own `prefers-color-scheme: dark` rules) turns
  // ordinary emails black. Chat bubbles (normalize=true) keep theme-aware colors
  // because they sit on a themed bubble, not a white page.
  // Transparent canvas (chat bubbles) when EITHER the aggressive normalize is on
  // OR the caller explicitly asked to keep the email's own styles but still let
  // the bubble tint show through (transparentCanvas).
  const lightCanvas = !normalize && !transparentCanvas;
  const emailDark = isDark && !lightCanvas;
  const fg = emailDark ? 'hsl(210, 40%, 98%)' : 'hsl(222.2, 84%, 4.9%)';
  const link = emailDark ? 'hsl(217.2, 91.2%, 59.8%)' : 'hsl(221.2, 83.2%, 53.3%)';
  const quoteBorder = emailDark ? 'hsl(217.2, 32.6%, 17.5%)' : 'hsl(214.3, 31.8%, 91.4%)';
  const quoteFg = emailDark ? 'hsl(215, 20.2%, 65.1%)' : 'hsl(215.4, 16.3%, 46.9%)';

  // Chat View tables — opt-in via styledTables. AI-extracted GFM
  // markdown tables collapse to plain text without borders + padding.
  const tableBorder = emailDark ? 'hsl(217.2, 32.6%, 22%)' : 'hsl(214.3, 31.8%, 87%)';
  const tableHeaderBg = emailDark ? 'hsl(217.2, 32.6%, 14%)' : 'hsl(210, 40%, 96%)';
  const tableRowAltBg = emailDark ? 'hsl(217.2, 32.6%, 11%)' : 'hsl(210, 40%, 98.5%)';
  // Semi-transparent theme wash laid OVER a sender's cell colour to soften it
  // into a readable pastel (their hue shows through at ~35%). White-ish in
  // light mode, dark in dark mode, so text stays legible on top either way.
  const cellWash = emailDark ? 'rgba(17, 24, 39, 0.62)' : 'rgba(255, 255, 255, 0.64)';
  const tableCss = styledTables ? `
    table:not([cellspacing]):not([cellpadding]) {
      max-width: 100%;
      border-collapse: collapse;
      margin: 0.5em 0;
      border: 1px solid ${tableBorder};
    }
    table:not([cellspacing]):not([cellpadding]) th,
    table:not([cellspacing]):not([cellpadding]) td {
      border: 1px solid ${tableBorder};
      padding: 6px 10px;
      text-align: left;
      vertical-align: top;
    }
    table:not([cellspacing]):not([cellpadding]) thead th,
    table:not([cellspacing]):not([cellpadding]) th {
      background: ${tableHeaderBg};
      font-weight: 600;
    }
    table:not([cellspacing]):not([cellpadding]) tbody tr:nth-child(even) td {
      background: ${tableRowAltBg};
    }
  ` : '';

  // Note the selectors carry low specificity. Email authors using
  // table-layout shells with their own cellspacing/cellpadding +
  // inline styles are not affected — their styles win every time.
  // The !important rules below force consistent typography across
  // every bubble — emails routinely inline `style="font-family:Arial"`
  // or `font-family:Calibri` per-element, which produces a patchwork
  // chat view with each bubble in a different font. We override:
  //   • font-family — always the app's sans stack
  //   • font-size — 13.5px base (headings keep their proportional size)
  //   • line-height — 1.55 for comfortable reading
  //   • color — theme foreground
  // We do NOT force background-color, padding/margin on tables, or
  // image dimensions — those are part of the email's intentional
  // layout (gray-page-bg invoice cards etc.) and stay intact.
  return `
    html, body {
      margin: 0;
      padding: 0;
      ${lightCanvas ? 'background-color: #ffffff;' : ''}
    }
    body, body * {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif${imp};
      line-height: 1.55${imp};
    }
    body {
      font-size: ${normalize ? '15px' : '16px'}${imp};
      color: ${fg};
      word-wrap: break-word;
      overflow-wrap: break-word;
      /* Never let a wide child (fixed-width table, long recipient list,
         unbroken URL) push a scrollbar onto the whole message. Wide tables
         get their OWN contained scroll via the rule below. */
      overflow-x: hidden;
    }
    html, body { max-width: 100%; }
    /* Force uniform body text size on every common inline + block tag.
       With normalize=true (Chat View) we !important this so inline
       \`<span style="font-size:10pt">\` from Outlook / pasted Word
       content can't break the bubble's typographic rhythm. Headings
       below get their own rule with higher specificity.
       AI Chat View uses 15px — slightly smaller than Standard view's
       16px. The bubble shell already gives the message its own
       visual frame, so dialing the text down keeps long replies
       skimmable without sacrificing the sender's bold/italic/color
       emphasis (which is preserved verbatim). */
    body p, body div, body span, body li, body td, body th, body dd, body dt,
    body b, body strong, body em, body i, body u, body small, body a, body font {
      font-size: ${normalize ? '15px' : '16px'}${imp};
    }
    /* Headings keep their proportional sizing but use the same family.
       !important when normalized so the body * rule doesn't override. */
    body h1 { font-size: 1.5em${imp}; margin: 0.6em 0 0.4em; }
    body h2 { font-size: 1.3em${imp}; margin: 0.6em 0 0.4em; }
    body h3 { font-size: 1.15em${imp}; margin: 0.5em 0 0.3em; }
    body h4, body h5, body h6 { font-size: 1em${imp}; margin: 0.5em 0 0.3em; }
    /* Paragraph rhythm. !important only when normalize=true (Chat View) so
       per-<p> inline margins Outlook ships don't fragment the bubble
       rhythm. Standard view leaves these as low-specificity defaults
       so the sender's intentional spacing wins. */
    body p { margin: 0 0 0.5em 0${imp}; }
    body p:last-child { margin-bottom: 0${imp}; }
    body > div { margin: 0 0 0.5em 0${imp}; }
    body > div:last-child { margin-bottom: 0${imp}; }
    /* Explicit marker type so bullets/numbers always render (an inline
       list-style:none from a sender's layout trick can still override — no
       !important). Guarantees our own sent lists show markers in the thread. */
    body ul { list-style-type: disc; margin: 0.3em 0 0.5em${imp}; padding-left: 1.5em; }
    body ol { list-style-type: decimal; margin: 0.3em 0 0.5em${imp}; padding-left: 1.5em; }
    body li { margin: 0.1em 0${imp}; }
    /* Zero out trailing margin/padding on whatever the last element
       actually is — covers cases where the last child is something
       other than <p> or <div> (e.g. <span>, <font>, <table>, <br>).
       Without this, content like "<div>text</div><br>" leaves a blank
       line at the bottom of the bubble. */
    body > *:last-child {
      margin-bottom: 0${imp};
      padding-bottom: 0${imp};
    }
    a { color: ${link}; }
    img { max-width: 100%; height: auto; }
    ${lightCanvas ? `
    /* Un-clip attachment-name chips that cap themselves with a fixed
       max-width + ellipsis (+ a fixed-height overflow:hidden wrapper) tuned for
       the sender's OWN narrower webfont; with our system-font fallback the name
       clips a few characters early (e.g. Google Calendar showing
       "Madhav_Sethi -" instead of "Madhav_Sethi - S.E..pdf"). Google's chip
       is <table class="attachment-chip"> whose td/div/a all clip, so relax the
       whole chain. Also cover any titled, inline-ellipsis element generically.
       Scoped to the Standard view; ordinary one-line truncated buttons/headings
       (no attachment-chip class, no title) are untouched. */
    .attachment-chip, .attachment-chip td, .attachment-chip div, .attachment-chip a,
    [title][style*="ellipsis"] {
      max-width: none !important;
      height: auto !important;
      overflow: visible !important;
      text-overflow: clip !important;
      white-space: normal !important;
      overflow-wrap: break-word;
    }` : ''}
    /* Chat View enforces ONE clean table style on EVERY table, overriding
       whatever layout/border/width/height the sender (or a mangled
       re-serialization) inlined — senders ship "width:0px", "table-layout:fixed",
       "white-space:nowrap", fixed row heights, 0px borders, etc. that make
       data tables collapse or read as mush. We force clean structure (theme
       borders, padding, layout) and SOFTEN the sender's cell colours rather
       than dropping them: a translucent theme wash is composited OVER their
       background-color (background-image beats the background shorthand), so
       their hue shows through as a light pastel, and text is forced to the
       theme colour so it stays readable on top. A genuinely wide table scrolls
       WITHIN itself (contained scrollbar) rather than stretching the bubble.
       Standard email view leaves the sender's table layout untouched. */
    ${normalize ? `
    table {
      width: max-content !important; max-width: 100% !important;
      table-layout: auto !important; border-collapse: collapse !important;
      display: block; overflow-x: auto;
      margin: 0.5em 0 !important; border: 1px solid ${tableBorder} !important;
    }
    table td, table th {
      border: 1px solid ${tableBorder} !important;
      padding: 6px 10px !important;
      text-align: left; vertical-align: top;
      white-space: normal !important; word-break: break-word;
      height: auto !important; min-width: 0 !important;
      background-image: linear-gradient(${cellWash}, ${cellWash}) !important;
      color: ${fg} !important;
    }
    table a { color: ${link} !important; }
    ` : ''}
    ${(!normalize && transparentCanvas) ? `
    /* Designed tables in a chat bubble: soften the sender's saturated cell
       colours into readable pastels using the SAME wash the normalized path
       uses, but WITHOUT restructuring their table layout. Scoped to cells that
       actually declare a background (bgcolor / inline background, or a coloured
       row) so plain cells are left untouched, and the theme text colour is
       forced on top so white-on-dark headers stay legible once lightened. */
    table td[bgcolor], table th[bgcolor],
    table td[style*="background"], table th[style*="background"],
    table tr[bgcolor] td, table tr[bgcolor] th {
      background-image: linear-gradient(${cellWash}, ${cellWash}) !important;
      color: ${fg} !important;
    }
    ` : ''}
    ${normalize ? '' : `
    /* A table too wide for the message scrolls inside its own wrapper rather
       than being clipped by the body. Standard view only — the normalized path
       above already gives every table a contained scroll. */
    ${TABLE_SCROLL_CSS}
    `}
    pre, code {
      white-space: pre-wrap;
      max-width: 100%;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace${imp};
    }
    blockquote {
      border-left: 3px solid ${quoteBorder};
      margin: 0.5em 0;
      padding-left: 1em;
      color: ${quoteFg};
    }
    ${tableCss}
  `;
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
 * What we keep: inline \`<style>\` rules that aren't \`@font-face\`,
 * inline images already converted to data URIs by image-cache, and
 * \`<link rel="icon">\` (cheap and harmless).
 *
 * What we drop:
 *   - \`@font-face { ... }\` blocks and \`@import url(...)\` lines inside <style>
 *   - \`<link rel="stylesheet">\`
 *   - \`<link rel="preload" as="font|style">\`
 *   - \`<link rel="prefetch">\`
 *   - \`<script>\` (defense-in-depth — sandbox already blocks scripts)
 */
function stripBlockingResources(html: string): string {
  let out = html;

  // 1. Inline <style>: drop @font-face blocks + @import lines, and neutralize
  //    dark-mode media queries.
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
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

  // 2. <link rel="stylesheet|preload|prefetch|preconnect|dns-prefetch">.
  out = out.replace(
    /<link\b[^>]*\brel\s*=\s*["']?(?:stylesheet|preload|prefetch|preconnect|dns-prefetch|modulepreload)["']?[^>]*>/gi,
    '',
  );

  // 3. <script>...</script> — sandbox blocks execution but the parser
  // still spends time tokenizing them and can stall on src= fetches.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b[^>]*\/?>/gi, '');

  return out;
}

/**
 * Wrap a fragment (no <html>/<body>) in a minimal HTML document so
 * iframe srcdoc has a real document to render. Full HTML documents
 * pass through unchanged so the email's own <style> block ordering,
 * media queries, and body attributes work natively.
 *
 * Either way, our theme `<style>` is injected at the END of <head>
 * so it provides defaults BUT loses to any selector the email
 * author wrote (later-defined rules of equal specificity win).
 */
/**
 * Final cleanup pass on the email HTML before it goes into the iframe:
 *
 *   • Strip `font-size:` and `font-family:` declarations from inline
 *     `style="..."` attrs. We normalize typography via our injected
 *     theme CSS (!important font-family + uniform font-size) and
 *     these inline overrides are exactly what produced the
 *     patchwork-fonts look the user complained about.
 *   • Strip `class="..."` attrs entirely. The email's own <style>
 *     blocks are already stripped (stripBlockingResources removes
 *     them), so classes are dead weight that only invite the kind
 *     of overrides we just normalized away.
 *   • Collapse 3+ consecutive `<br>` → 2 (mail clients leave huge
 *     whitespace blocks around quote attribution).
 *   • Drop empty `<p></p>` / `<div></div>` tags.
 *   • Collapse runs of 3+ newlines in the HTML source to 2 (cosmetic,
 *     keeps the cached body compact).
 */
function normalizeHtmlForBubble(html: string): string {
  let out = html;

  // Strip the inline-style declarations that fight our normalized
  // theme CSS: font-size/font-family override the typography stack;
  // margin/padding/line-height override the uniform paragraph
  // rhythm; mso-* are Outlook Word-only and have no effect anyway.
  //
  // INTENTIONALLY KEPT:
  //   • font-weight       — preserves <span style="font-weight:bold">
  //   • font-style        — preserves italic
  //   • text-decoration   — preserves underline / strikethrough
  //   • color, background-color — preserves the sender's emphasis
  //   • text-align, width, border, display, vertical-align — layout
  const KILL_DECL = /^(font-size|font-family|line-height|margin(-top|-bottom|-left|-right)?|padding(-top|-bottom|-left|-right)?|mso-[a-z-]+)\s*:/i;
  // Also drop declarations whose VALUE references an undefined CSS
  // var (var(--compose-editor-bg, white) from Sarv's editor,
  // var(--outlook-…) from Outlook web). Those resolve to the
  // fallback color (usually white), which renders as a highlight
  // strip on a dark-theme bubble. The sender almost certainly didn't
  // intend a literal-white background — they just inherited it from
  // the compose editor's CSS-var theme.
  const KILL_VAR_VALUE = /var\s*\(\s*--/i;
  out = out.replace(/\sstyle\s*=\s*("|')([^"']*)\1/gi, (_full, quote: string, css: string) => {
    const trimmed = css
      .split(';')
      .map(d => d.trim())
      .filter(d => d && !KILL_DECL.test(d) && !KILL_VAR_VALUE.test(d))
      .join('; ');
    return trimmed ? ` style=${quote}${trimmed}${quote}` : '';
  });

  // Strip HTML4 <font face="..." size="..." color="..."> attributes
  // — these aren't CSS so the regex above doesn't touch them, but
  // they're a common Outlook / signed-from-mobile source of stray
  // sizing. Leave the <font> tag itself (CSS rules above pin its
  // font-size + font-family); just delete its sizing attributes.
  // KEEP `color=` because the user wants sender's color emphasis to
  // survive — only kill face/size.
  out = out.replace(/<font\b([^>]*)>/gi, (_full, attrs: string) => {
    const cleanedAttrs = attrs
      .replace(/\s(face|size)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return `<font${cleanedAttrs}>`;
  });

  // Strip class attrs entirely (their referencing <style> is gone).
  out = out.replace(/\sclass\s*=\s*("|')[^"']*\1/gi, '');

  // Drop Outlook's namespaced <o:p> tags entirely — they render as
  // empty paragraphs in non-Office viewers and add bogus gaps.
  out = out.replace(/<\/?o:p\b[^>]*>/gi, '');

  // Drop `<br>` tags that come right after a block-closing tag.
  // `</div><br>` and `</p><br>` produce a DOUBLE line break (the
  // closing tag already produces one) which is the main reason
  // div-paragraph bodies look more loosely spaced than p-paragraph
  // bodies. Strip the redundant <br> so block-tag siblings rely on
  // CSS margin alone for consistent rhythm.
  out = out.replace(
    /<\/(div|p|h[1-6]|li|ul|ol|td|tr|blockquote|table|section|article|header|footer)>\s*<br\s*\/?>/gi,
    '</$1>',
  );

  // Collapse 2+ <br> in a row → single <br>. Mail clients often
  // emit 2-4 <br> in a row as fake paragraph spacing; the CSS
  // already handles paragraph spacing via div/p margin so multiple
  // <br> just stack visible line breaks the user didn't intend.
  out = out.replace(/(?:<br\s*\/?>\s*){2,}/gi, '<br>');

  // Drop empty paragraphs / divs (any combo of whitespace + <br> inside).
  out = out.replace(/<p[^>]*>\s*(?:<br\s*\/?>\s*)*\s*<\/p>/gi, '');
  out = out.replace(/<div[^>]*>\s*(?:<br\s*\/?>\s*)*\s*<\/div>/gi, '');

  // Collapse 2+ source newlines → single newline (HTML ignores
  // these for rendering, but keeping them tight avoids subtle
  // whitespace artefacts and shrinks the cached body string).
  out = out.replace(/\n{2,}/g, '\n');

  return trimTrailingDeadSpace(out);
}

/**
 * Trim trailing whitespace + empty/break tags from the END of the body so the
 * iframe's measured height doesn't reserve dead space at the bottom. Repeats
 * until nothing else can be stripped — mail clients often nest
 * `<div><br></div><div>&nbsp;</div>` several deep at the end. Applied to EVERY
 * body (normalized or not): the height measurement excludes trailing margins
 * but still counts trailing empty ELEMENTS as layout, which is the "too much
 * blank space" the raw single-email view otherwise shows.
 */
function trimTrailingDeadSpace(html: string): string {
  // Bounded to a tail window so a large body can't turn the anchored `$`
  // regexes below into O(n^2). See trimTrailingWindowed.
  return trimTrailingWindowed(html, peelTrailingDeadSpace);
}

function peelTrailingDeadSpace(html: string): string {
  let out = html;
  let prev;
  // Hard cap on peel passes. Belt-and-suspenders against a pathological body:
  // this function must NEVER be able to wedge the render thread (an earlier
  // single-regex version backtracked catastrophically and froze the whole UI).
  let guard = 0;
  do {
    prev = out;
    // 1. Strip the trailing run of whitespace / &nbsp; & zero-width entities /
    //    <br> / <hr> in ONE pass. These alternatives are disjoint on their
    //    first character (whitespace vs '&' vs '<'), so the engine matches
    //    them deterministically — linear time, no backtracking.
    out = out.replace(
      /(?:\s|&nbsp;|&#xA0;|&#160;|&zwnj;|&zwj;|<br\s*\/?>|<hr\s*\/?>)+$/i,
      '',
    );
    // 2. Strip ONE trailing empty <p>/<div>/<span>/<font> (inner content of
    //    whitespace / <br> / entities only). Kept as a SEPARATE regex from
    //    step 1 on purpose: combining the container alternative with the plain
    //    whitespace/<br> alternatives under one `(?:…)+$` is what created the
    //    overlapping nested-quantifier pattern that backtracked exponentially.
    //    Here the inner group's alternatives are likewise disjoint on their
    //    first char, so it stays linear. The loop peels nested wrappers one
    //    layer per pass.
    out = out.replace(
      /<(p|div|span|font)\b[^>]*>(?:<br\s*\/?>|&nbsp;|&#xA0;|&#160;|&zwnj;|&zwj;|\s)*<\/\1>$/i,
      '',
    );
  } while (out !== prev && ++guard < 10000);
  return out;
}

function buildSrcdoc(html: string, themeCss: string, normalize: boolean, allowRemoteImages: boolean): string {
  // CSP meta belt-and-suspenders: block any remote resource fetch the
  // regex stripper missed. Allows inline styles (we inject our own),
  // data: URIs (image-cache base64), and same-origin (about:srcdoc).
  // No remote fonts, stylesheets, scripts, or image hotlinks.
  //
  // Remote images (http/https) are BLOCKED BY DEFAULT — they're the classic
  // tracking-pixel vector (the sender learns you opened the mail + your IP/
  // approx location). The user opts in per-message via "Load images", which
  // re-renders with http/https added back to img-src. Cached images (data:/blob:)
  // always render since they involve no network fetch.
  const imgSrc = allowRemoteImages ? 'data: blob: https: http:' : 'data: blob:';
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:;">`;
  const themeStyle = `<style data-sarv-theme>${themeCss}</style>`;
  const headInjection = `${csp}${themeStyle}`;
  // Strip blocking resources, then normalize fonts + classes + whitespace
  // before injection.
  // stripBlockingResources is ALWAYS applied (drops <script>/<style>/MSO
  // and CSP-doomed <link> tags — required for the iframe to render
  // without console noise and CORS-failed font fetches). The aggressive
  // normalize pass (typography/class/spacing strip) is opt-in via the
  // `normalize` prop — chat bubbles want it for visual consistency,
  // standard single-email view wants the raw rendering.
  const safe = stripBlockingResources(html);
  // Full typography/spacing normalize is opt-in (chat bubbles). The raw view
  // still gets two spacing passes, because "render it as the sender sent it"
  // was never meant to include the sender's dead space:
  //   • trimTrailingDeadSpace — always; it's what closes the gap at the bottom.
  //   • collapseExcessBlankSpace — only for bodies that DON'T look designed.
  //     A marketing template's empty rows are spacers holding its layout
  //     together; a hand-written mail's stacked empty <p>s are just a wall of
  //     nothing the reader has to scroll past. Skipping designed bodies is what
  //     keeps heavy HTML rendering exactly as-is.
  const trimmed = trimTrailingDeadSpace(safe);
  const cleaned = normalize
    ? normalizeHtmlForBubble(safe)
    : (htmlLooksDesigned(trimmed) ? trimmed : collapseExcessBlankSpace(trimmed));
  // Detect a full HTML document by presence of <html> or <body>.
  const hasHtmlTag = /<html\b/i.test(cleaned);
  const hasBodyTag = /<body\b/i.test(cleaned);

  if (hasHtmlTag) {
    // Inject into existing <head> if present, else create one.
    if (/<head\b/i.test(cleaned)) {
      return cleaned.replace(/<\/head>/i, `${headInjection}</head>`);
    }
    // No <head>: inject one right after <html>.
    return cleaned.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${headInjection}</head>`);
  }
  if (hasBodyTag) {
    // Has <body> but no <html>/<head>. Wrap.
    return `<!DOCTYPE html><html><head>${headInjection}</head>${cleaned}</html>`;
  }
  // Plain fragment.
  return `<!DOCTYPE html><html><head>${headInjection}</head><body>${cleaned}</body></html>`;
}

/**
 * Add href to <a> tags that wrap a URL in their text but have no href —
 * common in plaintext-converted-to-HTML output. Done on the source
 * string before srcdoc so the iframe sees correct anchors.
 */
function fixBareLinks(html: string): string {
  return html.replace(/<a(?![^>]*href)([^>]*)>(https?:\/\/[^<]+)<\/a>/gi, '<a href="$2"$1>$2</a>');
}

/**
 * Make all <img> tags non-blocking. Without this, the iframe's `load`
 * event waits for every image to fetch before firing, so a designed
 * email with 30+ tracking pixels + content images blocks the entire
 * render until they all finish (or time out).
 *
 * Adds (only if missing):
 *   - loading="lazy"        → image fetches when scrolled into view, not on parse
 *   - decoding="async"      → off-main-thread decode so it doesn't jank the iframe
 *   - referrerpolicy="no-referrer" → don't leak the user's referer to image hosts
 *
 * The lazy attr in particular changes everything: iframe `load` no
 * longer waits on offscreen images, so DOMContentLoaded happens
 * within milliseconds of srcdoc being set.
 */
function makeImagesNonBlocking(html: string): string {
  return html.replace(/<img\b([^>]*)>/gi, (_, attrs: string) => {
    let a = attrs;
    if (!/\bloading\s*=/i.test(a)) a += ' loading="lazy"';
    if (!/\bdecoding\s*=/i.test(a)) a += ' decoding="async"';
    if (!/\breferrerpolicy\s*=/i.test(a)) a += ' referrerpolicy="no-referrer"';
    return `<img${a}>`;
  });
}

/**
 * Estimate the rendered height from the html's text length BEFORE the
 * iframe has measured itself: ~90 chars per line at typical bubble
 * width, ~21px line-height, clamped to 44..360px. The iframe stays
 * invisible (opacity 0) until the first real measurement lands, so the
 * estimate only needs to be close enough to avoid large scroll jumps —
 * the snap from estimate to measured height happens while the content
 * is still transparent.
 */
function estimateInitialHeight(html: string): number {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = Math.max(1, Math.ceil(text.length / 90));
  return Math.max(44, Math.min(360, lines * 21 + 10));
}

/**
 * Renders email HTML inside an iframe (srcdoc). This is what Gmail,
 * Outlook web, ProtonMail, and effectively every modern email client
 * does — Shadow DOM is a half-measure that lets inheritable CSS leak
 * in and forces awkward <body>-to-<div> rewrites that break designed
 * email shells (gray page bg + white card layouts, table-based
 * centering with @media query breakpoints, etc.).
 *
 * Iframe properties we lean on:
 *  - `sandbox="allow-same-origin allow-popups"` keeps email JS from
 *    running while still letting the parent script read the iframe
 *    document for height measurement and link interception.
 *  - `srcdoc` puts the email's full HTML in its own document context,
 *    so <body> styles, @media queries, table layout, and the email's
 *    own <style> blocks all work natively without rewrites.
 *  - height auto-fits via ResizeObserver on iframe.contentDocument.body.
 */
export function SandboxedEmailBody({ html, className = '', styledTables = false, normalize = false, transparentCanvas = false, heightPadding = 0, blockRemoteImages = true, safeAutoLoad = false, senderAddress }: SandboxedEmailBodyProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Text-length-derived estimate stands in until the iframe document
  // reports a real height — kills the 80px → measured "pop" that used
  // to happen on every thread open.
  const estimatedHeight = useMemo(() => estimateInitialHeight(html), [html]);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  // Content fades in (~150ms) once the first real measurement lands,
  // so the estimate→measured resize happens while invisible.
  const [revealed, setRevealed] = useState(false);
  // Remote images are blocked (tracking-pixel protection) until the user opts in
  // per-message. `hasRemoteImages` drives the "Load images" banner; a remote
  // <img src> or a CSS url(http…) counts.
  const [imagesLoaded, setImagesLoaded] = useState(false);
  // The remote-image setting can opt OUT of blocking so users aren't clicking
  // "Load images" on every mail: 'always' auto-loads everywhere, 'safe'
  // auto-loads only AI-categorized mail that isn't Promotional/Spam (the caller
  // computes eligibility via safeAutoLoad), 'block' keeps the banner. Re-read
  // per message so navigating to a new email picks up a changed setting/category.
  // `html` is in the deps on purpose, though the decision does not read it: a
  // new message must re-ask, because the allowlist cache may have warmed since.
  const autoLoadImages = useMemo(
    () => shouldAutoLoadRemoteImages(senderAddress, safeAutoLoad),
    [html, safeAutoLoad, senderAddress],
  );
  const effectiveBlock = blockRemoteImages && !autoLoadImages;
  const hasRemoteImages = useMemo(
    () => /<img\b[^>]*\ssrc\s*=\s*["']?\s*https?:/i.test(html) || /url\(\s*["']?\s*https?:/i.test(html),
    [html],
  );

  // New html → new document: drop the stale measurement, re-block images, and
  // hide the iframe again until the new content has been measured once.
  useEffect(() => {
    setMeasuredHeight(null);
    setRevealed(false);
    setImagesLoaded(false);
  }, [html]);

  // Render → srcdoc. We rebuild whenever html/styledTables/theme changes.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const isDark = document.documentElement.classList.contains('dark');
    const themeCss = buildIframeCss(isDark, styledTables, normalize, transparentCanvas);
    // Lazy-load images BEFORE srcdoc so the iframe's load event isn't
    // gated on every image network request finishing.
    const lazied = makeImagesNonBlocking(html);
    const fixed = fixBareLinks(lazied);
    // Own/trusted content, or the auto-load setting, always loads; otherwise
    // received mail loads only once the user clicks "Load images".
    const doc = buildSrcdoc(fixed, themeCss, normalize, !effectiveBlock || imagesLoaded);

    // Setting srcdoc resets the iframe and re-fires onload.
    iframe.srcdoc = doc;
  }, [html, styledTables, normalize, imagesLoaded, effectiveBlock]);

  // Measure body height + intercept link clicks. Don't wait for the
  // iframe `load` event — it fires only after every subresource (images,
  // background images, etc.) finishes, which can take 30+ seconds for
  // a designed marketing email even with lazy-loading. Instead, poll
  // for the inner document body to appear (within milliseconds of
  // srcdoc being set) and start measuring from there.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let pollHandle: number | null = null;
    let onWindowResize: (() => void) | null = null;
    let clickHost: HTMLElement | null = null;
    let onBodyClick: ((e: Event) => void) | null = null;
    let attached = false;

    const attach = () => {
      if (attached) return;
      const idoc = iframe.contentDocument;
      if (!idoc || !idoc.body || !idoc.body.firstChild) return;
      attached = true;

      const measure = () => {
        // Before measuring: a table wider than the body would otherwise be
        // clipped away. Wrapping it changes the height (a scrollbar on
        // platforms that reserve space for one), so it has to happen first.
        if (!normalize) {
          try { wrapOverflowingTables(idoc); } catch { /* layout not ready */ }
        }
        // Measure the true bottom of the CONTENT with a Range over the body.
        // A Range's bounding box covers every text node + element (so a
        // trailing bare text node can't be missed → no under-measure →
        // no scrollbar) but EXCLUDES trailing margins/whitespace (so a
        // paragraph's bottom margin doesn't become dead space at the bottom of
        // the bubble). scrollHeight would include that margin; last-child-bottom
        // would miss trailing text — the Range gets both right.
        let h = 0;
        try {
          const range = idoc.createRange();
          range.selectNodeContents(idoc.body);
          const bottom = range.getBoundingClientRect().bottom;
          const bodyTop = idoc.body.getBoundingClientRect().top;
          h = Math.ceil(bottom - bodyTop);
        } catch { /* Range unavailable — fall back below */ }
        // Never UNDER-measure: take the max of the Range height and the
        // document scrollHeight. The iframe's own scrollbar is disabled
        // (scrolling="no"), so an under-measure would CLIP content — we size to
        // the full content height and let the outer page scroll instead. The
        // trailing-dead-space trim keeps scrollHeight from reserving empty space.
        h = Math.max(h, idoc.body.scrollHeight, idoc.documentElement.scrollHeight);
        if (h > 0) {
          setMeasuredHeight(h + heightPadding);
          // First real measurement → safe to fade the content in.
          setRevealed(true);
        }
      };

      // Immediate measurement: body is parsed, text/inline images already
      // laid out. Lazy-loaded remote images may still be coming, but the
      // ResizeObserver below catches their reflows.
      measure();
      // A few follow-ups in case fonts (we strip @font-face but inline
      // <style> may still affect layout) or first-paint images shift things.
      requestAnimationFrame(measure);
      setTimeout(measure, 50);
      setTimeout(measure, 200);
      setTimeout(measure, 800);

      // Observe body resize for dynamic content (e.g. lazy images loading).
      try {
        resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(idoc.body);
      } catch { /* ignore */ }

      // Observe DOM mutations.
      try {
        mutationObserver = new MutationObserver(measure);
        mutationObserver.observe(idoc.body, { childList: true, subtree: true, attributes: true });
      } catch { /* ignore */ }

      // Re-measure on window resize since @media queries inside the
      // iframe may change content height at viewport breakpoints.
      onWindowResize = () => measure();
      window.addEventListener('resize', onWindowResize);

      // Intercept anchor clicks → openExternal in default browser. Keep the
      // handler + its host so cleanup can detach it (the inner document is
      // usually discarded on srcdoc change/unmount, but remove it explicitly
      // for correctness and consistency with the other listeners).
      onBodyClick = (e) => {
        let el: Element | null = e.target as Element;
        while (el && el.tagName !== 'A') el = el.parentElement;
        if (!el) return;
        let href = el.getAttribute('href');
        if (!href) {
          const text = (el.textContent || '').trim();
          if (/^https?:\/\//.test(text)) href = text;
        }
        if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
        e.preventDefault();
        e.stopPropagation();
        if (window.electronAPI?.app?.openExternal) {
          window.electronAPI.app.openExternal(href);
        } else {
          window.open(href, '_blank');
        }
      };
      clickHost = idoc.body;
      clickHost.addEventListener('click', onBodyClick);
    };

    // Poll for the document body to appear. With srcdoc, the iframe's
    // contentDocument is available immediately but the body is parsed
    // asynchronously over a few ticks. 16ms (~1 frame) is enough most
    // of the time; we cap at 60 polls (~1s) to avoid leaking.
    let polls = 0;
    const startPoll = () => {
      if (attached) return;
      attach();
      if (attached) return;
      if (polls++ > 60) return;
      pollHandle = window.setTimeout(startPoll, 16);
    };
    startPoll();

    // Belt-and-suspenders: attach also fires on `load` for cases where
    // polling missed (very small docs that finished parsing before our
    // first poll, or browsers that fire load before our poll runs).
    const onLoad = () => attach();
    iframe.addEventListener('load', onLoad);

    // Safety net: never leave content invisible. If no measurement has
    // landed after 1.2s (e.g. a lazy iframe far offscreen that hasn't
    // loaded yet), reveal at the estimated height — worst case is the
    // old resize-while-visible behavior, never a blank bubble.
    const revealTimer = window.setTimeout(() => setRevealed(true), 1200);

    return () => {
      iframe.removeEventListener('load', onLoad);
      if (pollHandle != null) clearTimeout(pollHandle);
      clearTimeout(revealTimer);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (onWindowResize) window.removeEventListener('resize', onWindowResize);
      if (clickHost && onBodyClick) clickHost.removeEventListener('click', onBodyClick);
    };
  }, [html, styledTables, normalize]);

  // Theme change: re-render so our injected <style> picks up new colors.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      const idoc = iframe.contentDocument;
      if (!idoc) return;
      const isDark = document.documentElement.classList.contains('dark');
      const themeStyle = idoc.querySelector('style[data-sarv-theme]');
      if (themeStyle) {
        themeStyle.textContent = buildIframeCss(isDark, styledTables, normalize, transparentCanvas);
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, [styledTables, normalize]);

  return (
    <>
      {effectiveBlock && hasRemoteImages && !imagesLoaded && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 mb-1.5 rounded-md border border-border bg-muted/40 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5 min-w-0">
            <ImageOff className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">Remote images blocked to protect your privacy</span>
          </span>
          <button
            type="button"
            onClick={() => { rememberSenderImagesAllowed(senderAddress); setImagesLoaded(true); }}
            className="font-medium text-primary hover:underline whitespace-nowrap flex-shrink-0"
          >
            Load images
          </button>
        </div>
      )}
      <iframe
      ref={iframeRef}
      // No allow-scripts: email JS never runs. allow-same-origin
      // gives the parent script DOM access (for height + clicks).
      // allow-popups so the email's links → window.open fall through
      // before our click interceptor catches and reroutes them.
      sandbox="allow-same-origin allow-popups"
      // The iframe is sized to its full content height, so it should never
      // show its OWN scrollbar — a single email expands fully and the outer
      // page scrolls. (Height is a max of Range + scrollHeight, so content is
      // never clipped by this.)
      scrolling="no"
      // loading="lazy" keeps off-screen iframes from spending CPU on
      // parse/layout until they scroll near the viewport. In chat
      // view with 10+ bubbles this turns "scrolly stutter while every
      // iframe lays out" into "instant first paint of the first 2-3".
      loading="lazy"
      className={className}
      style={{
        width: '100%',
        height: `${measuredHeight ?? estimatedHeight}px`,
        border: 0,
        display: 'block',
        // Transparent — the email's body styling provides any
        // background. The app shell's bg shows through if absent.
        backgroundColor: 'transparent',
        colorScheme: 'normal',
        // Fade in once the first real measurement has landed so the
        // estimate→measured height snap happens while invisible.
        opacity: revealed ? 1 : 0,
        transition: 'opacity 150ms ease-out',
      }}
      title="Email body"
      />
    </>
  );
}
