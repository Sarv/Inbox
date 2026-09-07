import { describe, it, expect } from 'vitest';

import { cleanLLMJsonResponse, truncate } from '../../../../src/utils/llm-json';

describe('cleanLLMJsonResponse', () => {
  // Every AI feature (categorization, summaries, search parsing) JSON.parse()s
  // the result of this helper. Anything it fails to strip becomes a thrown
  // SyntaxError at a call site that treats it as "AI unhealthy".
  it('passes bare JSON through untouched', () => {
    expect(cleanLLMJsonResponse('{"a":1}')).toBe('{"a":1}');
  });

  it('returns empty string for empty/nullish input instead of throwing', () => {
    expect(cleanLLMJsonResponse('')).toBe('');
    expect(cleanLLMJsonResponse(undefined as unknown as string)).toBe('');
  });

  it('strips a ```json fenced block (the most common model wrapper)', () => {
    expect(cleanLLMJsonResponse('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips a bare ``` fence too', () => {
    expect(cleanLLMJsonResponse('```\n[1,2]\n```')).toBe('[1,2]');
  });

  it('strips an unterminated opening fence (model cut off before closing it)', () => {
    // A truncated response often has the opener but no closer; leaving the
    // opener in would make JSON.parse throw on the very first character.
    expect(cleanLLMJsonResponse('```json\n{"a":1}')).toBe('{"a":1}');
  });

  it('removes complete <think>/<thinking>/<reasoning>/<thought> blocks', () => {
    expect(cleanLLMJsonResponse('<think>hmm\nmulti-line</think>{"a":1}')).toBe('{"a":1}');
    expect(cleanLLMJsonResponse('<THINKING>x</THINKING>{"a":1}')).toBe('{"a":1}');
    expect(cleanLLMJsonResponse('<reasoning>x</reasoning>{"a":1}')).toBe('{"a":1}');
    expect(cleanLLMJsonResponse('<thought>x</thought>{"a":1}')).toBe('{"a":1}');
  });

  it('handles a reasoning block wrapped inside a fence', () => {
    expect(cleanLLMJsonResponse('<think>plan</think>\n```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  it('drops everything from a DANGLING reasoning opener onward', () => {
    // A truncated <think> with no closer means the JSON never arrived — better
    // to return '' (caller sees a parse failure) than to hand back prose.
    expect(cleanLLMJsonResponse('{"a":1}<think>still thinking...')).toBe('{"a":1}');
    expect(cleanLLMJsonResponse('<thinking>never closed')).toBe('');
  });

  it('does NOT salvage trailing prose after the JSON (documents current behaviour)', () => {
    // Guard, not endorsement: the helper only strips fences + reasoning blocks,
    // so a model that appends commentary still yields unparseable text. If this
    // ever changes, the assertion below is the thing to revisit.
    expect(cleanLLMJsonResponse('{"a":1}\nHope that helps!')).toBe('{"a":1}\nHope that helps!');
  });

  it('is idempotent — re-cleaning already-clean output is a no-op', () => {
    const once = cleanLLMJsonResponse('```json\n{"a":1}\n```');
    expect(cleanLLMJsonResponse(once)).toBe(once);
  });
});

describe('truncate', () => {
  // The suffix is a parameter precisely because call sites use different
  // markers; appending it to a short string would corrupt prompts silently.
  it('leaves a string at or below the limit untouched (no suffix)', () => {
    expect(truncate('hello', 5, '...')).toBe('hello');
    expect(truncate('hi', 5, '...')).toBe('hi');
  });

  it('cuts to exactly `max` chars and appends the caller-supplied suffix', () => {
    expect(truncate('abcdefgh', 3, '…[cut]')).toBe('abc…[cut]');
  });

  it('supports an empty suffix', () => {
    expect(truncate('abcdef', 2, '')).toBe('ab');
  });
});
