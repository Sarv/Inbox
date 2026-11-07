import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOAuthProvider, SARV_PRODUCTION_CLIENT_ID, setSarvBaseUrl } from '../../../src/oauth/providers';
import { revokeToken } from '../../../src/oauth/token-refresher';
import type { OAuthProviderConfig } from '../../../src/oauth/types';

// Sign-out revokes the grant at the provider so "remove account" really ends
// the app's access to the mailbox (Google's verification checks this). If this
// breaks, removed Gmail accounts stay listed under the user's Google
// third-party access forever, or — worse — a transient failure is mistaken for
// success and nobody ever retries or tells the user.

const GOOGLE: OAuthProviderConfig = {
  id: 'gmail',
  label: 'Gmail',
  purpose: 'email',
  clientId: 'cid',
  clientSecret: 'csecret',
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  scopes: [],
  tokenBodyFormat: 'form',
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('revokeToken', () => {
  // Happy path: a form POST carrying the refresh token and client credentials.
  it('POSTs the refresh token to the revocation endpoint and reports revoked', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(revokeToken({ provider: GOOGLE, token: 'rt-1' })).resolves.toBe('revoked');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('token')).toBe('rt-1');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('csecret');
  });

  // Idempotent re-run: revoking an already-revoked/expired token is success in
  // effect, not an error to surface.
  it('treats a 400 (already revoked or expired) as already-invalid', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"invalid_token"}', { status: 400 }));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt' })).resolves.toBe('already-invalid');
  });

  // Transient: 5xx / 429 / network must read as failed (grant may be live),
  // and must never throw out of sign-out.
  it('reports failed on 5xx, 429 and network errors without throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt' })).resolves.toBe('failed');

    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt' })).resolves.toBe('failed');

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt' })).resolves.toBe('failed');
  });

  // A hung revocation must not hang sign-out.
  it('reports failed when the request times out', async () => {
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt', timeoutMs: 10 })).resolves.toBe('failed');
  });

  // Public clients (no secret) must not send an empty client_secret.
  it('omits client_secret for a public client', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    await revokeToken({ provider: { ...GOOGLE, clientSecret: undefined }, token: 'rt' });
    const body = new URLSearchParams(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.has('client_secret')).toBe(false);
  });

  // No endpoint → no request at all (Microsoft, Sarv, Yahoo).
  it('returns unsupported without any request when the provider has no endpoint', async () => {
    await expect(revokeToken({ provider: { ...GOOGLE, revokeEndpoint: undefined }, token: 'rt' })).resolves.toBe('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('provider revocation endpoints', () => {
  // Yahoo is cloned from the Gmail template: inheriting Google's revoke URL
  // would send Yahoo refresh tokens to Google.
  // Changed deliberately (CASA tracker 6): Sarv now has one too. Breaks: a removed
  // Sarv account's sign-in stays live at Sarv.
  it('Gmail and Sarv have a revocation endpoint, each its own', () => {
    expect(getOAuthProvider('gmail').revokeEndpoint).toBe('https://oauth2.googleapis.com/revoke');
    expect(getOAuthProvider('sarv').revokeEndpoint).toBe('https://oauth.sarv.com/api/oauth/revoke');
    expect(getOAuthProvider('yahoo').revokeEndpoint).toBeUndefined();
    expect(getOAuthProvider('microsoft').revokeEndpoint).toBeUndefined();
  });
});

/**
 * Sarv's revocation endpoint, as measured on 2026-11-05 with no real token: a
 * JSON POST of { token, token_type_hint, client_id }; a form POST or a missing
 * field gets 422; an unknown token gets 200 with
 * { revoked: false, message: 'Token not found or already revoked' }.
 *
 * What breaks if these fail: removing a Sarv account leaves its sign-in live at
 * Sarv, or the app says it ended a sign-in nothing confirmed.
 */
describe('revokeToken — Sarv', () => {
  const OK = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const sarv = () => getOAuthProvider('sarv');
  afterEach(() => setSarvBaseUrl({ oauthBase: 'https://oauth.sarv.com' }));

  // Breaks: nothing is ever revoked at Sarv, or the body is a form Sarv answers 422 to.
  it('POSTs JSON with the token, hint and client id, and no client secret', async () => {
    fetchMock.mockResolvedValueOnce(OK({ revoked: true }));
    await expect(revokeToken({ provider: sarv(), token: 'sarv-rt' })).resolves.toBe('revoked');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth.sarv.com/api/oauth/revoke');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      token: 'sarv-rt',
      token_type_hint: 'refresh_token',
      client_id: SARV_PRODUCTION_CLIENT_ID,
    });
  });

  // Breaks: a dev build signed in against localhost sends its token to production.
  it('follows a dev OAuth server: the endpoint comes from the OAuth base URL', () => {
    setSarvBaseUrl({ oauthBase: 'http://localhost:8123' });
    expect(sarv().revokeEndpoint).toBe('http://localhost:8123/api/oauth/revoke');
    expect(sarv().tokenEndpoint).toBe('http://localhost:8123/api/oauth/token');
  });

  // THE measured answer, and the idempotent re-run. Breaks: an unknown or
  // already-revoked token is reported as a revocation that just happened.
  it('reads a 200 saying revoked:false as already-invalid, not revoked', async () => {
    fetchMock.mockResolvedValueOnce(OK({ revoked: false, message: 'Token not found or already revoked' }));
    await expect(revokeToken({ provider: sarv(), token: 'gone' })).resolves.toBe('already-invalid');
  });

  // Breaks: the same 200 from Google, whose body is empty, stops reading as revoked.
  it.each([
    ['empty', ''],
    ['whitespace', ' \n'],
    ['an empty JSON object', '{}'],
    ['JSON with no revoked field', '{"ok":true}'],
    ['revoked:true', '{"revoked":true}'],
  ])('reads a 200 with %s as revoked', async (_what, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt' })).resolves.toBe('revoked');
  });

  // Answers that confirm nothing. Breaks: a 200 carrying an error, or a shape
  // nobody documented, is logged as the grant being revoked.
  it.each([
    ['a revoked that is not a boolean', '{"revoked":"false"}'],
    ['a revoked of 0', '{"revoked":0}'],
    ['a revoked of null', '{"revoked":null}'],
    ['an error', '{"error":"server_error"}'],
    ['a JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"ok"'],
  ])('reports failed for a 200 with %s', async (_what, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
    await expect(revokeToken({ provider: sarv(), token: 'rt' })).resolves.toBe('failed');
  });

  // Google's answer for a token already gone, which is the state we wanted.
  // Breaks: its idempotent re-run reads as a failure.
  it.each([['invalid_token'], ['invalid_grant']])('reads a 400 saying %s as already-invalid', async (error) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: 400 }));
    await expect(revokeToken({ provider: GOOGLE, token: 'rt' })).resolves.toBe('already-invalid');
  });

  // RFC 7009 keeps 400 for a refused request. Not a documented Sarv answer at all.
  // Breaks: a request the server refused is reported to the user as the sign-in ended.
  it.each([
    ['another error', '{"error":"invalid_request"}'],
    ['no error', '{}'],
    ['an empty body', ''],
    ['a body that is not JSON', 'Bad Request'],
  ])('reports failed for a 400 with %s', async (_what, body) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
    await expect(revokeToken({ provider: sarv(), token: 'rt' })).resolves.toBe('failed');
  });

  // Captive portal / proxy. Breaks: a sign-in page answering 200 is logged as
  // the grant being revoked, and the user is never told it may still be live.
  it('reports failed for a 200 whose body is not JSON, without logging the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValueOnce(new Response('<html>Sign in to the Wi-Fi: sarv-rt</html>', { status: 200 }));
      await expect(revokeToken({ provider: sarv(), token: 'sarv-rt' })).resolves.toBe('failed');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Wi-Fi');
    } finally {
      warn.mockRestore();
    }
  });

  // Connection cut after the status line. Breaks: an unread answer counts as confirmed.
  it('reports failed when the 2xx body cannot be read', async () => {
    const res = new Response(new ReadableStream({ start(c) { c.error(new Error('socket closed')); } }), { status: 200 });
    fetchMock.mockResolvedValueOnce(res);
    await expect(revokeToken({ provider: sarv(), token: 'rt' })).resolves.toBe('failed');
  });

  // Permanent refusals and transient failures alike. Breaks: any of them is read
  // as success, so a live grant is reported as ended.
  it.each([[401], [403], [404], [405], [422], [429], [500], [502], [503]])('reports failed on %i', async (status) => {
    fetchMock.mockResolvedValueOnce(new Response('{"detail":"no"}', { status }));
    await expect(revokeToken({ provider: sarv(), token: 'rt' })).resolves.toBe('failed');
  });

  // Breaks: the sign-in that was just being ended lands in app.log. Every path.
  it('never logs the token', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); }));
    try {
      for (const answer of [
        () => Promise.resolve(OK({ revoked: true })),
        () => Promise.resolve(OK({ revoked: false })),
        () => Promise.resolve(new Response('', { status: 503 })),
        () => Promise.resolve(new Response('SECRET-REFRESH-TOKEN', { status: 400 })),
        () => Promise.resolve(new Response('not json', { status: 200 })),
        () => Promise.reject(new TypeError('fetch failed')),
      ]) {
        fetchMock.mockImplementationOnce(answer);
        await revokeToken({ provider: sarv(), token: 'SECRET-REFRESH-TOKEN' });
      }
      expect(lines.join('\n')).not.toContain('SECRET-REFRESH-TOKEN');
      // The assertion above must have had log lines to look at.
      expect(lines.length).toBeGreaterThan(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
