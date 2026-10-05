// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../../../src/services/ai-service';
import { listCaiModels, listCaiProviders, listCaiZones } from '../../../../src/services/sarv-cai-api';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  window.electronAPI = { oauth: { getAccessToken: vi.fn(async () => ({ success: true, data: { accessToken: 'synthetic-test-bearer' } })) } } as unknown as typeof window.electronAPI;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('onboarding authenticated AI transport', () => {
  // Sarv catalog redirects could transmit bearer credentials to an unintended endpoint.
  it.each([listCaiModels, listCaiProviders, listCaiZones])('refuses redirects on all Sarv catalog endpoints', async (list) => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));
    await list('https://cai.example', 'demo@sarv.example');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('https://cai.example/oauth/v1/'), expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-test-bearer' }) }));
  });

  // Model tests carry vendor-specific key headers; none may be forwarded by redirects.
  it.each(['openai', 'gemini', 'sarv'] as const)('refuses redirects during %s model verification', async (type) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(type === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] } : { choices: [{ message: { content: 'Hello' } }] }), { status: 200 }));
    await testProvider({ type, id: 'test', name: 'Test', apiKey: 'synthetic-test-key', model: 'demo-model', isDefault: false, baseUrl: 'https://models.example/v1' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('https://models.example/v1/'), expect.objectContaining({ redirect: 'error' }));
  });
});
