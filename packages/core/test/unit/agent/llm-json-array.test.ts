import { describe, expect, it } from 'vitest';

import { parseLLMJsonArray, salvageDiagnosticsSummary } from '../../../src/agent/llm-json-array';

// The ONE read of an AI answer that should be a JSON array, shared by core's
// validateCategorizationResponse and the desktop AICategorizationService (they
// used to carry copies). What breaks if this file fails: a categorization batch
// the model answered in a recoverable shape is thrown away (and retried for
// ever), or a log line about an unusable answer has nothing but text to say.

describe('parseLLMJsonArray', () => {
  // Breaks: a clean answer (after thinking tags and fences) is not read whole.
  it('reads a whole answer, fences and thinking tags stripped', () => {
    const read = parseLLMJsonArray('<think>pondering</think>```json\n[{"emailId":"e1"}]\n```');
    expect(read).toEqual({ how: 'whole', value: [{ emailId: 'e1' }] });
  });

  // Breaks: a bare object is reported as an array (the caller decides).
  it('reports a whole non-array answer as it is', () => {
    expect(parseLLMJsonArray('{"emailId":"e1"}')).toEqual({ how: 'whole', value: { emailId: 'e1' } });
  });

  // Breaks: a truncated batch loses the objects that did arrive.
  it('salvages the complete objects of a truncated array, with the walk counts', () => {
    const read = parseLLMJsonArray('[{"emailId":"e1"},{"emailId":"e2","categ');
    expect(read.how).toBe('salvaged');
    expect(read.value).toEqual([{ emailId: 'e1' }]);
    if (read.how !== 'salvaged') throw new Error('unreachable');
    expect(read.diagnostics).toMatchObject({ objectsParsed: 1, truncatedMidObject: true, reachedArrayEnd: false });
    expect(read.summary).toBe(salvageDiagnosticsSummary(read.diagnostics));
  });

  // Breaks: an array buried in reasoning prose with no object to salvage is lost.
  it('falls back to the first balanced array in prose', () => {
    const read = parseLLMJsonArray('analysis: I would use ["invoice"] here');
    expect(read).toMatchObject({ how: 'bracket', value: ['invoice'] });
  });

  // Breaks: prose with no array reads as something, or the failure has no
  // counts for the log line to report.
  it('reports nothing usable, with counts only', () => {
    const read = parseLLMJsonArray('I cannot help with that.');
    expect(read).toMatchObject({ how: 'none', value: null });
    if (read.how !== 'none') throw new Error('unreachable');
    expect(read.summary).toBe('inputLen=24 attempted=0 closed=0 parsed=0 truncated=false reachedEnd=false');
  });

  // Breaks: an answer that IS one balanced array but not valid JSON loops back
  // into itself as a "bracket" retry and reads as an array.
  it('does not retry the answer itself as a bracket match', () => {
    expect(parseLLMJsonArray('[not json at all, really]').how).toBe('none');
  });
});

describe('salvageDiagnosticsSummary', () => {
  // Breaks: the summary grows a field that carries text from the answer.
  it('is numbers and booleans only', () => {
    expect(salvageDiagnosticsSummary({
      inputLength: 10, objectsAttempted: 2, objectsClosed: 1, objectsParsed: 1, truncatedMidObject: true, reachedArrayEnd: false,
    })).toBe('inputLen=10 attempted=2 closed=1 parsed=1 truncated=true reachedEnd=false');
  });
});
