// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testProvider } from '../../../../src/services/ai-service';
import { listCaiModels, listCaiProviders, listCaiZones } from '../../../../src/services/sarv-cai-api';

const fetchMock = vi.fn();
const sarvCatalog = vi.fn();
const proxyFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  window.electronAPI = {
    oauth: { sarvCatalog },
    aiProxy: { fetch: proxyFetch, abort: vi.fn() },
  } as unknown as typeof window.electronAPI;
  sarvCatalog.mockResolvedValue({ ok: true, body: [] });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('onboarding authenticated AI transport', () => {
  // Changed deliberately (CASA I-2): this used to assert the renderer's own
  // catalog fetch sent `Authorization: Bearer` with redirect:'error'. The
  // renderer no longer holds the Sarv token, so the catalog is fetched by main
  // (redirect:'error' + Bearer now pinned in core sarv-catalog.test.ts and
  // main's sarv-catalog-service.test.ts). Breaks if the renderer fetches the
  // catalog itself again, or sends main a URL to send the token to.
  it.each([listCaiModels, listCaiProviders, listCaiZones])('asks main for every Sarv catalog list, sending no request itself', async (list) => {
    await list('demo@sarv.example');
    expect(sarvCatalog).toHaveBeenCalledWith(expect.objectContaining({ email: 'demo@sarv.example' }));
    expect(JSON.stringify(sarvCatalog.mock.calls)).not.toMatch(/https?:|Bearer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Model tests carry vendor-specific key headers; none may be forwarded by redirects.
  it.each(['openai', 'gemini', 'sarv'] as const)('refuses redirects during %s model verification', async (type) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(type === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'Hello' }] } }] } : { choices: [{ message: { content: 'Hello' } }] }), { status: 200 }));
    await testProvider({ type, id: 'test', name: 'Test', apiKey: 'synthetic-test-key', model: 'demo-model', isDefault: false, baseUrl: 'https://models.example/v1' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('https://models.example/v1/'), expect.objectContaining({ redirect: 'error' }));
  });

  // THE I-2 regression for model verification: a Sarv sign-in's test goes
  // through main, which attaches the token; no renderer fetch ever carries it.
  it('verifies a Sarv sign-in model through main, never with a renderer-held bearer', async () => {
    proxyFetch.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', contentType: 'application/json', headers: {},
      body: JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }),
    });
    const result = await testProvider({
      type: 'sarv', id: 'sarv-1', name: 'Sarv', apiKey: '', model: 'demo-model', isDefault: false,
      baseUrl: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'demo@sarv.example',
    });
    expect(result).toEqual({ success: true, message: 'Connection successful!' });
    expect(fetchMock).not.toHaveBeenCalled();
    const [request] = proxyFetch.mock.calls[0];
    expect(request).toMatchObject({ url: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions', oauth: { provider: 'sarv', email: 'demo@sarv.example' } });
    expect(JSON.stringify(request.headers ?? {})).not.toMatch(/authorization/i);
  });
});
