// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

import {
  hasQuotedHistory,
  hasEmbeddedConversation,
  compressHtmlToPlainTextForLLM,
} from '../../../../src/services/conversation-service';

// These detectors decide WHETHER the chat view extracts a conversation from an
// email. A regression means the chat view either shows raw quoted history it
// should have split, or fails to open a real thread as a conversation.

describe('hasQuotedHistory', () => {
  it('detects the common quote/forward markers', () => {
    expect(hasQuotedHistory('Reply text<br>On Mon, Jan 1, 2026 at 9:00 AM Bob &lt;b@x.com&gt; wrote:')).toBe(true);
    expect(hasQuotedHistory('<blockquote>old message</blockquote>')).toBe(true);
    expect(hasQuotedHistory('<div class="gmail_quote">quoted</div>')).toBe(true);
    expect(hasQuotedHistory('From: alice@x.com\nSent: yesterday')).toBe(true);
    expect(hasQuotedHistory('--- Original Message ---')).toBe(true);
    expect(hasQuotedHistory('> previously written line')).toBe(true);
  });

  it('is false for a plain standalone message and for empty input', () => {
    expect(hasQuotedHistory('Hi, just checking in — no quotes here.')).toBe(false);
    expect(hasQuotedHistory('')).toBe(false);
    expect(hasQuotedHistory(null)).toBe(false);
    expect(hasQuotedHistory(undefined)).toBe(false);
  });
});

describe('hasEmbeddedConversation', () => {
  it('is true for a multi-message chain (container + ≥2 boundaries)', () => {
    const body = [
      '<blockquote>',
      'On Mon, Jan 1 2026 Bob wrote:',
      'first reply',
      'On Sun, Dec 31 2025 Alice wrote:',
      'original',
      '</blockquote>',
    ].join('\n');
    expect(hasEmbeddedConversation(body)).toBe(true);
  });

  it('is false for a single reply that quotes only ONE message', () => {
    // A normal reply with one quote stays a card, not a chat view.
    const body = '<blockquote>On Mon, Jan 1 2026 Bob wrote:\nthe one quoted message</blockquote>';
    expect(hasEmbeddedConversation(body)).toBe(false);
  });

  it('is false when there is no quote container at all', () => {
    expect(hasEmbeddedConversation('On Monday we met. He wrote a report.')).toBe(false);
    expect(hasEmbeddedConversation('')).toBe(false);
  });

  it('treats a clearly multi-party forwarded thread as a conversation', () => {
    const body = [
      '--- Forwarded message ---',
      'a@x.com wrote to b@y.com',
      'cc c@z.com and d@w.com',
    ].join('\n');
    expect(hasEmbeddedConversation(body)).toBe(true); // container + ≥4 distinct addresses
  });
});

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
