import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addProvider, loadAISettings } from '../../../../src/services/ai-service';
import {
  ensureSarvAiProvider,
  resolveRecommendedSarvDraft,
  runEnsureSarvAiProvider,
  type EnsureSarvAiDeps,
  type SarvAccountEndpoints,
  type SarvCatalogDeps,
} from '../../../../src/services/sarv-ai-auto-register';
import type { SarvProviderDraft } from '../../../../src/services/sarv-llm-provider';

// The default catalog wiring (used by the fire-and-forget entry point) goes
// through these; the pure pickers stay real so the recommended defaults apply.
const catalogMocks = vi.hoisted(() => ({
  loadZoneSelection: vi.fn(),
  listCaiProviders: vi.fn(),
  listCaiModels: vi.fn(),
}));
vi.mock('../../../../src/services/sarv-cai-api', async (importActual) => ({
  ...(await importActual<object>()),
  ...catalogMocks,
}));

// Background auto-registration exists because the on-screen pickers can be torn
// down before they register anything (onboarding is replaced by the inbox the
// moment the Sarv mailbox connects). If these regress, a fresh install signs in
// to Sarv and still lands on "AI is inactive" — or, worse, a user's chosen
// provider gets replaced behind their back.

const account: SarvAccountEndpoints = {
  email: 'ankur.d@sarv.com',
  apiBaseUrl: 'https://ai.sarv.com',
  fallbackEdgeBaseUrl: 'https://edge.fallback.sarv.com',
};

const zone = { code: 'jpr1', name: 'Jaipur', api_domain: 'jpr1.ai.sarv.com' } as any;

const catalog = (overrides: Partial<SarvCatalogDeps> = {}): SarvCatalogDeps => ({
  loadZoneSelection: vi.fn().mockResolvedValue({ zones: [zone], zoneCode: 'jpr1' }),
  listCaiProviders: vi.fn().mockResolvedValue([
    { code: 'other_vendor', name: 'Other' },
    { code: 'sarv_partners', name: 'Sarv LLM' },
  ]),
  listCaiModels: vi.fn().mockResolvedValue([
    { code: 'small-model', display_name: 'Small' },
    { code: 'gpt-oss-120b', display_name: 'Sarv Mati' },
  ]),
  ...overrides,
});

describe('resolveRecommendedSarvDraft', () => {
  it('drafts the recommended provider + model in the default zone', async () => {
    // Background registration must pick the SAME default the pickers show,
    // not whatever the catalog lists first.
    const deps = catalog();
    const result = await resolveRecommendedSarvDraft(account, deps);
    expect(result).toEqual({
      ok: true,
      draft: expect.objectContaining({ modelCode: 'gpt-oss-120b', email: account.email, name: 'Sarv · Sarv LLM · Sarv Mati' }),
    });
    expect(deps.listCaiProviders).toHaveBeenCalledWith(account.apiBaseUrl, account.email, 'jpr1');
    expect(deps.listCaiModels).toHaveBeenCalledWith(account.apiBaseUrl, account.email, 'sarv_partners', 'jpr1');
  });

  it('falls back to the env edge URL when the account has no zone', async () => {
    // Accounts with credits but no org get a zones 403 → no zone; they must
    // still get a working provider, not be dropped.
    const deps = catalog({ loadZoneSelection: vi.fn().mockResolvedValue({ zones: [], zoneCode: '' }) });
    const result = await resolveRecommendedSarvDraft(account, deps);
    expect(result.ok).toBe(true);
    expect(result.ok && result.draft.baseUrl).toContain('edge.fallback.sarv.com');
  });

  it('reports no-edge-url when there is neither a zone nor a fallback', async () => {
    // A provider with no URL would be registered broken; refuse instead.
    const deps = catalog({ loadZoneSelection: vi.fn().mockResolvedValue({ zones: [], zoneCode: '' }) });
    const result = await resolveRecommendedSarvDraft({ ...account, fallbackEdgeBaseUrl: null }, deps);
    expect(result).toEqual({ ok: false, reason: 'no-edge-url' });
  });

  it('reports incomplete and skips the models call when the catalog has no providers', async () => {
    // An account with no LLM access must not register an empty provider.
    const deps = catalog({ listCaiProviders: vi.fn().mockResolvedValue([]) });
    expect(await resolveRecommendedSarvDraft(account, deps)).toEqual({ ok: false, reason: 'incomplete' });
    expect(deps.listCaiModels).not.toHaveBeenCalled();
  });

  it('propagates a catalog failure so it is treated as transient, not "no models"', async () => {
    // A network blip must not be mistaken for an account with nothing to register.
    const deps = catalog({ listCaiModels: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) });
    await expect(resolveRecommendedSarvDraft(account, deps)).rejects.toThrow('ETIMEDOUT');
  });
});

const draft: SarvProviderDraft = {
  name: 'Sarv · Sarv LLM · Sarv Mati',
  modelCode: 'gpt-oss-120b',
  baseUrl: 'https://jpr1.ai.sarv.com',
  email: account.email,
};

const ensureDeps = (overrides: Partial<EnsureSarvAiDeps> = {}): EnsureSarvAiDeps => ({
  readAccount: vi.fn().mockResolvedValue(account),
  resolveDraft: vi.fn().mockResolvedValue({ ok: true, draft }),
  hasDefaultProvider: vi.fn().mockReturnValue(false),
  register: vi.fn().mockReturnValue({ provider: { id: 'p1' }, added: true }),
  // The user already agreed; the consent gate has its own tests below.
  getConsent: vi.fn().mockReturnValue('granted'),
  askConsent: vi.fn().mockResolvedValue('granted'),
  ...overrides,
});

describe('runEnsureSarvAiProvider', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('registers the recommended model for a signed-in account with no provider', async () => {
    // The fresh-install case: signed in, nothing registered → AI must activate.
    const deps = ensureDeps();
    expect(await runEnsureSarvAiProvider(deps)).toBe('registered');
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.register).toHaveBeenCalledWith(draft);
  });

  it('leaves an existing default provider alone and does no network work', async () => {
    // Must never replace a model (or non-Sarv provider) the user chose, and must
    // not hit the catalog on every boot for users who are already set up.
    const deps = ensureDeps({ hasDefaultProvider: vi.fn().mockReturnValue(true) });
    expect(await runEnsureSarvAiProvider(deps)).toBe('has-default');
    expect(deps.readAccount).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  it('does not register when a provider was added while the catalog was loading', async () => {
    // Onboarding's Continue can land mid-walk; its explicit choice wins.
    const hasDefault = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const deps = ensureDeps({ hasDefaultProvider: hasDefault });
    expect(await runEnsureSarvAiProvider(deps)).toBe('has-default');
    expect(deps.register).not.toHaveBeenCalled();
  });

  it('does nothing when no Sarv account is signed in', async () => {
    // Users on Gmail/IMAP only must not get a Sarv provider out of nowhere.
    const deps = ensureDeps({ readAccount: vi.fn().mockResolvedValue(null) });
    expect(await runEnsureSarvAiProvider(deps)).toBe('not-signed-in');
    expect(deps.resolveDraft).not.toHaveBeenCalled();
  });

  it.each(['incomplete', 'no-edge-url'] as const)('does not register when the draft is %s', async (reason) => {
    // A half-resolved selection would register a broken provider.
    const deps = ensureDeps({ resolveDraft: vi.fn().mockResolvedValue({ ok: false, reason }) });
    expect(await runEnsureSarvAiProvider(deps)).toBe(reason);
    expect(deps.register).not.toHaveBeenCalled();
  });

  // Consent gate. Breaks if: Sarv AI starts reading mail (Gmail data included)
  // on sign-in with no agreement — a Google Limited Use / privacy-policy breach.
  it('asks once when never asked, and registers only on yes', async () => {
    const deps = ensureDeps({ getConsent: vi.fn().mockReturnValue(null) });
    expect(await runEnsureSarvAiProvider(deps)).toBe('registered');
    expect(deps.askConsent).toHaveBeenCalledTimes(1);
  });

  it('registers nothing and walks no catalog when the user says no', async () => {
    const deps = ensureDeps({
      getConsent: vi.fn().mockReturnValue(null),
      askConsent: vi.fn().mockResolvedValue('declined'),
    });
    expect(await runEnsureSarvAiProvider(deps)).toBe('declined');
    expect(deps.resolveDraft).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  // Idempotent re-run: an earlier "no" is not asked again on every launch.
  it('does not ask again after an earlier no', async () => {
    const deps = ensureDeps({ getConsent: vi.fn().mockReturnValue('declined') });
    expect(await runEnsureSarvAiProvider(deps)).toBe('declined');
    expect(deps.askConsent).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
  });

  // Only a signed-in user with no provider is ever asked.
  it('does not ask when nobody is signed in or a provider already exists', async () => {
    const signedOut = ensureDeps({ getConsent: vi.fn().mockReturnValue(null), readAccount: vi.fn().mockResolvedValue(null) });
    expect(await runEnsureSarvAiProvider(signedOut)).toBe('not-signed-in');
    expect(signedOut.askConsent).not.toHaveBeenCalled();

    const hasOne = ensureDeps({ getConsent: vi.fn().mockReturnValue(null), hasDefaultProvider: vi.fn().mockReturnValue(true) });
    expect(await runEnsureSarvAiProvider(hasOne)).toBe('has-default');
    expect(hasOne.askConsent).not.toHaveBeenCalled();
  });

  it('returns failed (never throws) on a transient catalog error', async () => {
    // Fire-and-forget callers must not get an unhandled rejection; the next
    // boot or sign-in retries.
    const deps = ensureDeps({ resolveDraft: vi.fn().mockRejectedValue(new Error('503')) });
    expect(await runEnsureSarvAiProvider(deps)).toBe('failed');
    expect(deps.register).not.toHaveBeenCalled();
  });
});

describe('ensureSarvAiProvider (wired to main + stored settings)', () => {
  const store = new Map<string, string>();
  let listProviders: ReturnType<typeof vi.fn>;
  let listAccounts: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    listProviders = vi.fn().mockResolvedValue({
      success: true,
      data: [{ id: 'sarv', apiBaseUrl: 'https://ai.sarv.com', llmBaseUrl: null }],
    });
    listAccounts = vi.fn().mockResolvedValue({
      success: true,
      data: [{ provider: 'gmail', email: 'me@gmail.com' }],
    });
    (globalThis as any).window = {
      electronAPI: {
        oauth: { listProviders, listAccounts },
        aiSecrets: { set: vi.fn(), delete: vi.fn(), get: vi.fn() },
        ai: { setProviderConfigured: vi.fn().mockResolvedValue({ success: true }) },
        agent: { setAIConfig: vi.fn().mockResolvedValue({ success: true }) },
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete (globalThis as any).localStorage;
    delete (globalThis as any).window;
    vi.restoreAllMocks();
  });

  it('ignores other OAuth accounts — only a Sarv account triggers registration', async () => {
    // Multi-account: a Gmail OAuth account is not a Sarv sign-in.
    expect(await ensureSarvAiProvider()).toBe('not-signed-in');
    expect(loadAISettings().providers).toHaveLength(0);
  });

  it('treats a failed account read from main as not-signed-in', async () => {
    // An unreadable account list must not be guessed at.
    listAccounts.mockResolvedValue({ success: false, error: 'boom' });
    expect(await ensureSarvAiProvider()).toBe('not-signed-in');
  });

  it('treats a failed provider-config read from main as not-signed-in', async () => {
    // Without the Sarv API base URL there is no catalog to walk.
    listAccounts.mockResolvedValue({ success: true, data: [{ provider: 'sarv', email: account.email }] });
    listProviders.mockResolvedValue({ success: false, error: 'boom' });
    expect(await ensureSarvAiProvider()).toBe('not-signed-in');
  });

  it('skips main entirely when a provider is already stored', async () => {
    // The common boot path for set-up users: zero IPC, zero network.
    addProvider('openai', 'sk-test', 'gpt-4o');
    expect(await ensureSarvAiProvider()).toBe('has-default');
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('registers the recommended Sarv model end to end for a signed-in Sarv account', async () => {
    // The whole fresh-install path: main reports a Sarv account, the catalog is
    // walked, and a default provider is stored and pushed to main.
    listAccounts.mockResolvedValue({
      success: true,
      data: [{ provider: 'gmail', email: 'me@gmail.com' }, { provider: 'sarv', email: account.email }],
    });
    catalogMocks.loadZoneSelection.mockResolvedValue({ zones: [zone], zoneCode: 'jpr1' });
    catalogMocks.listCaiProviders.mockResolvedValue([{ code: 'sarv_partners', name: 'Sarv LLM' }]);
    catalogMocks.listCaiModels.mockResolvedValue([{ code: 'gpt-oss-120b', display_name: 'Sarv Mati' }]);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    // The user agreed to Sarv AI earlier (the consent prompt).
    store.set('sarvinbox-ai-consent', 'granted');

    expect(await ensureSarvAiProvider()).toBe('registered');
    const [stored] = loadAISettings().providers;
    expect(stored).toMatchObject({ oauthProvider: 'sarv', oauthEmail: account.email, model: 'gpt-oss-120b', isDefault: true });
    expect((globalThis as any).window.electronAPI.ai.setProviderConfigured).toHaveBeenCalledWith(true);
    // Idempotent re-run (next boot): the stored default short-circuits it.
    expect(await ensureSarvAiProvider()).toBe('has-default');
    expect(loadAISettings().providers).toHaveLength(1);
  });

  it('shares one run between concurrent callers (boot + sign-in at once)', async () => {
    // Two overlapping triggers must not walk the catalog twice.
    const first = ensureSarvAiProvider();
    const second = ensureSarvAiProvider();
    expect(second).toBe(first);
    await first;
    expect(listAccounts).toHaveBeenCalledTimes(1);
    // …and a later call starts a fresh run (a retry after a transient failure).
    await ensureSarvAiProvider();
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });
});
