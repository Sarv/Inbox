import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAISettings, getDefaultProvider, addProvider } from '../../../../src/services/ai-service';
import {
  buildSarvProviderDraft,
  findRegisteredSarvProvider,
  registerSarvProvider,
  NO_EDGE_URL_MESSAGE,
  type SarvProviderSelection,
} from '../../../../src/services/sarv-llm-provider';

// Signing in to Sarv now auto-registers the recommended provider/model so a
// fresh sign-in isn't left behind the "AI is inactive" banner. Two things have
// to hold for that to be safe, and these tests pin both: the registration is
// IDEMPOTENT (auto-register + a later "Add to AI providers" click on the same
// tuple must not produce two entries pointing at the same model), and it never
// steals the default from a provider the user already chose.

const installEnv = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  // saveAISettings / syncAIProviderToMain reach for IPC; stub it.
  (globalThis as any).window = {
    electronAPI: {
      aiSecrets: { set: vi.fn(), delete: vi.fn(), get: vi.fn() },
      ai: { setProviderConfigured: vi.fn().mockResolvedValue({ success: true }) },
      agent: { setAIConfig: vi.fn().mockResolvedValue({ success: true }) },
    },
  };
};

beforeEach(installEnv);
afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

const selection = (overrides: Partial<SarvProviderSelection> = {}): SarvProviderSelection => ({
  email: 'ankur.d@sarv.com',
  providerCode: 'sarv_partners',
  modelCode: 'gpt-oss-120b',
  zoneCode: 'jpr1',
  providers: [{ code: 'sarv_partners', name: 'Sarv LLM' } as any],
  models: [{ code: 'gpt-oss-120b', display_name: 'Sarv Mati' } as any],
  zones: [{ code: 'jpr1', api_domain: 'https://jpr1-ai-edge.sarv.com' } as any],
  fallbackEdgeBaseUrl: 'https://fallback.sarv.com/edge/v1/llm',
  ...overrides,
});

describe('buildSarvProviderDraft', () => {
  it('names the entry from the catalog labels and points it at the zone edge URL', () => {
    // If the name or URL drifts, Settings and onboarding register two
    // different-looking entries for the same model.
    const result = buildSarvProviderDraft(selection());
    expect(result).toEqual({
      ok: true,
      draft: {
        name: 'Sarv · Sarv LLM · Sarv Mati',
        modelCode: 'gpt-oss-120b',
        baseUrl: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm',
        email: 'ankur.d@sarv.com',
      },
    });
  });

  it('falls back to the raw codes when the catalog has no display labels', () => {
    // A catalog entry without a name must still produce a usable provider,
    // not "Sarv · undefined · undefined".
    const result = buildSarvProviderDraft(selection({ providers: [], models: [] }));
    expect(result).toMatchObject({ ok: true, draft: { name: 'Sarv · sarv_partners · gpt-oss-120b' } });
  });

  it('uses the env fallback edge URL when the account has no zone', () => {
    // An account with credits but no org gets a 403 from /zones — it must
    // still be able to register a provider.
    const result = buildSarvProviderDraft(selection({ zones: [], zoneCode: '' }));
    expect(result).toMatchObject({ ok: true, draft: { baseUrl: 'https://fallback.sarv.com/edge/v1/llm' } });
  });

  it('reports "incomplete" while the catalog has not resolved a provider/model yet', () => {
    // The auto-registration effect must stay silent here rather than showing
    // an error on a still-loading picker.
    expect(buildSarvProviderDraft(selection({ providerCode: '', modelCode: '' })))
      .toEqual({ ok: false, reason: 'incomplete' });
  });

  it('reports "no-edge-url" when there is neither a zone nor a fallback', () => {
    // Registering here would store a broken base URL that fails on every call.
    expect(buildSarvProviderDraft(selection({ zones: [], zoneCode: '', fallbackEdgeBaseUrl: null })))
      .toEqual({ ok: false, reason: 'no-edge-url' });
    expect(NO_EDGE_URL_MESSAGE).toContain('No Sarv edge URL available');
  });
});

describe('registerSarvProvider', () => {
  const draftOf = (sel: SarvProviderSelection) => {
    const result = buildSarvProviderDraft(sel);
    if (!result.ok) throw new Error(`expected a draft, got ${result.reason}`);
    return result.draft;
  };

  it('registers the model as an OAuth-backed provider and makes the first one default', () => {
    // This is what clears the "AI is inactive" banner right after sign-in.
    const { provider, added } = registerSarvProvider(draftOf(selection()));
    expect(added).toBe(true);
    expect(provider).toMatchObject({
      type: 'sarv',
      model: 'gpt-oss-120b',
      authMethod: 'oauth',
      oauthProvider: 'sarv',
      oauthEmail: 'ankur.d@sarv.com',
      isDefault: true,
    });
    expect(loadAISettings().providers).toHaveLength(1);
  });

  it('is idempotent — re-registering the same tuple returns the existing entry', () => {
    // Auto-registration on sign-in plus a later "Add to AI providers" click
    // must not leave two identical providers in the list.
    const draft = draftOf(selection());
    const first = registerSarvProvider(draft);
    const second = registerSarvProvider(draft);
    expect(second.added).toBe(false);
    expect(second.provider.id).toBe(first.provider.id);
    expect(loadAISettings().providers).toHaveLength(1);
  });

  it('treats the same model in a different region as a separate provider', () => {
    // Region is part of the identity: two zones are two different endpoints.
    registerSarvProvider(draftOf(selection()));
    const other = registerSarvProvider(draftOf(selection({
      zoneCode: 'del1',
      zones: [{ code: 'del1', api_domain: 'https://del1-ai-edge.sarv.com' } as any],
    })));
    expect(other.added).toBe(true);
    expect(loadAISettings().providers).toHaveLength(2);
  });

  it('does NOT steal the default from a provider the user already chose', () => {
    // Auto-registration is a convenience; silently repointing AI at Sarv when
    // the user had configured their own key would be a behaviour change.
    const mine = addProvider('openai', 'sk-test', 'gpt-4o');
    registerSarvProvider(draftOf(selection()));
    expect(getDefaultProvider()?.id).toBe(mine.id);
  });

  it('makes the entry default when the caller asks (onboarding Continue)', () => {
    // Onboarding's picker IS an explicit choice, so it overrides.
    addProvider('openai', 'sk-test', 'gpt-4o');
    const { provider } = registerSarvProvider(draftOf(selection()), { makeDefault: true });
    expect(getDefaultProvider()?.id).toBe(provider.id);
  });
});

describe('findRegisteredSarvProvider', () => {
  it('matches on account, model and edge URL, ignoring unrelated providers', () => {
    // Drives the "Already added" state on the Add button; a false negative
    // there is how a duplicate gets added by hand.
    const draft = {
      name: 'Sarv · Sarv LLM · Sarv Mati',
      modelCode: 'gpt-oss-120b',
      baseUrl: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm',
      email: 'ankur.d@sarv.com',
    };
    const registered = registerSarvProvider(draft).provider;
    const providers = loadAISettings().providers;
    expect(findRegisteredSarvProvider(providers, draft)?.id).toBe(registered.id);
    expect(findRegisteredSarvProvider(providers, { ...draft, email: 'someone@sarv.com' })).toBeUndefined();
    expect(findRegisteredSarvProvider(providers, { ...draft, modelCode: 'other-model' })).toBeUndefined();
    expect(findRegisteredSarvProvider([], draft)).toBeUndefined();
  });
});
