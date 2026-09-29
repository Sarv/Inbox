import { getOAuthProvider, setLogSink, type LogLevel } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `oauth:getAccessToken` is the one IPC channel that hands a live bearer to the
 * renderer, and the renderer also hosts email HTML and extension panels. Only
 * Sarv's token may cross: the renderer calls the Sarv API and the AI gateway
 * itself. A Gmail token carries https://mail.google.com/ (read, send and delete
 * every message), so it stays in main with Microsoft's and Yahoo's.
 *
 * Only the token store, the network gate and `fetch` are faked. The handler runs
 * over the real oauth-service and the real core token refresher, so the refresh
 * failures below fail the way they do in the app.
 */

type StoredAccount = Record<string, unknown> & { provider: string; email: string };
type Handler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  accounts: [] as StoredAccount[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, fn: Handler) => h.handlers.set(n, fn) },
  shell: { openExternal: async () => {} },
}));

// Sign-in, sign-out and proactive refresh belong to the other oauth:* handlers.
vi.mock('../../../../electron/services/oauth-refresh-scheduler', () => ({
  rescheduleOAuthAccount: vi.fn(),
  signOutOAuthAccount: vi.fn(),
}));

vi.mock('../../../../electron/services/network-readiness', () => ({
  waitForNetworkReady: async () => true,
}));

vi.mock('../../../../electron/services/oauth-token-store', () => {
  const same = (a: StoredAccount, provider: unknown, email: string) =>
    a.provider === provider && a.email.toLowerCase() === email.toLowerCase();
  return {
    getAccount: vi.fn(async (provider: unknown, email: string) =>
      h.accounts.find((a) => same(a, provider, email)) ?? null),
    saveAccount: vi.fn(async (next: StoredAccount) => {
      h.accounts = h.accounts.map((a) => (same(a, next.provider, next.email) ? next : a));
    }),
    removeAccount: vi.fn(async () => false),
    listAccounts: vi.fn(async () => [...h.accounts]),
  };
});

import { registerOAuthHandlers } from '../../../../electron/ipc/oauth-handlers';
import { getAccount } from '../../../../electron/services/oauth-token-store';

const getAccessToken = (providerId: unknown, email: unknown) =>
  h.handlers.get('oauth:getAccessToken')!({}, providerId, email);

const nowSec = () => Math.floor(Date.now() / 1000);

/** A signed-in account whose access token has an hour of life left. */
const liveAccount = (provider: string, email: string, accessToken: string): StoredAccount => ({
  provider,
  email,
  accessToken,
  refreshToken: `rt-${email}`,
  accessExpiresAt: nowSec() + 3_600,
  scopes: [],
  createdAt: nowSec() - 86_400,
  updatedAt: nowSec() - 60,
});

/** The same account with an access token that expired an hour ago: a refresh is due. */
const expiredAccount = (provider: string, email: string): StoredAccount => ({
  ...liveAccount(provider, email, 'stale-token'),
  accessExpiresAt: nowSec() - 3_600,
  updatedAt: nowSec() - 7_200,
});

type TokenReply = { status: number; body: unknown } | Error;

/** A successful refresh: each refresh token mints its own recognisable access token. */
const minted = (refreshToken: string): TokenReply => ({
  status: 200,
  body: { access_token: `fresh-for-${refreshToken}`, expires_in: 900, token_type: 'Bearer' },
});

/** What the token endpoint answers, keyed by the refresh token presented. */
let tokenReply: (refreshToken: string) => TokenReply;

const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
  const reply = tokenReply(JSON.parse(init.body).refresh_token);
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

const logs: Array<{ level: LogLevel; name: string; message: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.accounts = [];
  logs.length = 0;
  tokenReply = minted;
  vi.stubGlobal('fetch', fetchMock);
  setLogSink((level, name, message) => { logs.push({ level, name, message }); });
  // The refresher logs every failure it classifies; keep the run readable.
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
  registerOAuthHandlers();
});

afterEach(() => {
  setLogSink(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('oauth:getAccessToken: which providers the renderer may hold a token for', () => {
  // THE regression: breaks if a mail provider's token can be pulled into the
  // renderer again, even for an account that holds a live one.
  it.each(['gmail', 'microsoft', 'yahoo'])('refuses a %s token without reading the token store', async (provider) => {
    h.accounts.push(liveAccount(provider, 'me@example.com', `${provider}-live-token`));

    const res = await getAccessToken(provider, 'me@example.com');

    expect(res).toEqual({
      success: false,
      error: `Access tokens for ${provider} are not available to the renderer`,
    });
    expect(JSON.stringify(res)).not.toContain('live-token');
    // Refused before the lookup: no refresh starts on the renderer's behalf, and
    // the answer cannot reveal whether such an account is signed in.
    expect(getAccount).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Breaks if the check is loosened into a lookup that a crafted id slips past:
  // an object-key test admits '__proto__', String() coercion admits ['sarv'], a
  // case-fold admits 'SARV'.
  it.each<[string, unknown]>([
    ['upper-case', 'SARV'],
    ['padded', ' sarv '],
    ['a prototype key', '__proto__'],
    ['an inherited method name', 'toString'],
    ['empty', ''],
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
    ['an array', ['sarv']],
    ['an object', { id: 'sarv' }],
  ])('refuses a provider id that is %s', async (_what, providerId) => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));

    await expect(getAccessToken(providerId, 'me@sarv.com')).resolves.toEqual({
      success: false,
      error: 'Access tokens for an unrecognised provider are not available to the renderer',
    });
    expect(getAccount).not.toHaveBeenCalled();
  });

  // Breaks the audit trail: a refusal is a failed access-control decision, so it
  // must leave a warning in app.log that names the provider.
  it('logs each refusal as a warning that names the provider', async () => {
    h.accounts.push(liveAccount('gmail', 'me@gmail.com', 'gmail-live-token'));

    await getAccessToken('gmail', 'me@gmail.com');

    expect(logs).toEqual([
      { level: 'warn', name: 'oauth-handlers', message: expect.stringContaining('access token for gmail') },
    ]);
  });

  // Breaks if a crafted argument can forge lines in app.log (log injection): the
  // renderer's provider id and email are never echoed into the log.
  it('never writes renderer-supplied text into the log', async () => {
    const forged = '\n[2026-09-29 00:00:00.000] [INFO] [oauth-service] forged';

    await getAccessToken(`gmail${forged}`, 'me@gmail.com');
    await getAccessToken('gmail', `me@gmail.com${forged}`);

    expect(logs).toHaveLength(2);
    for (const { message } of logs) {
      expect(message).not.toContain('forged');
      expect(message).not.toContain('\n');
    }
    expect(logs[0].message).toContain('an unrecognised provider');
  });

  // Breaks Sarv AI (the edge gateway and the CAI catalog) if the allow-list shuts
  // out the one provider the renderer does need.
  it('hands the renderer a live Sarv token', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));

    await expect(getAccessToken('sarv', 'me@sarv.com')).resolves.toEqual({
      success: true,
      data: { accessToken: 'sarv-live-token' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // Runs before every AI request, so an allowed call must not log.
    expect(logs).toEqual([]);
  });

  // Breaks AI about fifteen minutes after sign-in if a renderer request no longer
  // gets an expiring Sarv token refreshed in main first.
  it('refreshes an expired Sarv token before handing it over', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));

    await expect(getAccessToken('sarv', 'me@sarv.com')).resolves.toEqual({
      success: true,
      data: { accessToken: 'fresh-for-rt-me@sarv.com' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(getOAuthProvider('sarv').tokenEndpoint);
  });
});

describe('oauth:getAccessToken: when the Sarv refresh fails', () => {
  // Breaks if a revoked Sarv session throws across IPC (an unhandled rejection in
  // the renderer) or falls back to the stale token, instead of returning an error
  // the AI UI can turn into "sign in to Sarv again".
  it('reports a permanent refresh failure as an error, never the stale token', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token reuse detected' } });

    const res = await getAccessToken('sarv', 'me@sarv.com');

    expect(res).toEqual({ success: false, error: expect.stringContaining('Token refresh failed (400)') });
    expect(JSON.stringify(res)).not.toContain('stale-token');
  });

  // Breaks if one network blip sticks: the handler must keep no state, so the next
  // AI request refreshes again and succeeds instead of replaying the failure.
  it('recovers on the next request after a transient network failure', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));
    tokenReply = () => new TypeError('fetch failed');

    await expect(getAccessToken('sarv', 'me@sarv.com')).resolves.toEqual({
      success: false,
      error: expect.stringContaining('Cannot reach OAuth server'),
    });

    tokenReply = minted;
    await expect(getAccessToken('sarv', 'me@sarv.com')).resolves.toEqual({
      success: true,
      data: { accessToken: 'fresh-for-rt-me@sarv.com' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Breaks if tokens or failures cross accounts: two Sarv accounts refreshing at
  // once each get the token minted from their own refresh token, and one dead
  // session does not fail the other.
  it('keeps two Sarv accounts apart when one refresh fails', async () => {
    h.accounts.push(expiredAccount('sarv', 'a@sarv.com'), expiredAccount('sarv', 'b@sarv.com'));
    tokenReply = (rt) => (rt === 'rt-a@sarv.com' ? { status: 400, body: { error: 'invalid_grant' } } : minted(rt));

    const [a, b] = await Promise.all([
      getAccessToken('sarv', 'a@sarv.com'),
      getAccessToken('sarv', 'b@sarv.com'),
    ]);

    expect(a).toEqual({ success: false, error: expect.stringContaining('Token refresh failed (400)') });
    expect(b).toEqual({ success: true, data: { accessToken: 'fresh-for-rt-b@sarv.com' } });
  });
});
