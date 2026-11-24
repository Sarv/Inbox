import { describe, expect, it } from 'vitest';

import { describeLLMResponseShape, LLMJsonError, parseLLMJson } from '../../../../src/utils/llm-json';

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
  //
  // Changed deliberately: this used to pin `Response began: "<160 chars>"`, the
  // head of the answer quoted into the message. Every caller logs that error, and
  // the answer is built from mail (signature HTML, a polished draft, a summary,
  // an echoed search), so it reached app.log. The message now describes the
  // answer's shape and the `code` names the failure; neither quotes it.
  it('names what KIND of answer the model returned when it fails, without quoting it', () => {
    let thrown: unknown;
    try { parseLLMJson('The provided HTML contains no signature block.'); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(LLMJsonError);
    expect(thrown).toMatchObject({ name: 'LLMJsonError', code: 'prose' });
    expect((thrown as Error).message).toMatch(/prose.*chars=46.*began with a letter/);
    expect((thrown as Error).message).not.toMatch(/provided|HTML|signature/);
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

/**
 * The thrown message never quotes the model's answer.
 *
 * What breaks if this block fails: mail text reaches a release app.log. Every
 * caller of parseLLMJson (signature detection, polish, AI search, thread
 * summaries) logs the error it throws, and the answer it describes is built from
 * mail — signature HTML, a rewritten draft, a summary, a search query echoed
 * back. The sentinel stands for that text.
 */
describe('parseLLMJson failure messages carry no response text', () => {
  const SENTINEL = 'SENTINEL-LLM-7f3c';
  const failureOf = (raw: string): LLMJsonError => {
    try {
      parseLLMJson(raw);
    } catch (err) {
      return err as LLMJsonError;
    }
    throw new Error('expected parseLLMJson to throw');
  };

  it.each([
    ['prose', `Here is the signature: ${SENTINEL}, regards.`, 'prose'],
    ['a fenced prose answer', `\`\`\`\n${SENTINEL} is not JSON\n\`\`\``, 'prose'],
    ['prose after a thinking block', `<think>${SENTINEL}</think>${SENTINEL} said no`, 'prose'],
    ['markup instead of JSON', `<div class="sig">${SENTINEL}</div>`, 'prose'],
    // jsonrepair's own message quotes what it stopped at ("\u12SE" here) — that is
    // the answer again, so only the kind of failure and its position survive.
    ['JSON the repair pass cannot fix', `{"sampleHtml":"\\u12${SENTINEL}"}`, 'unrepairable'],
    ['only a thinking block', `<think>${SENTINEL}`, 'empty'],
  ])('%s', (_label, raw, code) => {
    const err = failureOf(raw);
    expect(err).toBeInstanceOf(LLMJsonError);
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(SENTINEL);
    expect(err.message).not.toContain('SENT');
    expect(err.stack ?? '').not.toContain(SENTINEL);
    expect(err.message).toContain(`chars=${raw.length}`);
  });

  // The repair failure keeps what it was (the kind and where), so a broken
  // object still reads differently from a model that answered in sentences.
  it('says where the repair pass stopped and why, without the character it stopped at', () => {
    const err = failureOf(`{"a":"\\u12${SENTINEL}"}`);
    expect(err.message).toMatch(/not JSON even after repair \(Invalid unicode character at position \d+; chars=\d+, began with an object\)/);
  });

  // A failure jsonrepair words without quoting anything keeps its kind and
  // position too. (Unknown wordings: llm-json-repair-failure.test.ts.)
  it('keeps a known repair failure kind and its position', () => {
    const err = failureOf(`{"a" 1 ${SENTINEL}}`);
    expect(err.message).toMatch(/Colon expected at position \d+/);
    expect(err.message).not.toContain(SENTINEL);
  });
});

/**
 * What a response looked like, for a log line or an error message.
 *
 * What breaks if this block fails: the failure messages lose the detail that
 * tells a prose answer from a cut-off object from a fence or thinking block
 * that ate the token budget — or start quoting the answer to get it back.
 */
describe('describeLLMResponseShape', () => {
  it('counts the characters and names how the answer began', () => {
    expect(describeLLMResponseShape('{"a":1}')).toBe('chars=7, began with an object');
    expect(describeLLMResponseShape('[1]')).toBe('chars=3, began with an array');
    expect(describeLLMResponseShape('"quoted"')).toBe('chars=8, began with a string');
    expect(describeLLMResponseShape('Sure!')).toBe('chars=5, began with a letter');
    expect(describeLLMResponseShape('42 things')).toBe('chars=9, began with a digit');
    expect(describeLLMResponseShape('<p>x</p>')).toBe('chars=8, began with markup');
    expect(describeLLMResponseShape('* item')).toBe('chars=6, began with a symbol');
    expect(describeLLMResponseShape('')).toBe('chars=0, began with nothing');
  });

  it('notes a fence, a thinking block and what cleaning removed', () => {
    expect(describeLLMResponseShape('```json\n{"a":1}\n```')).toBe('chars=19, cleanedChars=7, fenced, began with an object');
    expect(describeLLMResponseShape('<think>hm</think>{"a":1}')).toBe('chars=24, cleanedChars=7, thinking block, began with an object');
  });

  // Non-Latin prose is still prose: a reply in Hindi or Japanese is "a letter".
  it('reads a letter in any script as a letter', () => {
    expect(describeLLMResponseShape('नमस्ते')).toMatch(/began with a letter$/);
    expect(describeLLMResponseShape('こんにちは')).toMatch(/began with a letter$/);
  });
});
