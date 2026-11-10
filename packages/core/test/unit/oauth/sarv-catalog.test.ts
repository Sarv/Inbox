import { describe, expect, it, vi } from 'vitest';

import {
  fetchSarvCatalog,
  parseSarvCatalogError,
  sarvCatalogUrl,
  type SarvCatalogDeps,
} from '../../../src/oauth/sarv-catalog';
import { OAuthError } from '../../../src/oauth/types';

// The catalog populates the Sarv provider / model / zone pickers. It is fetched
// by MAIN with the account's bearer — which is also the Sarv mailbox's XOAUTH2
// credential — so the renderer never holds that token (CASA I-2). What breaks
// if this file fails: the bearer rides a redirect to another host, a doubled
// slash or a stray empty filter empties every picker, an expired token is no
// longer refreshed and retried, a missing scope reads as a generic failure in
// the log, or "sign in again" becomes indistinguishable from "offline".
//
// Changed deliberately (CASA I-2): this file used to test fetchSarvProviders,
// fetchSarvModels, fetchSarvZones and fetchSarvWallet, global-fetch fetchers
// with no callers. They are removed; main now fetches the catalog through
// fetchSarvCatalog. Carried over: URL shape, Bearer auth, trailing slashes,
// percent-encoding, the FastAPI `detail` error envelope, non-JSON and
// non-object bodies, network rejection. Dropped with their code: the wallet
// fetch, per-fetcher AbortSignal forwarding, and that file's own Retry-After
// and 402/429 code mapping (the live SarvApiError path in
// utils/sarv-api-error.ts is unchanged and keeps its tests).

const API = 'https://ai.sarv.com';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function deps(over: Partial<SarvCatalogDeps> = {}) {
  const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => json([]));
  const resolveBearer = vi.fn(async (force: boolean) => (force ? 'fresh-token' : 'current-token'));
  return { apiBaseUrl: API, fetchImpl, resolveBearer, ...over } as SarvCatalogDeps & {
    fetchImpl: typeof fetchImpl; resolveBearer: typeof resolveBearer;
  };
}

describe('sarvCatalogUrl', () => {
  // Breaks: each picker reads the wrong list.
  it('maps each kind to its endpoint', () => {
    expect(sarvCatalogUrl(API, { kind: 'providers' })).toBe('https://ai.sarv.com/oauth/v1/llm/providers');
    expect(sarvCatalogUrl(API, { kind: 'models' })).toBe('https://ai.sarv.com/oauth/v1/llm/models');
    expect(sarvCatalogUrl(API, { kind: 'zones' })).toBe('https://ai.sarv.com/oauth/v1/zones');
  });

  // apiBaseUrl comes from config/env and users add trailing slashes; '//oauth'
  // 404s on the gateway.
  it('never doubles the slash before /oauth', () => {
    expect(sarvCatalogUrl('http://localhost:8880///', { kind: 'zones' })).toBe('http://localhost:8880/oauth/v1/zones');
  });

  // THE zone-less regression: an empty `zone_code=` is sent as a real filter
  // and can match nothing, so an org-less account sees no providers at all.
  it('omits empty filters entirely', () => {
    expect(sarvCatalogUrl(API, { kind: 'providers', zoneCode: '' })).toBe('https://ai.sarv.com/oauth/v1/llm/providers');
    expect(sarvCatalogUrl(API, { kind: 'models', providerCode: '', zoneCode: '' })).not.toContain('?');
  });

  // Breaks: the org case regresses into always-unscoped, or a code with '&'
  // truncates the filter and quietly returns the WRONG model list.
  it('scopes to provider and zone, percent-encoded', () => {
    expect(sarvCatalogUrl(API, { kind: 'models', providerCode: 'open ai&x=1', zoneCode: 'blr1' }))
      .toBe('https://ai.sarv.com/oauth/v1/llm/models?provider_code=open+ai%26x%3D1&zone_code=blr1');
    expect(sarvCatalogUrl(API, { kind: 'providers', zoneCode: 'jpr1', providerCode: 'ignored' }))
      .toBe('https://ai.sarv.com/oauth/v1/llm/providers?zone_code=jpr1');
  });

  // Zones are not zone-filtered: a stray filter would hide the user's zones.
  it('sends no filters for zones', () => {
    expect(sarvCatalogUrl(API, { kind: 'zones', zoneCode: 'jpr1', providerCode: 'p' })).toBe('https://ai.sarv.com/oauth/v1/zones');
  });
});

describe('fetchSarvCatalog — request', () => {
  // Breaks: the bearer (a mailbox credential) follows a redirect elsewhere, or
  // the server answers 401 for a missing Bearer header.
  it('GETs with the bearer, Accept JSON and redirect:error', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => json([{ code: 'sarv_partners' }])) });
    const res = await fetchSarvCatalog({ kind: 'providers', zoneCode: 'jpr1' }, d);
    expect(res).toEqual({ ok: true, body: [{ code: 'sarv_partners' }] });
    const [url, init] = d.fetchImpl.mock.calls[0];
    expect(url).toBe('https://ai.sarv.com/oauth/v1/llm/providers?zone_code=jpr1');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer current-token' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(d.resolveBearer.mock.calls).toEqual([[false]]);
  });

  // An empty catalog is a valid answer (no models enabled for this org).
  it('returns an empty list as success', async () => {
    expect(await fetchSarvCatalog({ kind: 'zones' }, deps())).toEqual({ ok: true, body: [] });
  });

  // Breaks: AI stops working ~15 minutes after sign-in when the edge refuses a
  // token our clock still trusted — or a refused fresh token loops.
  it('on 401 refreshes the token and retries exactly once', async () => {
    const d = deps({ fetchImpl: vi.fn().mockResolvedValueOnce(json({ detail: 'expired' }, 401)).mockResolvedValueOnce(json([{ code: 'z' }])) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toEqual({ ok: true, body: [{ code: 'z' }] });
    expect(d.resolveBearer.mock.calls).toEqual([[false], [true]]);
    expect(d.fetchImpl.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer fresh-token' });

    const twice = deps({ fetchImpl: vi.fn(async () => json({ detail: { error: 'invalid_token' } }, 401)) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, twice)).toMatchObject({ ok: false, status: 401, code: 'invalid_token' });
    expect(twice.fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Breaks: the normal org-less zones 403 forces a token refresh on every boot.
  it('does not retry a 403', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => json({ detail: { error: 'missing org_id claim' } }, 403)) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toEqual({ ok: false, status: 403, code: 'missing org_id claim', message: 'missing org_id claim' });
    expect(d.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchSarvCatalog — failures stay plain data', () => {
  // Permanent: only signing in again helps. Breaks: the UI cannot tell this
  // from a blip, or the old token-layer message (what the user saw) is lost.
  it('reports a revoked session as sign_in_required without any request', async () => {
    const d = deps({ resolveBearer: vi.fn(async () => { throw new OAuthError('Token refresh failed (400): invalid_grant', 'TOKEN_REFRESH_FAILED'); }) });
    expect(await fetchSarvCatalog({ kind: 'providers' }, d)).toEqual({
      ok: false, status: 0, code: 'sign_in_required', message: 'Token refresh failed (400): invalid_grant',
    });
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  // A signed-out account is permanent too.
  it('reports a missing account as sign_in_required', async () => {
    const d = deps({ resolveBearer: vi.fn(async () => { throw new OAuthError('No OAuth account for sarv:x', 'ACCOUNT_NOT_FOUND'); }) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toMatchObject({ code: 'sign_in_required' });
  });

  // Transient: the OAuth server is unreachable right now. Breaks: a Wi-Fi blip
  // tells the user to re-authenticate.
  it('reports an unreachable token endpoint as token_unavailable', async () => {
    const d = deps({ resolveBearer: vi.fn(async () => { throw new OAuthError('Cannot reach OAuth server', 'TOKEN_REFRESH_NETWORK_ERROR'); }) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toEqual({ ok: false, status: 0, code: 'token_unavailable', message: 'Cannot reach OAuth server' });
  });

  // Transient: no response at all. A refused redirect lands here too.
  it('reports a network failure as network', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => { throw new TypeError('redirect mode is set to error'); }) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toEqual({ ok: false, status: 0, code: 'network', message: 'redirect mode is set to error' });
  });

  // Breaks: a hung server leaves the picker spinning forever.
  it('times out a hung request', async () => {
    const d = deps({
      timeoutMs: 20,
      fetchImpl: vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })),
    });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toEqual({ ok: false, status: 0, code: 'timeout', message: 'Sarv did not answer within 0.02s' });
  });

  // Breaks: a proxy's HTML 200 crashes the IPC handler instead of failing cleanly.
  it('reports a non-JSON success body as invalid_response', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => new Response('<html>login</html>', { status: 200 })) });
    expect(await fetchSarvCatalog({ kind: 'zones' }, d)).toMatchObject({ ok: false, status: 200, code: 'invalid_response' });
  });

  // Transient upstream failure keeps its own status, so a blip never reads as
  // "your account has no AI".
  it('surfaces a 503 with its status and FastAPI string detail', async () => {
    const d = deps({ fetchImpl: vi.fn(async () => json({ detail: 'upstream unavailable' }, 503)) });
    expect(await fetchSarvCatalog({ kind: 'providers' }, d)).toEqual({ ok: false, status: 503, code: '503', message: 'upstream unavailable' });
  });
});

describe('parseSarvCatalogError', () => {
  // THE diagnosis: the code sits INSIDE `detail` for the OAuth shape; reading
  // the top level only made every 403 indistinguishable.
  it('reads the code inside a FastAPI { detail: {…} } envelope', () => {
    expect(parseSarvCatalogError(403, JSON.stringify({ detail: { error: 'insufficient_scope', error_description: 'llm:view required' } })))
      .toEqual({ code: 'insufficient_scope', message: 'llm:view required' });
    expect(parseSarvCatalogError(403, JSON.stringify({ detail: { code: 'cai_account_required', message: 'Link your CAI account' } })))
      .toEqual({ code: 'cai_account_required', message: 'Link your CAI account' });
  });

  // An unwrapped body names its code at the top level.
  it('reads a top-level { error, error_description } body', () => {
    expect(parseSarvCatalogError(401, JSON.stringify({ error: 'invalid_token', error_description: 'expired' })))
      .toEqual({ code: 'invalid_token', message: 'expired' });
    expect(parseSarvCatalogError(400, JSON.stringify({ code: 'bad', message: 'Bad filter' })))
      .toEqual({ code: 'bad', message: 'Bad filter' });
  });

  // Breaks: a 422 list becomes "[object Object]" in the user-facing toast.
  it('joins a 422 validation list into one message', () => {
    expect(parseSarvCatalogError(422, JSON.stringify({ detail: [{ loc: ['q'], msg: 'bad zone' }, 'and another', { loc: [] }] })))
      .toEqual({ code: '422', message: 'bad zone; and another' });
    expect(parseSarvCatalogError(422, JSON.stringify({ detail: [{}] }))).toEqual({ code: '422', message: 'Sarv API 422' });
  });

  // A gateway's HTML page or an empty body must still name the status, never
  // throw in the parser.
  it.each(['<html>Bad Gateway</html>', '', 'null', '"just a string"', '[1,2]', '{"detail":"  "}'])('falls back to the status for %j', (raw) => {
    expect(parseSarvCatalogError(502, raw)).toEqual({ code: '502', message: 'Sarv API 502' });
  });

  // Breaks: an OpenAI-style object `error` becomes the code "[object Object]".
  it('ignores non-string code fields', () => {
    expect(parseSarvCatalogError(400, JSON.stringify({ error: { message: 'nested' }, detail: { error: 7 } })))
      .toEqual({ code: '400', message: 'Sarv API 400' });
  });
});
