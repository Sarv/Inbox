import { describe, expect, it } from 'vitest';

import { BehaviorIntelligence } from '../../../src/agent/behavior-intelligence';
import { MAX_URGENCY_TEXT_CHARS, computeContentUrgency } from '../../../src/agent/signals/content-urgency';
import { ciTimeout } from '../../../src/test-support/ci-timeout';
import { costRatio, growthRatio, linearGrowthLimit } from '../../../src/test-support/complexity';
import type { EmailRecord } from '../../../src/types/models';

// Priority scoring runs synchronously in the Electron main process on every
// email's subject, body and To/Cc — all attacker-controlled. Before this, three
// regexes went quadratic on crafted input (80 KB of `<` took ~3 s, a 16 K-word
// line of "what" ~0.6 s, an 80 KB address header ~3.5 s), so ONE email froze
// the whole app, again after every restart while it stayed unscored.
//
// These check the SHAPE of the cost, not a wall-clock budget: a 50 ms budget
// failed CI twice on a call that takes 1.3 ms locally (57 ms in the v1.3.6
// release, 59 ms fastest-of-three on PR #116). See test-support/complexity.ts.

const HOSTILE = 100_000;

/** The 100 KB hostile body against one of an eighth of the cap. */
const CAPPED_SMALL = MAX_URGENCY_TEXT_CHARS / 8;

/**
 * Cost of scoring a 100 KB body over scoring a MAX_URGENCY_TEXT_CHARS / 8 one
 * of the same pattern. The cap cuts the large one to MAX_URGENCY_TEXT_CHARS, so
 * linear scoring costs ~8x, and quadratic ~64x. A revert of the cap alone shows
 * as ~40x (100 KB / 2.5 KB), which fails too. Sized so a full revert fails in
 * seconds rather than hanging CI (the regexes are synchronous; a test timeout
 * can't interrupt them).
 */
function cappedGrowth(pattern: (chars: number) => string): number {
  const large = pattern(HOSTILE);
  const small = pattern(CAPPED_SMALL);
  return costRatio(
    () => computeContentUrgency('s', large, 'Ann'),
    () => computeContentUrgency('s', small, 'Ann'),
  );
}

describe('computeContentUrgency — bounded work on hostile bodies', () => {
  // Breaks: a body of unclosed `<` stalls the main process (the tag strip).
  it('scores a 100 KB run of "<" in time linear in the capped text', () => {
    expect(cappedGrowth((chars) => '<'.repeat(chars))).toBeLessThan(linearGrowthLimit(8));
  });

  // Breaks: a long line of question words with no "?" stalls the main process.
  it.each(['what ', 'can you ', 'which '])('scores a 100 KB line of %j with no "?" in time linear in the capped text', (word) => {
    expect(cappedGrowth((chars) => word.repeat(Math.ceil(chars / word.length)))).toBeLessThan(linearGrowthLimit(8));
  });

  // Breaks: markup the tag strip can't pair up (`<<b>`, a bare `<`) hides a
  // signal from scoring.
  it('scores through stray "<" and still sees the signals', () => {
    const signal = computeContentUrgency('s', '<<b>URGENT</b> a < b, <i>can you confirm?', 'Ann');
    expect(signal).toMatchObject({ hasUrgencyMarkers: true, hasDirectQuestion: true });
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

  // Breaks: a crafted To/Cc header stalls the main process. The old regex was
  // quadratic (~7 s on 120 KB); the parser is linear, so 8x the header costs
  // ~8x when linear and ~64x when quadratic (limit 22.6). The two sides are
  // timed interleaved on this thread's CPU clock, so a busy runner no longer
  // decides it: timed wall-clock, back to back, this linear parser measured 48
  // and 59 against a limit of 24 with the CPU 8x oversubscribed (and 8.3 against
  // 8 at 4x sizes on a busy CI runner). Heavy but linear: 470 ms under
  // local coverage (the parser is slow on 24 KB), so its timeout is sized for CI.
  it('scores hostile To and Cc headers in time linear in their length', () => {
    const headers = (n: number) => ({
      toAddress: 'a'.repeat(n),
      ccAddress: `${'x@y.com, '.repeat(n / 120)}${'"'.repeat(n / 6)}`,
    });
    expect(growthRatio(headers, role, { size: 3_000 })).toBeLessThan(linearGrowthLimit(8));
  }, ciTimeout(470));
});
