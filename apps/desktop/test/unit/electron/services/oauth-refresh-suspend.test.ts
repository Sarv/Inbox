import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { OAuthError } from '@sarvinbox/core';

/**
 * Cancelling and deferring token refreshes around system sleep.
 *
 * THE incident these pin (2026-09-08): macOS Power Nap woke the machine for ~2
 * seconds every ~16 minutes, a refresh POST was started inside that window and
 * frozen mid-flight when the machine slept again. Sarv rotates refresh tokens,
 * so the server consumed the presented token while its response never reached
 * us — and the next attempt replayed a spent token. The reuse detector cannot
 * tell that from theft: it revoked the session, and every refresh for the next
 * nine hours returned 400 "Refresh token reuse detected".
 *
 * Two rules follow, and both are load-bearing:
 *   - don't START a refresh while suspended, and
 *   - ABORT one already in flight when suspend arrives.
 * Neither may cost a healthy account its cached token or its session.
 *
 * Only the store, the network gate and `fetch` are faked — the refresh path
 * itself is the real oauth-service + real core token-refresher.
 */

const h = vi.hoisted(() => ({
  state: {
    account: null as Record<string, unknown> | null,
    saved: [] as Record<string, unknown>[],
  },
}));

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => '/tmp/sarvinbox-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async () => h.state.account,
  saveAccount: async (acc: Record<string, unknown>) => { h.state.saved.push(acc); },
  removeAccount: async () => false,
  listAccounts: async () => [],
}));

// The link-settle wait has its own tests; here it must never add latency.
vi.mock('../../../../electron/services/network-readiness', () => ({
  waitForNetworkReady: async () => true,
}));

import {
  abortInFlightTokenRefreshes,
  getValidAccessToken,
  isRefreshDeferredError,
} from '../../../../electron/services/oauth-service';
import { getSystemSuspended, setSystemSuspended } from '../../../../electron/shared';

const GMAIL = 'gmail' as never;
const EMAIL = 'me@gmail.com';
const NOW_SEC = 1_800_000_000;

/** An account whose access token expired an hour ago — a refresh is due. */
const expiredAccount = () => ({
  provider: 'gmail',
  email: EMAIL,
  accessToken: 'stale-token',
  refreshToken: 'rt-1',
  accessExpiresAt: NOW_SEC - 3_600,
  scopes: ['mail'],
  updatedAt: NOW_SEC - 7_200,
});

const okTokenResponse = (over: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ access_token: 'fresh-token', expires_in: 900, token_type: 'Bearer', ...over }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

/** A fetch that never settles until its AbortSignal fires — a frozen request. */
const hangingFetch = vi.fn((_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
  }),
);

let fetchMock: Mock<[], Promise<Response>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  h.state.account = expiredAccount();
  h.state.saved.length = 0;
  hangingFetch.mockClear();
  fetchMock = vi.fn(async () => okTokenResponse());
  vi.stubGlobal('fetch', fetchMock);
  setSystemSuspended(false);
});

afterEach(() => {
  setSystemSuspended(false);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('refresh gating while suspended', () => {
  // THE regression: a refresh started during sleep cannot finish before the
  // machine sleeps again, and an unfinished refresh against a rotating provider
  // costs the whole session. Nothing may reach the token endpoint.
  it('refuses to START a refresh while the system is suspended', async () => {
    setSystemSuspended(true);

    const err = await getValidAccessToken(GMAIL, EMAIL).catch((e) => e);

    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe('REFRESH_DEFERRED_SUSPENDED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.state.saved).toHaveLength(0);
  });

  // The gate sits AFTER the cached-token fast path deliberately: a token that
  // is still valid must keep being handed out during sleep, or every caller
  // (IDLE reconnects, the sync engine) breaks the moment the lid closes.
  it('still returns a cached token that has not expired', async () => {
    h.state.account = { ...expiredAccount(), accessToken: 'good-token', accessExpiresAt: NOW_SEC + 3_600 };
    setSystemSuspended(true);

    await expect(getValidAccessToken(GMAIL, EMAIL)).resolves.toBe('good-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The scheduler routes on this predicate alone; if a deferral stopped
  // matching it, sleep would start burning the transient-failure budget.
  it('recognises the deferral, and nothing else, as deferred', async () => {
    expect(isRefreshDeferredError(new OAuthError('deferred', 'REFRESH_DEFERRED_SUSPENDED'))).toBe(true);
    expect(isRefreshDeferredError(new OAuthError('cancelled', 'TOKEN_REFRESH_ABORTED'))).toBe(false);
    expect(isRefreshDeferredError(new Error('REFRESH_DEFERRED_SUSPENDED'))).toBe(false);
  });

  // Once awake, the same call must go through — the gate defers, never disables.
  it('refreshes normally again once the system resumes', async () => {
    setSystemSuspended(true);
    await getValidAccessToken(GMAIL, EMAIL).catch(() => {});
    setSystemSuspended(false);

    await expect(getValidAccessToken(GMAIL, EMAIL)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getSystemSuspended()).toBe(false);
  });
});

describe('abortInFlightTokenRefreshes', () => {
  // The suspend hook's actual job: close the socket at a moment we chose,
  // rather than letting sleep freeze it open with the token already spent.
  it('aborts a refresh that is already in flight, with the reason attached', async () => {
    vi.stubGlobal('fetch', hangingFetch);

    const pending = getValidAccessToken(GMAIL, EMAIL).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    abortInFlightTokenRefreshes('system suspend');
    const err = await pending;

    expect((err as OAuthError).code).toBe('TOKEN_REFRESH_ABORTED');
    expect((err as Error).message).toContain('system suspend');
    // Nothing was persisted from a request whose outcome we never learned.
    expect(h.state.saved).toHaveLength(0);
  });

  // The controller must be REPLACED after an abort. Reusing the aborted one
  // would make every later refresh fail instantly — mail would stop for good.
  it('installs a fresh controller so the next refresh is not born aborted', async () => {
    abortInFlightTokenRefreshes('system suspend');

    await expect(getValidAccessToken(GMAIL, EMAIL)).resolves.toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // Safe to call on every suspend, including the overwhelmingly common case of
  // nothing being in flight.
  it('is a no-op when no refresh is running', () => {
    expect(() => abortInFlightTokenRefreshes()).not.toThrow();
  });

  // Single-flight: concurrent callers share ONE POST. Two in-flight refreshes
  // against a rotating provider is itself a reuse-detection trigger.
  it('coalesces concurrent callers into a single token request', async () => {
    const [a, b] = await Promise.all([
      getValidAccessToken(GMAIL, EMAIL),
      getValidAccessToken(GMAIL, EMAIL),
    ]);

    expect(a).toBe('fresh-token');
    expect(b).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
