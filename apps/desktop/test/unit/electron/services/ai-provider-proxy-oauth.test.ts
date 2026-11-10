import { getOAuthProvider, setLogSink, type LogLevel } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sarv AI requests from the renderer are made by MAIN, which attaches the Sarv
 * bearer itself (CASA I-2). That token is also the Sarv mailbox's XOAUTH2
 * credential (email:read/send/delete), and the renderer also renders untrusted
 * email HTML, so it must never hold it — and it must not be able to choose
 * where main sends it either.
 *
 * What breaks if this file fails: the Sarv (or a Gmail) token goes to a
 * renderer-chosen server; a refused request still reads the token store (and
 * so can start a refresh, or reveal which accounts exist); an expired token is
 * no longer refreshed and retried once — or a refused one is retried in a loop;
 * "sign in again" and "OAuth server unreachable" stop being told apart; two
 * Sarv accounts get each other's token; a cancelled request keeps running; or
 * the 429 back-off loses retry-after.
 *
 * These carry over the refresh / permanent / transient / multi-account cases
 * of the removed `oauth:getAccessToken` channel. Only the token store, the
 * network gate, the AI endpoint (chromiumFetch) and the token endpoint (global
 * fetch) are faked; the proxy, oauth-service and the core refresher are real.
 */

type StoredAccount = Record<string, unknown> & { provider: string; email: string };
type EdgeReply = { status: number; body?: unknown; headers?: Record<string, string> };

const h = vi.hoisted(() => ({
  accounts: [] as StoredAccount[],
  edge: vi.fn(),
  resolveAiKey: vi.fn(),
}));

vi.mock('electron', () => ({ shell: { openExternal: async () => {} } }));
vi.mock('../../../../electron/services/network-readiness', () => ({ waitForNetworkReady: async () => true }));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: h.edge }));
vi.mock('../../../../electron/services/ai-secret-store', () => ({ resolveAiKey: h.resolveAiKey }));
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

import { abortAiProviderFetch, proxyAiProviderFetch } from '../../../../electron/services/ai-provider-proxy';
import { getAccount } from '../../../../electron/services/oauth-token-store';

const EDGE = 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions';
const nowSec = () => Math.floor(Date.now() / 1000);

/** A signed-in account whose access token has an hour of life left. */
const liveAccount = (provider: string, email: string, accessToken: string): StoredAccount => ({
  provider, email, accessToken, refreshToken: `rt-${email}`,
  accessExpiresAt: nowSec() + 3_600, scopes: [], createdAt: nowSec() - 86_400, updatedAt: nowSec() - 60,
});
/** The same account with an access token that expired an hour ago: a refresh is due. */
const expiredAccount = (provider: string, email: string): StoredAccount => ({
  ...liveAccount(provider, email, 'stale-token'), accessExpiresAt: nowSec() - 3_600, updatedAt: nowSec() - 7_200,
});

type TokenReply = { status: number; body: unknown } | Error;
/** A successful refresh: each refresh token mints its own recognisable access token. */
const minted = (refreshToken: string): TokenReply => ({
  status: 200, body: { access_token: `fresh-for-${refreshToken}`, expires_in: 900, token_type: 'Bearer' },
});
let tokenReply: (refreshToken: string) => TokenReply;
const tokenEndpoint = vi.fn(async (_url: string, init: { body: string }) => {
  const reply = tokenReply(JSON.parse(init.body).refresh_token);
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
});

/** Answer the AI endpoint with `replies` in order (the last one repeats). */
const edgeReplies = (...replies: EdgeReply[]) => {
  let i = 0;
  h.edge.mockImplementation(async () => {
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(r.body ?? { ok: true }), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  });
};
/** The Authorization header each AI-endpoint call carried. */
const bearersSent = () => h.edge.mock.calls.map(([, init]) => (init.headers as Record<string, string>).Authorization);

let nextId = 0;
const sarvRequest = (over: Record<string, unknown> = {}) => ({
  requestId: `r${++nextId}`, providerId: 'sarv-provider', type: 'sarv', url: EDGE, method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' }, body: '{"model":"m"}',
  oauth: { provider: 'sarv', email: 'me@sarv.com' }, ...over,
});

const logs: Array<{ level: LogLevel; name: string; message: string }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts = [];
  logs.length = 0;
  tokenReply = minted;
  vi.stubGlobal('fetch', tokenEndpoint);
  edgeReplies({ status: 200, body: { choices: [] } });
  setLogSink((level, name, message) => { logs.push({ level, name, message }); });
  for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  setLogSink(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('proxyAiProviderFetch — a Sarv sign-in on an allowed endpoint', () => {
  // Breaks Sarv AI: the edge gateway gets no (or the wrong) bearer.
  it('attaches the account\'s live token, refuses redirects and returns the response', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    edgeReplies({ status: 200, body: { choices: [{ message: { content: 'Hi' } }] }, headers: { 'x-request-id': 'req-1' } });

    const res = await proxyAiProviderFetch(sarvRequest());

    expect(res).toEqual({
      ok: true, status: 200, statusText: '', contentType: 'application/json', headers: { 'x-request-id': 'req-1' },
      body: JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }),
    });
    const [url, init] = h.edge.mock.calls[0];
    expect(url).toBe(EDGE);
    expect(init).toMatchObject({ method: 'POST', body: '{"model":"m"}', redirect: 'error' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sarv-live-token' });
    // The token never comes back to the renderer, and no saved key is consulted.
    expect(JSON.stringify(res)).not.toContain('sarv-live-token');
    expect(h.resolveAiKey).not.toHaveBeenCalled();
    expect(tokenEndpoint).not.toHaveBeenCalled();
    // Runs on every AI request, so an allowed call must not warn.
    expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  // Breaks: a renderer-set credential header survives or replaces main's bearer.
  it('drops credential headers the renderer tries to set', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    await proxyAiProviderFetch(sarvRequest({ headers: { Authorization: 'Bearer forged', cookie: 'c', 'Proxy-Authorization': 'p', Accept: 'application/json' } }));
    expect(h.edge.mock.calls[0][1].headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer sarv-live-token' });
  });

  // Breaks AI about fifteen minutes after sign-in if an expiring token is no
  // longer refreshed in main before the request.
  it('refreshes an expired token before sending', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));
    await proxyAiProviderFetch(sarvRequest());
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    expect(tokenEndpoint.mock.calls[0][0]).toBe(getOAuthProvider('sarv').tokenEndpoint);
    expect(bearersSent()).toEqual(['Bearer fresh-for-rt-me@sarv.com']);
  });

  // Breaks: the 429 back-off loses the gateway's retry-after on the Sarv path.
  it('forwards retry-after from the edge', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    edgeReplies({ status: 429, body: { error: 'rate_limit_exceeded' }, headers: { 'retry-after': '9' } });
    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: true, status: 429, headers: { 'retry-after': '9' } });
  });
});

describe('proxyAiProviderFetch — refused before the token store is read', () => {
  // THE leaks. Each is refused with no token-store read (so no refresh starts
  // on the renderer's behalf, and the answer cannot reveal which accounts are
  // signed in), no AI request and no token-endpoint call.
  it.each([
    ['a mail provider\'s token for the Sarv edge', { oauth: { provider: 'gmail', email: 'me@gmail.com' } }],
    ['a Microsoft token for the Sarv edge', { oauth: { provider: 'microsoft', email: 'me@outlook.com' } }],
    ['a Sarv token for a non-Sarv host', { url: 'https://evil.example/v1/chat/completions' }],
    ['a Sarv token for OpenAI', { url: 'https://api.openai.com/v1/chat/completions' }],
    ['a Sarv token for a lookalike host', { url: 'https://jpr1-ai-edge.sarv.com.evil.example/edge/v1/llm/chat/completions' }],
    // A check loosened into a lookup lets a crafted id slip past: an object-key
    // test admits '__proto__', a case-fold admits 'SARV', a trim admits ' sarv '.
    ['an upper-cased provider id', { oauth: { provider: 'SARV', email: 'me@sarv.com' } }],
    ['a padded provider id', { oauth: { provider: ' sarv ', email: 'me@sarv.com' } }],
    ['a prototype key as provider id', { oauth: { provider: '__proto__', email: 'me@sarv.com' } }],
    ['an inherited method name as provider id', { oauth: { provider: 'toString', email: 'me@sarv.com' } }],
    ['an empty provider id', { oauth: { provider: '', email: 'me@sarv.com' } }],
  ])('refuses %s', async (_what, over) => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'), liveAccount('gmail', 'me@gmail.com', 'gmail-live-token'));

    const res = await proxyAiProviderFetch(sarvRequest(over));

    expect(res).toMatchObject({ ok: false, reason: 'oauth-refused' });
    expect(JSON.stringify(res)).not.toMatch(/live-token/);
    expect(getAccount).not.toHaveBeenCalled();
    expect(h.edge).not.toHaveBeenCalled();
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  // The shared AI transport rule (core checkAIEndpoint, CASA I-7) refuses these
  // addresses for every request before the OAuth rule is consulted, so they
  // come back as invalid requests. Breaks: the Sarv token goes out over plain
  // HTTP, or to a URL carrying someone else's credentials.
  it.each([
    ['a Sarv token over plain http', { url: 'http://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions' }],
    ['a credentialed URL', { url: 'https://user:pass@jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions' }],
  ])('refuses %s under the shared transport rule', async (_what, over) => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));

    const res = await proxyAiProviderFetch(sarvRequest(over));

    expect(res).toMatchObject({ ok: false, reason: 'invalid-request' });
    expect(JSON.stringify(res)).not.toMatch(/live-token/);
    expect(getAccount).not.toHaveBeenCalled();
    expect(h.edge).not.toHaveBeenCalled();
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  // Breaks: a malformed sign-in reference reaches the token store.
  it.each<[string, unknown]>([
    ['an empty email', { provider: 'sarv', email: '' }],
    ['a missing email', { provider: 'sarv' }],
    ['an array provider', { provider: ['sarv'], email: 'me@sarv.com' }],
    ['an object provider', { provider: { id: 'sarv' }, email: 'me@sarv.com' }],
    ['a number provider', { provider: 42, email: 'me@sarv.com' }],
    ['a missing provider', { email: 'me@sarv.com' }],
    ['a non-string email', { provider: 'sarv', email: ['me@sarv.com'] }],
    ['null', null],
    ['a string', 'sarv'],
  ])('rejects an oauth reference with %s as invalid', async (_what, oauth) => {
    expect(await proxyAiProviderFetch(sarvRequest({ oauth }))).toMatchObject({ ok: false, reason: 'invalid-request' });
    expect(getAccount).not.toHaveBeenCalled();
    expect(h.edge).not.toHaveBeenCalled();
  });

  // The audit trail: a refusal is a failed access-control decision and must be
  // logged — naming the provider and the endpoint's origin, never echoing
  // renderer text (a crafted value must not forge lines in app.log).
  it('logs each refusal once, without renderer-supplied text', async () => {
    const forged = '\n[2026-09-29 00:00:00.000] [INFO] [oauth-service] forged';
    await proxyAiProviderFetch(sarvRequest({ oauth: { provider: 'gmail', email: 'me@gmail.com' }, url: 'https://evil.example/v1/x?q=1' }));
    await proxyAiProviderFetch(sarvRequest({ oauth: { provider: `gmail${forged}`, email: 'me@gmail.com' } }));
    await proxyAiProviderFetch(sarvRequest({ url: `https://evil.example/v1/${forged}` }));

    const warnings = logs.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(3);
    expect(warnings[0].message).toContain('Refused a gmail token for AI endpoint https://evil.example');
    expect(warnings[0].message).not.toContain('q=1');
    expect(warnings[1].message).toContain('an unrecognised provider');
    for (const { message } of warnings) {
      expect(message).not.toContain('forged');
      expect(message).not.toContain('\n');
    }
  });
});

describe('proxyAiProviderFetch — the 401 retry', () => {
  // THE self-heal: the edge refused a token our clock still trusted. Exactly
  // one forced refresh and one retry, with the fresh token.
  it('on 401 forces a refresh and retries exactly once', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    edgeReplies({ status: 401, body: { error: 'invalid_token' } }, { status: 200, body: { choices: [] } });

    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: true, status: 200 });

    expect(bearersSent()).toEqual(['Bearer sarv-live-token', 'Bearer fresh-for-rt-me@sarv.com']);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    // The retry sends the same request body (a 401 means nothing was processed).
    expect(h.edge.mock.calls[1][1].body).toBe('{"model":"m"}');
    expect(logs.some((l) => l.message.includes('refused the Sarv token (401)'))).toBe(true);
  });

  // Breaks: a refused fresh token is retried again (and again force-refreshed).
  it('returns the second 401 instead of retrying twice', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    edgeReplies({ status: 401, body: { error: 'invalid_token' } });

    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: true, status: 401 });
    expect(h.edge).toHaveBeenCalledTimes(2);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
  });

  // Breaks: a server error or a scope/CAI verdict forces a refresh and a
  // duplicate request (a 500 may have been processed — a retry double-spends).
  it.each([500, 403, 429])('does not retry a %i', async (status) => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    edgeReplies({ status });

    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: true, status });
    expect(h.edge).toHaveBeenCalledTimes(1);
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  // Breaks: a session revoked server-side is reported as the 401 (or a network
  // error) instead of "sign in again".
  it('reports a failed forced refresh after a 401 as sign-in-required', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    edgeReplies({ status: 401 });
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });

    expect(await proxyAiProviderFetch(sarvRequest())).toEqual({
      ok: false, reason: 'sign-in-required', error: expect.stringContaining('Token refresh failed (400)'),
    });
    expect(h.edge).toHaveBeenCalledTimes(1);
  });
});

describe('proxyAiProviderFetch — when the Sarv token cannot be had', () => {
  // Permanent. Breaks if a revoked session sends the stale token, or the
  // renderer loses the message it showed for "sign in to Sarv again".
  it('reports a permanent refresh failure as sign-in-required, never the stale token', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token reuse detected' } });

    const res = await proxyAiProviderFetch(sarvRequest());

    expect(res).toEqual({ ok: false, reason: 'sign-in-required', error: expect.stringContaining('Token refresh failed (400)') });
    expect(JSON.stringify(res)).not.toContain('stale-token');
    expect(h.edge).not.toHaveBeenCalled();
    // The account address stays out of the log line.
    expect(logs.find((l) => l.message.includes('no Sarv token'))?.message).not.toContain('me@sarv.com');
  });

  // A signed-out account is permanent too.
  it('reports a missing account as sign-in-required', async () => {
    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: false, reason: 'sign-in-required' });
    expect(h.edge).not.toHaveBeenCalled();
  });

  // An empty stored token must never go out as `Authorization: Bearer `.
  it('reports an empty stored token as sign-in-required without sending', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', ''));
    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: false, reason: 'sign-in-required' });
    expect(h.edge).not.toHaveBeenCalled();
  });

  // Transient. Breaks if one network blip sticks (the proxy must keep no state,
  // so the next request refreshes again and succeeds) or reads as "sign in again".
  it('reports an unreachable token endpoint as token-unavailable and recovers next time', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));
    tokenReply = () => new TypeError('fetch failed');

    expect(await proxyAiProviderFetch(sarvRequest())).toEqual({
      ok: false, reason: 'token-unavailable', error: expect.stringContaining('Cannot reach OAuth server'),
    });
    expect(h.edge).not.toHaveBeenCalled();

    tokenReply = minted;
    expect(await proxyAiProviderFetch(sarvRequest())).toMatchObject({ ok: true, status: 200 });
    expect(bearersSent()).toEqual(['Bearer fresh-for-rt-me@sarv.com']);
    expect(tokenEndpoint).toHaveBeenCalledTimes(2);
  });
});

describe('proxyAiProviderFetch — two Sarv accounts', () => {
  // Breaks if tokens cross accounts: each request carries its own account's token.
  it('sends each account its own token, concurrently', async () => {
    h.accounts.push(liveAccount('sarv', 'a@sarv.com', 'token-a'), liveAccount('sarv', 'b@sarv.com', 'token-b'));

    await Promise.all([
      proxyAiProviderFetch(sarvRequest({ oauth: { provider: 'sarv', email: 'a@sarv.com' }, body: 'A' })),
      proxyAiProviderFetch(sarvRequest({ oauth: { provider: 'sarv', email: 'b@sarv.com' }, body: 'B' })),
    ]);

    const byBody = Object.fromEntries(h.edge.mock.calls.map(([, init]) => [init.body, init.headers.Authorization]));
    expect(byBody).toEqual({ A: 'Bearer token-a', B: 'Bearer token-b' });
  });

  // Breaks if one dead session fails the other, or refreshes cross accounts.
  it('keeps them apart when one refresh fails', async () => {
    h.accounts.push(expiredAccount('sarv', 'a@sarv.com'), expiredAccount('sarv', 'b@sarv.com'));
    tokenReply = (rt) => (rt === 'rt-a@sarv.com' ? { status: 400, body: { error: 'invalid_grant' } } : minted(rt));

    const [a, b] = await Promise.all([
      proxyAiProviderFetch(sarvRequest({ oauth: { provider: 'sarv', email: 'a@sarv.com' } })),
      proxyAiProviderFetch(sarvRequest({ oauth: { provider: 'sarv', email: 'b@sarv.com' } })),
    ]);

    expect(a).toMatchObject({ ok: false, reason: 'sign-in-required' });
    expect(b).toMatchObject({ ok: true, status: 200 });
    expect(bearersSent()).toEqual(['Bearer fresh-for-rt-b@sarv.com']);
  });
});

describe('proxyAiProviderFetch — abort', () => {
  // Breaks: a cancelled Sarv request keeps running (and spending) in main.
  it('aborts an in-flight Sarv request when the renderer gives up', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    h.edge.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    const pending = proxyAiProviderFetch(sarvRequest({ requestId: 'r-abort' }));
    await vi.waitFor(() => expect(h.edge).toHaveBeenCalled());
    abortAiProviderFetch('r-abort');

    expect(await pending).toEqual({ ok: false, reason: 'aborted', error: 'The AI request was cancelled.' });
  });

  // Breaks: an abort sent while main is still refreshing the token is lost,
  // and the request goes out anyway.
  it('honours an abort that arrives while the token is being refreshed', async () => {
    h.accounts.push(expiredAccount('sarv', 'me@sarv.com'));
    let release!: () => void;
    tokenEndpoint.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return new Response(JSON.stringify((minted(JSON.parse(init.body).refresh_token) as { body: unknown }).body), { status: 200 });
    });
    h.edge.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new Error('aborted');
      return new Response('{}', { status: 200 });
    });

    const pending = proxyAiProviderFetch(sarvRequest({ requestId: 'r-early' }));
    await vi.waitFor(() => expect(tokenEndpoint).toHaveBeenCalled());
    abortAiProviderFetch('r-early');
    release();

    expect(await pending).toEqual({ ok: false, reason: 'aborted', error: 'The AI request was cancelled.' });
  });
});
