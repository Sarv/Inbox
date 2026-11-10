import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAICompletion, providerBaseUrl, testProvider, type AIProvider } from '../../../../src/services/ai-service';

// CASA audit I-7, renderer side. A keyless Custom request or a just-typed key
// goes straight from the renderer to the provider's address, a Sarv request is
// sent by main with the bearer main attaches (CASA I-2), and saved providers
// come back from localStorage without passing the endpoint field's check.
// providerBaseUrl holds every such request to the shared transport rule before
// anything leaves the renderer. What breaks if this file fails: a provider
// saved by an older build (or a tampered localStorage) sends the user's mail,
// or has main send the Sarv bearer, over plain HTTP to another computer.

const AI_SETTINGS_KEY = 'sarvinbox-ai-settings';
const fetchMock = vi.fn();
const proxyFetch = vi.fn();
let store: Map<string, string>;

const sarv = (baseUrl: string): AIProvider => ({
  id: 'sarv-1', type: 'sarv', name: 'Sarv AI', apiKey: '', model: 'sarv-model', baseUrl, isDefault: true,
  authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'me@sarv.com',
});
const keylessCustom = (baseUrl: string): AIProvider => ({
  id: 'local-1', type: 'custom', name: 'My server', apiKey: '', model: 'm', baseUrl, isDefault: true, authMethod: 'apiKey',
});
const chat = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).window = {
    electronAPI: {
      aiSecrets: { set: vi.fn(), delete: vi.fn(), list: vi.fn(async () => ({ success: true, data: [] })) },
      aiProxy: { fetch: proxyFetch, abort: vi.fn() },
    },
  };
  proxyFetch.mockReset().mockResolvedValue({
    ok: true, status: 200, statusText: 'OK', contentType: 'application/json', headers: {},
    body: JSON.stringify({ choices: [{ message: { content: 'Hello' } }] }),
  });
  fetchMock.mockReset().mockImplementation(async () => chat());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
});

describe('providerBaseUrl', () => {
  // Breaks: a plain-HTTP or credential-carrying address passes, or a valid one is refused.
  it('applies the shared transport rule to the address a request goes to', () => {
    expect(providerBaseUrl({ type: 'custom', baseUrl: 'http://localhost:11434/v1' })).toBe('http://localhost:11434/v1');
    expect(providerBaseUrl({ type: 'openai' })).toBe('https://api.openai.com/v1');
    expect(() => providerBaseUrl({ type: 'custom', baseUrl: 'http://models.lan.example/v1' })).toThrow(/^AI provider address must use HTTPS/);
    expect(() => providerBaseUrl({ type: 'custom', baseUrl: 'http://localhost.evil.example/v1' })).toThrow(/must use HTTPS/);
    expect(() => providerBaseUrl({ type: 'custom', baseUrl: 'https://u:p@models.example/v1' })).toThrow(/username or password/);
  });

  // Breaks: a Custom provider with no address fetches the relative URL
  // "/chat/completions" against the app's own origin.
  it('refuses a provider with no address and no type default', () => {
    expect(() => providerBaseUrl({ type: 'custom', baseUrl: '' })).toThrow(/missing/);
  });
});

describe('testProvider', () => {
  // THE renderer path: a saved Sarv provider on plain HTTP to another computer.
  // Breaks: the Sarv bearer is minted and sent unencrypted.
  it('refuses a plain-HTTP Sarv provider before asking main for a bearer or sending anything', async () => {
    const result = await testProvider(sarv('http://edge.sarv.com/edge/v1/llm'));
    expect(result).toEqual({ success: false, message: expect.stringMatching(/^AI provider address must use HTTPS/) });
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Breaks: a keyless Custom test request goes over plain HTTP to another computer.
  it('refuses a plain-HTTP keyless Custom provider on another computer', async () => {
    await expect(testProvider(keylessCustom('http://10.0.0.5:11434/v1'))).resolves.toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Breaks: local model servers can no longer be tested.
  it('tests a model server on this computer over plain HTTP', async () => {
    await expect(testProvider(keylessCustom('http://localhost:11434/v1'))).resolves.toEqual({ success: true, message: 'Connection successful!' });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/v1/chat/completions', expect.objectContaining({ redirect: 'error' }));
  });
});

describe('makeAICompletion with a saved provider', () => {
  const saveDefault = (provider: AIProvider) => store.set(AI_SETTINGS_KEY, JSON.stringify({ providers: [provider] }));

  // Breaks: a provider saved by an older build sends mail (and the bearer) over plain HTTP.
  it.each([
    ['Sarv', sarv('http://edge.sarv.com/edge/v1/llm')],
    ['keyless Custom', keylessCustom('http://models.lan.example/v1')],
    ['Gemini', { id: 'g', type: 'gemini', name: 'Gemini', apiKey: 'typed', model: 'gm', baseUrl: 'http://gemini.example/v1beta', isDefault: true } as AIProvider],
  ])('refuses a saved %s provider on plain HTTP to another computer', async (_label, provider) => {
    saveDefault(provider);
    await expect(makeAICompletion({ systemPrompt: 's', userPrompt: 'mail text' })).rejects.toThrow(/^AI provider address must use HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  // Breaks: a saved HTTPS provider stops working. Sarv goes through main,
  // naming the account; the renderer sends nothing itself.
  it('sends to a saved HTTPS provider', async () => {
    saveDefault(sarv('https://jpr1-ai-edge.sarv.com/edge/v1/llm'));
    await expect(makeAICompletion({ systemPrompt: 's', userPrompt: 'mail text' })).resolves.toBe('Hello');
    expect(proxyFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions',
      oauth: { provider: 'sarv', email: 'me@sarv.com' },
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
