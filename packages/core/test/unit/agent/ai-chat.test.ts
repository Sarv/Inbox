import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callAIChat, callAIChatWithRetry, type AIChatMessage, type AIToolDefinition } from '../../../src/agent/ai-chat';
import type { AIProviderConfig } from '../../../src/agent/categorization-utils';
import { MAX_MESSAGE_BYTES } from '../../../src/utils/json-size';

// The multi-turn tool-calling transport an agent loop runs on. A regression here
// does not crash: the model silently stops seeing its earlier tool results, a
// tool call is dropped, or a reasoning model's empty reply becomes an empty
// answer. Every case goes through the injectable `fetchImpl`; no socket opens.

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const config = (over: Partial<AIProviderConfig> = {}): AIProviderConfig => ({
  type: 'openai', apiKey: 'key-123', model: 'gpt-test', baseUrl: 'https://api.example/v1', ...over,
});

const TOOLS: AIToolDefinition[] = [{
  name: 'search_mail', description: 'Search mail',
  parameters: { type: 'object', additionalProperties: false, properties: {
    query: { type: 'string' },
    filters: { type: 'object', additionalProperties: false, properties: { unread: { type: 'boolean' } } },
  } },
}];

const CONVERSATION: AIChatMessage[] = [
  { role: 'system', content: 'SYSTEM' },
  { role: 'user', content: 'How many unread?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-a', name: 'search_mail', arguments: '{"query":"x"}' }] },
  { role: 'tool', toolCallId: 'call-a', name: 'search_mail', content: 'Total: 3' },
];

const body = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fetchImpl.mock.calls[call]![1]!.body as string);

describe('callAIChat — OpenAI-compatible tool calls', () => {
  // Breaks: the model never sees its own earlier calls or their results, so it repeats them forever.
  it('sends the whole conversation, the tools and the output budget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] }));
    await callAIChat(config({ fetchImpl }), { messages: CONVERSATION, tools: TOOLS, maxOutputTokens: 3_000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example/v1/chat/completions');
    expect(init.redirect).toBe('error');
    const sent = body(fetchImpl);
    expect(sent.model).toBe('gpt-test');
    expect(sent.max_completion_tokens).toBe(3_000);
    expect(sent.tool_choice).toBe('auto');
    expect(sent.tools).toEqual([{ type: 'function', function: { name: 'search_mail', description: 'Search mail', parameters: TOOLS[0]!.parameters } }]);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'How many unread?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'search_mail', arguments: '{"query":"x"}' } }] },
      { role: 'tool', tool_call_id: 'call-a', content: 'Total: 3' },
    ]);
  });

  // Breaks: a provider that refuses unknown fields rejects every plain call with a 400.
  it('leaves tools out entirely when there are none', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    await callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'hi' }] });
    expect(Object.keys(body(fetchImpl)).sort()).toEqual(['max_completion_tokens', 'messages', 'model']);
  });

  // Breaks: Sarv loses its reasoning settings on agent calls and burns the budget thinking.
  it('applies the provider-specific request options', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    await callAIChat(config({ type: 'sarv', baseUrl: 'http://localhost:8880/edge/v1/llm', fetchImpl }), { messages: [{ role: 'user', content: 'hi' }] });
    expect(body(fetchImpl).reasoning_effort).toBe('minimal');
  });

  // Breaks: gpt-6-luna refuses every tool request on Chat Completions with reasoning on.
  it('turns reasoning off only when asked, and lets a provider pin win', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'x' } }] }));
    await callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, reasoningEffort: 'none' });
    await callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    await callAIChat(config({ type: 'sarv', baseUrl: 'http://localhost:8880/edge/v1/llm', fetchImpl }), { messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'none' });
    expect(body(fetchImpl, 0).reasoning_effort).toBe('none');
    expect(body(fetchImpl, 1)).not.toHaveProperty('reasoning_effort');
    expect(body(fetchImpl, 2).reasoning_effort).toBe('minimal');
  });

  // Breaks: a tool call is dropped or its arguments mangled, so the agent acts on nothing.
  it('reads tool calls, tolerating object arguments and missing ids, and skips nameless ones', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_mail', arguments: '{"query":"a"}' } },
      { type: 'function', function: { name: 'count_mail', arguments: { unread: true } } },
      { id: 'c3', type: 'function', function: { arguments: '{}' } },
      { id: 'c4', type: 'function', function: { name: 'list_folders' } },
    ] } }] }));
    const result = await callAIChat(config({ fetchImpl }), { messages: CONVERSATION, tools: TOOLS });
    expect(result).toEqual({ text: '', finishReason: 'tool_calls', toolCalls: [
      { id: 'c1', name: 'search_mail', arguments: '{"query":"a"}' },
      { id: 'call-2', name: 'count_mail', arguments: '{"unread":true}' },
      { id: 'c4', name: 'list_folders', arguments: '{}' },
    ] });
  });

  // Breaks: an empty reasoning reply is mistaken for a finished answer.
  it.each([
    ['length', 'length'], ['stop', 'stop'], [undefined, 'stop'], ['content_filter', 'other'],
  ])('maps finish reason %s to %s', async (reason, expected) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: ' text ' }, finish_reason: reason }] }));
    const result = await callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.finishReason).toBe(expected);
    expect(result.text).toBe('text');
  });

  // Breaks: a malformed body crashes the loop instead of reading as an empty reply.
  it('reads a reply with no choices as empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    expect(await callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'hi' }] }))
      .toEqual({ text: '', toolCalls: [], finishReason: 'stop' });
  });

  // Breaks: an expired OAuth token fails the agent run instead of refreshing once.
  it('refreshes an OAuth bearer once on a 401, through the shared transport', async () => {
    const resolveBearer = vi.fn(async (force?: boolean) => force ? 'fresh' : 'stale');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'expired' } }, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const result = await callAIChat(config({ fetchImpl, resolveBearer }), { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('ok');
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });

  // Breaks: an oversized conversation is stringified and ends the app (see MAX_MESSAGE_BYTES).
  it('refuses a conversation over the size limit before any request', async () => {
    const fetchImpl = vi.fn();
    const huge = 'x'.repeat(MAX_MESSAGE_BYTES);
    await expect(callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'a' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'n', arguments: huge }] }] })).rejects.toMatchObject({ status: 413 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Breaks: Stop does not stop; a cancelled run still sends mail text to the provider.
  it('sends nothing once the signal is aborted', async () => {
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(callAIChat(config({ fetchImpl }), { messages: [{ role: 'user', content: 'a' }] }, controller.signal)).rejects.toThrow('stopped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('callAIChat — Gemini tool calls', () => {
  const gemini = (fetchImpl: ReturnType<typeof vi.fn>) => config({ type: 'gemini', baseUrl: undefined, model: 'gemini-2.5-flash', fetchImpl });

  // Breaks: Gemini rejects the schema, refuses two user turns in a row, or never
  // sees the results of its own calls.
  it('encodes the system prompt, turns, tools and grouped tool results', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
    await callAIChat(gemini(fetchImpl), { messages: [
      ...CONVERSATION.slice(0, 2),
      { role: 'assistant', content: 'Looking.', toolCalls: [
        { id: 'gemini-call-1', name: 'search_mail', arguments: '{"query":"x"}' },
        { id: 'provider-id', name: 'count_mail', arguments: 'not json' },
      ] },
      { role: 'tool', toolCallId: 'gemini-call-1', name: 'search_mail', content: 'Total: 3' },
      { role: 'tool', toolCallId: 'provider-id', name: 'count_mail', content: 'Unread: 2' },
      { role: 'user', content: 'and starred?' },
    ], tools: TOOLS, maxOutputTokens: 2_000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(init.redirect).toBe('error');
    const sent = body(fetchImpl);
    expect(sent.systemInstruction).toEqual({ parts: [{ text: 'SYSTEM' }] });
    expect(sent.generationConfig.maxOutputTokens).toBe(2_000);
    expect(sent.tools[0].functionDeclarations[0].parameters).toEqual({ type: 'object', properties: {
      query: { type: 'string' }, filters: { type: 'object', properties: { unread: { type: 'boolean' } } },
    } });
    expect(sent.contents).toEqual([
      { role: 'user', parts: [{ text: 'How many unread?' }] },
      { role: 'model', parts: [{ text: 'Looking.' },
        { functionCall: { name: 'search_mail', args: { query: 'x' } } },
        { functionCall: { name: 'count_mail', args: {}, id: 'provider-id' } }] },
      // Turns alternate: a note after tool results joins the same user turn.
      { role: 'user', parts: [
        { functionResponse: { name: 'search_mail', response: { content: 'Total: 3' } } },
        { functionResponse: { name: 'count_mail', response: { content: 'Unread: 2' }, id: 'provider-id' } },
        { text: 'and starred?' },
      ] },
    ]);
  });

  // Breaks: Gemini 3 refuses the next turn because the thought signature was dropped.
  it('echoes the provider parts of an earlier turn unchanged', async () => {
    const parts = [{ functionCall: { name: 'search_mail', args: {} }, thoughtSignature: 'sig' }];
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await callAIChat(gemini(fetchImpl), { messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'gemini-call-1', name: 'search_mail', arguments: '{}' }], providerParts: parts },
      { role: 'tool', toolCallId: 'gemini-call-1', name: 'search_mail', content: 'r' },
    ] });
    expect(body(fetchImpl).contents[1]).toEqual({ role: 'model', parts });
  });

  // Breaks: thinking text leaks into the answer, or a call / truncation goes unseen.
  it('reads calls, skips thought parts and reports truncation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: 'private thinking', thought: true },
      { text: 'Checking ' }, { text: 'now' },
      { functionCall: { name: 'search_mail', args: { query: 'x' } } },
      { functionCall: { name: 'count_mail', id: 'g-7' } },
      { functionCall: { args: {} } },
    ] } }] }));
    const result = await callAIChat(gemini(fetchImpl), { messages: [{ role: 'user', content: 'q' }], tools: TOOLS });
    expect(result.text).toBe('Checking now');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'gemini-call-1', name: 'search_mail', arguments: '{"query":"x"}' },
      { id: 'g-7', name: 'count_mail', arguments: '{}' },
    ]);
    expect(result.providerParts).toHaveLength(6);

    const truncated = vi.fn(async () => jsonResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }));
    expect((await callAIChat(gemini(truncated), { messages: [{ role: 'user', content: 'q' }] })).finishReason).toBe('length');
    const blocked = vi.fn(async () => jsonResponse({ candidates: [{ finishReason: 'SAFETY' }] }));
    expect(await callAIChat(gemini(blocked), { messages: [{ role: 'user', content: 'q' }] })).toEqual({ text: '', toolCalls: [], finishReason: 'other' });
  });

  // Breaks: a Gemini call can hang the agent forever (the single-prompt path has no timeout).
  it('times out a request that never answers', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));
      const pending = callAIChat(gemini(fetchImpl), { messages: [{ role: 'user', content: 'q' }], timeoutMs: 1_000 });
      const assertion = expect(pending).rejects.toMatchObject({ code: 'AI_REQUEST_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});

describe('callAIChatWithRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const drainBackoff = async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(10_000); };

  // Breaks: a reasoning model that spent the whole budget thinking (gpt-6-luna, all
  // 1000 tokens on reasoning) returns a blank answer instead of trying again.
  it('retries once with twice the budget when the budget ran out on reasoning', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }));
    const result = await callAIChatWithRetry(config({ fetchImpl }), { messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 1_000 });
    expect(result.text).toBe('answer');
    expect(body(fetchImpl, 0).max_completion_tokens).toBe(1_000);
    expect(body(fetchImpl, 1).max_completion_tokens).toBe(2_000);
  });

  // Breaks: a truncated but usable reply, or one already at the ceiling, costs a second paid call.
  it.each([
    ['text came back', { content: 'partial' }, 1_000],
    ['the budget is already the ceiling', { content: '' }, 16_000],
  ])('does not retry when %s', async (_case, message, maxOutputTokens) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message, finish_reason: 'length' }] }));
    await callAIChatWithRetry(config({ fetchImpl }), { messages: [{ role: 'user', content: 'q' }], maxOutputTokens });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Breaks: a rate limit or gateway blip fails the whole agent run.
  it('retries a transient failure and returns the recovery', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const pending = callAIChatWithRetry(config({ fetchImpl }), { messages: [{ role: 'user', content: 'q' }] });
    await drainBackoff();
    expect((await pending).text).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Breaks: a bad key or a provider that refuses tools is retried, burning time and money.
  it('does not retry a permanent failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'tools not supported' } }, { status: 400 }));
    const pending = callAIChatWithRetry(config({ fetchImpl }), { messages: [{ role: 'user', content: 'q' }], tools: TOOLS });
    const assertion = expect(pending).rejects.toMatchObject({ status: 400 });
    await drainBackoff();
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
