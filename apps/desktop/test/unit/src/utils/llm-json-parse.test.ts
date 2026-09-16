import { describe, expect, it } from 'vitest';

import { parseLLMJson } from '../../../../src/utils/llm-json';

/**
 * The one place renderer code turns a model's response into an object.
 *
 * THE bug this closes: four separate call sites in ai-service — text polish,
 * signature detection, search-query parsing and thread summaries — each did
 *
 *     const parsed = JSON.parse(cleanLLMJsonResponse(responseText));
 *
 * with no repair whatsoever. Any imperfection in the model's output threw and
 * the whole feature silently fell back. Only signature detection was ever
 * noticed, and only because it happened to log the failure; the other three
 * failed exactly the same way, quietly.
 *
 * The malformation classes below are taken from 36 real failed responses in one
 * user's log.
 */
describe('parseLLMJson', () => {
  it('parses a response that is already valid JSON', () => {
    expect(parseLLMJson('{"hasSignature":true}')).toEqual({ hasSignature: true });
  });

  it('strips a markdown fence before parsing', () => {
    expect(parseLLMJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a model thinking block before parsing', () => {
    expect(parseLLMJson('<think>weighing it up</think>{"a":1}')).toEqual({ a: 1 });
  });

  // THE dominant real failure: a quote escaped going into an HTML attribute
  // and not coming out, so the JSON string ends mid-value.
  it('repairs an unescaped quote inside a string value', () => {
    const out = parseLLMJson<{ sampleHtml: string }>('{"sampleHtml":"<div class="sig">Regards</div>"}');
    expect(out.sampleHtml).toContain('Regards');
  });

  // `\>` and `\;` are not JSON escapes — the model invents them writing HTML.
  it('repairs escapes JSON does not define', () => {
    const out = parseLLMJson<{ html: string }>('{"html":"<td\\>x</td\\>"}');
    expect(out.html).toContain('x');
  });

  it('repairs a missing closing brace', () => {
    expect(parseLLMJson('{"a":1,"b":2')).toMatchObject({ a: 1, b: 2 });
  });

  it('repairs trailing junk after the object', () => {
    expect(parseLLMJson('{"a":1} Hope that helps!')).toMatchObject({ a: 1 });
  });

  it('repairs a trailing comma', () => {
    expect(parseLLMJson('{"a":1,}')).toEqual({ a: 1 });
  });

  it('parses arrays as well as objects', () => {
    expect(parseLLMJson('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  // Throwing (rather than returning null) is deliberate: every call site
  // already wraps this in try/catch, so the shared helper is strictly more
  // recovery and never a new failure mode to handle.
  it('throws on a response with no JSON in it at all', () => {
    expect(() => parseLLMJson('The provided HTML contains no signature block.')).toThrow();
  });

  // The old failure read `SyntaxError: Unexpected token 'T', "The provid"...`,
  // which says how it broke and nothing about what came back. A model that
  // answered in prose is a different problem from one that emitted bad JSON,
  // and the message has to let you tell them apart.
  it('names what the model actually returned when it fails', () => {
    expect(() => parseLLMJson('The provided HTML contains no signature block.'))
      .toThrow(/Response began:.*provided HTML/);
  });

  it('rejects an empty response distinctly', () => {
    expect(() => parseLLMJson('')).toThrow(/empty response/);
    expect(() => parseLLMJson('   ')).toThrow(/empty response/);
  });

  // A fence containing prose must not be mistaken for a parse failure of
  // some recoverable kind — it has no JSON either.
  it('throws when a fence wraps something that is not JSON', () => {
    expect(() => parseLLMJson('```\nnot json at all\n```')).toThrow();
  });

  // The trailing-junk path slices to the first BALANCED value, and a brace
  // inside a string value must not be mistaken for the end of the object —
  // HTML and prose are full of them.
  it('ignores braces inside string values when trimming trailing junk', () => {
    const out = parseLLMJson<{ a: string }>('{"a":"} not the end {"} trailing commentary');
    expect(out.a).toBe('} not the end {');
  });

  it('handles an escaped quote inside a string while trimming trailing junk', () => {
    const out = parseLLMJson<{ a: string }>('{"a":"say \\"hi\\""} and then some prose');
    expect(out.a).toBe('say "hi"');
  });

  it('keeps nested objects intact when trimming trailing junk', () => {
    const out = parseLLMJson<{ a: { b: { c: number } } }>('{"a":{"b":{"c":1}}} thanks!');
    expect(out.a.b.c).toBe(1);
  });

  it('trims trailing junk after an array too', () => {
    expect(parseLLMJson('[1,2,3] hope that helps')).toEqual([1, 2, 3]);
  });

  // THE false-recovery guard. A real response read "The provided HTML is an
  // extremely large, truncated email template…" and contained a brace-shaped
  // fragment mid-sentence. Scanning for a brace ANYWHERE parsed that into a
  // six-element array — an object, valid, and missing every field the caller
  // reads. It must fail instead: a silent wrong answer is worse than the
  // exception it replaced.
  it('refuses to mine a JSON fragment out of the middle of prose', () => {
    expect(() => parseLLMJson('The provided HTML is large and contains {"x":1} somewhere'))
      .toThrow(/prose|Response began/);
  });

  it('still trims trailing junk when the response BEGINS with the value', () => {
    expect(parseLLMJson('  {"a":1}  Hope that helps!')).toEqual({ a: 1 });
  });

  // THE fabrication guard. Handed a prose sentence, jsonrepair splits it on the
  // commas and returns a perfectly valid array of fragments — structurally an
  // object, semantically invented. Three real responses did this, and every one
  // would have reached a caller that reads `.hasSignature` off it.
  it('never turns a prose sentence into an array of its clauses', () => {
    const prose = 'The provided HTML is an extremely large, truncated email template, likely a newsletter.';
    expect(() => parseLLMJson(prose)).toThrow(/prose/);
  });

  // The same shape of answer the models actually give when they decline.
  it('rejects a declining answer rather than inventing a result', () => {
    expect(() => parseLLMJson('The provided HTML is truncated and does not contain the body content.'))
      .toThrow(/prose/);
  });
});
