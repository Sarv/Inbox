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
