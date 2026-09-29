// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

import { compressHtmlToPlainTextForLLM } from '../../../../src/services/llm-text';

// Moved here unchanged, together with the function (services/llm-text.ts),
// from the retired whole-thread extractor's tests. What breaks if these fail:
// the thread summary's input changes — a page of legal boilerplate per message
// in the prompt, or real body text eaten by the disclaimer pattern.

// The signature-boilerplate stripper used to hardcode ONE company's disclaimer
// text. Publishing that named a real third party, so the pattern was widened to
// any "Email Disclaimer – <company>:" block. If this regresses, either the LLM
// prompt carries a page of legal boilerplate per message (burning context and
// skewing extraction), or — worse — the widened pattern eats real body text.
describe('compressHtmlToPlainTextForLLM — disclaimer boilerplate', () => {
  const disclaimer =
    'Email Disclaimer \u2013 Example Corp Limited: This message and any attachments ' +
    'are confidential and intended solely for the addressee, unless explicitly stated.';

  it('strips a disclaimer block whatever company it names', () => {
    for (const company of ['Example Corp Limited', 'Acme Pvt Ltd', 'Widgets, Inc']) {
      const body = `<p>Please review the attached invoice.</p><p>${disclaimer.replace('Example Corp Limited', company)}</p>`;
      const out = compressHtmlToPlainTextForLLM(body);
      expect(out).toContain('Please review the attached invoice.');
      expect(out).not.toContain('confidential and intended solely');
      expect(out).not.toContain(company);
    }
  });

  it('leaves ordinary prose that merely mentions a disclaimer alone', () => {
    const body = '<p>The Email Disclaimer we agreed on still needs legal sign-off.</p>';
    expect(compressHtmlToPlainTextForLLM(body)).toContain('still needs legal sign-off');
  });
});

// The rest of the compression, pinned now that it has a module of its own.
// What breaks if these fail: the thread summary is fed kilobytes of base64 or
// tracking pixels, loses the "> " structure that tells the model who said
// what, or loses message text along with a signature.
describe('compressHtmlToPlainTextForLLM — structure and chrome', () => {
  it('returns nothing for an empty body', () => {
    expect(compressHtmlToPlainTextForLLM('')).toBe('');
  });

  it('drops tracking pixels and src-less images, and keeps content images as short refs', () => {
    const out = compressHtmlToPlainTextForLLM([
      '<p>Hello</p>',
      '<img src="https://t.example/open?id=1" width="1" height="1">',
      '<img src="https://mailchimp.com/track/abc.png">',
      '<img alt="no source">',
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
      '<img src="https://cdn.example/diagram.png">',
    ].join(''));
    expect(out).toContain('Hello');
    expect(out).not.toContain('t.example/open');
    expect(out).not.toContain('mailchimp.com/track');
    expect(out).toMatch(/!\[\]\(sarv-image:[0-9a-f]{8}\)/);
    expect(out).not.toContain('base64');
    expect(out).toContain('![](https://cdn.example/diagram.png)');
  });

  it('drops signature blocks, but keeps a long block that only looks like one', () => {
    const out = compressHtmlToPlainTextForLLM([
      '<p>The actual message.</p>',
      '<div class="gmail_signature">Jane Doe | CEO</div>',
      '<div id="Signature">Short sig</div>',
      `<div class="signature">${'Real content that is long. '.repeat(30)}</div>`,
    ].join(''));
    expect(out).toContain('The actual message.');
    expect(out).not.toContain('Jane Doe');
    expect(out).not.toContain('Short sig');
    expect(out).toContain('Real content that is long.');
  });

  it('prefixes quoted lines with "> " per nesting level', () => {
    const out = compressHtmlToPlainTextForLLM(
      '<p>Top reply</p><blockquote><p>Level one</p><blockquote><p>Level two</p></blockquote></blockquote>',
    );
    expect(out).toContain('Top reply');
    expect(out).toMatch(/^> Level one$/m);
    expect(out).toMatch(/^> > Level two$/m);
  });

  it('flattens breaks, cells and entities, and drops MSO conditionals and head chrome', () => {
    const out = compressHtmlToPlainTextForLLM([
      '<html><head><title>T</title><style>p{}</style></head><body>',
      '<!--[if gte mso 9]><xml>office stuff</xml><![endif]-->',
      '<p>A &amp; B&nbsp;&lt;tag&gt; &quot;q&quot; it&#39;s<br>next line</p>',
      '<table><tr><td>c1</td><td>c2</td></tr></table>',
      '<p>Get Outlook for iOS</p>',
      '</body></html>',
    ].join(''));
    expect(out).toContain('A & B <tag> "q" it\'s');
    expect(out).toContain('next line');
    expect(out).toContain('c1 c2');
    expect(out).not.toContain('office stuff');
    expect(out).not.toContain('Get Outlook');
    expect(out).not.toMatch(/p\{\}/);
  });
});

describe('compressHtmlToPlainTextForLLM — edge shapes', () => {
  it('drops a pixel declared by its height alone', () => {
    expect(compressHtmlToPlainTextForLLM('<p>Hi</p><img src="https://x.example/p.gif" height="1">')).not.toContain('p.gif');
  });

  // Two quote blocks on ONE flattened line: each keeps its own depth.
  it('tracks quote depth across several blocks on one line', () => {
    const out = compressHtmlToPlainTextForLLM('<blockquote>first quote</blockquote><blockquote>second quote</blockquote>');
    expect(out).toMatch(/^> first quote$/m);
    expect(out).toMatch(/^> second quote$/m);
  });
});
