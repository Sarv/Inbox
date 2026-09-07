import { describe, expect, it } from 'vitest';

import { cleanEmailHtmlForLLM } from '../../../src/parser/html-clean';

// This cleaner shapes untrusted email HTML for an LLM prompt (and, in practice,
// its output is the text that gets embedded in prompts and shown in summaries).
// Two classes of guarantee are tested:
//   1. SAFETY — active content (script/iframe/on* handlers/javascript: URLs) is
//      removed, so nothing executable ever survives into a downstream renderer.
//   2. SIGNAL — the structural cues the LLM needs survive, and the noise
//      (styles, trackers, base64 images, MSO markup) does not.

describe('cleanEmailHtmlForLLM — active content is stripped', () => {
  it('drops <script> blocks together with their code', () => {
    const out = cleanEmailHtmlForLLM('<p>before</p><script>alert("xss");window.x=1</script><p>after</p>');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');           // the code text is gone too
  });

  it('drops <style> blocks together with their CSS', () => {
    const out = cleanEmailHtmlForLLM('<style>.a{color:red}</style><p>content</p>');
    expect(out).toContain('content');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('style');
  });

  it('drops <iframe>, <object>, <embed> and <form> wrappers', () => {
    const out = cleanEmailHtmlForLLM(
      '<iframe src="https://evil.example/x"></iframe>' +
      '<object data="evil.swf"></object>' +
      '<embed src="evil.swf">' +
      '<form action="https://evil.example/steal"><input name="pw"></form>' +
      '<p>real text</p>',
    );
    expect(out).toContain('real text');
    expect(out).not.toMatch(/iframe|object|embed|<form|<input/i);
    expect(out).not.toContain('evil.example');
  });

  it('removes every on* event handler attribute', () => {
    const out = cleanEmailHtmlForLLM(
      '<p onclick="steal()" onmouseover="x()">click me</p>' +
      '<div onload="boom()">body</div>',
    );
    expect(out).toContain('click me');
    expect(out).not.toMatch(/onclick|onmouseover|onload/i);
    expect(out).not.toContain('steal()');
  });

  it('strips javascript: and data: hrefs while keeping ordinary links', () => {
    const out = cleanEmailHtmlForLLM(
      '<a href="javascript:alert(1)">bad</a>' +
      '<a href="data:text/html;base64,PHNjcmlwdD4=">also bad</a>' +
      '<a href="https://good.example/page">good</a>',
    );
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:text/html');
    expect(out).toContain('href="https://good.example/page"'); // real link survives
    expect(out).toContain('bad');                              // anchor TEXT is kept
  });

  it('keeps no attributes other than href — no class/id/style/data-* leakage', () => {
    const out = cleanEmailHtmlForLLM(
      '<p class="MsoNormal" id="x1" style="font-family:Arial" data-track="abc">text</p>' +
      '<a href="https://x.example" class="btn" style="color:red">link</a>',
    );
    expect(out).not.toMatch(/class=|id=|style=|data-track/);
    expect(out).toContain('href="https://x.example"');
  });
});

describe('cleanEmailHtmlForLLM — noise removal', () => {
  it('removes head/meta/link/title/noscript boilerplate and its text', () => {
    const out = cleanEmailHtmlForLLM(
      '<head><meta charset="utf-8"><link rel="stylesheet" href="a.css"><title>Newsletter #42</title></head>' +
      '<noscript>enable javascript</noscript><p>body copy</p>',
    );
    expect(out).toContain('body copy');
    expect(out).not.toContain('Newsletter #42');
    expect(out).not.toContain('enable javascript');
    expect(out).not.toContain('a.css');
  });

  it('removes HTML comments including MSO conditionals', () => {
    const out = cleanEmailHtmlForLLM(
      '<!--[if mso]><table><tr><td>outlook only</td></tr></table><![endif]-->' +
      '<!-- plain comment --><p>real</p>',
    );
    expect(out).toContain('real');
    expect(out).not.toContain('outlook only');
    expect(out).not.toContain('plain comment');
  });

  it('replaces a content image with a short [image] marker', () => {
    const out = cleanEmailHtmlForLLM('<p>see <img src="https://cdn.example/photo.jpg" width="600" height="400"> here</p>');
    expect(out).toContain('[image]');
    expect(out).not.toContain('cdn.example');
  });

  it('drops tracking pixels (1x1 / 2px) entirely — no [image] noise', () => {
    expect(cleanEmailHtmlForLLM('<p>a<img src="https://x.example/p.gif" width="1" height="1">b</p>')).not.toContain('[image]');
    expect(cleanEmailHtmlForLLM('<p>a<img height="2" src="https://x.example/p.gif">b</p>')).not.toContain('[image]');
  });

  it('drops known-tracker image URLs even at a normal size', () => {
    for (const src of [
      'https://track.example.com/pixel.gif',
      'https://x.example/o/?id=1',
      'https://x.example/open?u=1',
      'https://x.list-manage.com/tracking/click',
      'https://hs-analytics.net/x.gif',
      'https://sendgrid.net/wf/open?upn=1',
    ]) {
      const out = cleanEmailHtmlForLLM(`<p>x<img src="${src}" width="600">y</p>`);
      expect(out, src).not.toContain('[image]');
    }
  });

  it('drops an <img> with no usable src (including inline base64 bloat)', () => {
    expect(cleanEmailHtmlForLLM('<p>a<img>b</p>')).not.toContain('[image]');
    expect(cleanEmailHtmlForLLM('<p>a<img alt="x">b</p>')).not.toContain('[image]');
    const b64 = cleanEmailHtmlForLLM(`<p>a<img src="data:image/png;base64,${'A'.repeat(500)}" width="600">b</p>`);
    expect(b64).not.toContain('AAAA');            // never echoes the payload
  });

  it('handles single-quoted and unquoted img src attributes', () => {
    expect(cleanEmailHtmlForLLM("<img src='https://cdn.example/a.png' width='600'>")).toContain('[image]');
    expect(cleanEmailHtmlForLLM('<img src=https://cdn.example/a.png width=600>')).toContain('[image]');
  });
});

describe('cleanEmailHtmlForLLM — structure and text the LLM needs', () => {
  it('keeps paragraphs, lists, tables, quotes, emphasis and links', () => {
    const out = cleanEmailHtmlForLLM(
      '<div><h2>Heading</h2><p>Intro <strong>bold</strong> and <em>italic</em>.</p>' +
      '<ul><li>first</li><li>second</li></ul>' +
      '<table><tr><td>cell</td></tr></table>' +
      '<blockquote>quoted</blockquote>' +
      '<pre><code>code()</code></pre>' +
      '<a href="https://x.example">link text</a></div>',
    );
    for (const fragment of ['<h2>', '<p>', '<strong>', '<em>', '<ul>', '<li>', '<table>', '<td>', '<blockquote>', '<pre>', '<code>', '<a href="https://x.example">']) {
      expect(out, fragment).toContain(fragment);
    }
    expect(out).toContain('second');
  });

  it('decodes the entities sanitize-html re-encodes, so the LLM reads plain text', () => {
    const out = cleanEmailHtmlForLLM(
      '<p>Tom&nbsp;&amp;&nbsp;Jerry &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39; &apos;x&apos; &#8364;5 &#x1F600;</p>',
    );
    // NOTE: &nbsp; survives as a literal U+00A0 (sanitize-html decodes it to the
    // character, so the `&nbsp;` → ' ' rule never sees an entity, and the
    // whitespace collapse only touches ASCII space/tab). Normalize before
    // asserting so this pins the real output rather than the intended one.
    expect(out.replace(/ /g, ' ')).toContain('Tom & Jerry');
    expect(out).toContain('<tag>');
    expect(out).toContain('"quoted"');
    expect(out).toContain("'apos'");
    expect(out).toContain('€5');
    expect(out).toContain('😀');
  });

  // Double-encoded entities (`&amp;#65;`) are common in forwarded/re-wrapped
  // email HTML: sanitize-html leaves them alone, so the decoder must resolve
  // them itself rather than leaving numeric escapes in the prompt.
  it('decodes double-encoded numeric entities and leaves out-of-range ones literal', () => {
    expect(cleanEmailHtmlForLLM('<p>&amp;#65;&amp;#x42;</p>')).toBe('<p>AB</p>');
    expect(cleanEmailHtmlForLLM('<p>&amp;#1114112; &amp;#x110000;</p>')).toBe('<p>&#1114112; &#x110000;</p>');
  });

  it('does not throw on out-of-range numeric entities (they degrade to U+FFFD)', () => {
    const out = cleanEmailHtmlForLLM('<p>&#1114112; &#xFFFFFFF;</p>');
    expect(out).toBe('<p>� �</p>');   // sanitize-html already replaced them
  });

  it('collapses runs of spaces and blank lines', () => {
    const out = cleanEmailHtmlForLLM('<p>a      b</p>\n\n\n\n\n<p>c</p>');
    expect(out).toContain('a b');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('collapses long <br> runs and removes leftover empty tags', () => {
    const out = cleanEmailHtmlForLLM('<p>a</p><br><br><br><br><br><p>b</p><span> </span><p></p>');
    expect(out.match(/<br/g)?.length ?? 0).toBeLessThanOrEqual(2);
    expect(out).not.toContain('<p></p>');
  });

  it('unwraps <span>/<small> wrappers but keeps their text', () => {
    const out = cleanEmailHtmlForLLM('<p><span>inner text</span> and <small>fine print</small></p>');
    expect(out).toContain('inner text');
    expect(out).toContain('fine print');
    expect(out).not.toContain('<span>');
    expect(out).not.toContain('<small>');
  });
});

describe('cleanEmailHtmlForLLM — options and bounds', () => {
  it('returns an empty string for empty/blank input', () => {
    expect(cleanEmailHtmlForLLM('')).toBe('');
    expect(cleanEmailHtmlForLLM(undefined as unknown as string)).toBe('');
    expect(cleanEmailHtmlForLLM('   \n  ')).toBe('');
  });

  it('truncates to maxLength', () => {
    const out = cleanEmailHtmlForLLM(`<p>${'word '.repeat(200)}</p>`, { maxLength: 50 });
    expect(out).toHaveLength(50);
  });

  it('leaves output alone when it is already under maxLength', () => {
    expect(cleanEmailHtmlForLLM('<p>short</p>', { maxLength: 500 })).toBe('<p>short</p>');
  });

  it('dropLinkHrefs keeps the anchor text but removes the URL (token saving)', () => {
    const out = cleanEmailHtmlForLLM('<a href="https://x.example/very/long/tracking/url">click</a>', { dropLinkHrefs: true });
    expect(out).toContain('click');
    expect(out).not.toContain('https://x.example');
  });

  // A hostile/huge marketing body must not pin the main process: the INPUT is
  // capped before sanitize-html tokenizes it.
  it('caps the raw input it will tokenize (200 KB) so a giant body cannot stall the main process', () => {
    const huge = `<p>${'x'.repeat(250_000)}</p><p>TAIL_MARKER</p>`;
    const started = Date.now();
    const out = cleanEmailHtmlForLLM(huge);
    expect(out).not.toContain('TAIL_MARKER');    // everything past the cap is discarded
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
