import { getOAuthProvider, setLogSink, setSarvBaseUrl, type LogLevel } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Sarv CAI catalog (providers / models / zones) is fetched by MAIN with the
 * account's bearer (CASA I-2): that token is also the Sarv mailbox's XOAUTH2
 * credential, so the renderer never holds it, and the renderer cannot choose
 * where main sends it.
 *
 * What breaks if this file fails: the bearer goes to a renderer-chosen base
 * URL or follows a redirect; a malformed request reads the token store; an
 * expired token is no longer refreshed (or a 401 no longer retried once); a
 * catalog 403 is logged without the code that tells a missing scope from a
 * missing CAI account; "sign in again" and "offline" stop being told apart; or
 * two Sarv accounts read each other's catalog.
 *
 * Carries the refresh / permanent / transient / multi-account cases of the
 * removed `oauth:getAccessToken` channel, and the logging cases of the
 * renderer's old catalog fetch. Only the token store, the network gate, the
 * catalog endpoint (chromiumFetch) and the token endpoint (global fetch) are
 * faked.
 */

type StoredAccount = Record<string, unknown> & { provider: string; email: string };

const h = vi.hoisted(() => ({
  accounts: [] as StoredAccount[],
  api: vi.fn(),
  /** Set to blank out the Sarv API base URL main reads. */
  noApiBase: false,
}));

vi.mock('@sarvinbox/core', async (orig) => {
  const actual = await orig<typeof import('@sarvinbox/core')>();
  return {
    ...actual,
    getOAuthProvider: (id: Parameters<typeof actual.getOAuthProvider>[0]) => {
      const provider = actual.getOAuthProvider(id);
      return h.noApiBase && id === 'sarv' ? { ...provider, apiBaseUrl: undefined } : provider;
    },
  };
});

vi.mock('electron', () => ({ shell: { openExternal: async () => {} } }));
vi.mock('../../../../electron/services/network-readiness', () => ({ waitForNetworkReady: async () => true }));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: h.api }));
vi.mock('../../../../electron/services/oauth-token-store', () => {
  const same = (a: StoredAccount, provider: unknown, email: string) =>
    a.provider === provider && a.email.toLowerCase() === email.toLowerCase();
  return {
    getAccount: vi.fn(async (provider: unknown, email: string) => h.accounts.find((a) => same(a, provider, email)) ?? null),
    saveAccount: vi.fn(async (next: StoredAccount) => {
      h.accounts = h.accounts.map((a) => (same(a, next.provider, next.email) ? next : a));
    }),
    removeAccount: vi.fn(async () => false),
    listAccounts: vi.fn(async () => [...h.accounts]),
  };
});

import { getAccount } from '../../../../electron/services/oauth-token-store';
import { fetchSarvCatalogForRenderer } from '../../../../electron/services/sarv-catalog-service';

const nowSec = () => Math.floor(Date.now() / 1000);
const liveAccount = (email: string, accessToken: string): StoredAccount => ({
  provider: 'sarv', email, accessToken, refreshToken: `rt-${email}`,
  accessExpiresAt: nowSec() + 3_600, scopes: [], createdAt: nowSec() - 86_400, updatedAt: nowSec() - 60,
});
const expiredAccount = (email: string): StoredAccount => ({
  ...liveAccount(email, 'stale-token'), accessExpiresAt: nowSec() - 3_600, updatedAt: nowSec() - 7_200,
});

type TokenReply = { status: number; body: unknown } | Error;
const minted = (rt: string): TokenReply => ({ status: 200, body: { access_token: `fresh-for-${rt}`, expires_in: 900, token_type: 'Bearer' } });
let tokenReply: (rt: string) => TokenReply;
const tokenEndpoint = vi.fn(async (_url: string, init: { body: string }) => {
  const reply = tokenReply(JSON.parse(init.body).refresh_token);
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bearersSent = () => h.api.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization);

const logs: Array<{ level: LogLevel; message: string }> = [];
const originalApiBase = getOAuthProvider('sarv').apiBaseUrl;

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [];
  logs.length = 0;
  tokenReply = minted;
  vi.stubGlobal('fetch', tokenEndpoint);
  h.api.mockImplementation(async () => json([]));
  setLogSink((level, _name, message) => { logs.push({ level, message }); });
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  h.noApiBase = false;
  setSarvBaseUrl({ apiBase: originalApiBase });
  setLogSink(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('where the catalog request goes', () => {
  // Breaks: the bearer (a mailbox credential) is sent to a renderer-chosen
  // server, or follows a redirect, or the server answers 401 for no Bearer.
  it('GETs main\'s own Sarv API base with the bearer and redirect:error, ignoring any renderer URL', async () => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    h.api.mockImplementation(async () => json([{ code: 'sarv_partners' }]));

    const res = await fetchSarvCatalogForRenderer({
      kind: 'providers', email: 'me@sarv.com', zoneCode: 'jpr1',
      // A compromised renderer naming its own server: ignored.
      apiBaseUrl: 'https://evil.example', url: 'https://evil.example/oauth/v1/llm/providers',
    });

    expect(res).toEqual({ ok: true, body: [{ code: 'sarv_partners' }] });
    const [url, init] = h.api.mock.calls[0];
    expect(url).toBe(`${originalApiBase!.replace(/\/+$/, '')}/oauth/v1/llm/providers?zone_code=jpr1`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer sarv-live-token' } });
    expect(JSON.stringify(res)).not.toContain('sarv-live-token');
  });

  // Breaks: a dev / staging override (SARVINBOX_SARV_OAUTH_BASE_URL) is ignored.
  it('follows main\'s configured base URL', async () => {
    setSarvBaseUrl({ apiBase: 'http://localhost:8880' });
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    await fetchSarvCatalogForRenderer({ kind: 'models', email: 'me@sarv.com', providerCode: 'sarv_partners' });
    expect(h.api.mock.calls[0][0]).toBe('http://localhost:8880/oauth/v1/llm/models?provider_code=sarv_partners');
  });

  // Breaks: with no Sarv API configured the request goes to "undefined/oauth…".
  it('reports an unconfigured Sarv API without any request', async () => {
    h.noApiBase = true;
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toMatchObject({ ok: false, code: 'not_configured' });
    expect(h.api).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
  });
});

describe('malformed requests', () => {
  // Breaks: a crafted request reaches the token store (a refresh started on the
  // renderer's behalf) or the network.
  it.each<[string, unknown]>([
    ['no request', undefined],
    ['a string', 'zones'],
    ['an unknown kind (the dead wallet endpoint)', { kind: 'wallet', email: 'me@sarv.com' }],
    ['a prototype key as kind', { kind: '__proto__', email: 'me@sarv.com' }],
    ['no email', { kind: 'zones' }],
    ['an empty email', { kind: 'zones', email: '  ' }],
    ['a non-string email', { kind: 'zones', email: ['me@sarv.com'] }],
    ['a non-string zone code', { kind: 'providers', email: 'me@sarv.com', zoneCode: { x: 1 } }],
    ['an oversized provider code', { kind: 'models', email: 'me@sarv.com', providerCode: 'x'.repeat(201) }],
  ])('refuses %s before reading the token store', async (_what, request) => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    expect(await fetchSarvCatalogForRenderer(request)).toEqual({ ok: false, status: 0, code: 'invalid_request', message: 'Invalid Sarv catalog request.' });
    expect(getAccount).not.toHaveBeenCalled();
    expect(h.api).not.toHaveBeenCalled();
  });
});

describe('token refresh and the 401 retry', () => {
  // Breaks the pickers about fifteen minutes after sign-in.
  it('refreshes an expired token before the request', async () => {
    h.accounts.push(expiredAccount('me@sarv.com'));
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toEqual({ ok: true, body: [] });
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    expect(bearersSent()).toEqual(['Bearer fresh-for-rt-me@sarv.com']);
  });

  // The edge refused a token our clock still trusted: one forced refresh, one retry.
  it('on 401 forces a refresh and retries exactly once', async () => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    h.api.mockResolvedValueOnce(json({ detail: { error: 'invalid_token' } }, 401)).mockResolvedValueOnce(json([{ code: 'jpr1' }]));
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toEqual({ ok: true, body: [{ code: 'jpr1' }] });
    expect(bearersSent()).toEqual(['Bearer sarv-live-token', 'Bearer fresh-for-rt-me@sarv.com']);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
  });

  // Breaks: an org-less account's normal zones 403 forces a refresh every boot.
  it('does not retry a 403', async () => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    h.api.mockImplementation(async () => json({ detail: { error: 'missing org_id claim' } }, 403));
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toMatchObject({ ok: false, status: 403 });
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });
});

describe('failures the pickers must tell apart', () => {
  // Permanent: only signing in again helps. The message is the one the
  // renderer always showed for this.
  it('reports a revoked session as sign_in_required without a request', async () => {
    h.accounts.push(expiredAccount('me@sarv.com'));
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });
    expect(await fetchSarvCatalogForRenderer({ kind: 'providers', email: 'me@sarv.com' })).toEqual({
      ok: false, status: 0, code: 'sign_in_required', message: expect.stringContaining('Token refresh failed (400)'),
    });
    expect(h.api).not.toHaveBeenCalled();
  });

  // Signed out / removed: permanent too.
  it('reports a missing account as sign_in_required', async () => {
    expect(await fetchSarvCatalogForRenderer({ kind: 'providers', email: 'gone@sarv.com' })).toMatchObject({ ok: false, code: 'sign_in_required' });
    expect(h.api).not.toHaveBeenCalled();
  });

  // Transient: the OAuth server is unreachable. The next lookup recovers — the
  // service keeps no state.
  it('reports an unreachable token endpoint as token_unavailable and recovers next time', async () => {
    h.accounts.push(expiredAccount('me@sarv.com'));
    tokenReply = () => new TypeError('fetch failed');
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toEqual({
      ok: false, status: 0, code: 'token_unavailable', message: expect.stringContaining('Cannot reach OAuth server'),
    });
    tokenReply = minted;
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toEqual({ ok: true, body: [] });
  });

  // Transient: no answer from the Sarv API at all.
  it('reports a network failure as network', async () => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    h.api.mockRejectedValue(new TypeError('net::ERR_NAME_NOT_RESOLVED'));
    expect(await fetchSarvCatalogForRenderer({ kind: 'zones', email: 'me@sarv.com' })).toEqual({
      ok: false, status: 0, code: 'network', message: 'net::ERR_NAME_NOT_RESOLVED',
    });
  });

  // A 403 here is three problems with three fixes; the log must carry the
  // code and message, not just the status — and never the account address.
  it('surfaces and logs the error code and message alongside the status', async () => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    h.api.mockImplementation(async () => json({ detail: { error: 'insufficient_scope', error_description: 'llm:view required' } }, 403));

    expect(await fetchSarvCatalogForRenderer({ kind: 'providers', email: 'me@sarv.com' })).toEqual({
      ok: false, status: 403, code: 'insufficient_scope', message: 'llm:view required',
    });
    const line = logs.find((l) => l.level === 'warn')!.message;
    expect(line).toContain('status=403');
    expect(line).toContain('code=insufficient_scope');
    expect(line).toContain('llm:view required');
    expect(line).not.toContain('me@sarv.com');
  });

  // Breaks: a hostile or broken server's body forges lines in app.log, or a
  // non-JSON page crashes the logging.
  it('logs a non-JSON or multi-line error body on one line', async () => {
    h.accounts.push(liveAccount('me@sarv.com', 'sarv-live-token'));
    h.api.mockImplementation(async () => json({ detail: 'down\n[2026-01-01] [INFO] [main] forged' }, 503));
    await fetchSarvCatalogForRenderer({ kind: 'providers', email: 'me@sarv.com' });
    h.api.mockImplementation(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await fetchSarvCatalogForRenderer({ kind: 'providers', email: 'me@sarv.com' })).toMatchObject({ status: 502, code: '502', message: 'Sarv API 502' });

    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(warnings).toHaveLength(2);
    for (const line of warnings) expect(line).not.toContain('\n');
    expect(warnings[0]).toContain('down\\n[2026-01-01]');
    expect(warnings[1]).toContain('code=502');
  });
});

describe('two Sarv accounts', () => {
  // Breaks if one account's catalog is read with the other's token, or one dead
  // session fails the other.
  it('reads each account\'s catalog with its own token, and keeps failures apart', async () => {
    h.accounts.push(liveAccount('a@sarv.com', 'token-a'), expiredAccount('b@sarv.com'), expiredAccount('c@sarv.com'));
    tokenReply = (rt) => (rt === 'rt-c@sarv.com' ? { status: 400, body: { error: 'invalid_grant' } } : minted(rt));

    const [a, b, c] = await Promise.all([
      fetchSarvCatalogForRenderer({ kind: 'zones', email: 'a@sarv.com' }),
      fetchSarvCatalogForRenderer({ kind: 'zones', email: 'b@sarv.com' }),
      fetchSarvCatalogForRenderer({ kind: 'zones', email: 'c@sarv.com' }),
    ]);

    expect(a).toEqual({ ok: true, body: [] });
    expect(b).toEqual({ ok: true, body: [] });
    expect(c).toMatchObject({ ok: false, code: 'sign_in_required' });
    expect(bearersSent().sort()).toEqual(['Bearer fresh-for-rt-b@sarv.com', 'Bearer token-a']);
  });
});
