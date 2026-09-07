import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSarvEdgeBaseUrl,
  listCaiModels,
  listCaiProviders,
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

const requestedUrls: string[] = [];

const installEnv = () => {
  requestedUrls.length = 0;
  (globalThis as any).window = {
    location: { origin: 'http://localhost' },
    electronAPI: {
      oauth: {
        getAccessToken: vi.fn().mockResolvedValue({
          success: true,
          data: { accessToken: 'test-token' },
        }),
      },
    },
  };
  // getJson logs each request (renderer console is tee'd to app.log); keep the
  // test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
};

/** Everything console.warn was handed this test, flattened for matching. */
const warnings = () =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((args) => args.map(String).join(' '));

/** Stub `fetch` with a per-URL-substring responder, recording every URL. */
const stubFetch = (routes: Array<[string, { status?: number; body: unknown }]>) => {
  (globalThis as any).fetch = vi.fn(async (url: string) => {
    requestedUrls.push(url);
    const match = routes.find(([fragment]) => url.includes(fragment));
    const status = match?.[1].status ?? 200;
    const body = JSON.stringify(match?.[1].body ?? []);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
    } as unknown as Response;
  });
};

beforeEach(installEnv);
afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).fetch;
  vi.restoreAllMocks();
});

describe('loadZoneSelection', () => {
  it('picks the default zone when the account has zones', () => {
    // The multi-zone/org case must keep working exactly as before.
    stubFetch([
      ['/oauth/v1/zones', { body: [
        { code: 'jpr1', name: 'Jaipur' },
        { code: 'blr1', name: 'Bengaluru', is_default: true },
      ] }],
    ]);

    return loadZoneSelection('https://ai.sarv.com', 'advik.d@sarv.com').then((selection) => {
      expect(selection.zoneCode).toBe('blr1');
      expect(selection.zones).toHaveLength(2);
    });
  });

  it('resolves to an empty selection on a 403 instead of rejecting', async () => {
    // THE regression: if this ever throws again, an account with credits but no
    // organization loses the whole LLM picker and AI silently stays off.
    stubFetch([
      ['/oauth/v1/zones', { status: 403, body: { detail: { error: 'missing org_id claim' } } }],
    ]);

    const selection = await loadZoneSelection('https://ai.sarv.com', 'advik.d@sarv.com');

    expect(selection).toEqual({ zones: [], zoneCode: '' });
  });

  it('records why the zone lookup failed instead of swallowing it', async () => {
    // Non-fatal must not mean invisible: this catch is why weeks of app.log held
    // `/oauth/v1/zones → 403` and not one word about the cause, leaving "the AI
    // stopped working" undiagnosable from the log.
    stubFetch([
      [
        '/oauth/v1/zones',
        { status: 403, body: { detail: { error: 'insufficient_scope', message: 'llm:view required' } } },
      ],
    ]);

    await loadZoneSelection('https://ai.sarv.com', 'advik.d@sarv.com');

    expect(warnings().join('\n')).toContain('zone lookup failed');
    expect(warnings().join('\n')).toContain('llm:view required');
  });

  it('resolves to an empty selection when the account simply has no zones', async () => {
    // A successful-but-empty response is the same survivable state as a 403 —
    // no zone code, no error.
    stubFetch([['/oauth/v1/zones', { body: [] }]]);

    await expect(loadZoneSelection('https://ai.sarv.com', 'advik.d@sarv.com')).resolves.toEqual({
      zones: [],
      zoneCode: '',
    });
  });

  it('resolves to an empty selection when the token itself cannot be minted', async () => {
    // Transient IPC/token failure must not be fatal either — the providers
    // fetch is what surfaces a genuinely unusable account.
    (globalThis as any).window.electronAPI.oauth.getAccessToken = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'no account' });
    stubFetch([]);

    await expect(loadZoneSelection('https://ai.sarv.com', 'advik.d@sarv.com')).resolves.toEqual({
      zones: [],
      zoneCode: '',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('catalog requests without a zone', () => {
  it('omits zone_code entirely when the zone code is empty', async () => {
    // The unscoped fetch is what makes a zone-less account work: an empty
    // `zone_code=` would be sent as a real filter and could match nothing.
    stubFetch([['/oauth/v1/llm/providers', { body: [{ code: 'sarv_partners', name: 'Sarv' }] }]]);

    await listCaiProviders('https://ai.sarv.com', 'advik.d@sarv.com', '');

    expect(requestedUrls[0]).toBe('https://ai.sarv.com/oauth/v1/llm/providers');
    expect(requestedUrls[0]).not.toContain('zone_code');
  });

  it('still scopes to the zone when one is available', async () => {
    // The org case must not regress into always-unscoped.
    stubFetch([['/oauth/v1/llm/models', { body: [{ code: 'gpt-oss-120b' }] }]]);

    await listCaiModels('https://ai.sarv.com', 'advik.d@sarv.com', 'sarv_partners', 'blr1');

    expect(requestedUrls[0]).toContain('provider_code=sarv_partners');
    expect(requestedUrls[0]).toContain('zone_code=blr1');
  });
});

describe('failed catalog requests', () => {
  // A 403 on the catalog is three different problems with three different
  // fixes — insufficient_scope (re-authorize for llm:view), cai_account_required
  // (no CAI account behind the login) and invalid_token. Logging only the status
  // makes them indistinguishable, and the AI just looks "off".
  it('logs the error code and message alongside the status', async () => {
    stubFetch([
      [
        '/oauth/v1/llm/providers',
        {
          status: 403,
          body: { detail: { error: 'insufficient_scope', error_description: 'llm:view required' } },
        },
      ],
    ]);

    await expect(
      listCaiProviders('https://ai.sarv.com', 'advik.d@sarv.com', ''),
    ).rejects.toThrow(/llm:view required/);

    const line = warnings().join('\n');
    expect(line).toContain('403');
    expect(line).toContain('code=insufficient_scope');
    expect(line).toContain('llm:view required');
  });

  // A permanent auth failure and a transient upstream one must stay tellable
  // apart in the log, or a retryable blip reads as "your account has no AI".
  it('logs a transient upstream failure with its own status', async () => {
    stubFetch([['/oauth/v1/llm/providers', { status: 503, body: { detail: 'upstream unavailable' } }]]);

    await expect(
      listCaiProviders('https://ai.sarv.com', 'advik.d@sarv.com', ''),
    ).rejects.toThrow(/upstream unavailable/);

    expect(warnings().join('\n')).toContain('503');
  });

  // The body is not always JSON (a gateway HTML error page); the log line must
  // still name the status rather than blowing up in the logging itself.
  it('logs a non-JSON error body without throwing in the logger', async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => '<html>bad gateway</html>',
    })) as unknown as typeof fetch;

    await expect(
      listCaiProviders('https://ai.sarv.com', 'advik.d@sarv.com', ''),
    ).rejects.toThrow(/Sarv API 502/);

    expect(warnings().join('\n')).toContain('code=502');
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
