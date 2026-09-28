import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setOAuthClientId, setOAuthClientSecret } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Microsoft sign-in end to end through `startOAuthFlow`, with only the browser
 * and the network faked. Microsoft's access token is minted for Outlook
 * (IMAP/SMTP), so it can't call a userinfo API; identity MUST come from the
 * id_token. If this breaks, "Sign in with Outlook" fails right after consent
 * with `userinfo failed (401)`, or stores the account under the wrong email.
 */

const saved: unknown[] = [];

// The "browser": follows the authorize URL straight to the app's loopback
// redirect with a code, as Microsoft would after the user consents.
const openExternal = vi.fn(async (url: string) => {
  const u = new URL(url);
  const cb = new URL(u.searchParams.get('redirect_uri')!);
  cb.searchParams.set('code', 'auth-code');
  cb.searchParams.set('state', u.searchParams.get('state')!);
  http.get(cb, (res) => res.resume());
});

vi.mock('electron', () => ({
  shell: { openExternal: (url: string) => openExternal(url) },
  app: { getPath: () => join(tmpdir(), 'sarvinbox-test'), getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async () => null,
  saveAccount: async (a: unknown) => { saved.push(a); },
  removeAccount: async () => false,
  listAccounts: async () => [],
}));

import { startOAuthFlow } from '../../../../electron/services/oauth-service';

const jwt = (payload: unknown): string =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function tokenResponse(extra: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ access_token: 'opaque-outlook-token', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', ...extra }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  saved.length = 0;
  openExternal.mockClear();
  setOAuthClientId('microsoft', 'ms-public-client');
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setOAuthClientId('microsoft', '');
  setOAuthClientSecret('microsoft', '');
});

describe('startOAuthFlow — Microsoft', () => {
  // Happy path: consent → token exchange → identity from id_token, and Graph /
  // any userinfo endpoint is never called with the Outlook-audience token.
  it('signs in with identity from the id_token and never calls userinfo', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ id_token: jwt({ email: 'me@outlook.com', name: 'Me' }) }));

    const account = await startOAuthFlow('microsoft');

    expect(account.email).toBe('me@outlook.com');
    expect(account.displayName).toBe('Me');
    expect(saved).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    // Public client: sending a secret gets AADSTS700025 from Microsoft.
    expect(String(init.body)).not.toContain('client_secret');

    const authUrl = new URL(openExternal.mock.calls[0][0]);
    expect(authUrl.origin + authUrl.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(authUrl.searchParams.get('scope')).toContain('offline_access');
  });

  // Work/school accounts often have no `email` claim — the UPN is the login.
  it('uses preferred_username for work accounts without an email claim', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({ id_token: jwt({ preferred_username: 'u@corp.com' }) }));

    const account = await startOAuthFlow('microsoft');

    expect(account.email).toBe('u@corp.com');
  });

  // No id_token (e.g. openid dropped from scopes) must fail the sign-in, not
  // persist an account keyed on an undefined email.
  it('fails without saving when the token response has no id_token', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse({}));

    await expect(startOAuthFlow('microsoft')).rejects.toMatchObject({ code: 'USERINFO_FAILED' });
    expect(saved).toHaveLength(0);
  });
});
