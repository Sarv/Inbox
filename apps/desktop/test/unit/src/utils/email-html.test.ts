import { describe, it, expect } from 'vitest';

import { collapseExcessBlankSpace, htmlLooksDesigned } from '../../../../src/utils/email-html';

describe('htmlLooksDesigned', () => {
  it('flags structural template markers', () => {
    expect(htmlLooksDesigned('<style>.x{}</style><p>hi</p>')).toBe(true);
    expect(htmlLooksDesigned('<table role="presentation"><tr><td>x</td></tr></table>')).toBe(true);
    expect(htmlLooksDesigned('<td bgcolor="#fff">x</td>')).toBe(true);
    expect(htmlLooksDesigned('<table></table><table></table>')).toBe(true);
    expect(htmlLooksDesigned('<img src="logo.png">')).toBe(true);
  });

  it('flags an INLINE-styled CTA button (the task-tracker notification shape)', () => {
    const html = `<a href="https://x" style="background:#6c5ce7;color:#fff;padding:12px 20px;border-radius:6px">View work item</a>`;
    expect(htmlLooksDesigned(html)).toBe(true);
  });

  it('flags a template with several inline style= attributes', () => {
    const html = `<div style="a"><p style="b">x</p><blockquote style="c">y</blockquote><hr style="d"></div>`;
    expect(htmlLooksDesigned(html)).toBe(true);
  });

  it('does NOT flag a plain hand-written reply', () => {
    expect(htmlLooksDesigned('<div><p>Sure, sounds good. Talk tomorrow.</p></div>')).toBe(false);
  });

  it('does NOT flag AI-extracted markdown (so its tables still get border help)', () => {
    // Plain HTML, no inline styles / images / <style> — must stay "not designed"
    // so the bubble applies styledTables to give the markdown table borders.
    const html = `<p>Here is the summary:</p><table><tr><td>A</td><td>B</td></tr></table>`;
    expect(htmlLooksDesigned(html)).toBe(false);
  });

  it('handles empty/nullish input', () => {
    expect(htmlLooksDesigned('')).toBe(false);
    expect(htmlLooksDesigned(null)).toBe(false);
    expect(htmlLooksDesigned(undefined)).toBe(false);
  });
});

describe('collapseExcessBlankSpace', () => {
  it('collapses a wall of empty paragraphs into ONE blank line', () => {
    const html = '<p>Hi</p><p></p><p></p><p>&nbsp;</p><p><br></p><p>Bye</p>';
    expect(collapseExcessBlankSpace(html)).toBe('<p>Hi</p><br><p>Bye</p>');
  });

  it('collapses stacked <br> padding down to a paragraph break', () => {
    expect(collapseExcessBlankSpace('a<br><br><br><br><br>b')).toBe('a<br><br>b');
  });

  it('leaves a single deliberate <br><br> alone', () => {
    expect(collapseExcessBlankSpace('a<br><br>b')).toBe('a<br><br>b');
  });

  it('leaves real content untouched', () => {
    const html = '<div>line one</div><div>line two</div>';
    expect(collapseExcessBlankSpace(html)).toBe(html);
  });

  it('never removes a STYLED empty block — that is a template spacer', () => {
    const html = '<div style="height:24px"></div><div style="height:24px"></div>';
    expect(collapseExcessBlankSpace(html)).toBe(html);
  });

  it('handles empty input', () => {
    expect(collapseExcessBlankSpace('')).toBe('');
  });
});
