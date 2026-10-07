import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AICategorizationService, type AIProviderConfig } from '../../../../electron/services/ai-categorization-service';
import { chromiumFetch } from '../../../../electron/services/net-fetch';

vi.mock('../../../../electron/shared', () => ({ getMainWindow: vi.fn(), requireStorage: vi.fn() }));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: vi.fn() }));

function transport(config: AIProviderConfig) {
  const service = new AICategorizationService() as unknown as {
    config: AIProviderConfig;
    callOpenAICompatibleAPI: (system: string, prompt: string) => Promise<string>;
  };
  service.config = config;
  return service;
}
const config = (fields: Partial<AIProviderConfig> = {}): AIProviderConfig => ({ type: 'custom', apiKey: '', model: 'local-model', baseUrl: 'http://localhost:11434/v1', ...fields });
beforeEach(() => { vi.clearAllMocks(); });

describe('main categorizer custom authentication', () => {
  // The fallback categorizer must honor the same custom no-auth choice as onboarding/pipeline.
  it('omits authorization for a configured no-auth custom service', async () => {
    vi.mocked(chromiumFetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }));
    expect(await transport(config()).callOpenAICompatibleAPI('synthetic system', 'synthetic prompt')).toBe('hello');
    expect(vi.mocked(chromiumFetch).mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
  });

  // Named-vendor keys and OAuth tokens stay mandatory rather than falling back to anonymous calls.
  it.each([config({ type: 'openai' }), config({ authMethod: 'oauth', resolveBearer: async () => '' })])('rejects missing credentials for authenticated configs', async (provider) => {
    await expect(transport(provider).callOpenAICompatibleAPI('synthetic system', 'synthetic prompt')).rejects.toThrow('empty bearer token');
    expect(chromiumFetch).not.toHaveBeenCalled();
  });
});

describe('main categorizer provider request fields', () => {
  // The fallback categorizer cannot send Sarv's vLLM extensions to OpenAI or a generic compatible server.
  it.each([
    { type: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', extras: {} },
    { type: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', extras: {} },
    { type: 'openai', model: 'o3', baseUrl: 'https://api.openai.com/v1', extras: {} },
    { type: 'custom', model: 'gpt-5', baseUrl: 'http://localhost:11434/v1', extras: {} },
    { type: 'sarv', model: 'gpt-oss-120b', baseUrl: 'https://synthetic.sarv.example/v1', extras: { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'minimal' } },
  ])('uses only supported fields for $type / $model', async ({ type, model, baseUrl, extras }) => {
    vi.mocked(chromiumFetch).mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }));
    const provider = config({ type: type as AIProviderConfig['type'], apiKey: 'synthetic-key', model, baseUrl });
    expect(await transport(provider).callOpenAICompatibleAPI('synthetic system', 'synthetic prompt')).toBe('hello');
    const [url, init] = vi.mocked(chromiumFetch).mock.calls[0];
    expect(url).toBe(`${baseUrl}/chat/completions`);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-key' });
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    const standardKeys = new Set(['model', 'messages', 'max_completion_tokens']);
    expect(Object.fromEntries(Object.entries(body).filter(([key]) => !standardKeys.has(key)))).toEqual(extras);
    expect(body).not.toHaveProperty('reasoning');
  });

  // An expired Sarv bearer refresh must keep the original endpoint and supported body on its retry.
  it('preserves Sarv options when refreshing its OAuth token', async () => {
    vi.mocked(chromiumFetch)
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }), { status: 200 }));
    const resolveBearer = vi.fn(async (forceRefresh?: boolean) => forceRefresh ? 'refreshed-token' : 'stale-token');
    const provider = config({ type: 'sarv', model: 'gpt-oss-120b', baseUrl: 'https://synthetic.sarv.example/v1', authMethod: 'oauth', resolveBearer });
    expect(await transport(provider).callOpenAICompatibleAPI('synthetic system', 'synthetic prompt')).toBe('hello');
    expect(resolveBearer.mock.calls).toEqual([[false], [true]]);
    const bodies = vi.mocked(chromiumFetch).mock.calls.map(([url, init]) => {
      expect(url).toBe('https://synthetic.sarv.example/v1/chat/completions');
      return JSON.parse(init?.body as string);
    });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'minimal' });
    expect(vi.mocked(chromiumFetch).mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer refreshed-token' });
  });
});
