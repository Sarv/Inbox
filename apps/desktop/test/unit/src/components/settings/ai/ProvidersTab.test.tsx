// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProvidersTab } from '../../../../../../src/components/settings/ai/ProvidersTab';
import { setAiConsent } from '../../../../../../src/services/ai-consent';
import { addValidatedProvider, loadAISettings, removeProvider, setDefaultProvider, syncAIProviderToMain, testProvider, type AIProvider } from '../../../../../../src/services/ai-service';
import { checkAIConnection, loadSarvAIConnection } from '../../../../../../src/services/onboarding-ai-connection';
import { cleanup, fire, render, settle, toggle, typeInto, type Mounted } from '../../../../../helpers/render';

vi.mock('../../../../../../src/services/ai-consent', () => ({ setAiConsent: vi.fn(), SARV_AI_DISCLOSURE: 'Sarv processes your email.' }));
vi.mock('../../../../../../src/services/ai-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../src/services/ai-service')>();
  return { ...actual, loadAISettings: vi.fn(), addValidatedProvider: vi.fn(), removeProvider: vi.fn(), setDefaultProvider: vi.fn(), syncAIProviderToMain: vi.fn(), testProvider: vi.fn() };
});
vi.mock('../../../../../../src/services/onboarding-ai-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../src/services/onboarding-ai-connection')>();
  return { ...actual, checkAIConnection: vi.fn(), loadSarvAIConnection: vi.fn() };
});

const button = (view: Mounted, label: string) => view.all('button').find((element) => element.textContent?.includes(label)) || null;
let stored: AIProvider[];
// A saved provider as the renderer sees it: the key stays in main (hasStoredKey).
const existing = (): AIProvider => ({ id: 'existing', name: 'Existing OpenAI', type: 'openai', apiKey: '', hasStoredKey: true, model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', isDefault: true });
function Harness() {
  const [providers, setProviders] = useState(stored);
  return <ProvidersTab aiProviders={providers} setAiProviders={setProviders} />;
}
async function configure(view: Mounted) {
  fire(button(view, 'Add provider'), 'click');
  fire(button(view, 'OpenAI'), 'click');
  typeInto(view.find('input[type="password"]'), 'new-key');
  fire(button(view, 'Check connection'), 'click'); await settle();
  const model = view.byLabel('Model') as HTMLSelectElement; model.value = 'available-model'; fire(model, 'change');
  toggle(view.find('input[type="checkbox"]'));
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); stored = [];
  vi.mocked(loadAISettings).mockImplementation(() => ({ providers: stored }));
  vi.mocked(checkAIConnection).mockImplementation(async (connection) => ({ ...connection, verified: true, models: [{ id: 'available-model', name: 'Available model' }], model: 'available-model' }));
  vi.mocked(testProvider).mockResolvedValue({ success: true, message: 'Connection works' });
  vi.mocked(addValidatedProvider).mockImplementation(async (draft, _isCurrent, options) => {
    const provider: AIProvider = { ...draft, id: options?.existingId || 'new-provider', isDefault: options?.existingId ? stored.find((entry) => entry.id === options.existingId)!.isDefault : !stored.length };
    stored = options?.existingId ? stored.map((entry) => entry.id === options.existingId ? provider : entry) : [...stored, provider];
    return provider;
  });
  vi.mocked(removeProvider).mockImplementation((id) => { stored = stored.filter((provider) => provider.id !== id); if (stored.length && !stored.some((provider) => provider.isDefault)) stored[0].isDefault = true; });
  vi.mocked(setDefaultProvider).mockImplementation((id) => { stored = stored.map((provider) => ({ ...provider, isDefault: provider.id === id })); });
  window.electronAPI = { oauth: { cancel: vi.fn(async () => ({ success: true })) } } as unknown as typeof window.electronAPI;
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('AI Providers settings onboarding flow', () => {
  // Merely visiting provider settings must not add Sarv entries, disable AI, or alter onboarding progress.
  it('has no configuration side effects on opening and reuses the actual provider icons', () => {
    stored = [existing()]; localStorage.setItem('sentinel-onboarding', 'complete');
    const view = render(<Harness />);
    expect(loadSarvAIConnection).not.toHaveBeenCalled(); expect(syncAIProviderToMain).not.toHaveBeenCalled(); expect(setAiConsent).not.toHaveBeenCalled();
    expect(view.find('img')?.getAttribute('src')).toContain('openai');
    expect(localStorage.getItem('sentinel-onboarding')).toBe('complete');
    expect(view.byLabel('Edit Existing OpenAI')).not.toBeNull(); expect(view.byLabel('Remove Existing OpenAI')).not.toBeNull();
  });

  // Clicking a provider immediately advances, and cancelling returns focus while preserving the working provider.
  it('opens the centered provider flow with blank credentials and cancels without changing settings', () => {
    stored = [existing()]; const view = render(<Harness />);
    const opener = button(view, 'Add provider')!; opener.focus(); fire(opener, 'click');
    expect(view.find('[role="dialog"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Choose your AI provider');
    fire(button(view, 'Google Gemini'), 'click');
    expect(view.container.textContent).toContain('Connect Google Gemini');
    expect(view.find('input[type="password"]')).toHaveProperty('value', '');
    fire(button(view, 'Cancel'), 'click');
    expect(view.find('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(stored).toEqual([existing()]); expect(setAiConsent).not.toHaveBeenCalled(); expect(syncAIProviderToMain).not.toHaveBeenCalled();
  });

  // Successful settings addition must update the list/main config without overwriting an existing default.
  it('adds a validated provider, preserves the default and starts another addition blank', async () => {
    stored = [existing()]; const view = render(<Harness />); await configure(view);
    fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(view.find('[role="dialog"]')).toBeNull(); expect(stored).toHaveLength(2); expect(stored[0].isDefault).toBe(true); expect(stored[1].isDefault).toBe(false);
    expect(syncAIProviderToMain).toHaveBeenCalledOnce();
    fire(button(view, 'Add provider'), 'click'); fire(button(view, 'OpenAI'), 'click');
    expect(view.find('input[type="password"]')).toHaveProperty('value', '');
  });

  // Explicit edit validates the selected entry and retains its identity/default instead of creating a second row.
  it('edits a saved provider using the same connection/model flow', async () => {
    stored = [existing()]; const view = render(<Harness />);
    fire(view.byLabel('Edit Existing OpenAI'), 'click');
    // Changed deliberately (CASA H-1): the saved key is never put back into the
    // form — the field starts blank and says a key is saved.
    expect(view.container.textContent).toContain('Edit Existing OpenAI'); expect(view.find('input[type="password"]')).toHaveProperty('value', '');
    expect(view.find('input[type="password"]')).toHaveProperty('placeholder', 'Saved — leave blank to keep it');
    typeInto(view.find('input[type="password"]'), 'replacement-key'); fire(button(view, 'Check connection'), 'click'); await settle();
    toggle(view.find('input[type="checkbox"]')); fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ id: 'existing', apiKey: 'replacement-key', model: 'available-model', isDefault: true });
  });

  // A failed model leaves the draft visible and keeps the existing provider usable.
  it('retains failed drafts without saving and ignores an interrupted connection result', async () => {
    stored = [existing()]; vi.mocked(testProvider).mockResolvedValueOnce({ success: false, message: 'Model unavailable' });
    const view = render(<Harness />); await configure(view); fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Model unavailable'); expect(addValidatedProvider).not.toHaveBeenCalled();
    fire(view.byLabel('Close setup'), 'click');
    let resolve!: (value: Awaited<ReturnType<typeof checkAIConnection>>) => void;
    vi.mocked(checkAIConnection).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    fire(button(view, 'Add provider'), 'click'); fire(button(view, 'OpenAI'), 'click'); typeInto(view.find('input[type="password"]'), 'another-key'); fire(button(view, 'Check connection'), 'click');
    fire(view.find('[role="dialog"]'), 'keydown', { key: 'Escape' });
    resolve({ type: 'openai', name: 'OpenAI', apiKey: 'another-key', baseUrl: 'https://api.openai.com/v1', authMethod: 'apiKey', useApiKey: true, verified: true, models: [], model: '', manualModel: false }); await settle();
    expect(view.find('[role="dialog"]')).toBeNull(); expect(stored).toEqual([existing()]); expect(setAiConsent).not.toHaveBeenCalled();
  });

  // Default/remove operations must retain the existing management functionality and resync the chosen provider.
  it('changes default and removes providers while promoting the remaining connection', () => {
    stored = [existing(), { ...existing(), id: 'second', name: 'Other AI', type: 'custom', apiKey: '', model: 'local-model', isDefault: false }];
    const view = render(<Harness />); fire(button(view, 'Make default'), 'click');
    expect(setDefaultProvider).toHaveBeenCalledWith('second'); expect(stored[1].isDefault).toBe(true);
    fire(view.byLabel('Remove Other AI'), 'click'); expect(stored).toHaveLength(1); expect(stored[0].isDefault).toBe(true);
    fire(view.byLabel('Remove Existing OpenAI'), 'click'); expect(view.container.textContent).toContain('No AI providers connected'); expect(syncAIProviderToMain).toHaveBeenCalledTimes(3);
  });

  // Native keyring fallback must remain visible after a successful save, so the UI doesn't imply encryption.
  it('reports unencrypted vault storage after a successful settings save', async () => {
    vi.mocked(addValidatedProvider).mockImplementationOnce(async (draft) => { const provider = { ...draft, id: 'new-provider', isDefault: true }; stored = [provider]; return { ...provider, keyStorageEncrypted: false }; });
    const view = render(<Harness />); await configure(view); fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(view.find('[role="status"]')?.textContent).toContain('saved without encryption');
  });

  // Older concurrent test results/timers cannot replace the latest provider status.
  it('tests providers, ignores stale results and clears the latest status after five seconds', async () => {
    vi.useFakeTimers(); stored = [existing(), { ...existing(), id: 'second', name: 'Second', model: 'custom-model', isDefault: false, authMethod: 'oauth', oauthEmail: 'sarv@example.com', baseUrl: undefined }];
    let firstResolve!: (value: Awaited<ReturnType<typeof testProvider>>) => void;
    vi.mocked(testProvider).mockReturnValueOnce(new Promise((done) => { firstResolve = done; })).mockResolvedValueOnce({ success: false, message: 'Second failed' });
    const view = render(<Harness />); fire(view.byLabel('Test Existing OpenAI'), 'click'); fire(view.byLabel('Test Second'), 'click'); await settle();
    firstResolve({ success: true, message: 'Old result' }); await settle(); expect(view.container.textContent).toContain('Second failed'); expect(view.container.textContent).not.toContain('Old result');
    await vi.advanceTimersByTimeAsync(5000); await settle(); expect(view.container.textContent).not.toContain('Second failed');
    vi.mocked(testProvider).mockResolvedValueOnce({ success: true, message: 'Healthy' }); fire(view.byLabel('Test Existing OpenAI'), 'click'); await settle(); expect(view.container.textContent).toContain('Healthy');
    view.unmount(); await vi.advanceTimersByTimeAsync(5000);
  });
});
