import { describe, it, expect } from 'vitest';

import { stripTags } from '../../../src/utils/strip-tags';

// stripTags feeds scoring, name matching and the reply-style sample — all on
// bodies a stranger wrote. It replaced `/<[^>]+>/g`, which went quadratic on a
// body of unclosed `<` and froze the main process for one email.

describe('stripTags', () => {
  // Breaks: markup leaks into scored text, or words next to a tag are lost.
  it('drops well-formed tags and keeps the text around them', () => {
    expect(stripTags('<p>Hi <b>Ann</b>,</p><br/>see you')).toBe('Hi Ann,see you');
    expect(stripTags('plain text, no tags')).toBe('plain text, no tags');
    expect(stripTags('')).toBe('');
  });

  // Breaks: a tag survives in the output (CodeQL js/incomplete-multi-character-
  // sanitization: the regex left a trailing `<script`), or text after a stray
  // `<` is lost.
  it('leaves no "<" at all, and keeps the text after a stray one', () => {
    expect(stripTags('x <script')).toBe('x script');
    expect(stripTags('<<b>URGENT</b> a < b')).toBe('URGENT a  b');
    expect(stripTags('<sc<script>ript>alert(1)')).toBe('script>alert(1)');
    expect(stripTags('a <> b')).toBe('a  b');
    for (const input of ['<', '<<<', 'a<b<c', '<x', '<<script>script>']) {
      expect(stripTags(input)).not.toContain('<');
    }
  });

  // Breaks: a well-formed tag is stripped differently from the regex this
  // replaced, changing what scoring and name matching see on ordinary mail.
  it('strips well-formed markup exactly as /<[^>]+>/g did', () => {
    for (const input of [
      '<div class="a">Hello <span>there</span></div>',
      'Ann <ann@example.com> wrote: > quoted',
      '<p>a > b</p> and c >= d',
      '<!-- comment --><table><tr><td>1</td></tr></table>',
    ]) {
      expect(stripTags(input)).toBe(input.replace(/<[^>]+>/g, ''));
    }
  });

  // Breaks: the regex this replaced scanned to the end once per `<`, so 200 K
  // of `<` took over 10 s (3 s at 80 K) and the test times out. Linear now.
  it('is linear on a long run of unclosed "<"', () => {
    expect(stripTags('<'.repeat(200_000))).toBe('');
    expect(stripTags(`a${'<'.repeat(200_000)}b`)).toBe('ab');
  });
});
