// @vitest-environment happy-dom
// Signature detection parses mail HTML with DOMParser.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detectSignature,
  generateThreadSummary,
  getDefaultProvider,
  getUserProfile,
  hydrateAiSecrets,
  loadAIFeatures,
  loadCategorizationPrompts,
  parseSearchQuery,
  polishText,
  removeSignatureFromBody,
  saveAISettings,
  saveCategorizationPrompts,
  stripSignaturesSimple,
  type EmailForSummary,
  type PolishContext,
} from '../../../../src/services/ai-service';

/**
 * The renderer's AI features — signature detection, polish, AI search, thread
 * summaries — send mail and the user's own words to a model and get mail back.
 * The renderer forwards console.log/info/warn/error to app.log in a release
 * build, so none of that text may appear in a log line: not the draft, not the
 * signature HTML the model copies out, not the search query or what the model
 * made of it, not the summary, not a sender or a selector taken from the mail,
 * and not an error message that quotes any of them.
 *
 * Every path here is driven with a sentinel in the mail / draft / query / model
 * answer, through the REAL forwarder (bootstrap/renderer-logging), and asserts
 * the sentinel never reaches `log.forward` while the result still carries it.
 *
 * What breaks if this file fails: mail text, drafts or search queries are written
 * to a release app.log — the file users attach to bug reports.
 */

const SENTINEL = 'SENTINEL-MAIL-5b1e';
const SENDER = `${SENTINEL.toLowerCase()}@sender.example`;

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
const originalConsole: Partial<Record<(typeof CONSOLE_METHODS)[number], (...args: unknown[]) => void>> = {};
const forward = vi.fn();
const fetchMock = vi.fn();
const signatures = { getByEmail: vi.fn(), save: vi.fn() };

beforeAll(async () => {
  // Silence DevTools passthrough, then install the real forwarder over it: every
  // console call below goes the way it goes in the app, into `forward`.
  for (const method of CONSOLE_METHODS) {
    originalConsole[method] = console[method];
    console[method] = () => {};
  }
  await import('../../../../src/bootstrap/renderer-logging');
});
afterAll(() => {
  for (const method of CONSOLE_METHODS) console[method] = originalConsole[method]!;
});

const PROVIDER_SETTINGS = 'sarvinbox-ai-settings';
/** A keyless local Custom provider: requests go straight to `fetch`. */
const useCustomProvider = () => localStorage.setItem(PROVIDER_SETTINGS, JSON.stringify({
  providers: [{ id: 'local', type: 'custom', name: 'Local', apiKey: '', model: 'm', baseUrl: 'http://localhost:11434/v1', isDefault: true }],
}));
/** A Gemini provider with a (legacy, still on disk) key: also a direct `fetch`. */
const useGeminiProvider = () => localStorage.setItem(PROVIDER_SETTINGS, JSON.stringify({
  providers: [{ id: 'gem', type: 'gemini', name: 'Gemini', apiKey: 'synthetic-key', model: 'gemini-x', isDefault: true }],
}));

const chatAnswer = (content: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], ...extra }), { status: 200 });
const answerWith = (content: string) => fetchMock.mockImplementation(async () => chatAnswer(content));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sarvinbox-ai-features', JSON.stringify([{ id: 'signature-detection', enabled: true }]));
  useCustomProvider();
  forward.mockReset();
  fetchMock.mockReset();
  signatures.getByEmail.mockReset().mockResolvedValue({ success: true, data: null });
  signatures.save.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { log: { forward }, signatures };
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Every line that reached app.log through the forwarder. */
const forwarded = (): string[] => forward.mock.calls.map(([record]) => (record as { text: string }).text);
const expectNoMailInLog = () => {
  const lines = forwarded();
  for (const line of lines) expect(line).not.toContain(SENTINEL);
  for (const line of lines) expect(line.toLowerCase()).not.toContain(SENTINEL.toLowerCase());
  return lines.join('\n');
};

// ─────────────────────────── signature detection ───────────────────────────

const SIGNED_BODY = `<p>Hello</p><div class="sig-${SENTINEL}">Regards, ${SENTINEL}</div>`;
const sigAnswer = (over: Record<string, unknown> = {}) => JSON.stringify({
  hasSignature: true,
  htmlSelector: `div.sig-${SENTINEL}`,
  sampleHtml: `<div class="sig-${SENTINEL}">Regards, ${SENTINEL}</div>`,
  signatureText: `Regards, ${SENTINEL}`,
  confidence: 'high',
  ...over,
});

describe('signature detection logs what happened, never the mail', () => {
  // Breaks: the "Raw AI response" / "Parsed response" dumps come back — the
  // signature HTML and text copied out of the sender's mail, at info level.
  it('describes an AI answer without its sampleHtml, signatureText, selector or the sender', async () => {
    answerWith(`\`\`\`json\n${sigAnswer()}\n\`\`\``);
    const result = await detectSignature(SIGNED_BODY, SENDER, 'e1');

    expect(result).toMatchObject({ hasSignature: true, htmlSelector: `div.sig-${SENTINEL}`, confidence: 'high' });
    expect(result.sampleHtml).toContain(SENTINEL);
    expect(signatures.save).toHaveBeenCalledWith(expect.objectContaining({ email: SENDER, htmlSelector: `div.sig-${SENTINEL}` }));
    const log = expectNoMailInLog();
    expect(log).toMatch(/asking the AI \(bodyChars=\d+\)/);
    expect(log).toMatch(/AI answered hasSignature=true selector=present confidence=high responseChars=\d+ cached=true/);
  });

  // Breaks: a model that writes prose into `confidence` has that prose logged.
  it('logs a free-text confidence as "other"', async () => {
    answerWith(sigAnswer({ confidence: `high, the ${SENTINEL} block` }));
    await detectSignature(SIGNED_BODY, SENDER);
    expect(expectNoMailInLog()).toMatch(/confidence=other/);
  });

  // Breaks: "no signature" answers, or a failed save, are logged with detail
  // that is not there (or the cache state is misreported).
  it('describes a "no signature" answer and a cache write that failed', async () => {
    answerWith(sigAnswer({ hasSignature: false, htmlSelector: null }));
    let log = '';
    await detectSignature(SIGNED_BODY, SENDER);
    log = expectNoMailInLog();
    expect(log).toMatch(/hasSignature=false selector=none .* cached=false/);

    forward.mockReset();
    answerWith(sigAnswer());
    signatures.save.mockRejectedValueOnce(new Error(`disk full writing ${SENTINEL}`));
    await detectSignature(SIGNED_BODY, SENDER);
    log = expectNoMailInLog();
    expect(log).toMatch(/failed to cache the signature \{"name":"Error"\}/);
    expect(log).toMatch(/cached=false/);
  });

  // Breaks: parseLLMJson's failure (it used to quote 160 chars of the answer)
  // is logged whole when the model answers in prose about the mail.
  it('logs a prose answer as a parse failure, without the prose', async () => {
    answerWith(`The signature reads "${SENTINEL}" and sits at the bottom.`);
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(result.hasSignature).toBe(false);
    expect(expectNoMailInLog()).toMatch(/AI detection failed \{"name":"LLMJsonError","code":"prose"\}/);
  });

  // PERMANENT provider failure. Breaks: the provider's error body (which can
  // quote the request — the mail) is logged through SarvLLMError's message.
  it('logs a provider error by class, code and status only', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: 'server_error', error_description: `could not process ${SENTINEL}` }),
      { status: 500 },
    ));
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(result.hasSignature).toBe(false);
    expect(expectNoMailInLog()).toMatch(/AI detection failed \{"name":"SarvLLMError","code":"server_error","status":500\}/);
  });

  // TRANSIENT failure, retried. Breaks: the 429 retry path logs the throttled
  // response, or the retry is lost and detection fails on a rate limit.
  it('retries a 429 and logs only the status and the wait', async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response(`slow down ${SENTINEL}`, { status: 429, headers: { 'retry-after': '0' } }))
      .mockImplementationOnce(async () => chatAnswer(sigAnswer()));
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.hasSignature).toBe(true);
    const log = expectNoMailInLog();
    expect(log).toMatch(/transient 429, waiting 0ms before retry 1\/1/);
    expect(log).toMatch(/hasSignature=true/);
  });

  // TRANSIENT failure that never clears (timeout, retried once). Breaks: the
  // abort's message reaches the log, or the timeout is not retried at all.
  it('logs a request that timed out twice as a 504', async () => {
    fetchMock.mockImplementation(async () => { throw new DOMException(`aborted ${SENTINEL}`, 'AbortError'); });
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.hasSignature).toBe(false);
    const log = expectNoMailInLog();
    expect(log).toMatch(/request timed out after 60000ms, retry 1\/1/);
    expect(log).toMatch(/AI detection failed \{"name":"SarvLLMError","code":"timeout","status":504\}/);
  });

  // Breaks: the empty-content warning dumps reasoning_content (the model
  // thinking about the mail, up to 800 chars) or a refusal that restates it,
  // or prints a field name the provider chose (fieldSizesForLog counts a key
  // that is not an identifier instead of writing it).
  it('names the message fields of an empty answer with their sizes only', async () => {
    const reasoning = `Looking at the signature ${SENTINEL} in this mail`;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: reasoning, refusal: null, tool_calls: [{ arguments: SENTINEL }], [`note about ${SENTINEL}`]: 'x' }, finish_reason: 'length' }],
      usage: { completion_tokens: 16000 },
    }), { status: 200 }));
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(result.hasSignature).toBe(false);
    const log = expectNoMailInLog();
    expect(log).toContain('empty content from the model');
    expect(log).toContain('"finish_reason": "length"');
    expect(log).toContain(`"reasoning_content": ${reasoning.length}`);
    expect(log).toContain('"refusal": "null"');
    expect(log).toContain('"tool_calls": "array(1)"');
    expect(log).toContain('"+more": 1');
    expect(log).toContain('AI returned an empty response');
    // The request dump stays lengths-only too.
    expect(log).toMatch(/"content_chars": \d+/);
  });

  // Breaks: a cached selector (taken from the sender's HTML) and the sender's
  // address are logged on every email the cache serves.
  it('logs a cache hit without the sender or the selector', async () => {
    signatures.getByEmail.mockResolvedValue({ success: true, data: { htmlSelector: `div.sig-${SENTINEL}`, confidence: 'high' } });
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(result).toMatchObject({ hasSignature: true, fromCache: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(expectNoMailInLog()).toContain('found by the cached selector');
  });

  // Breaks: the browser's SyntaxError, which quotes the whole (mail-derived)
  // selector, is logged when a cached selector no longer parses.
  it('logs a cached selector the browser rejects by class and length', async () => {
    const selector = `div[${SENTINEL}`;
    signatures.getByEmail.mockResolvedValue({ success: true, data: { htmlSelector: selector, confidence: 'high' } });
    answerWith(sigAnswer({ hasSignature: false, htmlSelector: null }));
    await detectSignature(SIGNED_BODY, SENDER);
    const log = expectNoMailInLog();
    expect(log).toContain(`could not extract a signature: the selector did not apply {"name":"DOMException","selectorChars":${selector.length}}`);
    expect(log).toContain('cached selector did not match, re-detecting');
  });

  // Breaks: a failed cache lookup logs the IPC error's message.
  it('logs a cache lookup failure by class only', async () => {
    signatures.getByEmail.mockRejectedValue(new Error(`no row for ${SENTINEL}`));
    answerWith(sigAnswer({ hasSignature: false, htmlSelector: null }));
    await detectSignature(SIGNED_BODY, SENDER);
    expect(expectNoMailInLog()).toContain('failed to check the cache {"name":"Error"}');
  });

  // Breaks: the common-selector path logs the sender, or misreports the save.
  it('logs a common-selector match without the sender, and whether it was cached', async () => {
    const body = `<p>Hi</p><div class="gmail_signature">${SENTINEL}</div>`;
    const result = await detectSignature(body, SENDER);
    expect(result).toMatchObject({ hasSignature: true, htmlSelector: 'div.gmail_signature' });
    expect(result.signatureText).toBe(SENTINEL);
    expect(expectNoMailInLog()).toContain('found by a common selector (cached=true)');

    forward.mockReset();
    signatures.save.mockRejectedValueOnce(new Error(`locked ${SENTINEL}`));
    await detectSignature(body, SENDER);
    const log = expectNoMailInLog();
    expect(log).toContain('failed to cache the common selector {"name":"Error"}');
    expect(log).toContain('found by a common selector (cached=false)');

    forward.mockReset();
    signatures.save.mockResolvedValueOnce({ success: false, error: `constraint ${SENTINEL}` });
    await detectSignature(body, SENDER);
    expect(expectNoMailInLog()).toContain('found by a common selector (cached=false)');
  });

  // Breaks: with no provider, detection still logs (or calls) something.
  it('says no provider is configured, and nothing about the mail', async () => {
    localStorage.removeItem(PROVIDER_SETTINGS);
    const result = await detectSignature(SIGNED_BODY, SENDER);
    expect(result.hasSignature).toBe(false);
    expect(expectNoMailInLog()).toContain('no AI provider configured and no common selector matched');
  });

  // Breaks: removing a signature with a cached selector that no longer parses
  // logs the selector through the browser's error.
  it('logs a selector that fails during removal by class and length', () => {
    const selector = `div[${SENTINEL}`;
    const out = removeSignatureFromBody(SIGNED_BODY, {
      hasSignature: true, htmlSelector: selector, sampleHtml: null, signatureText: null, confidence: 'high', fromCache: true,
    });
    expect(out).toEqual({ bodyWithoutSignature: SIGNED_BODY, signature: null });
    expect(expectNoMailInLog()).toContain(`could not remove a signature: the selector did not apply {"name":"DOMException","selectorChars":${selector.length}}`);
  });
});

// ──────────────────────────────── polish ───────────────────────────────────

const polishContext: PolishContext = {
  mode: 'reply',
  polishMode: 'full',
  subject: `Re: ${SENTINEL}`,
  recipient: SENDER,
  threadContext: `[Bob] earlier: the ${SENTINEL} contract`,
  userProfile: { name: 'Me', title: '', company: '', email: 'me@example.com', phone: '' },
};
const DRAFT = `<p>Thanks, I will sign the ${SENTINEL} contract.</p>`;

describe('polish logs what came back, never the draft', () => {
  // Breaks: "Raw response" / "Parsed response" / "Final result" come back —
  // the user's rewritten draft, at info level, three times.
  it('describes a polished draft by its subject flag and body size', async () => {
    const body = `<p>Thank you — I will sign the ${SENTINEL} contract today.</p>`;
    answerWith(JSON.stringify({ subject: `Re: ${SENTINEL}`, body }));
    const result = await polishText(DRAFT, polishContext, `mention ${SENTINEL}`);
    expect(result).toEqual({ subject: `Re: ${SENTINEL}`, body });
    expect(expectNoMailInLog()).toContain(`polished subject=true bodyChars=${body.length}`);
  });

  // Breaks: the non-JSON fallback logs the parse error (which quoted the
  // answer) and then the whole answer ("Raw text was").
  it('uses a prose answer as the body and logs only that it was not JSON', async () => {
    const prose = `Thanks, I will sign the ${SENTINEL} contract today.`;
    answerWith(prose);
    const result = await polishText(DRAFT, polishContext);
    expect(result).toEqual({ body: prose });
    expect(expectNoMailInLog()).toContain(`answer was not JSON, using it whole {"name":"LLMJsonError","code":"prose","responseChars":${prose.length}}`);
  });

  // Breaks: an answer with no body is dropped instead of used whole.
  it('uses an answer with no body whole, logging its size', async () => {
    const answer = JSON.stringify({ subject: SENTINEL });
    answerWith(answer);
    expect(await polishText(DRAFT, polishContext)).toEqual({ body: answer });
    expect(expectNoMailInLog()).toContain(`answer had no body, using it whole (responseChars=${answer.length})`);
  });

  // PERMANENT failure on the Gemini path, whose error message carries the
  // provider's response body. Breaks: that body reaches the log.
  it('logs a provider failure by class and status, and still throws', async () => {
    useGeminiProvider();
    fetchMock.mockImplementation(async () => new Response(`bad request near "${SENTINEL}"`, { status: 400 }));
    await expect(polishText(DRAFT, polishContext)).rejects.toThrow(/API request failed: 400/);
    expect(expectNoMailInLog()).toContain('polish failed {"name":"Error","status":400}');
  });
});

// ─────────────────────────────── AI search ──────────────────────────────────

describe('AI search logs the shape of a query, never its words', () => {
  // Breaks: the typed query, and the model's parse that echoes it back, are
  // logged; or this path names the parsed fields again, when the search store
  // already logs them once for every search (`parsed query fields=…`).
  it('logs the query size and leaves the parsed field names to the search store', async () => {
    const query = `mentions:${SENTINEL} budget`;
    answerWith(JSON.stringify({ textQuery: `${SENTINEL} budget`, subject: SENTINEL, isUnread: true, interpretation: `Searching for ${SENTINEL}`, confidence: 0.9 }));
    const result = await parseSearchQuery(query);
    expect(result.query).toEqual({ subject: SENTINEL, isUnread: true, textQuery: `${SENTINEL} budget` });
    expect(result.interpretation).toContain(SENTINEL);
    const log = expectNoMailInLog();
    expect(log).toContain(`parsing a query with AI (queryChars=${query.length})`);
    expect(log).not.toContain('fields=');
  });

  // Breaks: an answer with no usable field stops returning an empty query (so
  // the store's line can say "none"), or its interpretation is logged.
  it('returns an empty query when the model filled no field, logging none of it', async () => {
    answerWith(JSON.stringify({ interpretation: SENTINEL }));
    const result = await parseSearchQuery(`mentions:${SENTINEL}`);
    expect(result.query).toEqual({});
    expect(result.interpretation).toBe(SENTINEL);
    expect(expectNoMailInLog()).not.toContain('fields=');
  });

  // Breaks: a prose answer's parse error (quoting the echoed query) is logged,
  // or the search stops instead of falling back to the text as typed.
  it('falls back to the typed text on a prose answer, logging the failure class', async () => {
    const query = `mentions:${SENTINEL}`;
    answerWith(`You are looking for ${SENTINEL}.`);
    const result = await parseSearchQuery(query);
    expect(result.query).toEqual({ textQuery: query });
    expect(expectNoMailInLog()).toContain('AI could not parse the query, searching the text as typed {"name":"LLMJsonError","code":"prose"}');
  });

  // TRANSIENT network failure. Breaks: the network error's message is logged
  // or the search does not fall back.
  it('falls back on a network failure, logging its class', async () => {
    fetchMock.mockImplementation(async () => { throw new TypeError(`fetch failed for ${SENTINEL}`); });
    const result = await parseSearchQuery(`mentions:${SENTINEL}`);
    expect(result.confidence).toBe(0.3);
    expect(expectNoMailInLog()).toContain('{"name":"TypeError"}');
  });

  // Breaks: the fast path (no AI) starts logging the query.
  it('logs nothing of a query the fast path parses', async () => {
    const result = await parseSearchQuery(SENTINEL);
    expect(result.query.textQuery?.toLowerCase()).toBe(SENTINEL.toLowerCase());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(expectNoMailInLog()).toContain('fast path: parsed a simple query without AI');
  });
});

// ──────────────────────────── thread summaries ─────────────────────────────

const THREAD: EmailForSummary[] = [1, 2].map((n) => ({
  id: `e${n}`,
  subject: `${SENTINEL} contract`,
  fromAddress: SENDER,
  fromName: `Bob ${SENTINEL}`,
  toAddress: 'me@example.com',
  date: 1_760_000_000 + n,
  body: `<p>Message ${n} about the ${SENTINEL} contract.</p>`,
}));

describe('thread summaries log their size, never the summary', () => {
  // Breaks: "[Thread Summary] Raw response" (300 chars of the summary — names,
  // amounts, decisions from the thread) comes back.
  it('logs the summary length and key-point count', async () => {
    const summary = `Bob and you agreed on the ${SENTINEL} contract.`;
    answerWith(JSON.stringify({ summary, key_points: [`Sign ${SENTINEL}`, 'Friday'], participants: ['Bob'], confidence: 0.8 }));
    const result = await generateThreadSummary(THREAD);
    expect(result?.summary).toBe(summary);
    expect(expectNoMailInLog()).toContain(`summarised 2 emails (summaryChars=${summary.length}, keyPoints=2)`);
  });

  // Breaks: an answer with odd field types throws or logs a wrong size.
  it('counts a malformed summary as zero', async () => {
    answerWith(JSON.stringify({ summary: { text: SENTINEL }, key_points: SENTINEL }));
    await generateThreadSummary(THREAD);
    expect(expectNoMailInLog()).toContain('summarised 2 emails (summaryChars=0, keyPoints=0)');
  });

  // Breaks: a prose summary's parse error (quoting the summary) is logged.
  it('logs a prose answer by failure class and returns null', async () => {
    answerWith(`Bob and you agreed on the ${SENTINEL} contract.`);
    expect(await generateThreadSummary(THREAD)).toBeNull();
    expect(expectNoMailInLog()).toContain('failed to generate {"name":"LLMJsonError","code":"prose"}');
  });

  // Breaks: with no provider the summary path logs or calls anything else.
  it('returns null without a provider', async () => {
    localStorage.removeItem(PROVIDER_SETTINGS);
    expect(await generateThreadSummary(THREAD)).toBeNull();
    expect(expectNoMailInLog()).toContain('no AI provider configured');
  });
});

// ───────────────────────── stored settings that fail ────────────────────────

describe('unreadable AI settings are logged by class', () => {
  // Breaks: V8's JSON.parse error, which quotes the stored text (the user's
  // profile: name, phone; or provider settings), is logged.
  it('does not quote a corrupt profile or provider list', () => {
    localStorage.setItem('sarvinbox-settings', `${SENTINEL} not json`);
    localStorage.setItem(PROVIDER_SETTINGS, `${SENTINEL} not json`);
    expect(getUserProfile()).toBeNull();
    expect(getDefaultProvider()).toBeNull();
    const log = expectNoMailInLog();
    expect(log).toContain('failed to load the user profile {"name":"SyntaxError"}');
    expect(log).toContain('failed to load AI settings {"name":"SyntaxError"}');
  });
});

describe('settings and housekeeping failures are logged by class', () => {
  // Breaks: a vault or storage failure's message (which can name the key, the
  // endpoint, or quote the stored JSON) is logged whole.
  it('does not quote a failed vault read or key migration', async () => {
    localStorage.setItem(PROVIDER_SETTINGS, JSON.stringify({ providers: [{ id: 'legacy', type: 'openai', name: 'OpenAI', apiKey: `sk-${SENTINEL}`, model: 'm', isDefault: true }] }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      log: { forward },
      aiSecrets: {
        list: vi.fn(async () => { throw new Error(`keychain locked for ${SENTINEL}`); }),
        set: vi.fn(async () => { throw new Error(`could not store sk-${SENTINEL}`); }),
      },
    };
    await hydrateAiSecrets();
    const log = expectNoMailInLog();
    expect(log).toContain('failed to load AI key status from the vault {"name":"Error"}');
    expect(log).toContain('failed to migrate AI keys to the vault {"name":"Error"}');
  });

  // Breaks: a storage write failure (quota, a locked profile) is logged with its message.
  it('does not quote a failed settings or prompts write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error(`quota exceeded writing ${SENTINEL}`); },
    });
    saveAISettings({ providers: [] });
    saveCategorizationPrompts({ systemPrompt: `Sort mail about ${SENTINEL}` });
    const log = expectNoMailInLog();
    expect(log).toContain('failed to save AI settings {"name":"Error"}');
    expect(log).toContain('failed to save categorization prompts {"name":"Error"}');
  });

  // Breaks: V8 quotes the corrupt JSON it could not parse — a user's own
  // categorization prompt, their feature list.
  it('does not quote corrupt stored features or prompts', () => {
    localStorage.setItem('sarvinbox-ai-features', `${SENTINEL} not json`);
    localStorage.setItem('sarvinbox-categorization-prompts', `${SENTINEL} not json`);
    expect(loadAIFeatures().length).toBeGreaterThan(0);
    expect(loadCategorizationPrompts()).toEqual({ systemPrompt: '' });
    const log = expectNoMailInLog();
    expect(log).toContain('failed to load AI features {"name":"SyntaxError"}');
    expect(log).toContain('failed to load categorization prompts {"name":"SyntaxError"}');
  });

  // Breaks: a parser failure while stripping or matching signatures logs its
  // message, or stops returning the body untouched.
  it('does not quote a parser failure in the signature helpers', async () => {
    vi.stubGlobal('DOMParser', class { parseFromString(): never { throw new Error(`cannot parse ${SENTINEL}`); } });
    expect(stripSignaturesSimple(SIGNED_BODY)).toBe(SIGNED_BODY);
    localStorage.removeItem(PROVIDER_SETTINGS);
    expect((await detectSignature(SIGNED_BODY, SENDER)).hasSignature).toBe(false);
    const log = expectNoMailInLog();
    expect(log).toContain('failed to strip signatures {"name":"Error"}');
    expect(log).toContain('failed to try the common selectors {"name":"Error"}');
  });
});

