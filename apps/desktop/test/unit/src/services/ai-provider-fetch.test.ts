import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, aiProviderFetch, hydrateAiSecrets, loadAISettings, removeProvider } from '../../../../src/services/ai-service';

// The renderer also renders untrusted email HTML, so it never holds a SAVED AI
// key (CASA H-1). A request that needs one goes through main; a key the user is
// typing right now, or a Sarv OAuth bearer, is used directly. What breaks if
// this file fails: saved keys are read back into the renderer; requests that
// need them stop working; or a cancelled request isn't cancelled in main.

const proxyFetch = vi.fn();
const proxyAbort = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).window = {
    electronAPI: {
      aiSecrets: { set: vi.fn(async () => ({ success: true, encrypted: true })), delete: vi.fn(), list: vi.fn(async () => ({ success: true, data: [] })) },
      aiProxy: { fetch: proxyFetch, abort: proxyAbort },
      oauth: { getAccessToken: vi.fn(async () => ({ success: true, data: { accessToken: 'sarv-token' } })) },
    },
  };
  proxyFetch.mockReset().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', contentType: 'application/json', body: '{"a":1}' });
  proxyAbort.mockReset();
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
});

const saved = { id: 'p1', type: 'openai' as const, name: 'OpenAI', apiKey: '', hasStoredKey: true };

describe('aiProviderFetch — saved keys go through main', () => {
  it('asks main to make the request by provider id, and returns a normal Response', async () => {
    const res = await aiProviderFetch(saved, 'https://api.openai.com/v1/models', { method: 'GET', headers: { Accept: 'application/json' } });
    expect(proxyFetch).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'p1', type: 'openai', url: 'https://api.openai.com/v1/models', method: 'GET', headers: { Accept: 'application/json' },
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    await expect(res.json()).resolves.toEqual({ a: 1 });
  });

  // Breaks: callers' 4xx/5xx handling (auth classification, retries) stops working.
  it('passes HTTP error statuses through, including null-body ones', async () => {
    proxyFetch.mockResolvedValueOnce({ ok: true, status: 401, statusText: 'Unauthorized', contentType: null, body: 'no' });
    expect((await aiProviderFetch(saved, 'https://api.openai.com/v1/x', {})).status).toBe(401);
    proxyFetch.mockResolvedValueOnce({ ok: true, status: 204, statusText: '', contentType: null, body: '' });
    expect((await aiProviderFetch(saved, 'https://api.openai.com/v1/x', {})).status).toBe(204);
  });

  // Breaks: callers' retry-on-network-error and abort handling misfire.
  it('mirrors fetch failure shapes: network → TypeError, aborted → AbortError, refusals → Error', async () => {
    proxyFetch.mockResolvedValueOnce({ ok: false, reason: 'network', error: 'fetch failed' });
    await expect(aiProviderFetch(saved, 'https://api.openai.com/v1/x', {})).rejects.toBeInstanceOf(TypeError);
    proxyFetch.mockResolvedValueOnce({ ok: false, reason: 'aborted', error: 'cancelled' });
    await expect(aiProviderFetch(saved, 'https://api.openai.com/v1/x', {})).rejects.toMatchObject({ name: 'AbortError' });
    proxyFetch.mockResolvedValueOnce({ ok: false, reason: 'origin-mismatch', error: 'Your saved API key is for https://a. Re-enter your API key to use https://b.' });
    await expect(aiProviderFetch(saved, 'https://b/v1/x', {})).rejects.toThrow('Re-enter your API key');
  });

  // Breaks: a cancelled request (timeout, user navigated away) keeps running in main.
  it('forwards an abort to main, and refuses to start when already aborted', async () => {
    let settle!: (v: unknown) => void;
    proxyFetch.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const controller = new AbortController();
    const pending = aiProviderFetch(saved, 'https://api.openai.com/v1/x', { signal: controller.signal });
    controller.abort();
    const requestId = proxyFetch.mock.calls[0][0].requestId;
    expect(proxyAbort).toHaveBeenCalledWith(requestId);
    settle({ ok: false, reason: 'aborted', error: 'cancelled' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(aiProviderFetch(saved, 'https://api.openai.com/v1/x', { signal: controller.signal })).rejects.toBeTruthy();
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });
});

describe('aiProviderFetch — direct requests', () => {
  // A key being typed (onboarding / Settings test) isn't saved yet: the renderer has it.
  it('sends a typed key directly, Bearer or x-goog-api-key by type, never via main', async () => {
    await aiProviderFetch({ ...saved, apiKey: 'typed', hasStoredKey: false }, 'https://api.openai.com/v1/x', { headers: { A: '1' } });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { A: '1', Authorization: 'Bearer typed' } });
    await aiProviderFetch({ ...saved, type: 'gemini', apiKey: 'g-typed', hasStoredKey: false }, 'https://generativelanguage.googleapis.com/v1beta/x', {});
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ 'x-goog-api-key': 'g-typed' });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('uses a fresh Sarv OAuth bearer for OAuth providers', async () => {
    await aiProviderFetch({ id: 's', type: 'sarv', name: 'Sarv', apiKey: '', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'a@sarv.com' }, 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/x', {});
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer sarv-token' });
  });

  // Keyless Custom services are supported; any other keyless provider is a clear error.
  it('sends no auth for a keyless Custom service and refuses a keyless OpenAI one', async () => {
    await aiProviderFetch({ id: 'c', type: 'custom', name: 'Local', apiKey: '' }, 'http://localhost:8080/v1/x', {});
    expect(fetchMock.mock.calls[0][1].headers).toEqual({});
    await expect(aiProviderFetch({ id: 'o', type: 'openai', name: 'OpenAI', apiKey: '' }, 'https://api.openai.com/v1/x', {})).rejects.toThrow(/missing/);
  });
});

describe('saved-key bookkeeping', () => {
  // Breaks: a saved key comes back into the renderer, or is stored unbound.
  it('saves a typed key to the vault bound to its endpoint, and keeps only a flag', () => {
    const provider = addProvider('openai', 'sk-typed', 'gpt');
    expect((globalThis as any).window.electronAPI.aiSecrets.set).toHaveBeenCalledWith(provider.id, 'sk-typed', 'https://api.openai.com/v1');
    expect(provider).toMatchObject({ apiKey: '', hasStoredKey: true });
    expect(loadAISettings().providers[0]).toMatchObject({ apiKey: '', hasStoredKey: true });
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('sk-typed');
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('hasStoredKey');
    removeProvider(provider.id);
    expect((globalThis as any).window.electronAPI.aiSecrets.delete).toHaveBeenCalledWith(provider.id);
  });

  // Startup: learns which providers have keys; migrates legacy plaintext keys.
  it('hydrates key presence from main and migrates a legacy plaintext key, bound', async () => {
    localStorage.setItem('sarvinbox-ai-settings', JSON.stringify({ providers: [
      { id: 'legacy', type: 'gemini', name: 'G', apiKey: 'old-plain', model: 'm', isDefault: true },
      { id: 'vaulted', type: 'openai', name: 'O', apiKey: '', model: 'm', isDefault: false },
    ] }));
    (globalThis as any).window.electronAPI.aiSecrets.list.mockResolvedValue({ success: true, data: ['vaulted'], encrypted: true });
    await hydrateAiSecrets();
    expect((globalThis as any).window.electronAPI.aiSecrets.set).toHaveBeenCalledWith('legacy', 'old-plain', 'https://generativelanguage.googleapis.com/v1beta');
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('old-plain');
    expect(loadAISettings().providers.map((p) => [p.id, p.hasStoredKey, p.apiKey])).toEqual([['legacy', true, ''], ['vaulted', true, '']]);
  });
});
