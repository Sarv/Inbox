import { describe, it, expect } from 'vitest';

import { repairMalformedNumericFields, cleanLLMJsonResponse, tryParseLLMJson } from '../../../src/agent/llm-response-utils';

// The LLM occasionally emits a numeric field as garbage (observed: a decimal
// spelled out — `"confidence": 0. nine`). That is a JSON syntax error, and it
// killed the WHOLE categorization batch ("No usable JSON"). repairMalformed-
// NumericFields rewrites only a MALFORMED value of a known numeric key to null so
// the surrounding JSON still parses; the consumer then applies its own default.

describe('repairMalformedNumericFields', () => {
  it('rewrites a spelled-out confidence to null so the object parses', () => {
    const raw = '{ "emailId": "e1", "confidence": 0. nine, "reasoning": "x" }';
    const fixed = repairMalformedNumericFields(raw);
    expect(JSON.parse(fixed)).toMatchObject({ emailId: 'e1', confidence: null, reasoning: 'x' });
  });

  it('leaves a VALID number untouched (integer, decimal, leading dot, exponent)', () => {
    for (const v of ['0', '0.9', '-1', '.5', '1e3', '2.5E-2']) {
      const raw = `{ "confidence": ${v}, "x": 1 }`;
      expect(repairMalformedNumericFields(raw)).toBe(raw); // no change
    }
  });

  it('repairs a value at the END of an object (delimited by })', () => {
    const raw = '{ "score": 12 apples }';
    expect(JSON.parse(repairMalformedNumericFields(raw))).toEqual({ score: null });
  });

  it('does NOT touch a "confidence" that only appears inside a string value', () => {
    // Not in object-key position (no preceding { or ,), so it must be left alone.
    const raw = '{ "reasoning": "my confidence: high overall", "confidence": 0.8 }';
    const parsed = tryParseLLMJson<{ reasoning: string; confidence: number }>(
      repairMalformedNumericFields(raw),
    );
    expect(parsed).toEqual({ reasoning: 'my confidence: high overall', confidence: 0.8 });
  });

  it('is applied by cleanLLMJsonResponse end-to-end', () => {
    const raw = '```json\n[ { "emailId": "e1", "confidence": 0. nine } ]\n```';
    const parsed = tryParseLLMJson<Array<{ emailId: string; confidence: null }>>(
      cleanLLMJsonResponse(raw),
    );
    expect(parsed).toEqual([{ emailId: 'e1', confidence: null }]);
  });
});
