import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, makeAICompletion, testProvider, type AIProviderType } from '../../../../src/services/ai-service';

const fetchMock = vi.fn();
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('window', {
    electronAPI: {
      aiSecrets: { set: vi.fn().mockResolvedValue({ success: true }), delete: vi.fn() },
      // Changed deliberately (CASA I-2): no `oauth.getAccessToken` stub — the
      // renderer has no way to obtain a Sarv token any more.
      // A saved key never reaches the renderer: requests that need it go
      // through main, which adds the key header (Bearer, or x-goog-api-key for
      // Gemini) and makes the request. Stand-in for that proxy, so the
      // payload assertions below still see the request on the wire.
      aiProxy: {
        abort: vi.fn(),
        fetch: vi.fn(async (request: { url: string; method?: string; type: string; headers?: Record<string, string>; body?: string }) => {
          const auth = request.type === 'gemini' ? { 'x-goog-api-key': 'synthetic-key' } : { Authorization: 'Bearer synthetic-key' };
          const response = await fetchMock(request.url, { method: request.method, headers: { ...request.headers, ...auth }, body: request.body });
          return { ok: true, status: response.status, statusText: response.statusText, contentType: 'application/json', headers: {}, body: await response.text() };
        }),
      },
    },
  });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }), { status: 200 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('renderer AI provider request payloads', () => {
  // A successful onboarding test must send the same vendor-compatible options as real completions.
  it.each([
    { type: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', extras: {} },
    { type: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', extras: {} },
    { type: 'openai', model: 'o3', baseUrl: 'https://api.openai.com/v1', extras: {} },
    { type: 'custom', model: 'gpt-5', baseUrl: 'http://localhost:11434/v1', extras: {} },
    { type: 'sarv', model: 'gpt-oss-120b', baseUrl: 'https://synthetic.sarv.example/v1', extras: { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'minimal' } },
  ])('uses only supported fields for $type / $model', async ({ type, model, baseUrl, extras }) => {
    const provider = addProvider(type as AIProviderType, 'synthetic-key', model, { baseUrl });
    expect(await testProvider(provider)).toEqual({ success: true, message: 'Connection successful!' });
    expect(await makeAICompletion({ systemPrompt: 'Synthetic system', userPrompt: 'Synthetic message', maxTokens: 512, responseFormat: 'json_object' })).toBe('Hello');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`${baseUrl}/chat/completions`);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer synthetic-key' });
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const standardKeys = new Set(['model', 'messages', 'max_completion_tokens', 'response_format']);
      const actualExtras = Object.fromEntries(Object.entries(body).filter(([key]) => !standardKeys.has(key)));
      expect(actualExtras).toEqual(extras);
      expect(body).not.toHaveProperty('reasoning');
    }
    // Changed deliberately (CASA I-2): was `oauthToken` not called; an API-key
    // provider must never ask main to attach a Sarv sign-in either.
    for (const [request] of vi.mocked(window.electronAPI.aiProxy.fetch).mock.calls) expect(request).not.toHaveProperty('oauth');
    const completion = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(completion).toMatchObject({ model, max_completion_tokens: 512, response_format: { type: 'json_object' } });
  });

  // Selecting OpenAI must keep both verification and completion on OpenAI, even with a Sarv mailbox session.
  // Changed deliberately (CASA I-2): the renderer can no longer resolve a Sarv
  // token at all, so this now pins that neither request asks main to attach a
  // Sarv sign-in (`oauth`) — the only way a Sarv bearer could reach OpenAI.
  it('never asks main to attach a Sarv sign-in for an OpenAI API key', async () => {
    const provider = addProvider('openai', 'synthetic-key', 'gpt-4o');
    await testProvider(provider);
    await makeAICompletion({ systemPrompt: 'Synthetic system', userPrompt: 'Synthetic message' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ]);
    const proxied = vi.mocked(window.electronAPI.aiProxy.fetch).mock.calls.map(([request]) => request);
    expect(proxied).toHaveLength(2);
    for (const request of proxied) expect(request).not.toHaveProperty('oauth');
  });

  // THE I-2 regression on the completion path: a Sarv sign-in provider's
  // verification and completions go through main by account, and no renderer
  // request — direct or proxied — carries a Sarv bearer.
  it('sends Sarv sign-in requests through main with the account, never a token', async () => {
    const sarvProxy = vi.fn(async (request: { url: string; body?: string }) => {
      const response = await fetchMock(request.url, { method: 'POST', headers: { Authorization: 'Bearer minted-in-main' }, body: request.body });
      return { ok: true, status: response.status, statusText: '', contentType: 'application/json', headers: {}, body: await response.text() };
    });
    vi.mocked(window.electronAPI).aiProxy.fetch = sarvProxy as never;
    const provider = addProvider('sarv', '', 'gpt-oss-120b', {
      baseUrl: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'me@sarv.com',
    });
    expect(await testProvider(provider)).toEqual({ success: true, message: 'Connection successful!' });
    expect(await makeAICompletion({ systemPrompt: 'Synthetic system', userPrompt: 'Synthetic message' })).toBe('Hello');
    expect(sarvProxy).toHaveBeenCalledTimes(2);
    for (const [request] of sarvProxy.mock.calls) {
      expect(request).toMatchObject({ url: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions', oauth: { provider: 'sarv', email: 'me@sarv.com' } });
      expect(JSON.stringify(request)).not.toMatch(/Bearer|minted-in-main/);
    }
    expect(JSON.parse(sarvProxy.mock.calls[0][0].body!)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
  });
});
