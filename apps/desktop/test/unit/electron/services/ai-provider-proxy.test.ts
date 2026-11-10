import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Requests that need a SAVED AI key are made by main: the renderer (which also
 * renders untrusted email HTML) names the provider and the URL, and main
 * attaches the key — only for the origin it was saved for. What breaks if this
 * file fails: a saved key is sent to a renderer-chosen server, a renderer-set
 * Authorization header overrides main's, the key rides a redirect elsewhere,
 * or AI requests that use a saved key stop working at all.
 */

const h = vi.hoisted(() => ({
  resolveAiKey: vi.fn(),
  fetch: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/ai-secret-store', () => ({ resolveAiKey: h.resolveAiKey }));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: h.fetch }));

import { abortAiProviderFetch, proxyAiProviderFetch } from '../../../../electron/services/ai-provider-proxy';

const URL_OK = 'https://api.openai.com/v1/chat/completions';
const request = (over: Record<string, unknown> = {}) => ({
  requestId: 'r1', providerId: 'p1', type: 'openai', url: URL_OK, method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' }, body: '{"x":1}', ...over,
});

beforeEach(() => {
  h.resolveAiKey.mockReset().mockResolvedValue({ status: 'found', key: 'sk-1' });
  h.fetch.mockReset().mockResolvedValue(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
});

describe('proxyAiProviderFetch', () => {
  // Breaks: AI features that use a saved key stop working.
  it('attaches the saved key for its own origin and returns the response', async () => {
    const res = await proxyAiProviderFetch(request());
    expect(h.resolveAiKey).toHaveBeenCalledWith('p1', URL_OK);
    // Changed deliberately (CASA I-2): the result now also carries the
    // forwarded response headers (none here).
    expect(res).toEqual({ ok: true, status: 200, statusText: '', contentType: 'application/json', headers: {}, body: '{"ok":true}' });
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe(URL_OK);
    expect(init).toMatchObject({ method: 'POST', body: '{"x":1}', redirect: 'error' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-1' });
  });

  // Breaks: the Gemini key goes in the wrong header (or the URL).
  it('uses x-goog-api-key for Gemini', async () => {
    await proxyAiProviderFetch(request({ type: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models/m:generateContent' }));
    expect(h.fetch.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json', 'x-goog-api-key': 'sk-1' });
  });

  // Breaks: a renderer-supplied credential header survives or replaces main's.
  it('drops credential headers the renderer tries to set', async () => {
    await proxyAiProviderFetch(request({ headers: { Authorization: 'Bearer fake', 'X-Goog-Api-Key': 'g', Cookie: 'c', Accept: 'application/json' } }));
    expect(h.fetch.mock.calls[0][1].headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer sk-1' });
  });

  // THE leak: the key is saved for another endpoint.
  it('refuses a mismatched origin with a re-enter message, without any request', async () => {
    h.resolveAiKey.mockResolvedValue({ status: 'origin-mismatch', boundOrigin: 'https://api.openai.com' });
    const res = await proxyAiProviderFetch(request({ url: 'https://evil.example/v1/chat/completions' }));
    expect(res).toEqual({
      ok: false, reason: 'origin-mismatch',
      error: 'Your saved API key is for https://api.openai.com. Re-enter your API key to use https://evil.example.',
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports no saved key without any request', async () => {
    h.resolveAiKey.mockResolvedValue({ status: 'none' });
    expect(await proxyAiProviderFetch(request())).toMatchObject({ ok: false, reason: 'no-key' });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  // Breaks: a non-HTTP URL, an unsupported method or a missing id reaches the vault.
  it.each([
    [{ url: 'file:///etc/passwd' }],
    [{ url: 'not a url' }],
    [{ method: 'DELETE' }],
    [{ providerId: '' }],
    [{ requestId: '' }],
  ])('rejects an invalid request %j before touching the vault', async (over) => {
    expect(await proxyAiProviderFetch(request(over))).toMatchObject({ ok: false, reason: 'invalid-request' });
    expect(h.resolveAiKey).not.toHaveBeenCalled();
  });

  // Breaks: the renderer's 429 back-off falls back to blind exponential waits
  // because retry-after (and the provider's request id) never left main.
  it('forwards retry-after and x-request-id, and only those', async () => {
    h.fetch.mockResolvedValue(new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '12', 'x-request-id': 'req-9', 'set-cookie': 'a=b', server: 'x' },
    }));
    const res = await proxyAiProviderFetch(request());
    expect(res).toEqual({
      ok: true, status: 429, statusText: '', contentType: 'application/json',
      headers: { 'retry-after': '12', 'x-request-id': 'req-9' }, body: '{}',
    });
  });

  // Breaks: a saved-key request is sent with a Sarv sign-in, or a request that
  // names no provider for its saved key reaches the vault.
  it('needs a provider id for a saved-key request', async () => {
    expect(await proxyAiProviderFetch(request({ providerId: '' }))).toMatchObject({ reason: 'invalid-request' });
    expect(h.resolveAiKey).not.toHaveBeenCalled();
  });

  it('sends no body with GET', async () => {
    await proxyAiProviderFetch(request({ method: 'GET', url: 'https://api.openai.com/v1/models' }));
    expect(h.fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', body: undefined });
  });

  // Transient: the renderer's retry logic must see a fetch-style failure.
  // Breaks: a fetch error quoting renderer text (an invalid header value with
  // a CR/LF in it) is written to app.log as separate, forged lines.
  it('logs a failed request on one line, whatever the error quotes', async () => {
    h.fetch.mockRejectedValueOnce(new TypeError('Headers.append: "v\r\n[2026-10-12T10:00:00.000Z] [INFO] [main] forged" is an invalid header value.'));
    await proxyAiProviderFetch(request());
    const line = String(h.warn.mock.calls.at(-1)?.[0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain('v\\r\\n[2026-10-12T10:00:00.000Z]');
  });

  it('reports a network failure as such', async () => {
    h.fetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await proxyAiProviderFetch(request())).toEqual({ ok: false, reason: 'network', error: 'fetch failed' });
  });

  // Breaks: a cancelled request keeps running (and spending) in main.
  it('aborts an in-flight request when the renderer gives up', async () => {
    h.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = proxyAiProviderFetch(request({ requestId: 'r-abort' }));
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalled());
    abortAiProviderFetch('r-abort');
    expect(await pending).toEqual({ ok: false, reason: 'aborted', error: 'The AI request was cancelled.' });
    abortAiProviderFetch('r-abort'); // settled: a later abort is a no-op
  });
});
