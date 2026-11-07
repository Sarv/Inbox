import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSarvEdgeBaseUrl,
  listCaiModels,
  listCaiProviders,
  listCaiZones,
  loadZoneSelection,
  pickRecommendedModel,
  pickRecommendedProvider,
  RECOMMENDED_SARV_MODEL,
  RECOMMENDED_SARV_PROVIDER,
  type SarvLLMModel,
} from '../../../../src/services/sarv-cai-api';

// A Sarv account can hold CAI credits without belonging to an organization,
// and `/oauth/v1/zones` is the ONE org-gated endpoint in the catalog. Before
// this, a 403 there was treated as fatal: no zone → no providers → no model →
// no AI provider registered, so the account signed in fine, synced mail fine,
// and sat behind an "AI inactive" banner forever. These tests pin the contract
// that a missing zone is survivable end to end.

// The catalog is fetched by MAIN (`oauth:sarvCatalog`): the renderer never
// holds the Sarv token, which is also the Sarv mailbox's XOAUTH2 credential
// (CASA I-2). Changed deliberately (CASA I-2): these tests used to stub the
// renderer's own `fetch` + `oauth.getAccessToken`; that path no longer exists,
// so they stub the IPC call instead. What each pins is unchanged — the request
// and error-parsing halves moved to core's sarv-catalog.test.ts and main's
// sarv-catalog-service.test.ts.

type CatalogRequest = { kind: string; email: string; providerCode?: string; zoneCode?: string };
type CatalogAnswer = { ok: true; body: unknown } | { ok: false; status: number; code: string; message: string };

const catalogRequests: CatalogRequest[] = [];
const fetchSpy = vi.fn();

const installEnv = () => {
  catalogRequests.length = 0;
  fetchSpy.mockReset();
  (globalThis as any).fetch = fetchSpy;
  (globalThis as any).window = {
    location: { origin: 'http://localhost' },
    electronAPI: { oauth: { sarvCatalog: vi.fn(async () => ({ ok: true, body: [] })) } },
  };
  // loadZoneSelection logs its non-fatal failure (renderer console is tee'd to
  // app.log); keep the test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};

/** Everything console.warn was handed this test, flattened for matching. */
const warnings = () =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => args.map(String).join(' '));

/** Answer the catalog IPC per list kind, recording every request. */
const stubCatalog = (answers: Partial<Record<string, CatalogAnswer>>) => {
  (globalThis as any).window.electronAPI.oauth.sarvCatalog = vi.fn(async (request: CatalogRequest) => {
    catalogRequests.push(request);
    return answers[request.kind] ?? { ok: true, body: [] };
  });
};

beforeEach(installEnv);
afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).fetch;
  vi.restoreAllMocks();
});

describe('loadZoneSelection', () => {
  it('picks the default zone when the account has zones', async () => {
    // The multi-zone/org case must keep working exactly as before.
    stubCatalog({
      zones: { ok: true, body: [
        { code: 'jpr1', name: 'Jaipur' },
        { code: 'blr1', name: 'Bengaluru', is_default: true },
      ] },
    });

    const selection = await loadZoneSelection('advik.d@sarv.com');

    expect(selection.zoneCode).toBe('blr1');
    expect(selection.zones).toHaveLength(2);
    expect(catalogRequests).toEqual([{ kind: 'zones', email: 'advik.d@sarv.com' }]);
  });

  it('resolves to an empty selection on a 403 instead of rejecting', async () => {
    // THE regression: if this ever throws again, an account with credits but no
    // organization loses the whole LLM picker and AI silently stays off.
    stubCatalog({ zones: { ok: false, status: 403, code: 'missing org_id claim', message: 'missing org_id claim' } });

    const selection = await loadZoneSelection('advik.d@sarv.com');

    expect(selection).toEqual({ zones: [], zoneCode: '' });
  });

  it('records why the zone lookup failed instead of swallowing it', async () => {
    // Non-fatal must not mean invisible: this catch is why weeks of app.log held
    // `/oauth/v1/zones → 403` and not one word about the cause, leaving "the AI
    // stopped working" undiagnosable from the log.
    stubCatalog({ zones: { ok: false, status: 403, code: 'insufficient_scope', message: 'llm:view required' } });

    await loadZoneSelection('advik.d@sarv.com');

    expect(warnings().join('\n')).toContain('zone lookup failed');
    expect(warnings().join('\n')).toContain('llm:view required');
  });

  it('resolves to an empty selection when the account simply has no zones', async () => {
    // A successful-but-empty response is the same survivable state as a 403 —
    // no zone code, no error.
    stubCatalog({ zones: { ok: true, body: [] } });

    await expect(loadZoneSelection('advik.d@sarv.com')).resolves.toEqual({
      zones: [],
      zoneCode: '',
    });
  });

  it('resolves to an empty selection when the token itself cannot be minted', async () => {
    // Transient IPC/token failure must not be fatal either — the providers
    // fetch is what surfaces a genuinely unusable account. Permanent (signed
    // out) and transient (OAuth server unreachable) both stay non-fatal here.
    stubCatalog({ zones: { ok: false, status: 0, code: 'sign_in_required', message: 'No OAuth account for sarv:advik.d@sarv.com' } });
    await expect(loadZoneSelection('advik.d@sarv.com')).resolves.toEqual({ zones: [], zoneCode: '' });

    stubCatalog({ zones: { ok: false, status: 0, code: 'token_unavailable', message: 'Cannot reach OAuth server' } });
    await expect(loadZoneSelection('advik.d@sarv.com')).resolves.toEqual({ zones: [], zoneCode: '' });

    // Even the IPC call itself rejecting (main refused the sender) is survivable.
    (globalThis as any).window.electronAPI.oauth.sarvCatalog = vi.fn(async () => { throw new Error('Refused IPC'); });
    await expect(loadZoneSelection('advik.d@sarv.com')).resolves.toEqual({ zones: [], zoneCode: '' });
  });
});

describe('catalog requests go through main, carrying no URL and no token', () => {
  // THE I-2 regression: breaks if the renderer fetches the catalog itself
  // again (with a bearer it would have to hold), or chooses where main sends it.
  it('asks main by kind and account, with no URL, token or fetch of its own', async () => {
    stubCatalog({ providers: { ok: true, body: [{ code: 'sarv_partners', name: 'Sarv' }] } });

    await listCaiProviders('advik.d@sarv.com', '');
    await listCaiModels('advik.d@sarv.com', 'sarv_partners', 'blr1');
    await listCaiZones('advik.d@sarv.com');

    expect(catalogRequests).toEqual([
      { kind: 'providers', email: 'advik.d@sarv.com', zoneCode: '' },
      { kind: 'models', email: 'advik.d@sarv.com', providerCode: 'sarv_partners', zoneCode: 'blr1' },
      { kind: 'zones', email: 'advik.d@sarv.com' },
    ]);
    expect(JSON.stringify(catalogRequests)).not.toMatch(/https?:|Bearer|token/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('catalog payload normalisation', () => {
  // Breaks: a server that answers `{ data: [...] }` or uses `id` instead of
  // `code` empties the pickers.
  it('unwraps wrapped lists and normalises id/code and names', async () => {
    stubCatalog({
      providers: { ok: true, body: { data: [{ id: 'p1', display_name: 'Partner' }] } },
      models: { ok: true, body: { models: [{ id: 'm1', name: 'Model', provider_id: 'p1', supports_streaming: true }] } },
      zones: { ok: true, body: { zones: [{ id: 'z1', api_domain: 'https://z1.sarv.com' }] } },
    });

    await expect(listCaiProviders('a@sarv.com')).resolves.toEqual([{ code: 'p1', name: 'Partner' }]);
    await expect(listCaiModels('a@sarv.com', 'p1')).resolves.toEqual([
      { code: 'm1', display_name: 'Model', provider_code: 'p1', supports_streaming: true },
    ]);
    await expect(listCaiZones('a@sarv.com')).resolves.toEqual([
      { code: 'z1', name: null, country: null, city: null, api_domain: 'https://z1.sarv.com', is_default: false },
    ]);
  });

  // An unexpected shape is an empty list, not a crash.
  it('treats a non-list answer as empty', async () => {
    stubCatalog({ providers: { ok: true, body: { unexpected: true } } });
    await expect(listCaiProviders('a@sarv.com')).resolves.toEqual([]);
    stubCatalog({ providers: { ok: true, body: null } });
    await expect(listCaiProviders('a@sarv.com')).resolves.toEqual([]);
  });
});

describe('failed catalog requests', () => {
  // A 403 on the catalog is three different problems with three different
  // fixes — insufficient_scope (re-authorize for llm:view), cai_account_required
  // (no CAI account behind the login) and invalid_token. The error the UI shows
  // must carry the server's reason, and its code and status for the caller.
  it('rejects with the server message, code and status', async () => {
    stubCatalog({ providers: { ok: false, status: 403, code: 'insufficient_scope', message: 'llm:view required' } });

    const err = await listCaiProviders('advik.d@sarv.com', '').catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('llm:view required');
    expect(err).toMatchObject({ status: 403, code: 'insufficient_scope' });
  });

  // A permanent auth failure and a transient upstream one must stay tellable
  // apart, or a retryable blip reads as "your account has no AI".
  it('keeps a transient upstream failure distinct from a permanent one', async () => {
    stubCatalog({ providers: { ok: false, status: 503, code: '503', message: 'upstream unavailable' } });
    await expect(listCaiProviders('advik.d@sarv.com', '')).rejects.toMatchObject({ status: 503, message: 'upstream unavailable' });

    stubCatalog({ providers: { ok: false, status: 0, code: 'sign_in_required', message: 'Token refresh failed (400): invalid_grant' } });
    await expect(listCaiProviders('advik.d@sarv.com', '')).rejects.toMatchObject({
      status: 0, code: 'sign_in_required', message: 'Token refresh failed (400): invalid_grant',
    });

    stubCatalog({ providers: { ok: false, status: 0, code: 'token_unavailable', message: 'Cannot reach OAuth server' } });
    await expect(listCaiProviders('advik.d@sarv.com', '')).rejects.toMatchObject({ code: 'token_unavailable' });
  });
});

describe('pickRecommendedProvider / pickRecommendedModel', () => {
  it('prefers sarv_partners over an earlier entry in the catalog', () => {
    // Settings used to take `list[0]`, so it could register a different
    // provider than onboarding did for the same account.
    const picked = pickRecommendedProvider([
      { code: 'openai_direct', name: 'OpenAI' },
      { code: RECOMMENDED_SARV_PROVIDER, name: 'Sarv Partners' },
    ]);

    expect(picked?.code).toBe(RECOMMENDED_SARV_PROVIDER);
  });

  it('falls back to the first provider when sarv_partners is absent', () => {
    const picked = pickRecommendedProvider([{ code: 'openai_direct', name: 'OpenAI' }]);
    expect(picked?.code).toBe('openai_direct');
  });

  it('returns undefined for an empty provider list', () => {
    // Callers turn this into '' and leave Continue disabled.
    expect(pickRecommendedProvider([])).toBeUndefined();
  });

  it('prefers the fine-tuned model only for sarv_partners', () => {
    const models: SarvLLMModel[] = [
      { code: 'other-model', provider_code: RECOMMENDED_SARV_PROVIDER },
      { code: RECOMMENDED_SARV_MODEL, provider_code: RECOMMENDED_SARV_PROVIDER },
    ];

    expect(pickRecommendedModel(models, RECOMMENDED_SARV_PROVIDER)?.code)
      .toBe(RECOMMENDED_SARV_MODEL);
    // For any other provider the catalog order wins — gpt-oss-120b is only
    // the recommendation because Sarv fine-tuned its own hosting of it.
    expect(pickRecommendedModel(models, 'openai_direct')?.code).toBe('other-model');
  });

  it('returns undefined for an empty model list', () => {
    expect(pickRecommendedModel([], RECOMMENDED_SARV_PROVIDER)).toBeUndefined();
    expect(pickRecommendedModel([], 'openai_direct')).toBeUndefined();
  });
});

describe('buildSarvEdgeBaseUrl', () => {
  it('uses the zone api_domain when there is a zone', () => {
    expect(buildSarvEdgeBaseUrl('https://blr1-ai-edge.sarv.com', null))
      .toBe('https://blr1-ai-edge.sarv.com/edge/v1/llm');
  });

  it('falls back to the configured edge URL when there is no zone', () => {
    // This is the path a zone-less account takes — if it broke, the fix above
    // would produce a provider pointing at a malformed URL.
    expect(buildSarvEdgeBaseUrl(null, 'https://jpr1-ai-edge.sarv.com/edge/v1/llm'))
      .toBe('https://jpr1-ai-edge.sarv.com/edge/v1/llm');
  });

  it('accepts a fallback that has no /edge/v1/llm suffix', () => {
    expect(buildSarvEdgeBaseUrl(undefined, 'https://jpr1-ai-edge.sarv.com'))
      .toBe('https://jpr1-ai-edge.sarv.com/edge/v1/llm');
  });

  it('never emits a doubled slash', () => {
    expect(buildSarvEdgeBaseUrl('https://blr1-ai-edge.sarv.com///', null))
      .toBe('https://blr1-ai-edge.sarv.com/edge/v1/llm');
  });

  it('returns an empty string when neither source is available', () => {
    // Callers must show "no edge URL" rather than registering a provider whose
    // baseUrl is just "/edge/v1/llm".
    expect(buildSarvEdgeBaseUrl(null, null)).toBe('');
    expect(buildSarvEdgeBaseUrl('', '')).toBe('');
  });
});
