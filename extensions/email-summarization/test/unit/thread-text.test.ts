import type { EmailForSummary } from '@sarvinbox/core/extension-sdk';
import { describe, expect, it } from 'vitest';


import {
  MAX_MESSAGE_CHARS,
  MAX_THREAD_CHARS,
  MAX_THREAD_MESSAGES,
  collapseWhitespace,
  looksLikeHtml,
  messageTimestamp,
  participants,
  readableBody,
  renderMessage,
  renderThread,
  senderLabel,
  truncate,
} from '../../src/thread-text';

const BASE_SECONDS = Math.floor(Date.UTC(2026, 0, 15, 9, 0, 0) / 1000);

function email(overrides: Partial<EmailForSummary> = {}): EmailForSummary {
  return {
    id: 'msg-1',
    subject: 'Quarterly numbers',
    fromAddress: 'dana@example.com',
    fromName: 'Dana Ray',
    toAddress: 'me@example.com',
    date: BASE_SECONDS,
    body: 'The numbers are in and they are fine.',
    ...overrides,
  };
}

describe('looksLikeHtml', () => {
  // Regression: running the HTML converter over plain text is wasted
  // main-thread CPU on every body; skipping it on real HTML leaves table
  // scaffolding in the prompt.
  it('detects markup and ignores prose that merely contains angle brackets', () => {
    expect(looksLikeHtml('<p>hello</p>')).toBe(true);
    expect(looksLikeHtml('<DIV class="x">hi</DIV>')).toBe(true);
    expect(looksLikeHtml('<br/>')).toBe(true);
    expect(looksLikeHtml('a < b and b > c')).toBe(false);
    expect(looksLikeHtml('use the <- operator')).toBe(false);
    expect(looksLikeHtml('')).toBe(false);
  });
});

describe('collapseWhitespace', () => {
  // Regression: mail is full of soft-wrap padding; sending it raw spends the
  // model's budget on indentation.
  it('collapses runs of space and blank lines but keeps paragraphs apart', () => {
    expect(collapseWhitespace('a    b\t\tc')).toBe('a b c');
    expect(collapseWhitespace('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
    expect(collapseWhitespace('  \n line \n  ')).toBe('line');
    expect(collapseWhitespace('a\r\nb')).toBe('a\nb');
  });
});

describe('truncate', () => {
  // Regression: a cut mid-word reads as a typo to the model; a cut that always
  // seeks a space silently drops everything in a body that has none.
  it('prefers a nearby word boundary but still cuts text with no spaces', () => {
    expect(truncate('short', 20)).toBe('short');
    expect(truncate('alpha beta gamma delta', 12)).toBe('alpha beta');
    expect(truncate('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('readableBody', () => {
  // Regression: a body that is not a string reaches here from stored rows and
  // from IPC; throwing would fail the whole summary.
  it('returns empty for anything unusable', () => {
    expect(readableBody(null)).toBe('');
    expect(readableBody(undefined)).toBe('');
    expect(readableBody('   ')).toBe('');
    expect(readableBody(123 as unknown as string)).toBe('');
  });

  // Regression: summarizing raw HTML describes the layout, not the message.
  it('converts HTML to the visible text', () => {
    const text = readableBody('<html><body><h1>Invoice</h1><p>Due <b>Friday</b>.</p></body></html>');
    // The shared converter upper-cases headings; the words are what matter, so
    // this asserts the content rather than pinning that formatting choice.
    expect(text.toLowerCase()).toContain('invoice');
    expect(text).toContain('Due Friday.');
    expect(text).not.toContain('<p>');
  });

  // Regression: without the quote cut, a ten-message thread repeats message one
  // ten times and the summary says the same thing ten ways.
  it('drops the quoted tail', () => {
    const text = readableBody(
      'Yes, Friday works.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Dana Ray <dana@example.com> wrote:\n> Can we meet Friday?'
    );
    expect(text).toContain('Friday works');
    expect(text).not.toContain('Can we meet Friday?');
  });

  // Regression: bodies are attacker-controlled and unbounded; an uncapped one
  // is a token bill and a stalled main thread.
  it('caps a very long body', () => {
    expect(readableBody('word '.repeat(20_000)).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe('senderLabel', () => {
  // Regression: a thread summary that names nobody is unreadable, and "null"
  // appearing as a participant is worse.
  it('falls back through name, address and neither', () => {
    expect(senderLabel(email())).toBe('Dana Ray <dana@example.com>');
    expect(senderLabel(email({ fromName: null }))).toBe('dana@example.com');
    expect(senderLabel(email({ fromName: '  ', fromAddress: 'x@y.z' }))).toBe('x@y.z');
    expect(senderLabel(email({ fromName: 'Dana', fromAddress: '' }))).toBe('Dana');
    expect(senderLabel(email({ fromName: null, fromAddress: '' }))).toBe('unknown sender');
  });
});

describe('messageTimestamp', () => {
  // Regression: email dates are unix SECONDS. Treating them as milliseconds
  // dates every message to 1970, which the model narrates back as fact.
  it('reads the date as seconds, in UTC', () => {
    expect(messageTimestamp(BASE_SECONDS)).toBe('2026-01-15T09:00:00.000Z');
  });

  // Regression: an unparsable date must not put "Invalid Date" in the prompt.
  it('says so when the date is unusable', () => {
    expect(messageTimestamp(0)).toBe('unknown date');
    expect(messageTimestamp(-1)).toBe('unknown date');
    expect(messageTimestamp(Number.NaN)).toBe('unknown date');
  });
});

describe('renderMessage', () => {
  // Regression: the model needs who and when to attribute anything; a body-only
  // prompt produces a summary that cannot say who asked for what.
  it('carries sender, date, subject and body', () => {
    const rendered = renderMessage(email());
    expect(rendered).toContain('From: Dana Ray <dana@example.com>');
    expect(rendered).toContain('Date: 2026-01-15T09:00:00.000Z');
    expect(rendered).toContain('Subject: Quarterly numbers');
    expect(rendered).toContain('The numbers are in');
  });

  // Regression: an empty body must render as a stated absence, not as a blank
  // the model fills in.
  it('marks a missing subject and an unreadable body', () => {
    const rendered = renderMessage(email({ subject: '  ', body: '' }));
    expect(rendered).toContain('Subject: (no subject)');
    expect(rendered).toContain('(no readable text)');
  });
});

describe('renderThread', () => {
  function thread(count: number, bodyChars = 50): EmailForSummary[] {
    return Array.from({ length: count }, (_, index) =>
      email({
        id: `msg-${index}`,
        subject: `Message ${index}`,
        date: BASE_SECONDS + index * 3_600,
        body: `body-${index} ${'x'.repeat(bodyChars)}`,
      })
    );
  }

  // Regression: a model shown the messages out of order reports the wrong
  // conclusion as the latest one.
  it('orders oldest first regardless of input order', () => {
    const rendered = renderThread([...thread(3)].reverse());
    expect(rendered.indexOf('Message 0')).toBeLessThan(rendered.indexOf('Message 1'));
    expect(rendered.indexOf('Message 1')).toBeLessThan(rendered.indexOf('Message 2'));
  });

  // Regression: a summary is read to find out where a conversation GOT TO, so
  // the newest message is the one that must never be the one dropped.
  it('drops the oldest messages when the thread is too long', () => {
    const rendered = renderThread(thread(MAX_THREAD_MESSAGES + 5));
    expect(rendered).toContain(`Message ${MAX_THREAD_MESSAGES + 4}`);
    expect(rendered).not.toContain('Message 0\n');
  });

  // Regression: an unbounded thread is an unbounded prompt.
  it('stays within the character budget', () => {
    const rendered = renderThread(thread(MAX_THREAD_MESSAGES, 5_000));
    expect(rendered.length).toBeLessThanOrEqual(MAX_THREAD_CHARS);
  });

  // Regression: one enormous message is exactly the case somebody reaches for
  // a summary on. Dropping it for exceeding the budget returns nothing.
  it('keeps a single message that is bigger than the whole budget', () => {
    const rendered = renderThread([email({ body: 'y'.repeat(MAX_THREAD_CHARS * 2) })]);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThanOrEqual(MAX_THREAD_CHARS);
  });

  // Regression: an empty thread must render to nothing so the caller can skip
  // the AI call rather than summarizing a blank.
  it('renders an empty thread as empty', () => {
    expect(renderThread([])).toBe('');
  });
});

describe('participants', () => {
  // Regression: the senders are a fact we hold. Asking the model for them is
  // the field it most often gets wrong, so this list is the fallback.
  it('lists each distinct sender once, oldest first', () => {
    const names = participants([
      email({ fromAddress: 'b@x.com', fromName: 'Bee', date: BASE_SECONDS + 60 }),
      email({ fromAddress: 'a@x.com', fromName: 'Ay', date: BASE_SECONDS }),
      email({ fromAddress: 'A@X.com', fromName: 'Ay', date: BASE_SECONDS + 120 }),
    ]);
    expect(names).toEqual(['Ay <a@x.com>', 'Bee <b@x.com>']);
  });

  // Regression: a record with no sender address must not contribute an empty
  // participant to the list.
  it('skips a message with no sender address', () => {
    expect(participants([email({ fromAddress: '' })])).toEqual([]);
  });
});
