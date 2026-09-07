// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

import { stripQuotedContent } from '../../../../../src/components/email-detail/utils';

const visible = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('stripQuotedContent (HTML)', () => {
  it('does NOT hide a content blockquote preceded by a bare "X wrote:" (the task-tracker notification bug)', () => {
    const body = `
      <div>
        <p><b>Sohum Jadeja</b> commented on this task.</p>
        <p>Sohum Jadeja wrote:</p>
        <blockquote style="border-left:2px solid #ccc;padding-left:8px">
          The actual comment text that the user needs to read.
        </blockquote>
      </div>`;
    const { newContent, hasQuoted } = stripQuotedContent(body, true);
    expect(hasQuoted).toBe(false);
    expect(visible(newContent)).toContain('actual comment text');
  });

  it('collapses a Gmail reply quote', () => {
    const body = `<div>My reply here.</div><div class="gmail_quote"><blockquote>old message</blockquote></div>`;
    const { newContent, hasQuoted } = stripQuotedContent(body, true);
    expect(hasQuoted).toBe(true);
    expect(visible(newContent)).toBe('My reply here.');
    expect(visible(newContent)).not.toContain('old message');
  });

  it('collapses an Apple Mail cite blockquote but keeps the reply', () => {
    const body = `<div>Thanks!</div><blockquote type="cite">quoted original</blockquote>`;
    const { newContent, hasQuoted } = stripQuotedContent(body, true);
    expect(hasQuoted).toBe(true);
    expect(visible(newContent)).toContain('Thanks!');
    expect(visible(newContent)).not.toContain('quoted original');
  });

  it('collapses an "On ... wrote:" attribution and everything after it', () => {
    const body = `<p>See below.</p><p>On Mon, Jan 1, 2026 at 9:00 AM, Bob &lt;b@x.com&gt; wrote:</p><div>the older thread</div>`;
    const { newContent, hasQuoted } = stripQuotedContent(body, true);
    expect(hasQuoted).toBe(true);
    expect(visible(newContent)).toBe('See below.');
    expect(visible(newContent)).not.toContain('older thread');
  });

  it('preserves pre-quote content nested alongside the quote (no "half the email vanished")', () => {
    const body = `<div><p>Intro line.</p><div class="gmail_quote">quoted</div></div><div>footer after</div>`;
    const { newContent } = stripQuotedContent(body, true);
    expect(visible(newContent)).toContain('Intro line.');
    expect(visible(newContent)).not.toContain('quoted');
    expect(visible(newContent)).not.toContain('footer after');
  });

  it('leaves a plain email with no quote untouched', () => {
    const body = `<div><p>Just a normal message.</p></div>`;
    const { newContent, hasQuoted } = stripQuotedContent(body, true);
    expect(hasQuoted).toBe(false);
    expect(visible(newContent)).toBe('Just a normal message.');
  });
});
