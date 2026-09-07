import { describe, expect, it } from 'vitest';

import {
  decodeAiCategories,
  encodeAiCategories,
  labelDrainDecision,
  mirrorableCategories,
} from '../../../src/utils/ai-categories';

// This module exists to keep "the AI decided nothing" and "we never asked the
// AI" apart. Collapse those two and the label mirror either strips correct
// category labels off every pre-existing message in the user's real mailbox, or
// stops stripping stale ones at all. Everything below pins that distinction.

describe('encodeAiCategories', () => {
  // The verdict is what the mirror applies; losing or reordering it would apply
  // the wrong labels.
  it('encodes categories in the order the model returned them', () => {
    expect(encodeAiCategories(['invoice', 'finance'])).toBe('|invoice|finance|');
  });

  // An empty answer MUST encode to the sentinel, never to '' or null — those
  // read back as "no verdict" and the cleared mail keeps its stale label.
  it('encodes an empty answer as the sentinel, not as nothing', () => {
    expect(encodeAiCategories([])).toBe('||');
    expect(decodeAiCategories(encodeAiCategories([]))).toEqual([]);
  });

  // A model that repeats itself must not produce a doubled label apply.
  it('collapses duplicates while keeping first-seen order', () => {
    expect(encodeAiCategories(['finance', 'invoice', 'finance'])).toBe('|finance|invoice|');
  });

  // Blank/whitespace slugs would emit a '||' run inside the string, which every
  // `instr(tags, '|x|')` probe matches — the same corruption buildTags guards.
  it('drops blank and whitespace-only slugs', () => {
    expect(encodeAiCategories(['invoice', '', '   ', 'finance'])).toBe('|invoice|finance|');
    expect(encodeAiCategories(['', ''])).toBe('||');
  });

  // The delimiter can never appear inside a name, or two categories become
  // indistinguishable from one oddly-named category.
  it('sanitises a slug containing the delimiter', () => {
    expect(encodeAiCategories(['a|b'])).toBe('|a_b|');
  });
});

describe('decodeAiCategories', () => {
  // The three states, asserted directly.
  it('reads a verdict back', () => {
    expect(decodeAiCategories('|invoice|finance|')).toEqual(['invoice', 'finance']);
  });

  it('reads the sentinel as "ran, chose nothing"', () => {
    expect(decodeAiCategories('||')).toEqual([]);
  });

  it('reads NULL, undefined and empty string as "no verdict recorded"', () => {
    // The empty string is included deliberately: a legacy or half-written row
    // holding '' is not evidence the AI chose nothing.
    expect(decodeAiCategories(null)).toBeNull();
    expect(decodeAiCategories(undefined)).toBeNull();
    expect(decodeAiCategories('')).toBeNull();
  });
});

describe('mirrorableCategories', () => {
  const known = new Set(['invoice', 'finance', 'important']);

  // The mirror acts on this. null means "do not touch this email's labels".
  it('returns null for a row with no recorded verdict', () => {
    expect(mirrorableCategories(null, known)).toBeNull();
    expect(mirrorableCategories('', known)).toBeNull();
  });

  // A category the user deleted must not keep its label alive, and a slug the
  // model invented must never become a mailbox.
  it('keeps only categories this account actually defines', () => {
    expect(mirrorableCategories('|invoice|hallucinated|finance|', known))
      .toEqual(['invoice', 'finance']);
  });

  // THE distinction that matters: filtering can empty a verdict, and an emptied
  // verdict is still a verdict — [] (strip the stale labels), never null (skip).
  it('returns an empty array, not null, when filtering removes everything', () => {
    expect(mirrorableCategories('|deleted_category|', known)).toEqual([]);
  });

  it('returns an empty array for a verdict that was already empty', () => {
    expect(mirrorableCategories('||', known)).toEqual([]);
  });

  // The regression in one line: `important` reaches the mirror only because the
  // AI recorded it, never because Gmail's `\Important` label put it in tags.
  it('mirrors important only when it is in the recorded verdict', () => {
    expect(mirrorableCategories('|important|', known)).toEqual(['important']);
    // Same email, tag string full of `important`, but nothing recorded:
    expect(mirrorableCategories(null, known)).toBeNull();
  });

  // An account with no categories defined yet must strip nothing by surprise —
  // it still reports a verdict, just an empty one.
  it('handles an account with no category definitions', () => {
    expect(mirrorableCategories('|invoice|', new Set<string>())).toEqual([]);
    expect(mirrorableCategories(null, new Set<string>())).toBeNull();
  });
});

describe('labelDrainDecision', () => {
  const known = new Set(['invoice', 'finance', 'important']);

  // The drain must send the AI's verdict to the server, nothing else. If this
  // returned the tag string's categories, Gmail's own `\Important` guess would
  // again be written back as our `Sarv Inbox/Important` label.
  it('mirrors a recorded verdict', () => {
    expect(labelDrainDecision('|invoice|finance|', known))
      .toEqual({ action: 'mirror', categories: ['invoice', 'finance'] });
  });

  // Retire, not skip: the drain re-selects the same newest-first page every
  // tick, so a legacy row left 'pending' blocks every genuinely pending mail
  // behind it forever — the "only the 2 newest got labelled" failure again.
  it('retires a row with no recorded verdict instead of mirroring it', () => {
    expect(labelDrainDecision(null, known)).toEqual({ action: 'retire' });
    expect(labelDrainDecision('', known)).toEqual({ action: 'retire' });
  });

  // Retiring must never be confused with stripping: the caller does not touch
  // the server for a retired row, so old mail keeps its correct labels.
  it('never reports an empty mirror for a missing verdict', () => {
    const decision = labelDrainDecision(undefined, known);
    expect(decision.action).toBe('retire');
    expect(decision).not.toHaveProperty('categories');
  });

  // The opposite case, and the reason 'retire' and 'mirror []' are distinct: an
  // AI that cleared a mail must get its stale label REMOVED, which only happens
  // if the drain still calls the mirror with an empty list.
  it('mirrors an empty list when the AI ran and chose nothing', () => {
    expect(labelDrainDecision('||', known)).toEqual({ action: 'mirror', categories: [] });
  });

  // A category the user deleted stops being mirrored, and its label gets
  // stripped — the verdict is still a verdict after filtering.
  it('mirrors an empty list when every recorded category has been deleted', () => {
    expect(labelDrainDecision('|gone|', known)).toEqual({ action: 'mirror', categories: [] });
  });

  // Re-running the drain over the same row must produce the same instruction;
  // a decision that drifted between ticks would flap labels on the server.
  it('is idempotent for the same row', () => {
    const first = labelDrainDecision('|invoice|', known);
    const second = labelDrainDecision('|invoice|', known);
    expect(second).toEqual(first);
  });
});
