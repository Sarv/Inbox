import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getOAuthProvider } from '../../../src/oauth/providers';
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
  it('only Gmail has a revocation endpoint', () => {
    expect(getOAuthProvider('gmail').revokeEndpoint).toBe('https://oauth2.googleapis.com/revoke');
    expect(getOAuthProvider('yahoo').revokeEndpoint).toBeUndefined();
    expect(getOAuthProvider('microsoft').revokeEndpoint).toBeUndefined();
    expect(getOAuthProvider('sarv').revokeEndpoint).toBeUndefined();
  });
});
