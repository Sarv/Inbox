import { describe, expect, it, vi } from 'vitest';

import { callAIProvider, type AIProviderConfig } from '../../../src/agent/categorization-utils';
import { buildAIAuthHeaders } from '../../../src/utils/ai-provider-auth';

describe('onboarding custom AI authentication', () => {
  // Custom no-auth is deliberate; empty OAuth or named-vendor keys are failures.
  it('omits authorization only for custom providers without OAuth', () => {
    expect(buildAIAuthHeaders({ type: 'custom' }, '')).toEqual({});
    expect(buildAIAuthHeaders({ type: 'custom' }, undefined)).toEqual({});
    expect(buildAIAuthHeaders({ type: 'custom' }, null)).toEqual({});
    expect(buildAIAuthHeaders({ type: 'openai' }, 'key')).toEqual({ Authorization: 'Bearer key' });
    expect(buildAIAuthHeaders({ type: 'custom' }, ' key ')).toEqual({ Authorization: 'Bearer key' });
    expect(() => buildAIAuthHeaders({ type: 'sarv' }, '')).toThrow('empty bearer token');
    expect(() => buildAIAuthHeaders({ type: 'custom', authMethod: 'oauth' }, '')).toThrow('empty bearer token');
    expect(() => buildAIAuthHeaders({ type: 'custom', resolveBearer: async () => '' }, '')).toThrow('empty bearer token');
    expect(() => buildAIAuthHeaders({ type: 'custom' }, 42)).toThrow('empty bearer token');
    expect(() => buildAIAuthHeaders({ type: 'custom' }, '   ')).toThrow('empty bearer token');
  });

  // A no-auth model selected during onboarding must work in the actual pipeline.
  it('calls a custom local model without an illegal empty bearer header', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'synthetic result' } }] }), { status: 200 }));
    const config: AIProviderConfig = { type: 'custom', apiKey: '', model: 'local-model', baseUrl: 'http://localhost:11434/v1', fetchImpl };
    expect(await callAIProvider(config, 'synthetic system', 'synthetic prompt')).toBe('synthetic result');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  // OAuth refresh returning an empty token must never silently become unauthenticated.
  it('rejects an empty resolved OAuth token even on a custom endpoint', async () => {
    const fetchImpl = vi.fn();
    const config: AIProviderConfig = { type: 'custom', apiKey: '', model: 'local-model', baseUrl: 'https://custom.example/v1', fetchImpl, resolveBearer: async () => '' };
    await expect(callAIProvider(config, 'synthetic system', 'synthetic prompt')).rejects.toThrow('empty bearer token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
