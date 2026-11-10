import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, aiProviderFetch, hydrateAiSecrets, loadAISettings, removeProvider } from '../../../../src/services/ai-service';

// The renderer also renders untrusted email HTML, so it never holds a SAVED AI
// key (CASA H-1) or a Sarv access token (CASA I-2 — that token is also the Sarv
// mailbox's XOAUTH2 credential). A request that needs either goes through main;
// only a key the user is typing right now is used directly. What breaks if this
// file fails: saved keys or the Sarv token are read back into the renderer;
// requests that need them stop working; a cancelled request isn't cancelled in
// main; or the 429 back-off loses the server's retry-after.

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
      // Changed deliberately (CASA I-2): no `oauth.getAccessToken` — the
      // bridge no longer exists, so nothing here can hand the renderer a token.
      oauth: {},
    },
  };
  // Changed deliberately (CASA I-2): main's result now carries the forwarded
  // response headers (`headers`), so the default stand-in does too.
  proxyFetch.mockReset().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', contentType: 'application/json', headers: {}, body: '{"a":1}' });
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

describe('aiProviderFetch — Sarv sign-in requests go through main', () => {
  const sarv = { id: 's', type: 'sarv' as const, name: 'Sarv', apiKey: '', authMethod: 'oauth' as const, oauthProvider: 'sarv' as const, oauthEmail: 'a@sarv.com' };
  const EDGE = 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions';

  // Changed deliberately (CASA I-2): this replaces "uses a fresh Sarv OAuth
  // bearer for OAuth providers", which asserted the renderer's own fetch
  // carried `Authorization: Bearer sarv-token`. THE regression now: breaks if
  // the renderer fetches with a Sarv bearer again, or sends main a token.
  it('names the account to main and never sends a bearer itself', async () => {
    const res = await aiProviderFetch(sarv, EDGE, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const [request] = proxyFetch.mock.calls[0];
    expect(request).toMatchObject({ providerId: 's', type: 'sarv', url: EDGE, method: 'POST', body: '{}', oauth: { provider: 'sarv', email: 'a@sarv.com' } });
    // No token anywhere in what crosses to main (main strips the forged header).
    expect(JSON.stringify(request)).not.toContain('sarv-token');
  });

  // Breaks: the 429 back-off falls back to blind exponential waits because the
  // rebuilt Response lost the server's retry-after (and the request id).
  it('rebuilds the Response with the forwarded retry-after and x-request-id', async () => {
    proxyFetch.mockResolvedValueOnce({
      ok: true, status: 429, statusText: 'Too Many Requests', contentType: 'application/json',
      headers: { 'retry-after': '7', 'x-request-id': 'req-123' }, body: '{"error":"rate_limit_exceeded"}',
    });
    const res = await aiProviderFetch(sarv, EDGE, {});
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('x-request-id')).toBe('req-123');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  // Breaks: the renderer's sign-in-needed vs transient behaviour changes. Both
  // surface as a plain Error carrying main's message — exactly what the old
  // renderer-side token fetch threw — not as a network TypeError or an abort.
  it.each([
    ['sign-in-required', 'Token refresh failed (400): invalid_grant'],
    ['token-unavailable', 'Cannot reach OAuth server [ENOTFOUND] at https://oauth.sarv.com/api/oauth/token'],
    ['oauth-refused', 'Only a Sarv sign-in can authenticate AI requests, and only to Sarv AI — not https://evil.example.'],
  ])('reports %s as a plain Error with main\'s message', async (reason, error) => {
    proxyFetch.mockResolvedValueOnce({ ok: false, reason, error });
    const err = await aiProviderFetch(sarv, EDGE, {}).catch((e) => e);
    expect(err.constructor).toBe(Error);
    expect(err.message).toBe(error);
  });

  // Breaks: an OAuth provider missing its account is sent to main half-formed.
  it('refuses an OAuth provider with no account before asking main', async () => {
    await expect(aiProviderFetch({ ...sarv, oauthEmail: undefined }, EDGE, {})).rejects.toThrow('oauthProvider/oauthEmail missing');
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  // Breaks: a cancelled Sarv request keeps running (and spending) in main.
  it('forwards an abort to main for a Sarv request too', async () => {
    let settle!: (v: unknown) => void;
    proxyFetch.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const controller = new AbortController();
    const pending = aiProviderFetch(sarv, EDGE, { signal: controller.signal });
    controller.abort();
    expect(proxyAbort).toHaveBeenCalledWith(proxyFetch.mock.calls[0][0].requestId);
    settle({ ok: false, reason: 'aborted', error: 'cancelled' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
