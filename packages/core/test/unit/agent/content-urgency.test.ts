import { describe, expect, it } from 'vitest';

import { BehaviorIntelligence } from '../../../src/agent/behavior-intelligence';
import { MAX_URGENCY_TEXT_CHARS, computeContentUrgency } from '../../../src/agent/signals/content-urgency';
import type { EmailRecord } from '../../../src/types/models';

// Priority scoring runs synchronously in the Electron main process on every
// email's subject, body and To/Cc — all attacker-controlled. Before this, three
// regexes went quadratic on crafted input (80 KB of `<` took ~3 s, a 16 K-word
// line of "what" ~0.6 s, an 80 KB address header ~3.5 s), so ONE email froze
// the whole app, again after every restart while it stayed unscored.
//
// Sizing: inputs are 100 KB — past MAX_URGENCY_TEXT_CHARS, so the cap is
// exercised, yet small enough that a full revert fails in seconds rather than
// hanging CI for minutes (the regexes are synchronous; a test timeout can't
// interrupt them). The 50 ms body budget is ~25x the measured post-fix cost but
// below the ~180 ms the old regexes need even on the CAPPED 20 K text, so it
// catches a regex revert on its own, not only a cap revert.

/** Wall-clock ms of `fn`. */
function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const HOSTILE = 100_000;

describe('computeContentUrgency — bounded work on hostile bodies', () => {
  // Breaks: a body of unclosed `<` stalls the main process (the tag strip).
  it('scores a 100 KB run of "<" quickly', () => {
    expect(timed(() => computeContentUrgency('s', '<'.repeat(HOSTILE), 'Ann'))).toBeLessThan(50);
  });

  // Breaks: a long line of question words with no "?" stalls the main process.
  it.each(['what ', 'can you ', 'which '])('scores a 100 KB line of %j with no "?" quickly', (word) => {
    const body = word.repeat(Math.ceil(HOSTILE / word.length));
    expect(timed(() => computeContentUrgency('s', body, 'Ann'))).toBeLessThan(50);
  });

  // Breaks: a signal that sits past the cap leaks the full-body cost back in,
  // or the cap stops applying to the subject + body together.
  it('only scores the first MAX_URGENCY_TEXT_CHARS of subject + body', () => {
    const filler = 'x '.repeat(MAX_URGENCY_TEXT_CHARS);
    expect(computeContentUrgency('hello', `${filler} URGENT`, '').hasUrgencyMarkers).toBe(false);
    expect(computeContentUrgency('hello', `URGENT ${filler}`, '').hasUrgencyMarkers).toBe(true);
  });
});

describe('computeContentUrgency — detection unchanged for real mail', () => {
  // Breaks: real questions stop counting toward priority.
  it('detects direct questions, including across a long sentence', () => {
    expect(computeContentUrgency('', 'Can you send the deck by Friday?', '').hasDirectQuestion).toBe(true);
    expect(computeContentUrgency('', `What do you think about ${'the plan '.repeat(15)}?`, '').hasDirectQuestion).toBe(true);
  });

  // Breaks: a statement is scored as a question just because a "?" appears on
  // a LATER line (the old `.*` never crossed a newline either).
  it('does not pair a question word with a "?" on another line', () => {
    const r = computeContentUrgency('', 'what we shipped today\nsee the notes - ok?', '');
    // The second line still ends in "?", which is its own (line-end) signal.
    expect(r.hasDirectQuestion).toBe(true);
    expect(computeContentUrgency('', 'what we shipped today\nsee the notes', '').hasDirectQuestion).toBe(false);
  });

  // Pins the BOUNDED span between a question word and its "?" — the part of the
  // fix the 20 K cap alone would mask in a timing test. Breaks if the span goes
  // back to `.*`: matching turns quadratic again on a long "?"-less line.
  it('ignores a question word more than 200 characters before its "?"', () => {
    const far = `what ${'x '.repeat(150)}? thanks`;
    expect(computeContentUrgency('', far, '').hasDirectQuestion).toBe(false);
    const near = `what ${'x '.repeat(90)}? thanks`;
    expect(computeContentUrgency('', near, '').hasDirectQuestion).toBe(true);
  });

  // Breaks: markup inside an HTML body hides urgency words or leaks tag text.
  it('strips HTML tags before matching, and keeps text around a stray "<"', () => {
    expect(computeContentUrgency('', '<p class="x">Please <b>approve</b> the invoice</p>', '').hasFinancialContent).toBe(true);
    expect(computeContentUrgency('', '<div data-x="deadline">hi</div>', '').hasDeadline).toBe(false);
    expect(computeContentUrgency('', 'if a < b then <i>urgent</i>', '').hasUrgencyMarkers).toBe(true);
  });

  // Breaks: the score or its reasons drift for an ordinary actionable email.
  it('scores an ordinary actionable email as before', () => {
    const r = computeContentUrgency('Invoice due Friday', 'Hi Ann, please approve the attached invoice by Friday. Can you confirm?', 'Ann Lee');
    expect(r).toMatchObject({
      hasDeadline: true,
      hasDirectQuestion: true,
      hasApprovalRequest: true,
      hasFinancialContent: true,
      userNameMentioned: true,
      value: 1,
    });
  });
});

describe('BehaviorIntelligence recipient role — parsed, not regex-scanned', () => {
  const engine = new BehaviorIntelligence({
    userEmail: 'ann@example.com',
    userName: 'Ann',
    getSenderSignalData: () => { throw new Error('no history'); },
    getThreadParticipation: () => { throw new Error('no thread'); },
    getContactType: () => 'unknown' as never,
    getPeakHours: () => [],
  });
  const email = (over: Partial<EmailRecord>): EmailRecord => ({
    id: 'e1',
    fromAddress: 'bob@example.org',
    toAddress: '',
    ccAddress: '',
    subject: 's',
    cleanBody: 'hi',
    date: Math.floor(Date.now() / 1000),
    tags: '',
    ...over,
  }) as EmailRecord;
  const role = (over: Partial<EmailRecord>) => engine.scoreEmail(email(over)).signals.response.recipientRole;

  // Breaks: a cc'd user is scored as a direct recipient (or vice versa).
  it('finds the user in To or Cc, including quoted display names with commas', () => {
    expect(role({ toAddress: '"Lee, Ann" <Ann@Example.com>' })).toBe('to');
    expect(role({ toAddress: 'Bob <bob@example.org>', ccAddress: '"Lee, Ann" <ann@example.com>, c@x.org' })).toBe('cc');
  });

  // Breaks: "joann@example.com" substring-matches the user "ann@example.com".
  it('matches whole addresses only', () => {
    expect(role({ toAddress: 'bob@example.org', ccAddress: 'joann@example.com' })).toBe('to'); // default, not cc
  });

  // Breaks: a crafted To/Cc header stalls the main process. The old regex took
  // ~7 s on 120 KB; the parser is linear (~0.1 s), hence the 1 s budget.
  it('scores an email with hostile 120 KB To and Cc headers quickly', () => {
    const ms = timed(() => role({ toAddress: 'a'.repeat(120_000), ccAddress: `${'x@y.com, '.repeat(1000)}${'"'.repeat(20_000)}` }));
    expect(ms).toBeLessThan(1_000);
  });
});
