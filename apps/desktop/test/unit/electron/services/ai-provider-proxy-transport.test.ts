import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CASA audit I-7, at main's AI proxy (the only path a SAVED key takes). The
 * renderer chooses the URL; main must refuse plain HTTP to another computer
 * before it even looks the key up, because aiEndpointOrigin — the proxy's
 * gate and the key binding's — now applies the shared transport rule.
 *
 * What breaks if this file fails: the user's saved OpenAI/Gemini/custom key is
 * sent unencrypted across a network, or a local model server stops working
 * with a saved key.
 */

const h = vi.hoisted(() => ({ resolveAiKey: vi.fn(), fetch: vi.fn() }));

vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/ai-secret-store', () => ({ resolveAiKey: h.resolveAiKey }));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: h.fetch }));

import { proxyAiProviderFetch } from '../../../../electron/services/ai-provider-proxy';

const request = (url: string) => ({
  requestId: 'r1', providerId: 'p1', type: 'custom', url, method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' }, body: '{}',
});

beforeEach(() => {
  h.resolveAiKey.mockReset().mockResolvedValue({ status: 'found', key: 'sk-1' });
  h.fetch.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('proxyAiProviderFetch — transport rule', () => {
  it.each([
    'http://models.lan.example/v1/chat/completions',
    'http://localhost.evil.example/v1/chat/completions',
    'http://127.0.0.1.nip.io/v1/chat/completions',
    'https://user:pw@models.example/v1/chat/completions',
  ])('refuses %s before looking up the key or sending anything', async (url) => {
    await expect(proxyAiProviderFetch(request(url))).resolves.toEqual({
      ok: false, reason: 'invalid-request', error: 'Invalid AI provider request.',
    });
    expect(h.resolveAiKey).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('still sends to a model server on this computer, with redirects refused', async () => {
    const url = 'http://localhost:11434/v1/chat/completions';
    await expect(proxyAiProviderFetch(request(url))).resolves.toMatchObject({ ok: true, status: 200 });
    expect(h.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
  });
});
