import { describe, expect, it } from 'vitest';

import { htmlMiningWindow, htmlToPlainText, repairedCleanBody } from '../../../src/utils/html-text';
import { MAX_HTML_PARSE_BYTES } from '../../../src/utils/mail-parse';


// This helper is what stands between a marketing mail and a blank row in the
// list. `clean_body` feeds the list snippet, the filter engine and every AI
// prompt; an HTML-only mail (no text/plain alternative) has nothing else to
// derive it from. Measured on a production-sized mailbox: 205 of 26,185 rows had HTML
// downloaded and clean_body empty.

// A representative HTML-only marketing mail, reduced: tracking pixel, block structure,
// links whose href is noise, and an unsubscribe footer.
const MARKETING_HTML = [
  '<!doctype html PUBLIC><html><head><meta charset="utf-8"></head><body>',
  '<img height="0px" src="https://logs.example.com/uba?data=%7B%22deviceType%22%3A%22WEB%22%7D">',
  '<div>Naukri Minis</div>',
  '<p>Hey Advik, Emergent just raised $130M.</p>',
  '<a href="https://example.com/really/long/tracked/link?x=1">Read the full story</a>',
  '<p>Regards,<br>Team Naukri</p>',
  '</body></html>',
].join('');

describe('htmlToPlainText', () => {
  // Regression: if the tracking pixel or the href leaks into the output, the
  // snippet becomes a wall of URL instead of the sentence a human wrote — which
  // is why this is html-to-text and not the Markdown converter (which emits
  // `![](…)` and `[text](href)`).
  it('returns the readable sentences and drops images and hrefs', () => {
    const text = htmlToPlainText(MARKETING_HTML);

    expect(text).toContain('Naukri Minis');
    expect(text).toContain('Emergent just raised $130M');
    expect(text).toContain('Read the full story');
    expect(text).toContain('Team Naukri');
    expect(text).not.toContain('logs.example.com');
    expect(text).not.toContain('really/long/tracked/link');
    expect(text).not.toMatch(/<[a-z]/i);
  });

  // Regression: signature/phone mining reads the href on purpose — a mailto: or
  // tel: link IS the contact detail. Dropping hrefs for that caller would lose
  // the signal it exists to find.
  it('keeps hrefs when the caller asks for them', () => {
    const text = htmlToPlainText('<a href="mailto:advik.d@sarv.com">write to me</a>', { keepLinkHrefs: true });

    expect(text).toContain('advik.d@sarv.com');
  });

  // Regression: every caller is mid-message-ingest. A malformed or absurd body
  // must degrade to an empty snippet, never throw and abort the whole mail.
  it('returns empty for nothing to convert instead of throwing', () => {
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText('   ')).toBe('');
    expect(htmlToPlainText(undefined as unknown as string)).toBe('');
    expect(htmlToPlainText(null as unknown as string)).toBe('');
    expect(htmlToPlainText('<p>unclosed <b>tags')).toContain('unclosed');
  });

  // Regression: bodies are attacker-controlled and conversion is synchronous
  // main-thread CPU. Without the cap a single huge part pins the UI (the same
  // reason SIMPLE_PARSER_OPTIONS caps mailparser).
  it('caps the HTML it will convert', () => {
    const oversized = `<p>head</p>${'x'.repeat(MAX_HTML_PARSE_BYTES)}<p>tail</p>`;

    const text = htmlToPlainText(oversized);

    expect(text).toContain('head');
    expect(text).not.toContain('tail'); // everything past the cap was cut
  });

  // Plain text arriving on a path that expects HTML must survive intact —
  // the local repair below feeds it raw_body, which is sometimes not HTML.
  it('passes plain text through', () => {
    expect(htmlToPlainText('just a sentence.')).toBe('just a sentence.');
  });
});

describe('repairedCleanBody', () => {
  // Regression: the repair must be a no-op for healthy rows. Returning a string
  // here would rewrite a ~250 KB inline-body record for every email in the
  // mailbox — the exact write amplification the perf work removed.
  it('returns null when clean_body already has text', () => {
    expect(repairedCleanBody('Hello there', MARKETING_HTML)).toBeNull();
  });

  // The bug being repaired: HTML present, clean_body empty.
  it('rebuilds clean_body from the raw HTML when it was stored empty', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const repaired = repairedCleanBody(empty, MARKETING_HTML);
      expect(repaired).toContain('Emergent just raised $130M');
    }
  });

  // Regression: an image-only mail has HTML but no readable text. Writing '' back
  // gains nothing and re-queues the row every session; the caller must be able to
  // tell "nothing to do" from "here is the text".
  it('returns null when there is nothing to repair from', () => {
    expect(repairedCleanBody('', null)).toBeNull();
    expect(repairedCleanBody('', undefined)).toBeNull();
    expect(repairedCleanBody('', '')).toBeNull();
    expect(repairedCleanBody('', '   ')).toBeNull();
    expect(repairedCleanBody('', '<img src="https://x.test/a.png">')).toBeNull();
  });

  // Idempotent re-run: feeding the repaired value back in must be a no-op, so a
  // second pass over the same rows writes nothing.
  it('is idempotent — a repaired row is not repaired again', () => {
    const first = repairedCleanBody('', MARKETING_HTML);
    expect(first).not.toBeNull();
    expect(repairedCleanBody(first, MARKETING_HTML)).toBeNull();
  });
});

/**
 * The window signature mining converts. The bug it exists to prevent is silent
 * and permanent: a tail-only slice of a long reply thread throws away the
 * sender's OWN signature (top-posted, above the quote) and keeps whoever's
 * signature happened to end the chain, so a contact who writes their mobile in
 * every mail they send shows no number at all.
 */
describe('htmlMiningWindow', () => {
  const HEAD_SIG = '<p>Thanks,</p><p>Amit Shukla<br>M: +91 98765 43210</p>';
  const QUOTE = `<blockquote>${'<p>Older thread text that pads this out.</p>'.repeat(400)}<p>Ravi Menon<br>M: +91 90000 11111</p></blockquote>`;

  // Regression: the whole point. A top-posted reply longer than the budget must
  // still carry the sender's own signature into the converted text.
  it('keeps a top-posted signature that a tail-only slice would have dropped', () => {
    const reply = HEAD_SIG + QUOTE;
    expect(reply.length).toBeGreaterThan(4096);
    const windowed = htmlMiningWindow(reply, 4096);
    expect(windowed).toContain('+91 98765 43210');
    expect(reply.slice(-4096)).not.toContain('+91 98765 43210');
  });

  // Regression: a bottom-posted signature (a first message, not a reply) is the
  // case the old tail-only slice got right — it must not become the casualty of
  // fixing the other one.
  it('keeps a bottom-posted signature too', () => {
    const long = `<div>${'<p>Body paragraph.</p>'.repeat(400)}</div><p>Amit Shukla<br>M: +91 98765 43210</p>`;
    expect(htmlMiningWindow(long, 4096)).toContain('+91 98765 43210');
  });

  // Regression: a body that already fits must be handed on untouched — no
  // separator spliced into it, nothing trimmed.
  it('returns a body that already fits unchanged', () => {
    const small = '<p>Hi<br>+91 98765 43210</p>';
    expect(htmlMiningWindow(small, 4096)).toBe(small);
    expect(htmlMiningWindow(small, small.length)).toBe(small);
  });

  // Regression: butting the two halves together would let the last digits of the
  // head and the first digits of the tail read as one number nobody ever wrote.
  it('separates the two halves so they cannot fuse into a phantom number', () => {
    const fused = htmlMiningWindow(`${'x'.repeat(80)}98765${'y'.repeat(80)}43210${'z'.repeat(80)}`, 100);
    expect(htmlToPlainText(fused)).not.toContain('9876543210');
  });

  // Regression: cutting mid-tag leaves attribute text behind, and html-to-text
  // renders that leftover as visible words — the numeric junk that converting
  // before mining exists to keep out.
  it('cuts on tag boundaries so no attribute text leaks into the conversion', () => {
    const html = `<p>start</p><img src="tracking-9988776655.png" width="600" height="400">${'<p>pad</p>'.repeat(60)}<a href="https://x.test/9911223344">end</a>`;
    const text = htmlToPlainText(htmlMiningWindow(html, 200));
    expect(text).not.toContain('tracking-9988776655');
    expect(text).not.toContain('9911223344');
  });

  // Regression: raw_body is not always HTML (a text/plain mail is stored as-is),
  // and a `<br>` spliced into plain text is a word, not a line break.
  it('separates plain text with a blank line rather than a tag', () => {
    const plain = `${'a'.repeat(120)}\n${'b'.repeat(120)}`;
    const windowed = htmlMiningWindow(plain, 100);
    expect(windowed).not.toContain('<br>');
    expect(windowed).toContain('\n\n');
  });

  // Regression: mining calls this on every body of every contact. A non-string
  // or an absent budget must not throw in the middle of a scan.
  it('never throws on degenerate input', () => {
    expect(htmlMiningWindow('', 100)).toBe('');
    expect(htmlMiningWindow(undefined as unknown as string, 100)).toBe('');
    expect(htmlMiningWindow('<p>abc</p>', 0)).toBe('<p>abc</p>');
    expect(htmlMiningWindow('<p>abc</p>', -5)).toBe('<p>abc</p>');
  });
});
