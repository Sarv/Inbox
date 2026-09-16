import { describe, it, expect } from 'vitest';

import {
  DEFAULT_CATEGORIZATION_TEMPLATE,
  buildCategorizationPrompt,
} from '../../../src/agent/categorization-utils';

/**
 * The categorization system prompt.
 *
 * THE measurement that prompted this: across 1,802 real categorization runs the
 * model returned an EMPTY category array 1,318 times — 73%. On mail the app had
 * already flagged as bulk it was 81%, and 66 emails were handed an "archive" or
 * "spam" recommendation while being assigned no category at all: the model knew
 * what they were and filed them nowhere.
 *
 * The cause was that the prompt asked ONE question — "does the user need to act
 * on this?" — and used the answer for every category. That is right for
 * `important` / `needs_response`, which should be rare and relevance-gated, and
 * wrong for descriptive ones like `promotions` or `invoice`, which are facts
 * about the message. "The user will ignore this" was being read as "no
 * category", when it is the very reason a promotions category exists.
 *
 * These tests pin the distinction rather than the wording — an edit that
 * rephrases is fine, one that collapses the two kinds back together is not.
 */
describe('DEFAULT_CATEGORIZATION_TEMPLATE', () => {
  // THE fix. Without this separation the prompt cannot express why a
  // promotional blast is `promotions` even though nobody will read it.
  it('separates descriptive categories from judgement categories', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/DESCRIPTIVE categories/);
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/JUDGEMENT categories/);
  });

  // The old text said "assign ONLY when clearly relevant to the user" over the
  // whole category list, which is what suppressed the descriptive ones.
  it('does not gate every category behind relevance to the user', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).not.toMatch(/CATEGORIES — assign ONLY when clearly relevant/);
  });

  // "Empty [] is perfectly valid" sat directly under "when in doubt, assign
  // FEWER" — together they made [] the safe default answer rather than a
  // specific claim that nothing matched.
  it('does not present an empty array as the safe answer', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).not.toMatch(/Empty \[\] is perfectly valid/);
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/should be the exception/);
  });

  // The 66 archive-or-spam-with-no-category cases: the model contradicted its
  // own recommendation, and nothing in the prompt told it that was wrong.
  it('forbids recommending archive or spam while assigning no category', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/ACTION\/CATEGORY CONSISTENCY/);
  });

  // The judgement rules are NOT the bug and must survive. Their reasoning in
  // the field was consistently correct ("User is only CC'd on an email
  // addressed to Devendra", confidence 0.95) and relaxing them would trade one
  // failure for a worse one.
  it('keeps the strict rules that make "important" rare', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/"important" is RARE/);
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/CC emails: DEFAULT is NOT important/);
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/a HUMAN must be waiting for a HUMAN reply/);
  });

  // The single worked example was `"categories": []`. It was the only sample of
  // a finished answer in the whole prompt, so the model's strongest anchor for
  // "what does output look like" was the empty case.
  it('shows a populated category array in the worked examples', () => {
    const examples = DEFAULT_CATEGORIZATION_TEMPLATE.slice(
      DEFAULT_CATEGORIZATION_TEMPLATE.indexOf('RETURN FORMAT:'),
    );
    expect(examples).toMatch(/"categories": \["promotions"\]/);
    // …and still shows a legitimate empty one, so [] is not eliminated either.
    expect(examples).toMatch(/"categories": \[\]/);
    expect(examples.indexOf('["promotions"]')).toBeLessThan(examples.indexOf('"categories": []'));
  });

  // A stray duplicate heading sat hundreds of lines above the real one, so the
  // model saw "RETURN FORMAT:" followed by a different section entirely.
  it('names the return format exactly once', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE.match(/RETURN FORMAT:/g)).toHaveLength(1);
  });

  // should_auto_draft drives real side effects (a drafted reply), so its
  // agreement with needs_response has to survive any prompt edit.
  it('keeps should_auto_draft tied to needs_response', () => {
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/CONSISTENCY RULE/);
    expect(DEFAULT_CATEGORIZATION_TEMPLATE).toMatch(/MUST contain "needs_response"/);
  });
});

describe('buildCategorizationPrompt', () => {
  const cats = [
    { slug: 'promotions', name: 'Promotions', prompt: 'Marketing and newsletters' },
    { slug: 'invoice', name: 'Invoice', prompt: 'Bills from vendors' },
  ];

  // A placeholder that survives into the sent prompt is a literal "{{userEmail}}"
  // in the model's instructions — it then reasons about a user who does not exist.
  it('leaves no placeholder unsubstituted', () => {
    const out = buildCategorizationPrompt(cats, 'rc@example.com');
    expect(out).not.toMatch(/\{\{\s*\w+\s*\}\}/);
  });

  it('renders the user identity the CC rules depend on', () => {
    const out = buildCategorizationPrompt(cats, 'rc@example.com');
    expect(out).toContain('rc@example.com');
    expect(out).toContain('rc');          // userName, used by the "named in body" rule
    expect(out).toContain('example.com'); // userDomain, used for internal/external
  });

  it('lists every category with its definition', () => {
    const out = buildCategorizationPrompt(cats, 'rc@example.com');
    expect(out).toContain('1. promotions:');
    expect(out).toContain('Marketing and newsletters');
    expect(out).toContain('2. invoice:');
  });

  // The user can rewrite the prompt in Settings; their text must be used and
  // still get its placeholders filled.
  it('renders a user override instead of the default', () => {
    const out = buildCategorizationPrompt(cats, 'rc@example.com', 'Mine for {{userEmail}}: {{categorySection}}');
    expect(out).toBe('Mine for rc@example.com: 1. promotions:\nMarketing and newsletters\n\n2. invoice:\nBills from vendors');
  });

  // A blank or whitespace override means "no override" — otherwise clearing the
  // textarea would send the model an empty system prompt.
  it('falls back to the default when the override is blank', () => {
    expect(buildCategorizationPrompt(cats, 'rc@example.com', '   ')).toContain('DESCRIPTIVE categories');
  });
});
