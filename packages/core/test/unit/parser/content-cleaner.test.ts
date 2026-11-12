import { describe, expect, it } from 'vitest';

import { ContentCleaner, cleanEmailContent, contentCleaner } from '../../../src/parser/content-cleaner';

// The content cleaner reduces a reply chain to "what this person actually wrote"
// — the text that feeds categorization, reply drafting and summaries. What must
// hold: quote/signature/forward markers are detected on EVERY matching line (the
// shared regexes are reused across calls, so a stray /g flag silently alternates
// false negatives), the flags in CleaningOptions are honoured, and no input can
// make it throw.

const cleaner = new ContentCleaner();
const lines = (...l: string[]): string => l.join('\n');

describe('ContentCleaner.clean — quoted content', () => {
  it('removes ">" quote lines and reports how many were dropped', () => {
    const result = cleaner.clean(lines(
      'My answer is yes.',
      '> what do you think?',
      '> please advise',
    ));
    expect(result.cleanText).toBe('My answer is yes.');
    expect(result.removedQuotes).toBe(2);
    expect(result.originalText).toContain('> what do you think?'); // original preserved
  });

  // Regression guard for the /g-flag lastIndex bug: with a global regex, .test()
  // on repeated identical lines alternates true/false and leaves half the quote.
  it('removes EVERY repeated identical quote line (no lastIndex alternation)', () => {
    const quoted = Array.from({ length: 10 }, () => '> same quoted line');
    const result = cleaner.clean(lines('Reply body.', ...quoted));
    expect(result.removedQuotes).toBe(10);
    expect(result.cleanText).toBe('Reply body.');
  });

  it('recognises the common attribution and header-block quote markers', () => {
    const markers = [
      '> chevron quote',
      '| outlook pipe quote',
      'On Mon, 18 Aug 2026 at 10:00, Alice wrote:',
      'From: alice@example.com',
      'Sent: Monday, August 18, 2026 10:00 AM',
      'To: bob@example.com',
      'Subject: Re: something',
      '-----Original Message-----',
      '________________________________',
      'Le 18 août 2026 à 10:00, Alice a écrit :',
      'Am 18.08.2026 um 10:00 schrieb Alice:',
      'El 18 ago 2026, a las 10:00, Alice escribió:',
    ];
    for (const marker of markers) {
      // Each marker alone must be detected as a quote line.
      expect(cleaner.hasQuotedContent(marker), marker).toBe(true);
    }
  });

  it('keeps quotes when removeQuotes is disabled', () => {
    const result = cleaner.clean(lines('Answer.', '> question?'), {
      removeQuotes: false,
      removeSignatures: false,
      removeForwardedContent: false,
    });
    expect(result.cleanText).toContain('> question?');
    expect(result.removedQuotes).toBe(0);
  });

  it('hasQuotedContent is stable across repeated calls on the same text', () => {
    const text = lines('body', '> quoted');
    expect(cleaner.hasQuotedContent(text)).toBe(true);
    expect(cleaner.hasQuotedContent(text)).toBe(true);   // would flip with a /g regex
    expect(cleaner.hasQuotedContent('just a plain body')).toBe(false);
  });
});

describe('ContentCleaner.clean — signatures', () => {
  it('cuts everything from the standard "--" separator onward', () => {
    const result = cleaner.clean(lines('The body.', '--', 'Alice', 'Acme Corp'), {
      removeQuotes: false,
      removeForwardedContent: false,
    });
    expect(result.cleanText).toBe('The body.');
    expect(result.removedSignature).toBe(true);
  });

  it('cuts mobile and sign-off signatures', () => {
    for (const marker of [
      'Sent from my iPhone',
      'Get Outlook for Android',
      'Sent via BlackBerry',
      'Best regards,',
      'Kind regards',
      'Sincerely,',
      'Thanks,',
      'Cheers,',
      'Warm regards,',
      '———',
      '_____',
    ]) {
      const result = cleaner.clean(lines('Real content here.', marker, 'Alice'), {
        removeQuotes: false,
        removeForwardedContent: false,
      });
      expect(result.removedSignature, marker).toBe(true);
      expect(result.cleanText, marker).toBe('Real content here.');
    }
  });

  // Heuristic fallback: no explicit marker, but a trailing block with contact
  // details / a job title is a signature.
  it('falls back to the contact-info heuristic (phone, email, job title)', () => {
    for (const tail of ['555-123-4567', 'alice@example.com', 'VP Engineering']) {
      const result = cleaner.clean(lines('Please review the deck.', 'Alice Smith', tail), {
        removeQuotes: false,
        removeForwardedContent: false,
      });
      expect(result.removedSignature, tail).toBe(true);
      expect(result.cleanText, tail).toContain('Please review the deck.');
    }
  });

  it('leaves a body with no signature untouched', () => {
    const body = lines('Line one of the note.', 'Line two of the note.');
    const result = cleaner.clean(body, { removeQuotes: false, removeForwardedContent: false });
    expect(result.removedSignature).toBe(false);
    expect(result.cleanText).toBe(body);
  });

  it('keeps the signature when removeSignatures is disabled', () => {
    const result = cleaner.clean(lines('Body.', '--', 'Alice'), {
      removeSignatures: false,
      removeQuotes: false,
      removeForwardedContent: false,
    });
    expect(result.cleanText).toContain('--');
    expect(result.removedSignature).toBe(false);
  });

  // maxSignatureLines bounds how far back the scan looks: a marker further up
  // than that must NOT swallow the body.
  it('respects maxSignatureLines when scanning backwards', () => {
    const body = ['Best regards,', ...Array.from({ length: 30 }, (_, i) => `content line ${i}`)];
    const result = cleaner.clean(lines(...body), {
      removeQuotes: false,
      removeForwardedContent: false,
      maxSignatureLines: 2,
    });
    expect(result.removedSignature).toBe(false);
    expect(result.cleanText).toContain('content line 29');
  });

  it('hasSignature only inspects the tail of the message', () => {
    expect(cleaner.hasSignature(lines('body', 'Sent from my iPhone'))).toBe(true);
    const farAway = lines('Sent from my iPhone', ...Array.from({ length: 30 }, (_, i) => `line ${i}`));
    expect(cleaner.hasSignature(farAway)).toBe(false);
  });
});

describe('ContentCleaner.clean — forwarded content', () => {
  it('drops everything from a forwarded marker onward', () => {
    for (const marker of [
      '---------- Forwarded message ----------',
      'Begin forwarded message:',
      'Forwarded by Alice on Monday',
      'FW: original subject',
      'Fwd: original subject',
    ]) {
      const result = cleaner.clean(lines('Please see below.', marker, 'From: someone@example.com', 'old body'), {
        removeQuotes: false,
        removeSignatures: false,
      });
      expect(result.removedForwarded, marker).toBe(true);
      expect(result.cleanText, marker).toBe('Please see below.');
    }
  });

  it('reports removedForwarded=false and keeps the text when there is no marker', () => {
    const result = cleaner.clean('Just a normal message.', { removeQuotes: false, removeSignatures: false });
    expect(result.removedForwarded).toBe(false);
    expect(result.cleanText).toBe('Just a normal message.');
  });

  it('keeps the forwarded block when removeForwardedContent is disabled', () => {
    const result = cleaner.clean(lines('Note.', 'Begin forwarded message:', 'old body'), {
      removeForwardedContent: false,
      removeQuotes: false,
      removeSignatures: false,
    });
    expect(result.cleanText).toContain('Begin forwarded message:');
    expect(result.removedForwarded).toBe(false);
  });
});

describe('ContentCleaner.clean — whitespace and robustness', () => {
  it('collapses runs of spaces and blank lines and trims each line', () => {
    const result = cleaner.clean('a      b   \n\n\n\n\nc   ', {
      removeQuotes: false,
      removeSignatures: false,
      removeForwardedContent: false,
    });
    expect(result.cleanText).toBe('a b\n\nc');
  });

  it('returns an empty string for empty input without throwing', () => {
    const result = cleaner.clean('');
    expect(result.cleanText).toBe('');
    expect(result.removedQuotes).toBe(0);
  });

  // A non-string body (bad IPC payload / null column) must not take down the
  // categorization pass: the cleaner falls back to the original value.
  it('never throws on a non-string input — it returns the original', () => {
    const result = cleaner.clean(null as unknown as string);
    expect(result.cleanText).toBeNull();
    expect(result.originalText).toBeNull();
    expect(result.removedSignature).toBe(false);
  });

  it('preserveFormatting is accepted as an option (no crash, default off)', () => {
    const result = cleaner.clean('body text', { preserveFormatting: true });
    expect(result.cleanText).toBe('body text');
  });
});

// Every quote and forward marker runs on each line of a stranger's body, and a
// body line can be as long as the body. Four of them were super-linear on one
// crafted line (CodeQL js/polynomial-redos flagged the "On …, … wrote:" and
// "Am … schrieb …:" pair; the `\r` runs were found alongside), so one email
// stalled categorization, drafting and contact mining for seconds. The first
// three inputs made the old patterns take 8-15 s, so under them the tests time
// out.
describe('ContentCleaner — bounded work on one crafted line', () => {
  const CR = '\r';
  const LS = String.fromCharCode(0x2028); // LINE SEPARATOR, a line terminator to `^`/`$`

  // Breaks: "On …, … wrote:" is matched by two `.+` around ", " again —
  // 80 K repetitions of "a, " with no "wrote:" took about 8 s.
  it('rejects a long "On a, a, a, …" line with no "wrote:" at once', () => {
    expect(cleaner.hasQuotedContent(`On ${'a, '.repeat(80_000)}`)).toBe(false);
  });

  // Breaks: "Am … schrieb …:" is a two-`.+` regex again — 60 K repetitions of
  // "a schrieb " with no closing colon took about 14 s.
  it('rejects a long "Am a schrieb a schrieb …" line with no colon at once', () => {
    expect(cleaner.hasQuotedContent(`Am ${'a schrieb '.repeat(60_000)}`)).toBe(false);
    expect(cleaner.hasQuotedContent(`Am ${'a schrieb '.repeat(60_000)}:`)).toBe(true);
  });

  // Breaks: the `>` / `|` markers' leading whitespace eats `\r` again, and a
  // line of 100 K `\r` (quoted-printable `=0D` or base64 decodes to a bare CR)
  // takes about 9 s.
  it('rejects a line of many bare CRs at once', () => {
    expect(cleaner.hasQuotedContent(`${CR.repeat(100_000)}x`)).toBe(false);
    expect(cleaner.hasQuotedContent(`${CR.repeat(100_000)}> quoted`)).toBe(true);
  });

  // Breaks: the forwarded marker grows its second `.+` back. CodeQL flagged the
  // pair; V8 happened to stay linear on it (a trailing `.+$` can't fail under
  // `m`), but nothing in the pattern promised that.
  it('searches a long "Forwarded by a on a on …" line at once', () => {
    const result = cleaner.clean(`Body.\nForwarded by ${'a on '.repeat(80_000)}`, { removeQuotes: false, removeSignatures: false });
    expect(result.removedForwarded).toBe(true);
    expect(result.cleanText).toBe('Body.');
  });

  // Breaks: a rewritten pattern stops matching a line it used to — a CRLF body
  // (every line ends in `\r`), a terminator inside the line, or an attribution
  // with a comma — and quoted text leaks into "what this person wrote".
  it('still recognises the markers at a line break inside the line', () => {
    for (const marker of [
      `> quoted${CR}`,
      `  >> nested`,
      `text${CR}  > quoted after a bare CR`,
      `text${LS}\t| piped after a line separator`,
      `On Mon, 18 Aug 2026 at 10:00, Alice wrote:${CR}`,
      `Am 18.08.2026 um 10:00 schrieb Alice <a@x.de>:${CR}`,
      `noise${CR}Am 18.08.2026 schrieb Alice:`,
      'Am Montag schrieb Alice schrieb Bob:',
    ]) {
      expect(cleaner.hasQuotedContent(marker), JSON.stringify(marker)).toBe(true);
    }
  });

  // Breaks: a rewritten pattern starts matching ordinary prose and deletes it.
  it('does not take ordinary lines for markers', () => {
    for (const line of [
      'Am schrieb:',
      'Am  schrieb x:',
      'Am x schrieb :',
      'Am x schrieb y',
      'I am writing: Am x schrieb',
      'x > y',
      `a${CR}b > c`,
      'On my way, will write later',
    ]) {
      expect(cleaner.hasQuotedContent(line), JSON.stringify(line)).toBe(false);
    }
  });
});

describe('ContentCleaner reply-chain helpers', () => {
  it('extractNewestMessage returns only the newest message', () => {
    const newest = cleaner.extractNewestMessage(lines(
      'Yes, Tuesday works.',
      '',
      'On Mon, 18 Aug 2026 at 10:00, Alice wrote:',
      '> Does Tuesday work?',
      '--',
      'Alice',
    ));
    expect(newest).toBe('Yes, Tuesday works.');
  });

  it('splitMessageAndReply splits at the first quote line', () => {
    const { message, replyChain } = cleaner.splitMessageAndReply(lines(
      'My reply.',
      '',
      'On Mon, 18 Aug 2026 at 10:00, Alice wrote:',
      '> original question',
    ));
    expect(message).toBe('My reply.');
    expect(replyChain).toContain('On Mon, 18 Aug 2026 at 10:00, Alice wrote:');
    expect(replyChain).toContain('> original question');
  });

  it('splitMessageAndReply returns an empty reply chain when nothing is quoted', () => {
    const { message, replyChain } = cleaner.splitMessageAndReply('A standalone note.');
    expect(message).toBe('A standalone note.');
    expect(replyChain).toBe('');
  });
});

describe('module surface', () => {
  it('cleanEmailContent and the singleton behave like a fresh instance', () => {
    const text = lines('Body.', '> quoted');
    expect(cleanEmailContent(text).cleanText).toBe(cleaner.clean(text).cleanText);
    expect(contentCleaner.clean(text).cleanText).toBe(cleaner.clean(text).cleanText);
  });
});
