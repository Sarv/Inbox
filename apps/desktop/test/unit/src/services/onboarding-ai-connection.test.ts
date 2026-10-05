// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addValidatedProvider, loadAISettings, testProvider, type AIProvider } from '../../../../src/services/ai-service';
import { checkAIConnection, loadSarvAIConnection, makeAIConnection, normalizeAIEndpoint } from '../../../../src/services/onboarding-ai-connection';
import { listCaiModels, listCaiProviders, loadZoneSelection } from '../../../../src/services/sarv-cai-api';

vi.mock('../../../../src/services/sarv-cai-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/services/sarv-cai-api')>();
  return { ...actual, listCaiModels: vi.fn(), listCaiProviders: vi.fn(), loadZoneSelection: vi.fn() };
});

const fetchMock = vi.fn();
const vaultSet = vi.fn(async () => ({ success: true, encrypted: true }));
const vaultDelete = vi.fn(async () => ({ success: true }));
const providers = vi.fn();
const accounts = vi.fn();
const testProviderDraft: AIProvider = {
  id: 'test', type: 'openai', name: 'OpenAI', apiKey: 'synthetic-key', model: 'gpt-test',
  baseUrl: 'https://api.example/v1', authMethod: 'apiKey', isDefault: false,
};
const signal = () => new AbortController().signal;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('fetch', fetchMock);
  vaultSet.mockResolvedValue({ success: true, encrypted: true });
  window.electronAPI = { aiSecrets: { set: vaultSet, delete: vaultDelete }, oauth: { listProviders: providers, listAccounts: accounts } } as unknown as typeof window.electronAPI;
  providers.mockResolvedValue({ success: true, data: [{ id: 'sarv', apiBaseUrl: 'https://cai.example', llmBaseUrl: 'https://edge.example/edge/v1/llm', configured: true }] });
  accounts.mockResolvedValue({ success: true, data: [{ provider: 'sarv', email: 'first@example.com' }, { provider: 'sarv', email: 'selected@example.com' }] });
  vi.mocked(loadZoneSelection).mockResolvedValue({ zones: [], zoneCode: '' });
  vi.mocked(listCaiProviders).mockResolvedValue([{ code: 'sarv_partners', name: 'Sarv Partners' }]);
  vi.mocked(listCaiModels).mockResolvedValue([{ code: 'gpt-oss-120b', display_name: 'Inbox model', provider_code: 'sarv_partners' }]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AI configuration catalogs', () => {
  // Unencrypted remote endpoints and URL-embedded secrets must not receive keys.
  it.each(['http://remote.example/v1', 'https://name:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'file:///models', 'not-a-url'])(
    'rejects unsafe endpoint %s before any request', (endpoint) => {
      expect(() => normalizeAIEndpoint(endpoint)).toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  // Local model servers are valid without dropping HTTPS for remote hosts.
  it.each(['http://localhost:11434/v1/', 'http://127.0.0.1:11434/v1/', 'http://[::1]:11434/v1/', 'https://example.com/v1/'])(
    'accepts supported endpoint %s', (endpoint) => expect(normalizeAIEndpoint(endpoint)).toBe(endpoint.replace(/\/$/, '')),
  );

  // Listing models validates a key without spending a generation request.
  it('filters OpenAI models for chat and keeps a valid selected model', async () => {
    fetchMock.mockResolvedValue(json({ data: [{ id: 'embedding-test' }, { id: 'gpt-test' }, { id: 'gpt-audio' }, { id: 'gpt-test' }] }));
    const connection = await checkAIConnection({ ...makeAIConnection('openai'), apiKey: 'synthetic-key', model: 'gpt-test' }, signal());
    expect(connection.models).toEqual([{ id: 'gpt-test', name: 'gpt-test' }]);
    expect(connection.model).toBe('gpt-test');
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer synthetic-key' }, redirect: 'error' }));
    expect(vaultSet).not.toHaveBeenCalled();
    expect(loadAISettings().providers).toEqual([]);
  });

  // Gemini pagination and generation-method filtering prevent unavailable IDs.
  it('loads paginated Gemini generation models with key in header', async () => {
    fetchMock.mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-chat', displayName: 'Chat', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page two' }));
    fetchMock.mockResolvedValueOnce(json({ models: [{ name: 'models/gemini-next', supportedGenerationMethods: ['generateContent'] }] }));
    const checked = await checkAIConnection({ ...makeAIConnection('gemini'), apiKey: 'synthetic-key' }, signal());
    expect(checked.models).toEqual([{ id: 'gemini-chat', name: 'Chat' }, { id: 'gemini-next', name: 'models/gemini-next' }]);
    expect(fetchMock.mock.calls[1][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageToken=page%20two');
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('synthetic-key');
    expect(fetchMock.mock.calls[0][0]).not.toContain('synthetic-key');
  });

  // Only a genuinely unsupported custom catalog may ask for manual model ID.
  it('allows custom servers without auth or a catalog, still requiring a model test', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }));
    const checked = await checkAIConnection({ ...makeAIConnection('custom'), baseUrl: 'http://localhost:11434/v1', name: 'Local model', useApiKey: false }, signal());
    expect(checked).toMatchObject({ verified: true, manualModel: true, models: [], model: '' });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  // Auth, rate-limit, server and connection failures can never become success.
  it.each([401, 403, 429, 500])('rejects HTTP %s instead of falling back to manual IDs', async (status) => {
    fetchMock.mockResolvedValue(json({ error: 'synthetic-key must never be rendered' }, status));
    await expect(checkAIConnection({ ...makeAIConnection('custom'), name: 'Custom', baseUrl: 'https://custom.example/v1', apiKey: 'synthetic-key' }, signal())).rejects.not.toThrow('synthetic-key');
  });

  // Invalid catalog data must stay a failure; no defaults are invented.
  it.each([{ data: [] }, { unexpected: true }])('rejects empty or malformed catalogs', async (body) => {
    fetchMock.mockResolvedValue(json(body));
    await expect(checkAIConnection({ ...makeAIConnection('openai'), apiKey: 'synthetic-key' }, signal())).rejects.toThrow();
  });

  // Missing keys and provider names fail before sending a network request.
  it('validates required configuration fields', async () => {
    await expect(checkAIConnection(makeAIConnection('openai'), signal())).rejects.toThrow('API key');
    await expect(checkAIConnection({ ...makeAIConnection('custom'), name: '', baseUrl: 'https://example.com/v1', useApiKey: false }, signal())).rejects.toThrow('name');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A canceled connection cannot validate even when fetch resolves late.
  it('rejects stale catalog success after cancellation', async () => {
    const abort = new AbortController();
    fetchMock.mockImplementation(async () => { abort.abort(); return json({ data: [{ id: 'gpt-test' }] }); });
    await expect(checkAIConnection({ ...makeAIConnection('openai'), apiKey: 'synthetic-key' }, abort.signal)).rejects.toThrow();
  });

  // Sarv wallet-only users have no org/zone, but must still see available models.
  it('reuses the selected native Sarv identity without requiring a zone', async () => {
    const connection = await loadSarvAIConnection(makeAIConnection('sarv'), signal(), { email: 'selected@example.com' });
    expect(connection).toMatchObject({ verified: true, model: 'gpt-oss-120b', sarv: { email: 'selected@example.com', zoneCode: '' } });
    expect(listCaiProviders).toHaveBeenCalledWith('https://cai.example', 'selected@example.com', '');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vaultSet).not.toHaveBeenCalled();
  });

  // Identity/catalog failures remain visible and never silently activate AI.
  it('handles missing Sarv session and missing models honestly', async () => {
    accounts.mockResolvedValueOnce({ success: true, data: [] });
    await expect(loadSarvAIConnection(makeAIConnection('sarv'), signal())).rejects.toThrow('Sign in');
    vi.mocked(listCaiModels).mockResolvedValueOnce([]);
    await expect(loadSarvAIConnection(makeAIConnection('sarv'), signal())).rejects.toThrow('No models');
    expect(loadAISettings().providers).toEqual([]);
  });

  // Malformed response text may contain echoed credentials; errors stay generic.
  it('rejects malformed catalog JSON without echoing its body', async () => {
    fetchMock.mockResolvedValue(new Response('synthetic-key'));
    await expect(checkAIConnection({ ...makeAIConnection('openai'), apiKey: 'synthetic-key' }, signal())).rejects.toThrow('invalid model catalog');
    fetchMock.mockResolvedValue(json(null));
    await expect(checkAIConnection({ ...makeAIConnection('gemini'), apiKey: 'synthetic-key' }, signal())).rejects.toThrow('invalid model catalog');
  });

  // Giant or malformed catalogs must fail explicitly instead of truncating invisibly.
  it('rejects invalid and excessively paginated Gemini catalogs', async () => {
    fetchMock.mockResolvedValueOnce(json({ unexpected: true }));
    await expect(checkAIConnection({ ...makeAIConnection('gemini'), apiKey: 'synthetic-key' }, signal())).rejects.toThrow('invalid');
    fetchMock.mockImplementation(async () => json({ models: [{ supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'repeat' }));
    await expect(checkAIConnection({ ...makeAIConnection('gemini'), apiKey: 'synthetic-key' }, signal())).rejects.toThrow('too large');
  });

  // Native errors/missing service configuration cannot be misreported as an AI connection.
  it('requires a configured Sarv catalog and preserves the exact requested identity', async () => {
    providers.mockResolvedValueOnce({ success: false });
    await expect(loadSarvAIConnection(makeAIConnection('sarv'), signal())).rejects.toThrow('Could not check');
    providers.mockResolvedValueOnce({ success: true, data: [{ id: 'sarv' }] });
    await expect(loadSarvAIConnection(makeAIConnection('sarv'), signal())).rejects.toThrow('unavailable');
    await expect(loadSarvAIConnection(makeAIConnection('sarv'), signal(), { email: 'missing@example.com' })).rejects.toThrow('Sign in');
    vi.mocked(listCaiProviders).mockResolvedValueOnce([]);
    await expect(loadSarvAIConnection(makeAIConnection('sarv'), signal())).rejects.toThrow('No AI backends');
  });

  // Region/account/backend choices must scope models while preserving a still-valid selection.
  it('reuses an existing Sarv catalog selection and refreshes its region', async () => {
    const first = await loadSarvAIConnection(makeAIConnection('sarv'), signal());
    first.sarv!.zoneCode = 'region';
    vi.mocked(loadZoneSelection).mockResolvedValue({ zones: [{ code: 'region', api_domain: 'https://region.example' }], zoneCode: 'region' });
    const second = await loadSarvAIConnection(first, signal());
    expect(second.model).toBe(first.model);
    expect(listCaiProviders).toHaveBeenLastCalledWith('https://cai.example', 'first@example.com', 'region');
    expect(second.sarv?.providerCode).toBe('sarv_partners');
  });
});

describe('tested provider persistence', () => {
  // The vault must succeed before the provider can become active/default.
  it('awaits the vault and never writes the key to localStorage', async () => {
    let resolve!: (value: { success: boolean; encrypted: boolean }) => void;
    vaultSet.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    const saving = addValidatedProvider(draft, () => true);
    expect(loadAISettings().providers).toEqual([]);
    resolve({ success: true, encrypted: true });
    const saved = await saving;
    expect(saved?.isDefault).toBe(true);
    expect(loadAISettings().providers[0].apiKey).toBe('synthetic-key');
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('synthetic-key');
  });

  // Save failure must keep settings unchanged and a retry can succeed.
  it('does not register a provider when the vault rejects its write', async () => {
    vaultSet.mockResolvedValueOnce({ success: false, encrypted: true });
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    await expect(addValidatedProvider(draft, () => true)).rejects.toThrow('securely');
    expect(loadAISettings().providers).toEqual([]);
    expect(await addValidatedProvider(draft, () => true)).toMatchObject({ type: 'openai', isDefault: true });
  });

  // Skip while the vault writes must delete the orphan key, without metadata.
  it('discards an interrupted secure save before registration', async () => {
    let current = true;
    vaultSet.mockImplementationOnce(async () => { current = false; return { success: true, encrypted: true }; });
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    expect(await addValidatedProvider(draft, () => current)).toBeNull();
    expect(vaultDelete).toHaveBeenCalledOnce();
    expect(loadAISettings().providers).toEqual([]);
  });

  // Retesting the same tuple must preserve identity instead of accumulating duplicates.
  it('is idempotent and switches the chosen default', async () => {
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    const first = await addValidatedProvider(draft, () => true);
    const second = await addValidatedProvider(draft, () => true);
    expect(first?.id).toBe(second?.id);
    expect(loadAISettings().providers).toHaveLength(1);
    expect(vaultSet).toHaveBeenCalledOnce();
    await addValidatedProvider({ ...draft, model: 'second-model' }, () => true);
    expect(loadAISettings().providers.filter((provider) => provider.isDefault).map((provider) => provider.model)).toEqual(['second-model']);
  });

  // HTTP provider errors may echo tokens; the test UI must never echo their bodies.
  it('sanitizes a failed model test and passes cancellation to fetch', async () => {
    fetchMock.mockResolvedValue(json({ message: 'synthetic-key' }, 403));
    const abort = new AbortController();
    const result = await testProvider(testProviderDraft, { signal: abort.signal });
    expect(result).toEqual({ success: false, message: 'Authentication failed — your API key may be invalid or expired.' });
    expect(fetchMock.mock.calls[0][1].signal).toBe(abort.signal);
  });

  // A Gemini key must not enter URL logging/history, even for a synthetic test.
  it('sends Gemini model test credentials only in the request header', async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }));
    await expect(testProvider({ ...testProviderDraft, type: 'gemini', model: 'gemini-test' }, { signal: signal() })).resolves.toMatchObject({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/v1/models/gemini-test:generateContent');
    expect(fetchMock.mock.calls[0][1].headers['x-goog-api-key']).toBe('synthetic-key');
  });

  // Stale operations must not write a vault key or flip an existing default.
  it('rejects a save already cancelled before it began', async () => {
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    expect(await addValidatedProvider(draft, () => false)).toBeNull();
    expect(vaultSet).not.toHaveBeenCalled();
    expect(loadAISettings().providers).toEqual([]);
  });

  // Vault IPC may reject rather than return success:false; neither can leak its error body.
  it('sanitizes a rejected vault call', async () => {
    vaultSet.mockRejectedValueOnce(new Error('synthetic-key'));
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    await expect(addValidatedProvider(draft, () => true)).rejects.toThrow('Could not save your API key securely');
    expect(loadAISettings().providers).toEqual([]);
  });

  // A blocked metadata store cannot report a saved provider and leaves no orphan key.
  it('removes a newly stored key when metadata cannot be persisted', async () => {
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota exceeded'); } });
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    await expect(addValidatedProvider(draft, () => true)).rejects.toThrow('Could not save AI settings');
    expect(vaultDelete).toHaveBeenCalledOnce();
    expect(loadAISettings().providers).toEqual([]);
  });

  // OAuth registration stores only account metadata; bearer tokens are never persisted as keys.
  it('stores an OAuth provider without touching the API-key vault', async () => {
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    await addValidatedProvider({ ...draft, type: 'sarv', apiKey: '', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'demo@example.com' }, () => true);
    expect(vaultSet).not.toHaveBeenCalled();
    expect(loadAISettings().providers[0]).toMatchObject({ oauthEmail: 'demo@example.com', isDefault: true, apiKey: '' });
  });

  // A 200 with no usable model output is not proof a requested model works.
  it.each(['openai', 'gemini'] as const)('rejects empty %s model replies', async (type) => {
    fetchMock.mockResolvedValue(json(type === 'gemini' ? { candidates: [] } : { choices: [] }));
    expect(await testProvider({ ...testProviderDraft, type })).toMatchObject({ success: false, message: expect.stringContaining('usable response') });
  });

  // Synthetic model tests use real response structure and support no-auth local APIs.
  it('accepts a valid OpenAI-compatible reply without sending an empty bearer header', async () => {
    fetchMock.mockResolvedValue(json({ choices: [{ message: { content: 'Hello' } }] }));
    expect(await testProvider({ ...testProviderDraft, type: 'custom', apiKey: '' })).toMatchObject({ success: true });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  // Network errors and cancellation cannot reveal internal errors or become successes.
  it('reports failed and cancelled requests safely', async () => {
    fetchMock.mockRejectedValueOnce(new Error('synthetic-key'));
    expect(await testProvider(testProviderDraft)).toMatchObject({ success: false, message: 'Could not reach the AI provider. Check your connection and try again.' });
    const abort = new AbortController(); abort.abort();
    expect(await testProvider(testProviderDraft, { signal: abort.signal })).toMatchObject({ success: false, message: expect.stringContaining('cancelled') });
  });

  // Linux keyring fallback must be visible to onboarding without storing a key in renderer metadata.
  it('returns an unencrypted-storage warning only when reported by the native vault', async () => {
    vaultSet.mockResolvedValueOnce({ success: true, encrypted: false });
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    expect(await addValidatedProvider(draft, () => true)).toMatchObject({ keyStorageEncrypted: false });
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('synthetic-key');
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('keyStorageEncrypted');
    expect(await addValidatedProvider(draft, () => true)).toMatchObject({ keyStorageEncrypted: false });
  });
});
