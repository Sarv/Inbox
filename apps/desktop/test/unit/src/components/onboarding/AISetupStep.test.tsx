// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AISetupStep, type AISetupStage, type AISetupStepProps } from '../../../../../src/components/onboarding/AISetupStep';
import { setAiConsent } from '../../../../../src/services/ai-consent';
import { addValidatedProvider, loadAISettings, testProvider } from '../../../../../src/services/ai-service';
import { checkAIConnection, loadSarvAIConnection, makeAIConnection, type OnboardingAIConnection } from '../../../../../src/services/onboarding-ai-connection';
import { cleanup, fire, render, settle, toggle, typeInto, type Mounted } from '../../../../helpers/render';

vi.mock('../../../../../src/services/ai-consent', () => ({ setAiConsent: vi.fn(), SARV_AI_DISCLOSURE: 'Sarv processes new mail from every connected account.' }));
vi.mock('../../../../../src/services/ai-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/services/ai-service')>();
  return { ...actual, loadAISettings: vi.fn(() => ({ providers: [] })), addValidatedProvider: vi.fn(), testProvider: vi.fn() };
});
vi.mock('../../../../../src/services/onboarding-ai-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/services/onboarding-ai-connection')>();
  return { ...actual, checkAIConnection: vi.fn(), loadSarvAIConnection: vi.fn() };
});

const button = (view: Mounted, label: string) => view.all('button').find((element) => element.textContent?.includes(label)) || null;
const onComplete = vi.fn();
const onBackToEmail = vi.fn();
const onStage = vi.fn();
const cancel = vi.fn(async () => ({ success: true }));
const startFlow = vi.fn();

function Harness(props: Partial<AISetupStepProps>) {
  const [stage, setStage] = useState<AISetupStage>(props.stage || 'provider');
  return <AISetupStep active preferSarv={false} {...props} stage={stage} onStageChange={(next) => { onStage(next); setStage(next); }} onComplete={onComplete} onBackToEmail={onBackToEmail} />;
}

function verified(type: 'openai' | 'custom' | 'gemini' = 'openai'): OnboardingAIConnection {
  return { ...makeAIConnection(type), apiKey: 'synthetic-test-key', verified: true, models: [{ id: 'demo-model', name: 'Demo model' }] };
}
function sarvConnected(): OnboardingAIConnection {
  return {
    ...makeAIConnection('sarv'), verified: true, model: 'gpt-oss-120b',
    models: [{ id: 'gpt-oss-120b', name: 'Inbox model' }],
    sarv: {
      email: 'demo@sarv.example', accounts: [{ email: 'demo@sarv.example' }],
      apiBaseUrl: 'https://cai.example', edgeBaseUrl: 'https://edge.example/edge/v1/llm',
      zones: [], zoneCode: '', providers: [{ code: 'sarv_partners', name: 'Sarv Partners' }], providerCode: 'sarv_partners',
      models: [{ code: 'gpt-oss-120b', display_name: 'Inbox model', provider_code: 'sarv_partners' }],
    },
  };
}
async function configureOpenAI(view: Mounted) {
  fire(button(view, 'OpenAI'), 'click');
  typeInto(view.find('input[type="password"]'), 'synthetic-test-key');
  fire(button(view, 'Check connection'), 'click');
  await settle();
}
function selectModel(view: Mounted, value = 'demo-model') {
  const select = view.byLabel('Model') as HTMLSelectElement;
  select.value = value;
  fire(select, 'change');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAISettings).mockReturnValue({ providers: [] });
  vi.mocked(checkAIConnection).mockImplementation(async (connection) => ({ ...connection, ...verified(connection.type as 'openai'), type: connection.type, name: connection.name }));
  vi.mocked(loadSarvAIConnection).mockResolvedValue(sarvConnected());
  vi.mocked(testProvider).mockResolvedValue({ success: true, message: 'Success' });
  vi.mocked(addValidatedProvider).mockImplementation(async (draft, isCurrent) => isCurrent() ? { ...draft, id: 'saved', isDefault: true } : null);
  window.electronAPI = { oauth: { cancel, startFlow } } as unknown as typeof window.electronAPI;
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('AI onboarding', () => {
  // Choosing a provider must advance immediately without a second Continue.
  it('moves to provider-specific connection settings on selection', () => {
    const view = render(<Harness />);
    fire(button(view, 'Google Gemini'), 'click');
    expect(onStage).toHaveBeenLastCalledWith('connection');
    expect(view.container.textContent).toContain('Connect Google Gemini');
    expect(view.find('input[type="password"]')).not.toBeNull();
    expect(testProvider).not.toHaveBeenCalled();
  });

  // A config check must not enable AI, persist a key, or generate a model reply.
  it('lists models after configuration and waits for model selection and consent', async () => {
    const view = render(<Harness />);
    await configureOpenAI(view);
    expect(view.container.textContent).toContain('Choose your model');
    expect(testProvider).not.toHaveBeenCalled();
    expect(addValidatedProvider).not.toHaveBeenCalled();
    expect(button(view, 'Test model and enable AI')).toHaveProperty('disabled', true);
    selectModel(view);
    expect(button(view, 'Test model and enable AI')).toHaveProperty('disabled', true);
    toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    await settle();
    expect(testProvider).toHaveBeenCalledWith(expect.objectContaining({ model: 'demo-model', apiKey: 'synthetic-test-key' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(setAiConsent).toHaveBeenLastCalledWith('granted');
    expect(onComplete).toHaveBeenLastCalledWith({ enabled: true, providerName: 'OpenAI', modelName: 'Demo model' });
  });

  // Sarv email OAuth is an existing connection, never another browser login.
  it('reuses the specified Sarv mailbox session and opens the model screen', async () => {
    const view = render(<Harness stage="model" preferSarv preferSarvEmail="demo@sarv.example" />);
    await settle();
    expect(loadSarvAIConnection).toHaveBeenCalledWith(expect.objectContaining({ type: 'sarv' }), expect.any(AbortSignal), { email: 'demo@sarv.example' });
    expect(startFlow).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('demo@sarv.example');
    expect(addValidatedProvider).not.toHaveBeenCalled();
    expect(setAiConsent).not.toHaveBeenCalled();
    fire(button(view, 'Back'), 'click');
    expect(onBackToEmail).toHaveBeenCalledOnce();
  });

  // Back and provider changes must preserve independent validated connections.
  it('returns to a connected provider without requiring another key check', async () => {
    const view = render(<Harness />);
    await configureOpenAI(view);
    selectModel(view);
    fire(button(view, 'Change AI provider'), 'click');
    fire(button(view, 'Google Gemini'), 'click');
    typeInto(view.find('input[type="password"]'), 'gemini-synthetic-key');
    fire(button(view, 'Back'), 'click');
    fire(button(view, 'OpenAI'), 'click');
    expect(view.container.textContent).toContain('Choose your model');
    expect(view.byLabel('Model')).toHaveProperty('value', 'demo-model');
    expect(checkAIConnection).toHaveBeenCalledOnce();
    fire(button(view, 'Change AI provider'), 'click');
    fire(button(view, 'Google Gemini'), 'click');
    expect(view.find('input[type="password"]')).toHaveProperty('value', 'gemini-synthetic-key');
  });

  // Auth/catalog failure must stay editable instead of appearing connected.
  it('keeps failed configuration on the connection screen and supports retry', async () => {
    vi.mocked(checkAIConnection).mockRejectedValueOnce(new Error('Authentication failed'));
    const view = render(<Harness />);
    await configureOpenAI(view);
    expect(view.find('[role="alert"]')?.textContent).toContain('Authentication failed');
    expect(view.container.textContent).toContain('Connect OpenAI');
    fire(button(view, 'Check connection'), 'click');
    await settle();
    expect(view.container.textContent).toContain('Choose your model');
  });

  // A rejected model must not create a default provider or record AI consent.
  it('keeps a failed model test on model selection without saving', async () => {
    vi.mocked(testProvider).mockResolvedValue({ success: false, message: 'Model is not available' });
    const view = render(<Harness />);
    await configureOpenAI(view);
    selectModel(view);
    toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Model is not available');
    expect(addValidatedProvider).not.toHaveBeenCalled();
    expect(setAiConsent).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // A failing secure vault cannot silently enable AI with an unsaved key.
  it('reports a failed secret save and leaves onboarding open', async () => {
    vi.mocked(addValidatedProvider).mockRejectedValueOnce(new Error('Could not save your API key securely'));
    const view = render(<Harness />);
    await configureOpenAI(view);
    selectModel(view);
    toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Could not save your API key securely');
    expect(onComplete).not.toHaveBeenCalled();
    expect(setAiConsent).not.toHaveBeenCalled();
  });

  // Skip during a slow test must block its late success from enabling AI.
  it('cancels an in-flight model test when AI is skipped', async () => {
    let resolveTest!: (result: { success: boolean; message: string }) => void;
    vi.mocked(testProvider).mockReturnValue(new Promise((resolve) => { resolveTest = resolve; }));
    const view = render(<Harness />);
    await configureOpenAI(view);
    selectModel(view);
    toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    fire(button(view, 'Set up AI later'), 'click');
    expect(onComplete).toHaveBeenLastCalledWith({ enabled: false });
    expect(setAiConsent).toHaveBeenLastCalledWith('declined');
    resolveTest({ success: true, message: 'Late success' });
    await settle();
    expect(addValidatedProvider).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  // Late catalog results must not drag users forward after Back.
  it('ignores a pending catalog after returning to the provider picker', async () => {
    let resolveCheck!: (connection: OnboardingAIConnection) => void;
    vi.mocked(checkAIConnection).mockReturnValue(new Promise((resolve) => { resolveCheck = resolve; }));
    const view = render(<Harness />);
    fire(button(view, 'OpenAI'), 'click');
    typeInto(view.find('input[type="password"]'), 'synthetic-test-key');
    fire(button(view, 'Check connection'), 'click');
    fire(button(view, 'Back'), 'click');
    resolveCheck(verified());
    await settle();
    expect(view.container.textContent).toContain('Choose your AI provider');
    expect(onStage).toHaveBeenLastCalledWith('provider');
  });

  // Declining AI while Sarv OAuth is open cancels the shared native flow.
  it('cancels OAuth when skipped and ignores a late sign-in response', async () => {
    vi.mocked(loadSarvAIConnection).mockRejectedValueOnce(new Error('Sign in with Sarv'));
    let resolveFlow!: (value: unknown) => void;
    startFlow.mockReturnValue(new Promise((resolve) => { resolveFlow = resolve; }));
    const view = render(<Harness />);
    fire(button(view, 'Sarv AI'), 'click');
    await settle();
    fire(button(view, 'Sign in with Sarv'), 'click');
    fire(button(view, 'Set up AI later'), 'click');
    expect(cancel).toHaveBeenCalledOnce();
    resolveFlow({ success: true, data: { email: 'demo@sarv.example' } });
    await settle();
    expect(loadSarvAIConnection).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  // Native provider metadata plus a key saved in the vault skips config.
  // (Changed shape: the renderer learns only that a key is saved — CASA H-1.)
  it('opens models immediately for a previously stored provider', () => {
    vi.mocked(loadAISettings).mockReturnValue({ providers: [{ id: 'stored', type: 'openai', name: 'OpenAI', apiKey: '', hasStoredKey: true, model: 'stored-model', baseUrl: 'https://api.openai.com/v1', isDefault: true }] });
    const view = render(<Harness />);
    fire(button(view, 'OpenAI'), 'click');
    expect(view.container.textContent).toContain('Choose your model');
    expect(view.byLabel('Model')).toHaveProperty('value', 'stored-model');
    expect(checkAIConnection).not.toHaveBeenCalled();
  });

  // Breaks: resuming with a saved key saves a NEW provider with no key (when
  // the model changes), or asks the renderer to hold the saved key.
  it('enables a stored provider by updating it in place with its saved key', async () => {
    vi.mocked(loadAISettings).mockReturnValue({ providers: [{ id: 'stored', type: 'openai', name: 'OpenAI', apiKey: '', hasStoredKey: true, model: 'stored-model', baseUrl: 'https://api.openai.com/v1', isDefault: true }] });
    vi.mocked(testProvider).mockResolvedValue({ success: true, message: 'ok' });
    vi.mocked(addValidatedProvider).mockResolvedValue({ id: 'stored', type: 'openai', name: 'OpenAI', apiKey: '', model: 'stored-model', isDefault: true });
    const view = render(<Harness />);
    fire(button(view, 'OpenAI'), 'click');
    toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    await settle();
    expect(testProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'stored', apiKey: '', hasStoredKey: true }), expect.anything());
    expect(addValidatedProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', hasStoredKey: true }), expect.any(Function), { existingId: 'stored' });
  });

  // Custom/local services may use no authentication and an exact model ID.
  it('configures a custom unauthenticated endpoint and verifies a manual model', async () => {
    vi.mocked(checkAIConnection).mockImplementationOnce(async (connection) => ({ ...connection, verified: true, manualModel: true, models: [] }));
    const view = render(<Harness />);
    fire(button(view, 'Custom provider'), 'click');
    typeInto(view.find('input[placeholder="My AI server"]'), 'Local assistant');
    typeInto(view.find('input[type="url"]'), 'http://localhost:11434/v1');
    const auth = view.byLabel('Authentication') as HTMLSelectElement;
    auth.value = 'none';
    fire(auth, 'change');
    expect(view.find('input[type="password"]')).toBeNull();
    fire(button(view, 'Check connection'), 'click');
    await settle();
    expect(checkAIConnection).toHaveBeenCalledWith(expect.objectContaining({ name: 'Local assistant', baseUrl: 'http://localhost:11434/v1', useApiKey: false }), expect.any(AbortSignal));
    typeInto(view.find('input[placeholder="Enter the exact model ID"]'), 'local-exact-id');
    toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    await settle();
    expect(testProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: '', model: 'local-exact-id' }), expect.anything());
    expect(onComplete).toHaveBeenLastCalledWith({ enabled: true, providerName: 'Local assistant', modelName: 'local-exact-id' });
  });

  // Sarv key/session alternatives preserve independent credentials and avoid repeated OAuth.
  it('allows Sarv API-key configuration and returns to the existing session', async () => {
    vi.mocked(loadSarvAIConnection).mockRejectedValueOnce(new Error('Sign in required'));
    const view = render(<Harness />);
    fire(button(view, 'Sarv AI'), 'click');
    await settle();
    fire(button(view, 'Use an API key instead'), 'click');
    typeInto(view.find('input[type="password"]'), 'sarv-synthetic-key');
    typeInto(view.find('input[type="url"]'), 'https://edge.example/v1');
    fire(button(view, 'Use Sarv sign-in instead'), 'click');
    await settle();
    expect(startFlow).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Choose your model');
    fire(button(view, 'Connection settings'), 'click');
    fire(button(view, 'Use current Sarv connection'), 'click');
    await settle();
    expect(startFlow).not.toHaveBeenCalled();
  });

  // A browser sign-in cancellation remains recoverable without granting AI consent.
  it('reports Sarv OAuth cancellation, then retries into models', async () => {
    vi.mocked(loadSarvAIConnection).mockRejectedValueOnce(new Error('Sign in required'));
    startFlow.mockResolvedValueOnce({ success: false, error: 'cancelled' }).mockResolvedValueOnce({ success: true, data: { email: 'demo@sarv.example' } });
    const view = render(<Harness />);
    fire(button(view, 'Sarv AI'), 'click');
    await settle();
    fire(button(view, 'Sign in with Sarv'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('cancelled');
    fire(button(view, 'Sign in with Sarv'), 'click');
    await settle();
    expect(view.container.textContent).toContain('Choose your model');
    expect(setAiConsent).not.toHaveBeenCalled();
    fire(button(view, 'Connection settings'), 'click');
    fire(button(view, 'Sign in with a different Sarv account'), 'click');
    await settle();
    expect(startFlow).toHaveBeenCalledTimes(3);
  });

  // Changing Sarv account/region/backend rechecks the scoped catalog and resets agreement.
  it('loads advanced Sarv selections without generating or registering a default', async () => {
    const full = sarvConnected();
    full.sarv!.accounts.push({ email: 'second@sarv.example' });
    full.sarv!.zones = [{ code: 'first', name: 'First' }, { code: 'second' }];
    full.sarv!.zoneCode = 'first';
    full.sarv!.providers.push({ code: 'second', name: 'Second backend' });
    vi.mocked(loadSarvAIConnection).mockImplementation(async (_connection, _signal, selection) => ({
      ...full, sarv: { ...full.sarv!, email: selection?.email || full.sarv!.email, zoneCode: selection?.zoneCode || full.sarv!.zoneCode, providerCode: selection?.providerCode || full.sarv!.providerCode },
    }));
    const view = render(<Harness preferSarv stage="model" />);
    await settle();
    toggle(view.find('input[type="checkbox"]'));
    const account = view.byLabel('Sarv account') as HTMLSelectElement;
    account.value = 'second@sarv.example';
    fire(account, 'change');
    await settle();
    expect(loadSarvAIConnection).toHaveBeenLastCalledWith(expect.anything(), expect.any(AbortSignal), { email: 'second@sarv.example' });
    expect(view.find('input[type="checkbox"]')).toHaveProperty('checked', false);
    const region = view.byLabel('Region') as HTMLSelectElement;
    region.value = 'second'; fire(region, 'change'); await settle();
    expect(loadSarvAIConnection).toHaveBeenLastCalledWith(expect.anything(), expect.any(AbortSignal), { zoneCode: 'second' });
    const backend = view.byLabel('Backend') as HTMLSelectElement;
    backend.value = 'second'; fire(backend, 'change'); await settle();
    expect(loadSarvAIConnection).toHaveBeenLastCalledWith(expect.anything(), expect.any(AbortSignal), { providerCode: 'second' });
    expect(addValidatedProvider).not.toHaveBeenCalled();
    expect(testProvider).not.toHaveBeenCalled();
  });

  // Hidden steps must cancel network work but preserve in-memory draft values.
  it('ignores a model test after onboarding leaves the AI step', async () => {
    let resolveTest!: (value: { success: boolean; message: string }) => void;
    vi.mocked(testProvider).mockReturnValueOnce(new Promise((resolve) => { resolveTest = resolve; }));
    const view = render(<Harness />);
    await configureOpenAI(view);
    selectModel(view); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click');
    view.rerender(<Harness active={false} />);
    resolveTest({ success: true, message: 'Late result' });
    await settle();
    expect(addValidatedProvider).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    view.rerender(<Harness active />);
    expect(view.byLabel('Model')).toHaveProperty('value', 'demo-model');
  });

  // A hung OAuth operation must stop its spinner and offer retry/skip after timeout.
  it('times out a pending OAuth sign-in and rejects late completion', async () => {
    vi.useFakeTimers();
    vi.mocked(loadSarvAIConnection).mockRejectedValueOnce(new Error('Sign in required'));
    let resolveFlow!: (value: unknown) => void;
    startFlow.mockReturnValueOnce(new Promise((resolve) => { resolveFlow = resolve; }));
    const view = render(<Harness />);
    fire(button(view, 'Sarv AI'), 'click'); await settle();
    fire(button(view, 'Sign in with Sarv'), 'click');
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('timed out');
    expect(button(view, 'Sign in with Sarv')).toHaveProperty('disabled', false);
    expect(cancel).toHaveBeenCalledOnce();
    resolveFlow({ success: true, data: { email: 'late@example.com' } }); await settle();
    expect(loadSarvAIConnection).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // Failed async code can throw a non-Error; onboarding still needs a useful message.
  it('shows a generic error for an unexpected connection failure', async () => {
    vi.mocked(checkAIConnection).mockRejectedValueOnce(null);
    const view = render(<Harness />);
    await configureOpenAI(view);
    expect(view.find('[role="alert"]')?.textContent).toContain('Could not connect');
    fire(button(view, 'Back'), 'click');
    fire(button(view, 'Back'), 'click');
    expect(onBackToEmail).toHaveBeenCalledOnce();
  });

  // Ready must show the actual native plaintext fallback instead of implying every OS vault is encrypted.
  it('includes native unencrypted-key status in the completion summary', async () => {
    vi.mocked(addValidatedProvider).mockImplementationOnce(async (draft) => ({ ...draft, id: 'saved', isDefault: true, keyStorageEncrypted: false }));
    const view = render(<Harness />);
    await configureOpenAI(view);
    selectModel(view); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and enable AI'), 'click'); await settle();
    expect(onComplete).toHaveBeenLastCalledWith({ enabled: true, providerName: 'OpenAI', modelName: 'Demo model', keyStorageEncrypted: false });
  });
});

describe('AI setup reused from settings', () => {
  // Add must be a blank draft, never an implicit edit of an existing connection.
  it('starts new settings providers with blank credentials despite stored providers', () => {
    vi.mocked(loadAISettings).mockReturnValue({ providers: [{ id: 'stored', type: 'openai', name: 'OpenAI', apiKey: 'stored-key', model: 'stored-model', isDefault: true }] });
    const view = render(<Harness context="settings" />);
    fire(button(view, 'OpenAI'), 'click');
    expect(view.container.textContent).toContain('Connect OpenAI');
    expect(view.find('input[type="password"]')).toHaveProperty('value', '');
    expect(checkAIConnection).not.toHaveBeenCalled();
  });

  // Cancel/back in Settings must leave existing AI consent and enablement intact.
  it('cancels settings without declining AI consent or creating a provider', () => {
    const view = render(<Harness context="settings" />);
    fire(button(view, 'Cancel'), 'click');
    expect(onComplete).toHaveBeenCalledWith({ enabled: false });
    expect(setAiConsent).not.toHaveBeenCalled();
    expect(addValidatedProvider).not.toHaveBeenCalled();
    fire(button(view, 'Back'), 'click');
    expect(onBackToEmail).toHaveBeenCalledOnce();
  });

  // Settings addition must create a distinct entry without switching a user's existing default.
  it('tests and saves a new settings provider with explicit creation and default preservation', async () => {
    const view = render(<Harness context="settings" />);
    await configureOpenAI(view); selectModel(view); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(addValidatedProvider).toHaveBeenCalledWith(expect.objectContaining({ type: 'openai', model: 'demo-model' }), expect.any(Function), { existingId: undefined, createNew: true, makeDefault: false });
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, provider: expect.objectContaining({ id: 'saved' }) }));
  });

  // Editing uses only the selected entry's credentials and revalidates its connection before saving.
  it('prefills and saves an explicit edit with its identity rather than adding a duplicate', async () => {
    const editing = { id: 'edit-me', type: 'openai' as const, name: 'My OpenAI', apiKey: '', hasStoredKey: true, model: 'demo-model', isDefault: false };
    const view = render(<Harness context="settings" editingProvider={editing} stage="connection" />);
    // Changed deliberately (CASA H-1): the saved key is never put back into the
    // form; the field starts blank, and a blank field keeps the saved key.
    expect(view.find('input[type="password"]')).toHaveProperty('value', '');
    expect(view.find('input[type="password"]')).toHaveProperty('placeholder', 'Saved — leave blank to keep it');
    typeInto(view.find('input[type="password"]'), 'replacement-key');
    fire(button(view, 'Check connection'), 'click'); await settle(); selectModel(view);
    toggle(view.find('input[type="checkbox"]')); fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(addValidatedProvider).toHaveBeenCalledWith(expect.objectContaining({ name: 'My OpenAI' }), expect.any(Function), { existingId: 'edit-me', createNew: false, makeDefault: false });
  });

  // An OAuth provider edit must reuse its account, not force another browser login.
  it('reuses the edited Sarv identity and its existing session', async () => {
    const editing = { id: 'sarv-entry', type: 'sarv' as const, name: 'Sarv AI', apiKey: '', model: 'gpt-oss-120b', isDefault: true, authMethod: 'oauth' as const, oauthProvider: 'sarv' as const, oauthEmail: 'demo@sarv.example' };
    const view = render(<Harness context="settings" editingProvider={editing} stage="connection" />); await settle();
    expect(loadSarvAIConnection).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-oss-120b', savedSarvProvider: editing }), expect.any(AbortSignal), { email: 'demo@sarv.example' });
    expect(startFlow).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Choose your model');
  });

  // A durable credential save cannot be interrupted by Cancel after model validation succeeds.
  it('blocks closing/navigation only during the credential save and reports its completion', async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof addValidatedProvider>>) => void;
    vi.mocked(addValidatedProvider).mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    const savingChanged = vi.fn();
    const view = render(<Harness context="settings" onSavingChange={savingChanged} />);
    await configureOpenAI(view); selectModel(view); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(savingChanged).toHaveBeenLastCalledWith(true);
    for (const label of ['Cancel', 'Back', 'Change AI provider', 'Connection settings']) expect(button(view, label)).toHaveProperty('disabled', true);
    resolveSave({ id: 'saved', type: 'openai', name: 'OpenAI', apiKey: 'test-key', model: 'demo-model', isDefault: false }); await settle();
    expect(savingChanged).toHaveBeenLastCalledWith(false);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  // Failed saves must unlock cancellation and preserve the editable tested selection.
  it('unlocks settings after a vault failure without changing AI consent', async () => {
    vi.mocked(addValidatedProvider).mockRejectedValueOnce(new Error('Vault unavailable'));
    const savingChanged = vi.fn();
    const view = render(<Harness context="settings" onSavingChange={savingChanged} />);
    await configureOpenAI(view); selectModel(view); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Test model and save provider'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Vault unavailable');
    expect(savingChanged).toHaveBeenLastCalledWith(false);
    expect(button(view, 'Cancel')).toHaveProperty('disabled', false);
    expect(setAiConsent).not.toHaveBeenCalled();
  });
});

describe('provider edit authentication choices', () => {
  // An unavailable vault credential must remain replaceable instead of hiding the API-key field.
  it('keeps API-key inputs available when editing a stored provider with no hydrated key', () => {
    const editing = { id: 'no-key', type: 'openai' as const, name: 'OpenAI', apiKey: '', model: 'stored-model', isDefault: true };
    const view = render(<Harness context="settings" editingProvider={editing} stage="connection" />);
    expect(view.find('input[type="password"]')).toHaveProperty('value', '');
  });

  // Switching an OAuth Sarv edit to API-key authentication must actually offer a required key input.
  it('offers an API key when changing an edited Sarv OAuth connection', async () => {
    const editing = { id: 'sarv-edit', type: 'sarv' as const, name: 'Sarv', apiKey: '', model: 'gpt-oss-120b', isDefault: true, authMethod: 'oauth' as const, oauthEmail: 'demo@sarv.example' };
    const view = render(<Harness context="settings" editingProvider={editing} stage="connection" />); await settle();
    fire(button(view, 'Connection settings'), 'click'); fire(button(view, 'Use an API key instead'), 'click');
    expect(view.find('input[type="password"]')).toHaveProperty('value', '');
    expect(startFlow).not.toHaveBeenCalled();
  });
});

describe('recovering changed Sarv edit catalogs', () => {
  // A missing edited region/backend needs an explicit way to choose a new connection without repeating OAuth.
  it('offers a deliberate connection reset after saved-identity restoration fails', async () => {
    vi.mocked(loadSarvAIConnection).mockRejectedValueOnce(new Error('Your saved Sarv backend is no longer available'));
    const editing = { id: 'sarv-entry', type: 'sarv' as const, name: 'Sarv', apiKey: '', model: 'gpt-oss-120b', isDefault: true, authMethod: 'oauth' as const, oauthEmail: 'demo@sarv.example' };
    const view = render(<Harness context="settings" editingProvider={editing} stage="connection" />); await settle();
    fire(button(view, 'Choose a new Sarv connection'), 'click'); await settle();
    expect(loadSarvAIConnection).toHaveBeenLastCalledWith(expect.objectContaining({ savedSarvProvider: undefined, sarv: undefined, model: '' }), expect.any(AbortSignal), { email: 'demo@sarv.example' });
    expect(view.container.textContent).toContain('Choose your model'); expect(startFlow).not.toHaveBeenCalled(); expect(view.find('input[type="checkbox"]')).toHaveProperty('checked', false);
  });

  // A refreshed catalog must clear prior agreement and require a selected model instead of saving a silent substitution.
  it('shows an unavailable model warning and resets consent on a same-connection refresh', async () => {
    const editing = { id: 'sarv-entry', type: 'sarv' as const, name: 'Sarv', apiKey: '', model: 'gpt-oss-120b', isDefault: true, authMethod: 'oauth' as const, oauthEmail: 'demo@sarv.example' };
    const view = render(<Harness context="settings" editingProvider={editing} stage="connection" />); await settle(); toggle(view.find('input[type="checkbox"]'));
    vi.mocked(loadSarvAIConnection).mockResolvedValueOnce({ ...sarvConnected(), model: '', modelWarning: 'Your previous model is no longer available. Choose an available model before saving.' });
    fire(button(view, 'Connection settings'), 'click'); fire(button(view, 'Use current Sarv connection'), 'click'); await settle();
    expect(view.byLabel('Model')).toHaveProperty('value', ''); expect(view.find('input[type="checkbox"]')).toHaveProperty('checked', false);
    expect(view.find('[role="status"]')?.textContent).toContain('no longer available'); expect(button(view, 'Test model and save provider')).toHaveProperty('disabled', true);
    selectModel(view, 'gpt-oss-120b'); toggle(view.find('input[type="checkbox"]')); expect(button(view, 'Test model and save provider')).toHaveProperty('disabled', false);
  });
});
