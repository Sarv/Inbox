import { describe, expect, it } from 'vitest';

import {
  buildSrcdoc,
  estimateInitialHeight,
  fixBareLinks,
  forceLinksExternal,
  makeImagesNonBlocking,
  normalizeHtmlForBubble,
  stripBlockingResources,
  trimTrailingDeadSpace,
} from '../../../../src/components/SandboxedEmailBody';
import { collapseExcessBlankSpace, convertToEmailHtml, htmlLooksDesigned } from '../../../../src/utils/email-html';

// Opening an email runs its HTML through these transforms on the renderer's
// main thread. Most of them used `<tag\b[^>]*>` / lazy `[\s\S]*?</tag>` scans,
// which go quadratic on runs of unclosed tags: 40 KB of `<p<p<p…` took 1.7 s,
// 400 KB would freeze the window for minutes — one crafted email, every time it
// was opened. What breaks if this fails: an email can freeze the app again.

/** Hostile bodies: unclosed tags, unterminated blocks, ambiguous runs. */
const HOSTILE: Record<string, (n: number) => string> = {
  'unclosed <p': (n) => '<p'.repeat(n / 2),
  'unclosed <div': (n) => '<div'.repeat(n / 4),
  'unclosed <a ': (n) => '<a '.repeat(n / 3),
  'unclosed <img': (n) => '<img'.repeat(n / 4),
  'unclosed <img src': (n) => '<img src="'.repeat(n / 10),
  'unclosed <link': (n) => '<link'.repeat(n / 5),
  'unclosed <link rel': (n) => '<link rel=x'.repeat(n / 11),
  'unclosed <font': (n) => '<font'.repeat(n / 5),
  'unclosed <o:p': (n) => '<o:p'.repeat(n / 4),
  'unclosed <html': (n) => '<html'.repeat(n / 5),
  'unclosed <script': (n) => '<script'.repeat(n / 7),
  'unclosed <style': (n) => '<style'.repeat(n / 6),
  'unterminated <style>': (n) => '<style>'.repeat(n / 7),
  'unterminated <script>': (n) => '<script>'.repeat(n / 8),
  "lone '<'": (n) => '<'.repeat(n),
  'spaces in an empty <p>': (n) => `<p>${' '.repeat(n)}x`,
  '<br> runs': (n) => '<br> '.repeat(n / 5),
  'empty <p></p>': (n) => '<p></p>'.repeat(n / 7),
};

/** Everything the viewer runs on a body, in order. */
const renderPipeline = (html: string, normalize: boolean) => {
  const fixed = forceLinksExternal(fixBareLinks(makeImagesNonBlocking(html)));
  buildSrcdoc(fixed, '', normalize, false);
  estimateInitialHeight(html);
  htmlLooksDesigned(html);
};

describe('no email body can freeze the viewer', () => {
  // Sized so a regression FAILS in seconds instead of hanging CI (a regex
  // can't be interrupted): at 100 KB the linear code takes a few ms, the old
  // quadratic code took seconds — and at 1 MB, 38 s to 6.5 minutes for ONE
  // email. The budget is generous so a loaded runner never flakes.
  it.each(Object.keys(HOSTILE))('renders 100 KB of %s quickly', (name) => {
    const html = HOSTILE[name](100_000);
    const start = performance.now();
    renderPipeline(html, false);
    renderPipeline(html, true);
    collapseExcessBlankSpace(html);
    expect(performance.now() - start).toBeLessThan(750);
  });
});

describe('ordinary mail is transformed exactly as before', () => {
  // These pin behaviour the linear rewrite must keep (a differential run of
  // 6,000 generated realistic emails against the previous implementation found
  // no difference in any transform).
  it('strips style/script/stylesheet resources but keeps the rest', () => {
    const out = stripBlockingResources(
      '<style>@font-face{font-family:X} .a{color:red}</style><link rel="stylesheet" href="s.css"><link rel="icon" href="f.ico"><script>x()</script><script src=y /><p>hi</p>',
    );
    expect(out).toBe('<style> .a{color:red}</style><link rel="icon" href="f.ico"><p>hi</p>');
  });

  // Breaks: a script survives the strip (defense in depth behind the sandbox
  // and CSP) — closed by `</script >`, spliced together by the deletion, or
  // hidden behind a `<` in an attribute.
  it('leaves no <script tag behind, however the markup is bent', () => {
    expect(stripBlockingResources('<p>a</p><script>x()</script ><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(stripBlockingResources('<p>a</p><SCRIPT>x()</script foo="1"><p>b</p>')).toBe('<p>a</p><p>b</p>');
    for (const hostile of [
      '<scr<script></script>ipt>alert(1)</script>',
      '<script x="<">alert(1)</script>',
      '<<script>x</script>script>',
      '<script>unterminated',
    ]) {
      expect(stripBlockingResources(hostile)).not.toMatch(/<\/?script/i);
    }
    // Ordinary text that mentions scripts is untouched.
    expect(stripBlockingResources('<p>a subscript, a scripted reply</p>')).toBe('<p>a subscript, a scripted reply</p>');
  });

  // Breaks: a `</style >` closer is not recognised, so its style block is left
  // unprocessed (web fonts load, dark-mode CSS fires).
  it('processes a style block closed with </style >', () => {
    expect(stripBlockingResources('<style>@font-face{font-family:X} .a{}</style ><p>x</p>')).toBe('<style> .a{}</style><p>x</p>');
  });

  // The "up to the last closing tag" bound must not change what is matched.
  it('treats a <style> after the last </style> exactly as before (left alone)', () => {
    expect(stripBlockingResources('<style>a</style><p>x</p><style>unterminated')).toBe('<style>a</style><p>x</p><style>unterminated');
  });

  it('drops empty paragraphs and collapses <br> runs when normalizing', () => {
    expect(normalizeHtmlForBubble('<p>keep</p><p> <br>  <br/> </p><div>\n<br>\n</div><p>x</p>')).toBe('<p>keep</p><p>x</p>');
    expect(normalizeHtmlForBubble('a<br><br><br>b')).toBe('a<br>b');
  });

  it('collapses blank blocks but never a styled spacer', () => {
    expect(collapseExcessBlankSpace('a<p> </p><div>&nbsp;</div><p><br></p>b')).toBe('a<br>b');
    expect(collapseExcessBlankSpace('a<div style="height:20px"></div>b')).toBe('a<div style="height:20px"></div>b');
  });

  it('repairs bare links and makes links open externally', () => {
    expect(fixBareLinks('<a>https://x.example/p</a>')).toBe('<a href="https://x.example/p">https://x.example/p</a>');
    expect(forceLinksExternal('<a href="https://e.com">e</a>')).toBe('<a rel="noopener noreferrer" target="_blank" href="https://e.com">e</a>');
    expect(forceLinksExternal('<a href="mailto:a@b.c">m</a>')).toBe('<a href="mailto:a@b.c">m</a>');
  });

  it('lazy-loads images, keeping explicit attributes', () => {
    expect(makeImagesNonBlocking('<img src="a.png" loading=eager>')).toBe('<img src="a.png" loading=eager decoding="async" referrerpolicy="no-referrer">');
  });

  it('peels trailing dead space', () => {
    expect(trimTrailingDeadSpace('<p>last</p><div><br></div><div>&nbsp;</div>\n  ')).toBe('<p>last</p>');
  });

  it('still recognises designed mail and converts outgoing lists', () => {
    expect(htmlLooksDesigned('<a href="x" style="background:#06c;padding:8px">Go</a>')).toBe(true);
    expect(htmlLooksDesigned('<p>hi</p>')).toBe(false);
    expect(convertToEmailHtml('<ul class="x"><li data-a="1">a</li></ul>')).toContain('<ul style="margin: 0 0 10px; padding-left: 24px; list-style-type: disc;">');
  });

  // KNOWN, DELIBERATE divergence: a tag whose attribute contains a raw '<'
  // (invalid HTML — it should be &lt;) is no longer matched, because tag scans
  // now stop at the next '<' to stay linear. Only cosmetic rewrites are skipped
  // for such a tag; scripts still can't run (sandboxed frame) and remote
  // resources are still blocked by the frame's CSP.
  it('leaves a tag with a raw "<" in an attribute untouched (documented limitation)', () => {
    expect(makeImagesNonBlocking('<img alt="a<b" src="x.png">')).toBe('<img alt="a<b" src="x.png">');
    expect(estimateInitialHeight('<img alt="a<b" src="x.png">')).toBeGreaterThan(0);
  });
});
