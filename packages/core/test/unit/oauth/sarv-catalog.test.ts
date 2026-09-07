import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SarvApiError } from '../../../src/agent/categorization-utils';
import {
  fetchSarvProviders,
  fetchSarvModels,
  fetchSarvZones,
  fetchSarvWallet,
} from '../../../src/oauth/sarv-catalog';

// These four discovery calls populate the provider/model/zone pickers and the
// wallet display. Two things must not regress: the URL/auth shape (a doubled
// slash or a missing Bearer header makes every picker empty with no visible
// reason), and the error mapping — the calling UI branches ONLY on
// SarvApiError.code to decide "refresh the token" vs "top up the wallet" vs
// "back off", so a mis-mapped status sends the user down the wrong path.
// All fetches are stubbed; nothing leaves the process.

const TOKEN = 'jwt-access-token';

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => payload),
    text: vi.fn(async () => JSON.stringify(payload)),
    headers: new Headers(),
  } as unknown as Response;
}

function errorResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  return {
    ok: false,
    status,
    json: vi.fn(async () => JSON.parse(body)),
    text: vi.fn(async () => body),
    headers: new Headers(headers),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lastInit = () => fetchMock.mock.calls[0][1] as RequestInit;
const lastUrl = () => fetchMock.mock.calls[0][0] as string;

describe('sarv-catalog — request shape', () => {
  // Every endpoint needs the llm:view-scoped JWT as a Bearer header; without it
  // the server answers 401 and the UI shows an empty catalog.
  it('GETs the providers endpoint with Bearer auth and a JSON Accept header', async () => {
    fetchMock.mockResolvedValue(okJson([]));

    await fetchSarvProviders('https://ai.sarv.com', TOKEN);

    expect(lastUrl()).toBe('https://ai.sarv.com/oauth/v1/llm/providers');
    const init = lastInit() as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['Accept']).toBe('application/json');
  });

  // apiBaseUrl comes from config/env and users add trailing slashes; '//oauth'
  // 404s on the gateway.
  it('strips a trailing slash from apiBaseUrl so the path never doubles up', async () => {
    fetchMock.mockResolvedValue(okJson([]));

    await fetchSarvProviders('https://ai.sarv.com/', TOKEN);

    expect(lastUrl()).toBe('https://ai.sarv.com/oauth/v1/llm/providers');
    expect(lastUrl()).not.toContain('//oauth');
  });

  it('builds the zones and wallet URLs off the same base', async () => {
    fetchMock.mockResolvedValue(okJson([]));
    await fetchSarvZones('http://localhost:8880/', TOKEN);
    expect(lastUrl()).toBe('http://localhost:8880/oauth/v1/zones');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(okJson({ balance: 0, currency: 'INR', locked: false }));
    await fetchSarvWallet('http://localhost:8880', TOKEN);
    expect(lastUrl()).toBe('http://localhost:8880/oauth/v1/wallet');
  });

  it('omits the query string entirely when no providerCode is given', async () => {
    fetchMock.mockResolvedValue(okJson([]));

    await fetchSarvModels('https://ai.sarv.com', TOKEN);

    expect(lastUrl()).toBe('https://ai.sarv.com/oauth/v1/llm/models');
    expect(lastUrl()).not.toContain('?');
  });

  // Provider codes are server-supplied strings; an unescaped one with '&' or a
  // space would truncate the filter and quietly return the WRONG model list.
  it('percent-encodes the provider_code filter', async () => {
    fetchMock.mockResolvedValue(okJson([]));

    await fetchSarvModels('https://ai.sarv.com', TOKEN, { providerCode: 'open ai&x=1' });

    expect(lastUrl()).toBe('https://ai.sarv.com/oauth/v1/llm/models?provider_code=open%20ai%26x%3D1');
  });

  // The pickers cancel in-flight requests when the user closes the dialog or
  // switches provider; dropping the signal leaks the request and races a stale
  // response into the UI.
  it('forwards the AbortSignal on every fetcher', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(okJson([]));

    await fetchSarvProviders('https://ai.sarv.com', TOKEN, controller.signal);
    expect(lastInit().signal).toBe(controller.signal);

    fetchMock.mockClear();
    await fetchSarvModels('https://ai.sarv.com', TOKEN, { signal: controller.signal });
    expect(lastInit().signal).toBe(controller.signal);

    fetchMock.mockClear();
    await fetchSarvZones('https://ai.sarv.com', TOKEN, controller.signal);
    expect(lastInit().signal).toBe(controller.signal);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(okJson({ balance: 1, currency: 'INR', locked: false }));
    await fetchSarvWallet('https://ai.sarv.com', TOKEN, controller.signal);
    expect(lastInit().signal).toBe(controller.signal);
  });
});

describe('sarv-catalog — payload handling', () => {
  it('returns the parsed provider/model/zone lists as-is', async () => {
    fetchMock.mockResolvedValue(okJson([{ code: 'openai', name: 'OpenAI' }]));
    await expect(fetchSarvProviders('https://ai.sarv.com', TOKEN)).resolves.toEqual([
      { code: 'openai', name: 'OpenAI' },
    ]);

    fetchMock.mockResolvedValue(
      okJson([{ code: 'gpt-4o', display_name: 'GPT-4o', provider_code: 'openai', supports_streaming: true }]),
    );
    await expect(fetchSarvModels('https://ai.sarv.com', TOKEN)).resolves.toEqual([
      { code: 'gpt-4o', display_name: 'GPT-4o', provider_code: 'openai', supports_streaming: true },
    ]);

    fetchMock.mockResolvedValue(okJson([{ code: 'jpr1', name: 'Jaipur 1' }, { code: 'blr1' }]));
    await expect(fetchSarvZones('https://ai.sarv.com', TOKEN)).resolves.toEqual([
      { code: 'jpr1', name: 'Jaipur 1' },
      { code: 'blr1' }, // an unnamed zone is legal — the UI falls back to `code`
    ]);
  });

  // An empty catalog is a valid answer (no models enabled for this org) and must
  // resolve, NOT throw — the UI shows "no models available" instead of an error.
  it('resolves an empty list rather than treating it as a failure', async () => {
    fetchMock.mockResolvedValue(okJson([]));

    await expect(fetchSarvProviders('https://ai.sarv.com', TOKEN)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the wallet payload including a locked wallet', async () => {
    fetchMock.mockResolvedValue(okJson({ balance: 0, currency: 'INR', locked: true }));

    await expect(fetchSarvWallet('https://ai.sarv.com', TOKEN)).resolves.toEqual({
      balance: 0,
      currency: 'INR',
      locked: true,
    });
  });
});

describe('sarv-catalog — error mapping', () => {
  // 401 → the access token expired: the caller MUST refresh, so this code has to
  // be exact or the app pops a re-login instead of refreshing silently.
  it('maps a bare 401 to invalid_token', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, 'Unauthorized'));

    const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err).toBeInstanceOf(SarvApiError);
    expect(err.code).toBe('invalid_token');
    expect(err.status).toBe(401);
  });

  it('maps a bare 402 to insufficient_balance and 429 to rate_limit_exceeded', async () => {
    fetchMock.mockResolvedValue(errorResponse(402, 'Payment Required'));
    await expect(fetchSarvModels('https://ai.sarv.com', TOKEN)).rejects.toMatchObject({
      code: 'insufficient_balance',
      status: 402,
    });

    fetchMock.mockResolvedValue(errorResponse(429, 'Too Many Requests'));
    await expect(fetchSarvZones('https://ai.sarv.com', TOKEN)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
      status: 429,
    });
  });

  // Anything unrecognised must land on upstream_error — never on a code the UI
  // would react to by wiping credentials or sending the user to top up.
  it('maps an unmapped status (500/403) to upstream_error with a generic message', async () => {
    fetchMock.mockResolvedValue(errorResponse(500, 'Internal Server Error'));

    const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('Sarv API 500');
    expect(err.detail).toBeUndefined(); // non-JSON body carries no structured detail
  });

  // FastAPI wraps HTTPException payloads in { detail: … }; the real error code
  // lives inside. Reading the outer object instead would flatten every 403 into
  // upstream_error and lose the "re-authorize with broader scopes" path.
  it('prefers the error code inside a FastAPI { detail: … } envelope over the status', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(403, JSON.stringify({ detail: { error: 'insufficient_scope', message: 'llm:view required' } })),
    );

    const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.code).toBe('insufficient_scope');
    expect(err.message).toBe('llm:view required');
    expect(err.detail).toEqual({ error: 'insufficient_scope', message: 'llm:view required' });
    expect(err.status).toBe(403);
  });

  it('also reads an unwrapped { error, message } body', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(403, JSON.stringify({ error: 'cai_account_required', message: 'Link your CAI account' })),
    );

    const err = await fetchSarvZones('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.code).toBe('cai_account_required');
    expect(err.message).toBe('Link your CAI account');
  });

  // A body-declared code that overrides the status is only honoured when it is
  // one the app knows how to handle; an unknown string must not leak through as
  // a code no handler branches on.
  it('ignores an unknown error string in the body and falls back to the status mapping', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(401, JSON.stringify({ error: 'teapot_overflow', message: 'nope' })),
    );

    const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.code).toBe('invalid_token'); // from status, not from the body
    expect(err.message).toBe('nope'); // message is still surfaced
  });

  it('falls back to upstream_error when an unknown body code meets an unmapped status', async () => {
    fetchMock.mockResolvedValue(errorResponse(418, JSON.stringify({ error: 'teapot_overflow' })));

    const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('Sarv API 418'); // no usable message field in the body
  });

  // Honouring Retry-After is what keeps a rate-limited client from hammering the
  // gateway into a longer ban.
  it('parses a numeric Retry-After header on a 429', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(429, JSON.stringify({ error: 'rate_limit_exceeded', message: 'slow down' }), {
        'retry-after': '30',
      }),
    );

    const err = await fetchSarvModels('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.code).toBe('rate_limit_exceeded');
    expect(err.retryAfterSec).toBe(30);
  });

  // A non-numeric (HTTP-date) or zero Retry-After must become undefined, not
  // NaN/0 — a NaN backoff turns setTimeout into an immediate retry storm.
  it('leaves retryAfterSec undefined for a non-numeric or zero Retry-After', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, '', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }));
    let err = await fetchSarvModels('https://ai.sarv.com', TOKEN).catch((e) => e);
    expect(err.retryAfterSec).toBeUndefined();
    expect(Number.isNaN(err.retryAfterSec)).toBe(false);

    fetchMock.mockResolvedValue(errorResponse(429, '', { 'retry-after': '0' }));
    err = await fetchSarvModels('https://ai.sarv.com', TOKEN).catch((e) => e);
    expect(err.retryAfterSec).toBeUndefined();
  });

  it('has no Retry-After when the header is absent', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, ''));

    const err = await fetchSarvZones('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err.retryAfterSec).toBeUndefined();
  });

  // An HTML error page from a proxy is the common "logged out of the VPN" case:
  // it must still produce a typed SarvApiError, never a JSON parse crash.
  it('survives an HTML / empty error body without throwing a parse error', async () => {
    fetchMock.mockResolvedValue(errorResponse(502, '<html>Bad Gateway</html>'));
    let err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(SarvApiError);
    expect(err.code).toBe('upstream_error');
    expect(err.message).toBe('Sarv API 502');

    fetchMock.mockResolvedValue(errorResponse(503, ''));
    err = await fetchSarvWallet('https://ai.sarv.com', TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(SarvApiError);
    expect(err.message).toBe('Sarv API 503');
  });

  // A JSON body that isn't an object (array, string, null) must not crash the
  // property probing — real gateways do return bare arrays/strings.
  it('handles non-object JSON error bodies (array / string / null)', async () => {
    for (const body of ['[{"x":1}]', '"just a string"', 'null']) {
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(errorResponse(400, body));

      const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

      expect(err).toBeInstanceOf(SarvApiError);
      expect(err.code).toBe('upstream_error');
      expect(err.message).toBe('Sarv API 400');
    }
  });

  // A network throw is not an API error: it must propagate untouched so the
  // caller can retry, rather than being mislabelled invalid_token.
  it('lets a network-level fetch rejection propagate as-is', async () => {
    const netErr = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(netErr);

    const err = await fetchSarvProviders('https://ai.sarv.com', TOKEN).catch((e) => e);

    expect(err).toBe(netErr);
    expect(err).not.toBeInstanceOf(SarvApiError);
  });
});
