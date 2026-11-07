import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CASA audit I-7: prepareAIProviderConfig is the main-process chokepoint every
 * background AI config passes through (the pipeline push, its restore from
 * disk, both categorizer starts). It refuses an address the shared transport
 * rule forbids — plain HTTP to another computer, or credentials in the URL —
 * before any saved key is looked up or bearer attached.
 *
 * What breaks if this file fails: main sends new mail (and the user's key or
 * Sarv bearer) to a provider over plain HTTP because the config came from an
 * older build, from disk or from a tampered renderer instead of the endpoint
 * field; or a local model server stops working.
 */

const h = vi.hoisted(() => ({
  resolveAiKey: vi.fn(),
  pinAiSecretOrigin: vi.fn(),
  attachOAuthBearer: vi.fn((c: Record<string, unknown>) => (c.authMethod === 'oauth' ? { ...c, resolveBearer: 'attached' } : c)),
  send: vi.fn(),
  window: 'open' as 'open' | 'none' | 'throws',
}));

vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/ai-secret-store', () => ({ resolveAiKey: h.resolveAiKey, pinAiSecretOrigin: h.pinAiSecretOrigin }));
vi.mock('../../../../electron/services/oauth-service', () => ({ attachOAuthBearer: h.attachOAuthBearer }));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => {
    if (h.window === 'none') return null;
    if (h.window === 'throws') return { webContents: { send: () => { throw new Error('Object has been destroyed'); } } };
    return { webContents: { send: h.send } };
  },
}));

import {
  AIEndpointRefusedError,
  isAIEndpointRefusedError,
  prepareAIProviderConfig,
  reportAIEndpointRefused,
} from '../../../../electron/services/ai-provider-config';

beforeEach(() => {
  h.resolveAiKey.mockReset().mockResolvedValue({ status: 'found', key: 'sk-1' });
  h.pinAiSecretOrigin.mockReset().mockResolvedValue(undefined);
  h.attachOAuthBearer.mockClear();
  h.send.mockReset();
  h.window = 'open';
});

describe('prepareAIProviderConfig — transport rule', () => {
  // THE finding. Breaks: a saved key or bearer is attached for, and mail sent
  // to, a provider on another computer over plain HTTP.
  it.each([
    ['a Custom provider', { type: 'custom', apiKey: '', providerId: 'p1', baseUrl: 'http://models.lan.example/v1' }],
    ['an OAuth (Sarv) provider', { type: 'sarv', apiKey: '', authMethod: 'oauth' as const, oauthProvider: 'sarv', oauthEmail: 'a@sarv.com', baseUrl: 'http://edge.sarv.com/edge/v1/llm' }],
    ['a lookalike of localhost', { type: 'custom', apiKey: 'typed', baseUrl: 'http://localhost.evil.example/v1' }],
    ['a lookalike of 127.0.0.1', { type: 'custom', apiKey: 'typed', baseUrl: 'http://127.0.0.1.nip.io/v1' }],
  ])('refuses plain HTTP to another computer for %s, before any key or bearer', async (_label, config) => {
    const error = await prepareAIProviderConfig(config).catch((e: unknown) => e);
    expect(isAIEndpointRefusedError(error)).toBe(true);
    expect(error).toMatchObject({ reason: 'insecure', message: expect.stringMatching(/^AI provider address must use HTTPS/) });
    expect(h.resolveAiKey).not.toHaveBeenCalled();
    expect(h.attachOAuthBearer).not.toHaveBeenCalled();
  });

  // CASA I-7 review. A key saved before keys were bound to an address can no
  // longer bind by use once its address is refused. Breaks: it stays unbound
  // and goes to the first other address named; or a pin failure (vault
  // unreadable) turns the refusal into a different error.
  it('pins the provider\'s saved key to the refused address, then refuses', async () => {
    const config = { type: 'custom', apiKey: '', providerId: 'p1', baseUrl: 'http://models.lan.example:8000/v1' };
    await expect(prepareAIProviderConfig(config)).rejects.toBeInstanceOf(AIEndpointRefusedError);
    expect(h.pinAiSecretOrigin).toHaveBeenCalledExactlyOnceWith('p1', 'http://models.lan.example:8000/v1');

    h.pinAiSecretOrigin.mockRejectedValueOnce(new Error('vault unreadable'));
    await expect(prepareAIProviderConfig(config)).rejects.toBeInstanceOf(AIEndpointRefusedError);
  });

  // Breaks: an OAuth config, or one without a saved-key id, touches the vault.
  it('pins nothing for an OAuth config or one with no provider id', async () => {
    await prepareAIProviderConfig({ type: 'sarv', apiKey: '', authMethod: 'oauth' as const, providerId: 'p1', oauthProvider: 'sarv', oauthEmail: 'a@sarv.com', baseUrl: 'http://edge.sarv.com/edge/v1/llm' }).catch(() => {});
    await prepareAIProviderConfig({ type: 'custom', apiKey: 'typed', baseUrl: 'http://models.lan.example/v1' }).catch(() => {});
    expect(h.pinAiSecretOrigin).not.toHaveBeenCalled();
  });

  // Breaks: a URL carrying a password (which would be sent with every request) is used.
  it('refuses an address with credentials in it', async () => {
    await expect(prepareAIProviderConfig({ type: 'custom', apiKey: 'typed', baseUrl: 'https://user:pw@models.example/v1' }))
      .rejects.toMatchObject({ name: 'AIEndpointRefusedError', reason: 'credentials' });
  });

  // Breaks: a garbage address reaches fetch instead of a clear refusal.
  it('refuses an address that is not a web address', async () => {
    await expect(prepareAIProviderConfig({ type: 'custom', apiKey: 'typed', baseUrl: 'ftp://models.example/v1' }))
      .rejects.toMatchObject({ reason: 'insecure' });
    await expect(prepareAIProviderConfig({ type: 'custom', apiKey: 'typed', baseUrl: 'not a url' }))
      .rejects.toMatchObject({ reason: 'invalid' });
  });

  // Idempotent re-run: a refusal is permanent for that address — the renderer's
  // self-heal re-push gets the same answer every time, never a pass.
  it('refuses the same address every time', async () => {
    const config = { type: 'custom', apiKey: '', baseUrl: 'http://10.0.0.5:11434/v1' };
    await expect(prepareAIProviderConfig(config)).rejects.toBeInstanceOf(AIEndpointRefusedError);
    await expect(prepareAIProviderConfig(config)).rejects.toBeInstanceOf(AIEndpointRefusedError);
  });

  // Breaks: local model servers (Ollama, LM Studio, the Sarv dev edge) stop working.
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080/v1',
  ])('accepts plain HTTP to this computer (%s)', async (baseUrl) => {
    await expect(prepareAIProviderConfig({ type: 'custom', apiKey: '', providerId: 'p1', baseUrl }))
      .resolves.toMatchObject({ apiKey: 'sk-1', baseUrl });
    expect(h.resolveAiKey).toHaveBeenCalledWith('p1', baseUrl);
  });

  // Breaks: HTTPS providers, or a type's default endpoint, get refused.
  it('accepts HTTPS and a type default', async () => {
    await expect(prepareAIProviderConfig({ type: 'custom', apiKey: 'typed', baseUrl: 'https://models.example/v1' }))
      .resolves.toMatchObject({ apiKey: 'typed' });
    await expect(prepareAIProviderConfig({ type: 'openai', apiKey: '', providerId: 'p1' })).resolves.toMatchObject({ apiKey: 'sk-1' });
    expect(h.resolveAiKey).toHaveBeenCalledWith('p1', 'https://api.openai.com/v1');
  });

  // Known boundary, deliberately not refused here: a config with no address at
  // all is left to the call sites (core and the standalone categorizer refuse
  // it before any request, never falling back to OpenAI).
  it('leaves a config with no address at all to the call sites', async () => {
    await expect(prepareAIProviderConfig({ type: 'custom', apiKey: '' })).resolves.toMatchObject({ type: 'custom' });
  });
});

describe('reportAIEndpointRefused', () => {
  const refusal = new AIEndpointRefusedError('insecure', 'AI provider address must use HTTPS. Plain HTTP is allowed only for a model server on this computer.');

  // Breaks: the renderer's Fix banner never hears why AI stopped, or a
  // retry-able (non-terminal) error makes it keep retrying an address.
  it('sends a terminal error with the reason on the categorization error channel', () => {
    reportAIEndpointRefused(refusal);
    expect(h.send).toHaveBeenCalledExactlyOnceWith('ai-categorization:error', {
      message: refusal.message, terminal: true, kind: 'client', reason: refusal.message,
    });
  });

  // Breaks: a refusal at launch (no window yet) or during shutdown throws in main.
  it.each(['none', 'throws'] as const)('does not throw when the window is %s', (state) => {
    h.window = state;
    expect(() => reportAIEndpointRefused(refusal)).not.toThrow();
  });
});
