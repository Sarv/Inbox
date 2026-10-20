import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { describe, expect, it } from 'vitest';

import { buildPrintDocument } from '../../../../src/components/email-detail/print-document';
import { buildSrcdoc, stripBlockingResources } from '../../../../src/components/SandboxedEmailBody';

// Resource hints in email HTML. A `<link rel="dns-prefetch">` makes Chromium
// resolve its host as soon as the email is shown, and DNS prefetching is
// outside the frame's CSP — so with remote images blocked, a tracker with its
// own DNS still learns the email was opened, and from which network. Checked
// against Electron's network log: every form in HONORED resolved, and the old
// rel list missed the first three. What breaks if this file fails: such an
// email phones home on open.

type Node = DefaultTreeAdapterMap['childNode'] | DefaultTreeAdapterMap['document'];
const children = (node: Node): Node[] => ('childNodes' in node ? (node.childNodes as Node[]) : []);
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Every HTML <link>, <script> and frame a browser's parser builds from `doc`
 * (parse5 follows the spec) — including inside a nested frame's `srcdoc`,
 * which the browser decodes and parses as a document of its own.
 */
function parsedTags(doc: string): { links: number; scripts: number; frames: number } {
  const found = { links: 0, scripts: 0, frames: 0 };
  const walk = (node: Node) => {
    if ('tagName' in node && node.namespaceURI === HTML_NS) {
      if (node.tagName === 'link') found.links++;
      if (node.tagName === 'script') found.scripts++;
      if (node.tagName === 'iframe' || node.tagName === 'frame') found.frames++;
      const srcdoc = node.attrs.find((a) => a.name === 'srcdoc');
      if (srcdoc) {
        const nested = parsedTags(srcdoc.value);
        found.links += nested.links;
        found.scripts += nested.scripts;
        found.frames += nested.frames;
      }
    }
    if ('content' in node && node.content) walk(node.content as unknown as Node); // <template>
    children(node).forEach(walk);
  };
  walk(parse(doc));
  return found;
}

const HOST = '//t.tracker.example';

/** Each one made Electron 44 resolve the host (network log, DNS_TRANSACTION_QUERY). */
const HONORED = [
  `<link rel="alternate dns-prefetch" href="${HOST}">`,
  `<link rel=" dns-prefetch" href="${HOST}">`,
  `<link rel="&#100;ns-prefetch" href="${HOST}">`,
  `<link href="${HOST}" rel="DNS-PREFETCH">`,
  `<p>text <link rel="dns-prefetch" href="${HOST}"> more</p>`,
  `<link rel="dns-prefetch" href="https://t.tracker.example/path?x=1">`,
];

describe('stripBlockingResources — resource hints', () => {
  it.each(HONORED)('leaves no <link> from %s', (hint) => {
    const out = stripBlockingResources(`<p>a</p>${hint}<p>b</p>`);
    expect(parsedTags(out).links).toBe(0);
    expect(out).not.toContain('tracker.example');
  });

  // A hint ENTITY-ENCODED in a nested frame's srcdoc has no `<link` for the
  // drop to see; Chromium decodes it into a live link (network log: resolved,
  // nested twice too). Breaks: the hint simply moves into a frame.
  it.each([
    `<iframe srcdoc="&lt;link rel=dns-prefetch href=${HOST}&gt;" width=0 height=0></iframe>`,
    `<iframe srcdoc="&lt;iframe srcdoc='&amp;lt;link rel=dns-prefetch href=${HOST}&amp;gt;'&gt;&lt;/iframe&gt;"></iframe>`,
    `<IFRAME SRCDOC="&lt;link rel=dns-prefetch href=${HOST}&gt;"></IFRAME>`,
    `<ifr<link>ame srcdoc="&lt;link rel=dns-prefetch href=${HOST}&gt;"></iframe>`,
    `<frameset><frame src="https:${HOST}/"></frameset>`,
  ])('leaves no frame (and so no hidden hint) from %s', (hostile) => {
    const out = stripBlockingResources(`<p>a</p>${hostile}<p>b</p>`);
    expect(parsedTags(out)).toEqual({ links: 0, scripts: 0, frames: 0 });
  });

  // A frameset document is the one place a <frame> is built (after body
  // content the parser ignores <frameset>). Breaks: a framed email loads a
  // page the frame's CSP was never asked about.
  it('leaves no <frame> in a frameset email', () => {
    const email = `<html><head></head><frameset><frame src="https:${HOST}/"><FRAME/src="https:${HOST}/b"></frameset></html>`;
    expect(parsedTags(email).frames).toBe(2); // the oracle sees them unstripped
    expect(parsedTags(stripBlockingResources(email)).frames).toBe(0);
  });

  // Every rel, not a list: the list is what was bypassed.
  it.each(['preconnect', 'prefetch', 'preload', 'modulepreload', 'prerender', 'stylesheet', 'icon', 'next', 'made-up'])(
    'drops a link with rel=%s',
    (rel) => {
      expect(parsedTags(stripBlockingResources(`<link rel="${rel}" href="${HOST}"><p>x</p>`)).links).toBe(0);
    },
  );

  // A drop splices the text around it; what it leaves must not become a new
  // link or script. Breaks: `<lin<link>k …>` turns into a live hint.
  it.each([
    `<lin<link>k rel="dns-prefetch" href="${HOST}">`,
    `<li<script></script>nk rel="dns-prefetch" href="${HOST}">`,
    `<li<script src=x />nk rel="dns-prefetch" href="${HOST}">`,
    `<scr<link rel=x>ipt>alert(1)</script>`,
    `<LiNk/rel="dns-prefetch"/href="${HOST}">`,
    `<link\trel="dns-prefetch"\nhref="${HOST}"\f>`,
  ])('leaves no link or script from the splice %s', (hostile) => {
    const { links, scripts } = parsedTags(stripBlockingResources(`<p>a</p>${hostile}<p>b</p>`));
    expect(links).toBe(0);
    expect(scripts).toBe(0);
  });

  // Breaks: ordinary text and look-alike tags are mangled.
  it('leaves text and other tags that merely start with "link" or "frame" alone', () => {
    const html = '<p>Open the link below, in a frame</p><a href="https://example.com/">link</a><linkedin-badge>x</linkedin-badge><framework-note>y</framework-note>';
    expect(stripBlockingResources(html)).toBe(html);
  });

  // Breaks: a crafted email freezes the window (the regex rewrite this file
  // sits beside exists for that). One split per pass: linear.
  it('stays linear on hostile input', () => {
    const timed = (n: number) => {
      const input = `${'<link '.repeat(n)}${'<lin<link>k>'.repeat(n)}`;
      const start = performance.now();
      stripBlockingResources(input);
      return performance.now() - start;
    };
    timed(1_000); // warm up
    const small = Math.min(timed(20_000), timed(20_000));
    const large = Math.min(timed(160_000), timed(160_000));
    expect(large / Math.max(small, 0.5)).toBeLessThan(24); // 8x input: ~8x linear, ~64x quadratic
  }, 20_000);
});

describe('buildSrcdoc — the frame document', () => {
  // The normalize pass runs after the strip and deletes markup (`<o:p>`, class
  // and style attributes); a deletion can splice a new link together. Breaks:
  // the chat bubble view (normalize on) shows a live dns-prefetch hint.
  it.each([
    `<li<o:p>nk rel="dns-prefetch" href="${HOST}">`,
    `<li<o:p></o:p>nk rel="dns-prefetch" href="${HOST}">`,
    `<li class="a"nk rel="dns-prefetch" href="${HOST}">`,
  ])('contains no <link> after the normalize pass splices %s', (email) => {
    expect(parsedTags(buildSrcdoc(`<p>x</p>${email}<p>y</p>`, 'THEME', true, false)).links).toBe(0);
  });

  // The whole pipeline, as the frame gets it: full documents, fragments, and
  // the normalize pass. Breaks: a later transform re-creates a link.
  it.each([
    [`<html><head>${HONORED[0]}</head><body><p>x</p></body></html>`],
    [`<p>fragment</p>${HONORED[1]}`],
    [`<!DOCTYPE html><html><body>${HONORED[2]}</body></html>`],
  ])('contains no <link> for %s', (email) => {
    for (const normalize of [false, true]) {
      expect(parsedTags(buildSrcdoc(email, 'THEME', normalize, false)).links).toBe(0);
    }
  });
});

describe('buildPrintDocument', () => {
  const email = (rawBody: string) => ({ subject: 's', fromAddress: 'a@b.c', toAddress: 'me@x.y', date: 0, rawBody });

  // Print put the raw body into its frame with no strip at all: every hint,
  // the first-token ones included. Breaks: printing an email reports it.
  it.each(HONORED.concat(`<link rel="dns-prefetch" href="${HOST}">`, `<link rel="preconnect" href="https:${HOST}">`))(
    'prints no <link> from %s',
    (hint) => {
      const doc = buildPrintDocument(email(`<p>a</p>${hint}<p>b</p>`), false);
      expect(parsedTags(doc).links).toBe(0);
      expect(doc).not.toContain('tracker.example');
    },
  );

  it.each([
    `<iframe srcdoc="&lt;link rel=dns-prefetch href=${HOST}&gt;"></iframe>`,
    `<script>x()</script><scr<link>ipt>y()</script>`,
  ])('prints no frame or script from %s', (hostile) => {
    expect(parsedTags(buildPrintDocument(email(`<p>a</p>${hostile}`), false))).toMatchObject({ links: 0, frames: 0, scripts: 0 });
  });

  // Breaks: the strip loses the body itself.
  it('still prints the body', () => {
    expect(buildPrintDocument(email('<p>Quarterly numbers</p>'), false)).toContain('<p>Quarterly numbers</p>');
  });

  // Print keeps the email's own styles: it only needs the active content gone.
  // Breaks: a screen-only rule (`media="screen and (max-width:480px)"`) hides
  // part of the paper copy, or the sender's embedded font is dropped.
  it('keeps the email\'s style attributes and embedded fonts', () => {
    const body = '<style media="screen and (max-width:480px)">.desk{display:none}</style><style>@font-face{font-family:X;src:url(data:font/woff2;base64,AAAA)}</style><div class="desk">Order total: $42</div>';
    const doc = buildPrintDocument(email(body), false);
    expect(doc).toContain('<style media="screen and (max-width:480px)">');
    expect(doc).toContain('@font-face{font-family:X;src:url(data:font/woff2;base64,AAAA)}');
  });

  // Printed before the full body loaded, the plain-text snippet was inserted
  // as HTML, unstripped — and it can hold a literal `<link …>` (a text/plain
  // part, or decoded entities). Breaks: printing a not-yet-loaded email
  // reports it.
  it('prints the plain-text fallback as text', () => {
    const doc = buildPrintDocument({ subject: 's', fromAddress: 'a@b.c', date: 0, cleanBody: `<link rel=dns-prefetch href=${HOST}> hello` }, false);
    expect(parsedTags(doc).links).toBe(0);
    expect(doc).toContain(`&lt;link rel=dns-prefetch href=${HOST}&gt; hello`);
  });
});
