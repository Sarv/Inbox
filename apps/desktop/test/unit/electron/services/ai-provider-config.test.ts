import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Main's own AI calls (pipeline, categorizers) get their config from the
 * renderer, which no longer holds saved keys: it names the key by providerId.
 * What breaks if this file fails: background categorization runs with no key
 * after the update; or a renderer-supplied baseUrl gets the saved key filled
 * in, sending it to someone else's server.
 */

const h = vi.hoisted(() => ({ resolveAiKey: vi.fn() }));

vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/ai-secret-store', () => ({ resolveAiKey: h.resolveAiKey }));
vi.mock('../../../../electron/services/oauth-service', () => ({
  attachOAuthBearer: (c: Record<string, unknown>) => (c.authMethod === 'oauth' ? { ...c, resolveBearer: 'attached' } : c),
}));

import { prepareAIProviderConfig } from '../../../../electron/services/ai-provider-config';

beforeEach(() => {
  h.resolveAiKey.mockReset().mockResolvedValue({ status: 'found', key: 'sk-1' });
});

describe('prepareAIProviderConfig', () => {
  // Breaks: background AI stops working for API-key providers.
  it('fills in the saved key for the endpoint the request will use', async () => {
    const out = await prepareAIProviderConfig({ type: 'openai', apiKey: '', providerId: 'p1', model: 'm' });
    // No baseUrl → the type's default endpoint, exactly as the categorizer calls it.
    expect(h.resolveAiKey).toHaveBeenCalledWith('p1', 'https://api.openai.com/v1');
    expect(out).toMatchObject({ apiKey: 'sk-1', providerId: 'p1' });
  });

  // THE leak through main's own calls.
  it('leaves the key out when the endpoint is not the one it was saved for', async () => {
    h.resolveAiKey.mockResolvedValue({ status: 'origin-mismatch', boundOrigin: 'https://api.openai.com' });
    const out = await prepareAIProviderConfig({ type: 'custom', apiKey: '', providerId: 'p1', baseUrl: 'https://evil.example/v1' });
    expect(h.resolveAiKey).toHaveBeenCalledWith('p1', 'https://evil.example/v1');
    expect(out.apiKey).toBe('');
  });

  // A locked keychain is transient: no crash, just no key this time.
  it('survives an unreadable vault', async () => {
    h.resolveAiKey.mockRejectedValue(new Error('keychain locked'));
    expect((await prepareAIProviderConfig({ type: 'openai', apiKey: '', providerId: 'p1' })).apiKey).toBe('');
  });

  // Breaks: a key the user just typed is replaced, or OAuth configs hit the vault.
  it('passes typed keys and OAuth configs through without a vault lookup', async () => {
    expect(await prepareAIProviderConfig({ type: 'openai', apiKey: 'typed', providerId: 'p1' })).toMatchObject({ apiKey: 'typed' });
    expect(await prepareAIProviderConfig({ type: 'sarv', apiKey: '', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'a@sarv.com' }))
      .toMatchObject({ resolveBearer: 'attached' });
    expect(await prepareAIProviderConfig({ type: 'openai', apiKey: '' })).toMatchObject({ apiKey: '' });
    expect(h.resolveAiKey).not.toHaveBeenCalled();
  });
});
