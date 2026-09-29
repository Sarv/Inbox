// @vitest-environment happy-dom
// The composition splits bodies with the DOM (the library's split).
import { describe, expect, it } from 'vitest';

import { composeAiTurns } from '../../../../src/components/email-detail/ai-view-compose';
import { polishEntriesOf, threadTurns } from '../../../../src/components/email-detail/chat-message-adapter';
import { buildPolishThreadContext, type PolishEntry } from '../../../../src/services/ai-service';
import { email, ME } from '../components/email-detail/email-fixture';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  LOOPED_AT,
  loopedInEmail,
  loopedInParts,
} from '../components/email-detail/looped-in-fixture';

/**
 * The transcript reply polish grounds itself in (`buildPolishThreadContext`),
 * built from the chat view's turns — the AI view's composition when a usable
 * first-email split exists, Standard's split otherwise.
 *
 * What breaks if this file goes red: polish loses the message being answered
 * (the newest one dropped under the size cap), a looped-in history reaches the
 * model as one wall of quoted text instead of the messages it quotes, or every
 * date in the prompt is off by a factor of 1000 (the view's milliseconds
 * passed where the transcript formats seconds).
 */

const FIRST = loopedInEmail();
const REPLY = email({
  id: 'e2',
  date: LOOPED_AT + 3600,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: '<p>Thanks Dan, I will bring the forecast on Friday.</p>',
});

const blocks = (transcript: string) => transcript.split('\n\n');

describe('buildPolishThreadContext — from the chat turns', () => {
  // With a usable split, the first email's history is the messages it quotes
  // (Alice, Bob, Carol), then Dan's own words, then the later reply — newest
  // last, which is the message the draft answers.
  it('holds the first email\'s AI history and the newest later email, in order', () => {
    const standard = threadTurns([FIRST, REPLY], { currentUserEmail: ME });
    const composed = composeAiTurns({ standard, first: FIRST, parts: loopedInParts(), currentUserEmail: ME });
    const transcript = buildPolishThreadContext({ entries: polishEntriesOf(composed), currentUserEmail: ME });
    const lines = blocks(transcript);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\[Alice Chen\] /);
    expect(lines[0]).toContain(ALICE_TEXT);
    expect(lines[1]).toContain(BOB_TEXT);
    expect(lines[2]).toContain(CAROL_TEXT);
    expect(lines[3]).toMatch(/^\[Dan Moss\] /);
    expect(lines[3]).toContain(DAN_TEXT);
    // Dan's line holds his own words only — not the history again.
    expect(lines[3]).not.toContain(ALICE_TEXT);
    expect(lines[4]).toMatch(/^\[Bob Ray\] /);
    expect(lines[4]).toContain('bring the forecast');
  });

  // The view's dates are milliseconds; the transcript's are seconds. Converted
  // at the boundary (polishEntriesOf), every message is dated in its year.
  it('dates every message in seconds, never milliseconds', () => {
    const standard = threadTurns([FIRST, REPLY], { currentUserEmail: ME });
    const composed = composeAiTurns({ standard, first: FIRST, parts: loopedInParts(), currentUserEmail: ME });
    const entries = polishEntriesOf(composed);
    expect(entries.map((entry) => entry.date).every((date) => date > 1_700_000_000 && date < 1_900_000_000)).toBe(true);
    const transcript = buildPolishThreadContext({ entries, currentUserEmail: ME });
    for (const block of blocks(transcript)) expect(block).toMatch(/ 2026: /);
  });

  // Without a split: Standard's turns — the quoted history the library could
  // recover, each message once, under its own sender.
  it('uses Standard\'s turns when there is no split', () => {
    const standard = threadTurns([FIRST, REPLY], { currentUserEmail: ME });
    const transcript = buildPolishThreadContext({ entries: polishEntriesOf(standard.turns), currentUserEmail: ME });
    expect(transcript).toContain(ALICE_TEXT);
    expect(transcript.split(ALICE_TEXT)).toHaveLength(2);
    expect(blocks(transcript).at(-1)).toContain('bring the forecast');
  });

  // The size cap drops the OLDEST messages first and always keeps the newest
  // two — the message being answered and the one before it.
  it('keeps the newest two past the size cap and says what it omitted', () => {
    const long = 'x'.repeat(1_100);
    const entries: PolishEntry[] = Array.from({ length: 8 }, (_, index) => ({
      sender: `Sender ${index}`,
      address: `s${index}@acme.example`,
      date: LOOPED_AT + index * 60,
      body: `<p>message ${index} ${long}</p>`,
    }));
    const lines = blocks(buildPolishThreadContext({ entries, currentUserEmail: ME }));
    expect(lines[0]).toMatch(/^\(\d earlier messages omitted\)$/);
    expect(lines.at(-1)).toContain('message 7');
    expect(lines.at(-2)).toContain('message 6');
    expect(lines.some((line) => line.includes('message 0 '))).toBe(false);
  });

  // Marks the reader's own messages, skips bodiless turns, and says nothing
  // for nothing. An unreadable date (0 — what an undated turn converts to)
  // reads "unknown date", never "Jan 1, 1970".
  it('marks the reader, skips empty bodies, and is empty for no messages', () => {
    const transcript = buildPolishThreadContext({
      entries: [
        { sender: 'Me', address: ME.toUpperCase(), date: LOOPED_AT, body: '<p>On my way.</p>' },
        { sender: 'Ghost', address: 'ghost@acme.example', date: LOOPED_AT + 1, body: '' },
        { sender: '', address: 'x@acme.example', date: 0, body: 'plain' },
      ],
      currentUserEmail: ME,
    });
    expect(transcript).toContain('[Unknown] unknown date: plain');
    expect(transcript).toContain('[Me (you)]');
    expect(transcript).not.toContain('Ghost');
    expect(buildPolishThreadContext({ entries: [], currentUserEmail: ME })).toBe('');
  });
});
