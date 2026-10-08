import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, makeAICompletion, testProvider, type AIProviderType } from '../../../../src/services/ai-service';

const fetchMock = vi.fn();
const oauthToken = vi.fn();
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
      oauth: { getAccessToken: oauthToken },
      // A saved key never reaches the renderer: requests that need it go
      // through main, which adds the key header (Bearer, or x-goog-api-key for
      // Gemini) and makes the request. Stand-in for that proxy, so the
      // payload assertions below still see the request on the wire.
      aiProxy: {
        abort: vi.fn(),
        fetch: vi.fn(async (request: { url: string; method?: string; type: string; headers?: Record<string, string>; body?: string }) => {
          const auth = request.type === 'gemini' ? { 'x-goog-api-key': 'synthetic-key' } : { Authorization: 'Bearer synthetic-key' };
          const response = await fetchMock(request.url, { method: request.method, headers: { ...request.headers, ...auth }, body: request.body });
          return { ok: true, status: response.status, statusText: response.statusText, contentType: 'application/json', body: await response.text() };
        }),
      },
    },
  });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  oauthToken.mockReset();
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
    expect(oauthToken).not.toHaveBeenCalled();
    const completion = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(completion).toMatchObject({ model, max_completion_tokens: 512, response_format: { type: 'json_object' } });
  });

  // Selecting OpenAI must keep both verification and completion on OpenAI, even with a Sarv mailbox session.
  it('never resolves a Sarv OAuth token for an OpenAI API key', async () => {
    oauthToken.mockRejectedValue(new Error('Unexpected Sarv OAuth request'));
    const provider = addProvider('openai', 'synthetic-key', 'gpt-4o');
    await testProvider(provider);
    await makeAICompletion({ systemPrompt: 'Synthetic system', userPrompt: 'Synthetic message' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ]);
    expect(oauthToken).not.toHaveBeenCalled();
  });
});
