import { OAuthError } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';


/**
 * The fast-fail gate in front of the token endpoint.
 *
 * THE incident these pin (2026-09-08): a revoked Sarv session. Every connect
 * path in the app — startup auto-connect, the window-focus check, selectAccount,
 * the background sync tier, the IMAP reconnect ladder — independently retried,
 * and each retry POSTed the same dead refresh token. The log took 140–230 lines
 * a minute for over ten minutes, and replaying a spent token at a reuse detector
 * is precisely what keeps a family revoked.
 *
 * Once an account is KNOWN to need an interactive sign-in, no further request
 * may leave the machine until the user signs in. But the gate must not overreach:
 * a still-valid access token has to keep working, a refresh already in the air
 * has to finish, and the requirement must lift the instant the user signs in.
 *
 * Only the store and the network gate are faked — the token path is the real
 * oauth-service and the real core token-refresher.
 */

const h = vi.hoisted(() => ({
  state: { account: null as Record<string, unknown> | null },
}));

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => '/tmp/sarvinbox-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async () => h.state.account,
  saveAccount: async () => {},
  removeAccount: async () => false,
  listAccounts: async () => [],
}));

vi.mock('../../../../electron/services/network-readiness', () => ({
  waitForNetworkReady: async () => true,
}));

import { getValidAccessToken } from '../../../../electron/services/oauth-service';
import {
  clearAllReauthRequired,
  markReauthRequired,
  clearReauthRequired,
} from '../../../../electron/services/reauth-registry';

const SARV = 'sarv' as never;
const EMAIL = 'advik.d@sarv.com';
const NOW_SEC = 1_800_000_000;
const REVOKED =
  'Token refresh failed (400): {"detail":"Refresh token reuse detected. This session has been revoked for security; the user must sign in again."}';

/** An account whose access token expired an hour ago — a refresh is due. */
const expiredAccount = () => ({
  provider: 'sarv',
  email: EMAIL,
  accessToken: 'stale-token',
  refreshToken: 'rt-dead',
  accessExpiresAt: NOW_SEC - 3_600,
  scopes: ['mail'],
  updatedAt: NOW_SEC - 7_200,
});

/** The same account with a token that is still comfortably valid. */
const liveAccount = () => ({
  ...expiredAccount(),
  accessToken: 'still-good',
  accessExpiresAt: NOW_SEC + 3_600,
  updatedAt: NOW_SEC - 60,
});

let fetchMock: Mock<[], Promise<Response>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  clearAllReauthRequired();
  h.state.account = expiredAccount();
  fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ access_token: 'fresh-token', expires_in: 900, token_type: 'Bearer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  clearAllReauthRequired();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('re-auth gate on getValidAccessToken', () => {
  // THE regression: without this, every reconnect re-POSTs a token the server
  // has already revoked. Nothing may reach the network.
  it('refuses to refresh once the account is known to need a sign-in', async () => {
    markReauthRequired(SARV, EMAIL, REVOKED);

    const err = await getValidAccessToken(SARV, EMAIL).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe('REAUTH_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The recorded reason travels with the error, so the log says WHY a connect
  // was refused instead of an unexplained failure minutes after the real one.
  it('carries the recorded reason into the error', async () => {
    markReauthRequired(SARV, EMAIL, REVOKED);

    const err = await getValidAccessToken(SARV, EMAIL).catch((e) => e);

    expect((err as Error).message).toContain('needs an interactive sign-in');
    expect((err as Error).message).toContain('reuse detected');
  });

  // Deliberately AFTER the cached-token fast path. An account can be marked
  // while its current access token still has minutes of life; killing that
  // would break a working connection earlier than necessary.
  it('still hands out an access token that is not yet due for refresh', async () => {
    h.state.account = liveAccount();
    markReauthRequired(SARV, EMAIL, REVOKED);

    await expect(getValidAccessToken(SARV, EMAIL)).resolves.toBe('still-good');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The gate keys on provider+email, so one broken account must not stop a
  // healthy one — the multi-account case, where a silent block is invisible.
  it('leaves a different account untouched', async () => {
    markReauthRequired(SARV, 'someone.else@sarv.com', REVOKED);

    await expect(getValidAccessToken(SARV, EMAIL)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The scheduler reads addresses from the token store while the connect path
  // reads them from the IMAP config. A case difference between the two would
  // let the gated account slip straight past and resume hammering.
  it('matches the account however its address is capitalised', async () => {
    markReauthRequired(SARV, 'Advik.D@Sarv.com', REVOKED);

    const err = await getValidAccessToken(SARV, EMAIL).catch((e) => e);

    expect((err as OAuthError).code).toBe('REAUTH_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Signing in clears the requirement (rescheduleOAuthAccount does this), and
  // refreshes must resume immediately — otherwise the fix for the storm would
  // become a permanent lockout.
  it('lets refreshes resume the moment the requirement is cleared', async () => {
    markReauthRequired(SARV, EMAIL, REVOKED);
    await expect(getValidAccessToken(SARV, EMAIL)).rejects.toThrow(/interactive sign-in/);

    clearReauthRequired(SARV, EMAIL);

    await expect(getValidAccessToken(SARV, EMAIL)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // An unmarked account is the overwhelmingly common case and must be entirely
  // unaffected — the gate is not allowed to cost a healthy session anything.
  it('does nothing at all when no requirement is recorded', async () => {
    await expect(getValidAccessToken(SARV, EMAIL)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
