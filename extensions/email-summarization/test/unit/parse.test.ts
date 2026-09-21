import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONFIDENCE,
  MAX_POINTS,
  MAX_POINT_CHARS,
  MAX_SUMMARY_CHARS,
  cleanConfidence,
  cleanStringList,
  extractJsonObject,
  parseCompletion,
  parseEmailSummary,
  parseThreadSummary,
} from '../../src/parse';

describe('extractJsonObject', () => {
  // Regression: models wrap JSON in code fences and prose more often than not.
  // A parser that only accepts a bare object returns "no summary" for a perfectly
  // good answer.
  it('finds the object inside fences and preamble', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  // Regression: stopping at the first closing brace truncates any nested object
  // and produces invalid JSON from a valid answer.
  it('keeps nested objects whole', () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}},"d":2}')).toBe('{"a":{"b":{"c":1}},"d":2}');
  });

  // Regression: a brace inside a string literal ends the scan early unless
  // string state is tracked, which mangles any summary that mentions one.
  it('ignores braces and quotes inside strings', () => {
    expect(extractJsonObject('{"a":"} not the end {"}')).toBe('{"a":"} not the end {"}');
    expect(extractJsonObject('{"a":"he said \\"}\\" loudly"}')).toBe('{"a":"he said \\"}\\" loudly"}');
  });

  // Regression: a truncated completion (the token budget ran out mid-object)
  // must be rejected, not half-parsed.
  it('returns null when there is no balanced object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"a":1')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('parseCompletion', () => {
  // Regression: anything that is not a JSON object must be rejected rather than
  // indexed into, or `undefined` is rendered as a summary.
  it('rejects non-strings, arrays and invalid JSON', () => {
    expect(parseCompletion(null)).toBeNull();
    expect(parseCompletion(42)).toBeNull();
    expect(parseCompletion('[1,2,3]')).toBeNull();
    expect(parseCompletion('{"a":}')).toBeNull();
  });
});

describe('cleanStringList', () => {
  // Regression: String(["a"]) is "a" and String({}) is "[object Object]" — both
  // look like content in the UI and are not.
  it('drops non-strings and blanks instead of coercing them', () => {
    expect(cleanStringList(['ok', '', '  ', 3, null, {}, ['x']])).toEqual(['ok']);
    expect(cleanStringList('not a list')).toEqual([]);
    expect(cleanStringList(undefined)).toEqual([]);
  });

  // Regression: a runaway completion can return hundreds of bullets, each of
  // them a paragraph. All of it reaches the UI.
  it('caps the number of bullets and the length of each', () => {
    const many = cleanStringList(Array.from({ length: 50 }, (_, index) => `point ${index}`));
    expect(many).toHaveLength(MAX_POINTS);

    const [long] = cleanStringList(['z'.repeat(MAX_POINT_CHARS * 3)]);
    expect(long.length).toBeLessThanOrEqual(MAX_POINT_CHARS + 3);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('cleanConfidence', () => {
  // Regression: a NaN confidence propagates into every comparison as false and
  // silently hides the summary behind whatever threshold reads it.
  it('clamps to 0..1 and falls back for anything unusable', () => {
    expect(cleanConfidence(0.7)).toBe(0.7);
    expect(cleanConfidence(0)).toBe(0);
    expect(cleanConfidence(1)).toBe(1);
    expect(cleanConfidence(5)).toBe(1);
    expect(cleanConfidence(-2)).toBe(0);
    expect(cleanConfidence(Number.NaN)).toBe(DEFAULT_CONFIDENCE);
    expect(cleanConfidence('0.9')).toBe(DEFAULT_CONFIDENCE);
    expect(cleanConfidence(undefined)).toBe(DEFAULT_CONFIDENCE);
  });
});

describe('parseEmailSummary', () => {
  // Regression: the happy path has to survive the fences and the optional field.
  it('reads a well-formed answer', () => {
    const result = parseEmailSummary(
      '```json\n{"summary":"Invoice is due Friday.","key_points":["Amount 400"],"action_items":["Pay it"],"confidence":0.82}\n```'
    );
    expect(result).toEqual({
      summary: 'Invoice is due Friday.',
      key_points: ['Amount 400'],
      action_items: ['Pay it'],
      confidence: 0.82,
    });
  });

  // Regression: every surface that shows a summary shows the paragraph. An
  // entry with only bullets renders as a blank card.
  it('returns null when there is no summary text', () => {
    expect(parseEmailSummary('{"key_points":["a"],"confidence":0.9}')).toBeNull();
    expect(parseEmailSummary('{"summary":"   "}')).toBeNull();
    expect(parseEmailSummary('sorry, I cannot help with that')).toBeNull();
  });

  // Regression: an absent action list must be absent, not an empty array the UI
  // renders as an empty "Actions" heading.
  it('omits action_items when the model returned none', () => {
    const result = parseEmailSummary('{"summary":"Just a note.","key_points":[],"action_items":[]}');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('action_items');
    expect(result?.confidence).toBe(DEFAULT_CONFIDENCE);
  });

  // Regression: an unbounded summary reaches the UI verbatim.
  it('caps a runaway summary', () => {
    const result = parseEmailSummary(JSON.stringify({ summary: 'w'.repeat(MAX_SUMMARY_CHARS * 4) }));
    expect(result?.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + 3);
  });
});

describe('parseThreadSummary', () => {
  // Regression: the thread shape carries participants, which the email shape
  // does not.
  it('reads a well-formed answer', () => {
    const result = parseThreadSummary(
      '{"summary":"Still deciding.","key_points":["Two options"],"participants":["Dana <d@x.com>"],"confidence":0.6}'
    );
    expect(result?.participants).toEqual(['Dana <d@x.com>']);
    expect(result?.key_points).toEqual(['Two options']);
  });

  // Regression: the senders are a fact we already hold, and participants is the
  // field the model most often gets wrong or omits.
  it('falls back to the senders we derived ourselves', () => {
    const result = parseThreadSummary('{"summary":"Settled."}', ['Ay <a@x.com>', 'Bee <b@x.com>']);
    expect(result?.participants).toEqual(['Ay <a@x.com>', 'Bee <b@x.com>']);
  });

  // Regression: an unusable answer must be null, which the caller reports as
  // "no summary" rather than showing an empty card.
  it('returns null for an answer with no summary', () => {
    expect(parseThreadSummary('{"participants":["a"]}')).toBeNull();
    expect(parseThreadSummary(undefined)).toBeNull();
  });
});
