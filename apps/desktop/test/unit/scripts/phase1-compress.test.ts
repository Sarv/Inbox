import { describe, expect, it } from 'vitest';

import {
  compressToFit,
  compressToPlainText,
} from '../../../../../scripts/phase1-prompt-test/compress.mjs';

/**
 * The prompt harness's body compressor (scripts/phase1-prompt-test/compress.mjs).
 *
 * What breaks if this goes red: the harness scores a prompt on text the model
 * should never have been given. Sender addresses missing (so "senders
 * grounded" measures nothing), script or style text in the body, or quoted
 * history at the wrong depth, so the "fit" mode cuts the wrong messages.
 */
describe('compressToPlainText', () => {
  // Breaks if entities are decoded before tags are parsed: every
  // "&lt;name@host&gt;" then reads as a tag and the address vanishes, and a
  // literal "&amp;lt;" turns into "<".
  it('keeps "<name@host>" addresses and decodes each entity exactly once', () => {
    const out = compressToPlainText(
      '<p>From: Arun Iyer &lt;arun@partner.example&gt;</p><p>5 &amp;lt; 6</p>'
    );
    expect(out.split('\n')).toEqual(['From: Arun Iyer <arun@partner.example>', '5 &lt; 6']);
  });

  // Breaks if a legal end tag spelled with whitespace ("</script >"), an
  // upper-case tag, a comment or an MSO conditional leaks its content.
  it('drops head, style, script, comments and images, however the end tag is spelled', () => {
    const out = compressToPlainText(
      '<html><head><title>T</title><style>p{color:red}</style></head><body>' +
        '<!--[if mso]><p>MSO only</p><![endif]--><!-- a note --><p>Body</p>' +
        '<script>alert(1)</script ><SCRIPT>steal()</SCRIPT\n>' +
        '<img src="x.png" alt="pic"></body></html>'
    );
    expect(out).toBe('Body');
  });

  // Breaks if quoted history loses its depth or keeps its blank lines: "fit"
  // reads the depth from the "> " prefixes, and blank lines are wasted tokens.
  it('prefixes quoted lines by depth and drops blank lines', () => {
    const out = compressToPlainText(
      '<p>Top</p><blockquote><p>On Mon, A wrote:</p><p>one</p>' +
        '<blockquote><p>two</p></blockquote></blockquote>'
    );
    expect(out.split('\n')).toEqual(['Top', '> On Mon, A wrote:', '> one', '> > two']);
  });

  // Breaks if a body that is already plain text (the DB's clean_body, when no
  // raw HTML was stored) is parsed as HTML: its lines join into one and every
  // "<name@host>" in it is eaten as a tag.
  it("leaves an already-plain body's lines and addresses alone", () => {
    const plain = 'Hi\nOn Mon, A <a@x.example> wrote:\n> quoted';
    expect(compressToPlainText(plain, { html: false })).toBe(plain);
  });
});

describe('compressToFit', () => {
  // Breaks if an over-budget body is not cut down by quoted depth, leaving a
  // small-context model to truncate it silently from the wrong end.
  it('drops the deepest quoted history first until the body fits', () => {
    const html =
      '<p>Top</p><blockquote><p>one</p><blockquote><p>' +
      'buried '.repeat(50) +
      '</p></blockquote></blockquote>';
    const fit = compressToFit(html, 60);
    expect(fit.finalDepth).toBe(1);
    expect(fit.body).toContain('> one');
    expect(fit.body).not.toContain('buried');
    expect(fit.body.length).toBeLessThanOrEqual(60);
  });
});
