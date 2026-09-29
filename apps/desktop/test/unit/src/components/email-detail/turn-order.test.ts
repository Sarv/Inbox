// @vitest-environment happy-dom
// The library splits bodies with the DOM, so the parity checks need a DOMParser.
import {
  splitMailBody,
  threadToMessages,
  type ChatMessage,
  type Mail,
} from '@sarv-in/email-chat-view/transform';
import { describe, expect, it } from 'vitest';

import { clampQuoteDate, sortTurns } from '../../../../../src/components/email-detail/turn-order';

/**
 * The AI view puts bubbles the host built (the first email's split parts)
 * between bubbles the library built. What breaks if this file goes red: an
 * AI-recovered message sorts or dates differently from the library's own
 * recovered quotes — it lands out of order against its neighbours, is dated
 * after the email quoting it, or an unreadable date scatters through the
 * thread instead of grouping at its end. Both rules are the library's
 * exported ones; these tests pin that the host's use of them agrees with what
 * `threadToMessages` does internally.
 */

const CARRIER_MS = Date.UTC(2026, 2, 4, 10, 0, 0);

const attribution = (when: string, name: string, address: string) =>
  `<div class="gmail_attr">On ${when}, ${name} &lt;${address}&gt; wrote:<br></div>`;

/** A body quoting three messages: one dated in the FUTURE (a misread), one undated, one readable. */
const BODY = [
  '<div>Carrier text that opens the mail and says something of its own.</div>',
  '<div class="gmail_quote">',
  attribution('Fri, 20 Mar 2026 at 09:00', 'Future Fay', 'fay@acme.example'),
  '<blockquote class="gmail_quote"><div>A message whose attribution claims a date after the carrier.</div>',
  '<div class="gmail_quote">',
  attribution('the day', 'Undated Uma', 'uma@acme.example'),
  '<blockquote class="gmail_quote"><div>A message whose attribution carries no readable date at all.</div>',
  '<div class="gmail_quote">',
  attribution('Mon, 2 Mar 2026 at 10:00', 'Readable Rae', 'rae@acme.example'),
  '<blockquote class="gmail_quote"><div>A message with a perfectly readable, earlier date.</div></blockquote>',
  '</div></blockquote></div></blockquote></div>',
].join('');

const mail = (overrides: Partial<Mail> = {}): Mail => ({
  id: 'm1',
  fromAddress: 'carrier@acme.example',
  date: CARRIER_MS,
  body: BODY,
  ...overrides,
});

describe('clampQuoteDate — parity with threadToMessages', () => {
  it.each([
    ['a readable carrier', CARRIER_MS],
    ['an unreadable carrier', Number.NaN],
  ])('dates every recovered quote exactly as the library does, for %s', (_label, carrierMs) => {
    const segments = splitMailBody(BODY, Number.isNaN(carrierMs) ? {} : { refDate: new Date(carrierMs) });
    const messages = threadToMessages([mail({ date: carrierMs })]);
    const quoted = messages.filter((message) => message.sourceId === 'm1');
    expect(quoted).toHaveLength(3);
    segments.forEach((segment, index) => {
      if (segment.isOwn) return;
      const theirs = messages.find((message) => message.id === `m1#${index}`)!;
      const ours = clampQuoteDate(segment.attribution?.date ?? null, carrierMs, index);
      if (Number.isNaN(theirs.date)) expect(ours.dateMs).toBeNaN();
      else expect(ours.dateMs).toBe(theirs.date);
      expect(ours.approx).toBe(theirs.dateApprox === true);
    });
  });

  // The three cases the library's rule exists for, stated directly.
  it('refuses a date later than the carrier and infers one, marked approximate', () => {
    expect(clampQuoteDate(CARRIER_MS + 1, CARRIER_MS, 2)).toEqual({ dateMs: CARRIER_MS - 2, approx: true });
  });

  it('infers a missing date one millisecond per level before the carrier', () => {
    expect(clampQuoteDate(null, CARRIER_MS, 1)).toEqual({ dateMs: CARRIER_MS - 1, approx: true });
    expect(clampQuoteDate(null, CARRIER_MS, 3)).toEqual({ dateMs: CARRIER_MS - 3, approx: true });
  });

  it('believes a readable date at or before the carrier', () => {
    expect(clampQuoteDate(CARRIER_MS, CARRIER_MS, 1)).toEqual({ dateMs: CARRIER_MS, approx: false });
    expect(clampQuoteDate(CARRIER_MS - 5000, CARRIER_MS, 1)).toEqual({ dateMs: CARRIER_MS - 5000, approx: false });
  });

  // The library returns a NaN read date as the date, UNMARKED; the host treats
  // an unreadable reading as no reading, so it is inferred and marked.
  it('treats a NaN reading as no reading', () => {
    expect(clampQuoteDate(Number.NaN, CARRIER_MS, 1)).toEqual({ dateMs: CARRIER_MS - 1, approx: true });
  });
});

describe('sortTurns — parity with threadToMessages', () => {
  // The library's order for a thread with readable, equal and unreadable dates;
  // shuffled and re-sorted by the host it must come back the same.
  it('orders turns as the library does, unreadable dates last', () => {
    const mails: Mail[] = [
      mail({ id: 'a', date: CARRIER_MS, body: '<p>first mail, carrier of three quotes</p>' + BODY }),
      mail({ id: 'b', date: Number.NaN, body: '<p>a mail with no readable date</p>' }),
      mail({ id: 'c', date: CARRIER_MS + 60_000, body: '<p>a later mail</p>' }),
    ];
    const library = threadToMessages(mails);
    const shuffled = [...library].reverse();
    // Unreadable dates: the library groups them last; the host does too.
    const ours = sortTurns(shuffled);
    expect(ours.map((turn) => turn.id).filter((id) => id !== 'b'))
      .toEqual(library.map((turn) => turn.id).filter((id) => id !== 'b'));
    expect(ours[ours.length - 1]!.id).toBe('b');
  });

  it('keeps turns with equal dates in the order given (stable)', () => {
    const turns: Pick<ChatMessage, 'id' | 'date'>[] = [
      { id: 'x', date: 5 },
      { id: 'y', date: 5 },
      { id: 'z', date: Number.NaN },
      { id: 'w', date: 1 },
    ];
    expect(sortTurns(turns).map((turn) => turn.id)).toEqual(['w', 'x', 'y', 'z']);
    expect(turns.map((turn) => turn.id)).toEqual(['x', 'y', 'z', 'w']); // input untouched
  });
});
