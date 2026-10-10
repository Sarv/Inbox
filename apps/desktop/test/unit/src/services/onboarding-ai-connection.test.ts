// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addValidatedProvider, loadAISettings, testProvider, type AIProvider } from '../../../../src/services/ai-service';
import { checkAIConnection, loadSarvAIConnection, makeAIConnection, normalizeAIEndpoint, providerFromConnection } from '../../../../src/services/onboarding-ai-connection';
import { listCaiModels, listCaiProviders, loadZoneSelection } from '../../../../src/services/sarv-cai-api';

vi.mock('../../../../src/services/sarv-cai-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/services/sarv-cai-api')>();
  return { ...actual, listCaiModels: vi.fn(), listCaiProviders: vi.fn(), loadZoneSelection: vi.fn() };
});

const fetchMock = vi.fn();
const vaultSet = vi.fn(async (): Promise<{ success: boolean; encrypted: boolean; writeId?: number }> => ({ success: true, encrypted: true }));
const vaultDelete = vi.fn(async () => ({ success: true }));
// Main undoes a write by its id (the renderer never holds the old key).
const vaultRevert = vi.fn(async () => ({ success: true }));
let nextWriteId = 0;
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
  vaultSet.mockImplementation(async () => ({ success: true, encrypted: true, writeId: ++nextWriteId }));
  vaultRevert.mockResolvedValue({ success: true });
  window.electronAPI = { aiSecrets: { set: vaultSet, delete: vaultDelete, revert: vaultRevert }, oauth: { listProviders: providers, listAccounts: accounts } } as unknown as typeof window.electronAPI;
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

describe('resuming with a saved key', () => {
  // The renderer never holds a saved key (CASA H-1). Breaks: resuming setup
  // demands the key again, or the saved key is pulled into the renderer.
  const resumed = () => ({ ...makeAIConnection('openai'), useApiKey: true, apiKey: '', storedProviderId: 'p-saved' });

  it('lists models through main with the saved key, sending nothing directly', async () => {
    const proxyFetch = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-test' }] }) }));
    (window.electronAPI as any).aiProxy = { fetch: proxyFetch, abort: vi.fn() };
    const checked = await checkAIConnection(resumed(), new AbortController().signal);
    expect(checked.models).toEqual([{ id: 'gpt-test', name: 'gpt-test' }]);
    expect(proxyFetch).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p-saved', method: 'GET', url: 'https://api.openai.com/v1/models' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tests and saves as the saved provider when the key field is left blank', () => {
    expect(providerFromConnection({ ...resumed(), model: 'gpt-test' })).toMatchObject({ id: 'p-saved', apiKey: '', hasStoredKey: true });
    // A newly typed key wins over the saved one.
    expect(providerFromConnection({ ...resumed(), apiKey: 'typed', model: 'gpt-test' })).toMatchObject({ id: 'onboarding-test', apiKey: 'typed' });
  });

  it('still asks for a key when there is no saved one', async () => {
    await expect(checkAIConnection({ ...resumed(), storedProviderId: undefined }, new AbortController().signal)).rejects.toThrow('Enter your API key.');
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
    // Changed deliberately (CASA H-1): once saved, the key lives only in the
    // main-process vault — the renderer keeps a "has a saved key" flag, not the key.
    expect(loadAISettings().providers[0]).toMatchObject({ apiKey: '', hasStoredKey: true });
    expect(saved?.apiKey).toBe('synthetic-key'); // the draft the user just typed
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
    // Changed deliberately: the renderer can't compare a typed key with the
    // saved one (it never reads it back), so a retest re-saves it under the
    // SAME id — still one provider, never a duplicate.
    expect(vaultSet).toHaveBeenCalledTimes(2);
    expect(vaultSet.mock.calls.map((call) => (call as unknown[])[0])).toEqual([first?.id, first?.id]);
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
    // Every save reports the vault's real state (a retest saves again).
    vaultSet.mockResolvedValue({ success: true, encrypted: false });
    const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
    expect(await addValidatedProvider(draft, () => true)).toMatchObject({ keyStorageEncrypted: false });
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('synthetic-key');
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('keyStorageEncrypted');
    expect(await addValidatedProvider(draft, () => true)).toMatchObject({ keyStorageEncrypted: false });
  });
});

describe('validated provider additions and edits in settings', () => {
  const draft = { ...testProviderDraft, id: undefined, isDefault: undefined } as unknown as Omit<AIProvider, 'id' | 'isDefault'>;

  // The settings Add action is a new identity even when connection/model values coincide.
  it('creates a distinct same-configuration entry without replacing the existing default', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const second = await addValidatedProvider(draft, () => true, { createNew: true, makeDefault: false });
    expect(second?.id).not.toBe(first?.id);
    expect(second?.isDefault).toBe(false);
    expect(loadAISettings().providers).toHaveLength(2);
    expect(loadAISettings().providers.find((provider) => provider.isDefault)?.id).toBe(first?.id);
  });

  // First added settings provider still needs a usable default for the application's provider resolver.
  it('makes the first settings provider default and retains that identity through edits', async () => {
    const first = await addValidatedProvider(draft, () => true, { createNew: true, makeDefault: false });
    expect(first?.isDefault).toBe(true);
    const changed = await addValidatedProvider({ ...draft, apiKey: 'edited-secret', model: 'edited-model' }, () => true, { existingId: first!.id, makeDefault: false });
    expect(changed).toMatchObject({ id: first!.id, isDefault: true, model: 'edited-model' });
    expect(loadAISettings().providers).toHaveLength(1);
    // Saved bound to the endpoint it was entered for.
    expect(vaultSet).toHaveBeenLastCalledWith(first!.id, 'edited-secret', 'https://api.example/v1');
    expect(localStorage.getItem('sarvinbox-ai-settings')).not.toContain('edited-secret');
  });

  // Editing a non-default entry must preserve the user's existing default and independent configuration.
  it('updates only the explicitly selected non-default entry', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const second = await addValidatedProvider({ ...draft, model: 'other-model' }, () => true, { createNew: true, makeDefault: false });
    const changed = await addValidatedProvider({ ...draft, model: 'changed-model' }, () => true, { existingId: second!.id, makeDefault: false });
    expect(changed).toMatchObject({ id: second!.id, isDefault: false });
    expect(loadAISettings().providers.find((provider) => provider.isDefault)?.id).toBe(first!.id);
    expect(loadAISettings().providers[0].model).toBe('gpt-test');
  });

  // A deleted selected entry cannot silently turn into an unrelated new provider.
  it('rejects an edit whose selected identity no longer exists', async () => {
    await expect(addValidatedProvider(draft, () => true, { existingId: 'deleted', makeDefault: false })).rejects.toThrow('was removed');
    expect(vaultSet).not.toHaveBeenCalled();
    expect(loadAISettings().providers).toHaveLength(0);
  });

  // A cancelled edit must restore the old shared key rather than deleting an existing provider's secret.
  it('restores an edited key when the save becomes stale before publication', async () => {
    const first = await addValidatedProvider(draft, () => true);
    let current = true;
    vaultSet.mockImplementationOnce(async () => { current = false; return { success: true, encrypted: true, writeId: 41 }; });
    expect(await addValidatedProvider({ ...draft, apiKey: 'replacement-key' }, () => current, { existingId: first!.id, makeDefault: false })).toBeNull();
    // Changed with the key moving to main: main reverts exactly the write that
    // was cancelled (the renderer never held the old key to re-set it).
    expect(vaultRevert).toHaveBeenCalledWith(first!.id, 41);
    expect(vaultDelete).not.toHaveBeenCalled();
    expect(loadAISettings().providers[0]).toMatchObject({ apiKey: '', hasStoredKey: true });
  });

  // Metadata failure must roll an existing secret back and leave its saved model/default untouched.
  it('restores an existing key if edited metadata cannot be persisted', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota exceeded'); } });
    await expect(addValidatedProvider({ ...draft, apiKey: 'replacement-key', model: 'changed-model' }, () => true, { existingId: first!.id, makeDefault: false })).rejects.toThrow('Could not save AI settings');
    const replacementWrite = (await vaultSet.mock.results.at(-1)!.value) as { writeId: number };
    expect(vaultRevert).toHaveBeenCalledWith(first!.id, replacementWrite.writeId);
    expect(loadAISettings().providers[0]).toMatchObject({ hasStoredKey: true, model: 'gpt-test', isDefault: true });
  });

  // Switching an explicitly edited local service to no authentication removes the obsolete key before publication.
  it('removes a saved key when an edit no longer needs authentication', async () => {
    const first = await addValidatedProvider(draft, () => true);
    await addValidatedProvider({ ...draft, type: 'custom', apiKey: '', model: 'local-model' }, () => true, { existingId: first!.id, makeDefault: false });
    expect(vaultDelete).toHaveBeenCalledWith(first!.id);
    expect(loadAISettings().providers[0]).toMatchObject({ apiKey: '', type: 'custom', model: 'local-model' });
  });

  // Failed key removal cannot publish an unauthenticated edit that left its secret state inconsistent.
  it('keeps old settings if removing the existing key fails', async () => {
    const first = await addValidatedProvider(draft, () => true);
    vaultDelete.mockRejectedValueOnce(new Error('unavailable'));
    await expect(addValidatedProvider({ ...draft, apiKey: '' }, () => true, { existingId: first!.id, makeDefault: false })).rejects.toThrow('securely');
    expect(loadAISettings().providers[0]).toMatchObject({ hasStoredKey: true });
  });
});

describe('validated save interruption and rollback failures', () => {
  const { id: _id, isDefault: _default, ...draft } = testProviderDraft;

  // Legacy API-key metadata without authMethod must remain idempotent when saved again.
  it('reuses a legacy entry whose authentication method is implicit', async () => {
    const legacy = { ...draft, authMethod: undefined };
    const first = await addValidatedProvider(legacy, () => true);
    const second = await addValidatedProvider(legacy, () => true);
    expect(second?.id).toBe(first?.id); expect(loadAISettings().providers).toHaveLength(1);
  });

  // Cancellation before metadata publication must work even for a keyless OAuth save.
  it('drops a keyless save that becomes stale at the publication check', async () => {
    let checks = 0;
    expect(await addValidatedProvider({ ...draft, apiKey: '', authMethod: 'oauth' }, () => ++checks === 1)).toBeNull();
    expect(loadAISettings().providers).toHaveLength(0); expect(vaultSet).not.toHaveBeenCalled();
  });

  // A keyless metadata failure needs no secret cleanup and still stays recoverable in the model screen.
  it('reports a failed keyless metadata save without touching the vault', async () => {
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota exceeded'); } });
    await expect(addValidatedProvider({ ...draft, apiKey: '', authMethod: 'oauth' }, () => true)).rejects.toThrow('Could not save AI settings');
    expect(vaultSet).not.toHaveBeenCalled(); expect(vaultDelete).not.toHaveBeenCalled();
  });

  // A failed rollback must be reported instead of silently claiming the existing credential is usable.
  it('reports restoration failure without exposing the vault error or edited secret', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota exceeded'); } });
    vaultRevert.mockResolvedValueOnce({ success: false });
    await expect(addValidatedProvider({ ...draft, apiKey: 'edited-secret' }, () => true, { existingId: first!.id, makeDefault: false })).rejects.toThrow('Could not restore your saved API key');
    expect(loadAISettings().providers[0].model).toBe('gpt-test');
  });
});

describe('restoring an explicitly edited Sarv connection', () => {
  const saved = () => ({ name: 'Sarv · Saved backend · Saved model', model: 'saved-model', baseUrl: 'https://other-region.example/edge/v1/llm/', oauthEmail: 'selected@example.com' });
  const edit = () => ({ ...makeAIConnection('sarv'), baseUrl: saved().baseUrl, model: saved().model, savedSarvProvider: saved() });
  const zones = [{ code: 'default', api_domain: 'https://default-region.example' }, { code: 'saved-region', api_domain: 'https://other-region.example/' }];
  const backends = [{ code: 'sarv_partners', name: 'Recommended backend' }, { code: 'saved-backend', name: 'Saved backend' }];

  // Opening Edit cannot move an existing model to the default region/backend.
  it('restores the saved nondefault region and nonrecommended backend before listing models', async () => {
    vi.mocked(loadZoneSelection).mockResolvedValue({ zones, zoneCode: 'default' });
    vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockImplementation(async (_base, _email, backend) => backend === 'saved-backend' ? [{ code: 'saved-model', display_name: 'Saved model', provider_code: backend || '' }] : [{ code: 'recommended-model', provider_code: backend || '' }]);
    const restored = await loadSarvAIConnection(edit(), signal(), { email: 'selected@example.com' });
    expect(listCaiProviders).toHaveBeenLastCalledWith('https://cai.example', 'selected@example.com', 'saved-region');
    expect(restored).toMatchObject({ model: 'saved-model', sarv: { zoneCode: 'saved-region', providerCode: 'saved-backend' } });
    const provider = (await import('../../../../src/services/onboarding-ai-connection')).providerFromConnection(restored);
    expect(provider).toMatchObject({ model: 'saved-model', baseUrl: 'https://other-region.example/edge/v1/llm', sarvProviderCode: 'saved-backend', sarvZoneCode: 'saved-region' });
    expect(listCaiModels).toHaveBeenCalledOnce();
  });

  // Legacy entries whose friendly name changed still restore the backend that has their exact model.
  it('searches catalogs for a legacy saved model when its old backend name does not match', async () => {
    vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockImplementation(async (_base, _email, backend) => backend === 'saved-backend' ? [{ code: 'saved-model', provider_code: backend || '' }] : [{ code: 'different-model', provider_code: backend || '' }]);
    const previous = edit(); previous.savedSarvProvider.name = 'Legacy custom name';
    const restored = await loadSarvAIConnection(previous, signal(), { email: 'selected@example.com' });
    expect(restored.sarv?.providerCode).toBe('saved-backend'); expect(restored.model).toBe('saved-model');
    expect(listCaiModels).toHaveBeenCalledTimes(2);
  });

  // Persisted backend/zone codes resolve identical model names without choosing another backend.
  it('uses retained catalog identities when models occur in multiple backends or regions', async () => {
    vi.mocked(loadZoneSelection).mockResolvedValue({ zones: [{ code: 'first', api_domain: 'https://other-region.example' }, ...zones], zoneCode: 'first' });
    vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockResolvedValue([{ code: 'saved-model', provider_code: 'saved-backend' }]);
    const previous = { ...edit(), savedSarvProvider: { ...saved(), sarvZoneCode: 'saved-region', sarvProviderCode: 'saved-backend' } };
    const restored = await loadSarvAIConnection(previous, signal(), { email: 'selected@example.com' });
    expect(restored.sarv).toMatchObject({ providerCode: 'saved-backend', zoneCode: 'saved-region' });
    expect(listCaiModels).toHaveBeenCalledOnce();
  });

  // Unavailable saved models must offer a fresh catalog while requiring an explicit model choice.
  it.each([false, true])('clears an unavailable saved model with retained identity=%s', async (retainIdentity) => {
    vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockResolvedValue([{ code: 'different-model', provider_code: 'saved-backend' }]);
    const previous = { ...edit(), savedSarvProvider: { ...saved(), ...(retainIdentity ? { sarvProviderCode: 'saved-backend' } : {}) } };
    const result = await loadSarvAIConnection(previous, signal(), { email: 'selected@example.com' });
    expect(result.model).toBe(''); expect(result.modelWarning).toContain('no longer available'); expect(result.models[0].id).toBe('different-model');
  });

  // No-zone accounts retain their registered endpoint even if the app's global fallback later changes.
  it('preserves the saved edge fallback on both initial edit and subsequent refresh', async () => {
    vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockResolvedValue([{ code: 'saved-model', provider_code: 'saved-backend' }]);
    const restored = await loadSarvAIConnection(edit(), signal(), { email: 'selected@example.com' });
    const refreshed = await loadSarvAIConnection(restored, signal());
    const { providerFromConnection } = await import('../../../../src/services/onboarding-ai-connection');
    expect(providerFromConnection(refreshed).baseUrl).toBe('https://other-region.example/edge/v1/llm');
    expect(refreshed.sarv?.zoneCode).toBe('');
  });

  // Explicit region/backend changes must supersede preserved settings; switching accounts must use that account's defaults.
  it('honors deliberate region and backend choices, and drops old identity for another account', async () => {
    vi.mocked(loadZoneSelection).mockResolvedValue({ zones, zoneCode: 'default' });
    vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockResolvedValue([{ code: 'new-model', provider_code: 'sarv_partners' }]);
    const changed = await loadSarvAIConnection(edit(), signal(), { email: 'selected@example.com', zoneCode: 'default', providerCode: 'sarv_partners' });
    expect(changed.sarv).toMatchObject({ zoneCode: 'default', providerCode: 'sarv_partners' }); expect(changed.model).toBe('new-model');
    const other = await loadSarvAIConnection(edit(), signal(), { email: 'first@example.com' });
    expect(other.sarv).toMatchObject({ email: 'first@example.com', zoneCode: 'default', providerCode: 'sarv_partners' });
  });

  // Abort during a legacy backend search must stop before another catalog fetch or settings save.
  it('cancels a pending catalog restoration without checking later backends', async () => {
    const controller = new AbortController(); vi.mocked(listCaiProviders).mockResolvedValue(backends);
    vi.mocked(listCaiModels).mockImplementationOnce(async () => { controller.abort(); return []; });
    await expect(loadSarvAIConnection(edit(), controller.signal, { email: 'selected@example.com' })).rejects.toThrow();
    expect(listCaiModels).toHaveBeenCalledOnce();
  });
});

describe('provider edits racing current settings during a vault write', () => {
  const { id: _id, isDefault: _default, ...draft } = testProviderDraft;
  function deferWrite() {
    let resolve!: (value: { success: boolean; encrypted: boolean; writeId?: number }) => void;
    vaultSet.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    return () => resolve({ success: true, encrypted: true, writeId: 77 });
  }

  // Removing an account/provider while a key writes must never resurrect the provider or its orphan secret.
  it('rejects a removed edit target after the vault resolves and deletes its newly written key', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const complete = deferWrite();
    const saving = addValidatedProvider({ ...draft, apiKey: 'replacement-key' }, () => true, { existingId: first!.id, makeDefault: false });
    const { removeProvider } = await import('../../../../src/services/ai-service'); removeProvider(first!.id);
    complete(); await expect(saving).rejects.toThrow('was removed');
    expect(loadAISettings().providers).toHaveLength(0); expect(vaultDelete).toHaveBeenLastCalledWith(first!.id);
    expect(vaultSet).not.toHaveBeenLastCalledWith(first!.id, 'synthetic-key');
  });

  // Cancellation after removal must clean the written key, not restore a removed provider's original credential.
  it('deletes the orphan edited key if its provider was removed before cancellation', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const complete = deferWrite(); let current = true;
    const saving = addValidatedProvider({ ...draft, apiKey: 'replacement-key' }, () => current, { existingId: first!.id, makeDefault: false });
    const { removeProvider } = await import('../../../../src/services/ai-service'); removeProvider(first!.id); current = false;
    complete(); expect(await saving).toBeNull(); expect(loadAISettings().providers).toHaveLength(0);
    expect(vaultDelete).toHaveBeenLastCalledWith(first!.id); expect(vaultSet).not.toHaveBeenLastCalledWith(first!.id, 'synthetic-key');
  });

  // A default changed while editing must remain the only default after the asynchronous key save finishes.
  it('preserves the latest default instead of restoring the edited target old default state', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const second = await addValidatedProvider({ ...draft, model: 'second-model' }, () => true, { createNew: true, makeDefault: false });
    const complete = deferWrite();
    const saving = addValidatedProvider({ ...draft, apiKey: 'replacement-key' }, () => true, { existingId: first!.id, makeDefault: false });
    const { setDefaultProvider } = await import('../../../../src/services/ai-service'); setDefaultProvider(second!.id);
    complete(); expect(await saving).toMatchObject({ id: first!.id, isDefault: false });
    expect(loadAISettings().providers.filter((provider) => provider.isDefault).map((provider) => provider.id)).toEqual([second!.id]);
  });

  // Rolling back a stale edit must restore the latest live key if another edit changed it during the pending vault write.
  it('rolls back to the current saved key rather than the stale edit snapshot', async () => {
    const first = await addValidatedProvider(draft, () => true);
    const complete = deferWrite(); let current = true;
    const saving = addValidatedProvider({ ...draft, apiKey: 'replacement-key' }, () => current, { existingId: first!.id, makeDefault: false });
    const { updateProvider } = await import('../../../../src/services/ai-service'); updateProvider(first!.id, { apiKey: 'newer-key' }); current = false;
    // The newer key was written after ours; main's revert of OUR write (77)
    // is then a no-op (pinned in ai-secret-store.test.ts), so the newer key
    // stands — the renderer never re-sets an older key over it.
    complete(); expect(await saving).toBeNull(); expect(vaultSet).toHaveBeenLastCalledWith(first!.id, 'newer-key', 'https://api.example/v1');
    expect(vaultRevert).toHaveBeenCalledWith(first!.id, 77);
    expect(loadAISettings().providers[0]).toMatchObject({ hasStoredKey: true });
  });
});

describe('Sarv catalog disappearance while editing', () => {
  const saved = { name: 'Sarv · Saved · Original', baseUrl: 'https://saved.example/edge/v1/llm', model: 'original-model', oauthEmail: 'selected@example.com', sarvProviderCode: 'saved', sarvZoneCode: 'region' };
  const edit = () => ({ ...makeAIConnection('sarv'), model: saved.model, savedSarvProvider: saved });

  // A previously selected model disappearing on refresh must clear selection and remain cleared on further refreshes.
  it('requires a fresh model choice on same-identity refresh instead of recommending a replacement', async () => {
    vi.mocked(loadZoneSelection).mockResolvedValue({ zones: [{ code: 'region', api_domain: 'https://saved.example' }], zoneCode: 'region' });
    vi.mocked(listCaiProviders).mockResolvedValue([{ code: 'saved', name: 'Saved' }]);
    vi.mocked(listCaiModels).mockResolvedValueOnce([{ code: 'original-model', provider_code: 'saved' }]).mockResolvedValue([{ code: 'replacement-model', provider_code: 'saved' }]);
    const initial = await loadSarvAIConnection(edit(), signal(), { email: saved.oauthEmail });
    const refreshed = await loadSarvAIConnection(initial, signal());
    expect(refreshed.model).toBe(''); expect(refreshed.modelWarning).toContain('no longer available'); expect(refreshed.models[0].id).toBe('replacement-model');
    const again = await loadSarvAIConnection(refreshed, signal()); expect(again.model).toBe('');
  });

  // Missing retained backend identities must not silently switch to another backend sharing the same model ID.
  it('requires an explicit reset when a retained backend disappears', async () => {
    vi.mocked(listCaiProviders).mockResolvedValue([{ code: 'different', name: 'Different' }]);
    vi.mocked(listCaiModels).mockResolvedValue([{ code: 'original-model', provider_code: 'different' }]);
    await expect(loadSarvAIConnection(edit(), signal(), { email: saved.oauthEmail })).rejects.toThrow('saved Sarv backend is no longer available');
    expect(listCaiModels).not.toHaveBeenCalled();
  });

  // Missing retained region identities must not silently choose another region with the same endpoint.
  it('requires an explicit reset when the retained region disappears', async () => {
    vi.mocked(loadZoneSelection).mockResolvedValue({ zones: [{ code: 'different', api_domain: 'https://saved.example' }], zoneCode: 'different' });
    await expect(loadSarvAIConnection(edit(), signal(), { email: saved.oauthEmail })).rejects.toThrow('saved Sarv region is no longer available');
    expect(listCaiProviders).not.toHaveBeenCalled();
  });

  // An org-gated empty zone list must not erase a known region while that region's model catalog remains usable.
  it('retains a saved region when the zone catalog is unavailable', async () => {
    vi.mocked(listCaiProviders).mockResolvedValue([{ code: 'saved', name: 'Saved' }]);
    vi.mocked(listCaiModels).mockResolvedValue([{ code: 'original-model', provider_code: 'saved' }]);
    const restored = await loadSarvAIConnection(edit(), signal(), { email: saved.oauthEmail });
    expect(restored.sarv?.zoneCode).toBe('region'); expect(listCaiProviders).toHaveBeenLastCalledWith('https://cai.example', saved.oauthEmail, 'region');
  });

  // No-model legacy catalogs remain an honest failure rather than a fabricated verified model selection.
  it('fails an empty legacy restoration catalog without enabling AI', async () => {
    vi.mocked(listCaiModels).mockResolvedValue([]);
    await expect(loadSarvAIConnection({ ...edit(), savedSarvProvider: { ...saved, sarvProviderCode: undefined } }, signal(), { email: saved.oauthEmail })).rejects.toThrow('No models are available');
  });
});
