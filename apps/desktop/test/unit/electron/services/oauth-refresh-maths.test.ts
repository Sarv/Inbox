import { OAuthError } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


/**
 * The refresh-timing maths and error classification from `oauth-service` — the
 * shared decision behind BOTH the lazy gate and the proactive scheduler, so they
 * can never disagree about when a token is due.
 *
 * Pinned: the due-point is the EARLIER of the 5-minute hard floor before `exp`
 * and 75% of the token's lifetime; the JWT's own `exp`/`iat` win over the stored
 * estimate; and only a dead-grant style failure counts as TERMINAL (network /
 * 5xx / rate-limit must stay retryable).
 *
 * Only the store is mocked — the rest of oauth-service is the real module (its
 * network paths are never entered here).
 */

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => '/tmp/sarvinbox-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async () => null,
  saveAccount: async () => {},
  removeAccount: async () => false,
  listAccounts: async () => [],
}));

import { isAccountGoneError, isTerminalOAuthError, msUntilRefresh } from '../../../../electron/services/oauth-service';

const NOW_SEC = 1_800_000_000;

/** A signed-JWT-shaped access token carrying the given claims. */
const jwt = (claims: Record<string, unknown>): string =>
  ['hdr', Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url'), 'sig'].join('.');

const account = (over: Record<string, unknown> = {}) =>
  ({
    provider: 'gmail',
    email: 'me@gmail.com',
    accessToken: 'opaque-token',
    refreshToken: 'rt',
    accessExpiresAt: NOW_SEC + 3_600,
    updatedAt: NOW_SEC,
    ...over,
  }) as unknown as Parameters<typeof msUntilRefresh>[0];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => { vi.useRealTimers(); });

describe('msUntilRefresh', () => {
  it('uses 75% of the lifetime for a LONG-lived token (the fraction wins)', () => {
    // 1h lifetime issued now: 75% -> 45min, floor -> 55min. The earlier wins.
    expect(msUntilRefresh(account())).toBe(45 * 60_000);
  });

  it('uses the 5-minute hard floor for a SHORT-lived token (the floor wins)', () => {
    // 10min lifetime: 75% -> 7.5min, floor -> 5min. The floor is earlier.
    expect(msUntilRefresh(account({ accessExpiresAt: NOW_SEC + 600 }))).toBe(5 * 60_000);
  });

  it('prefers the JWT’s own exp/iat over the stored estimate', () => {
    const token = jwt({ iat: NOW_SEC, exp: NOW_SEC + 3_600 });
    const withStaleStore = account({
      accessToken: token,
      accessExpiresAt: NOW_SEC + 10, // wrong local estimate
      updatedAt: NOW_SEC - 10_000,
    });
    expect(msUntilRefresh(withStaleStore)).toBe(45 * 60_000);
  });

  it('is NEGATIVE (overdue) for an already-expired token', () => {
    expect(msUntilRefresh(account({ accessExpiresAt: NOW_SEC - 60, updatedAt: NOW_SEC - 3_660 })))
      .toBeLessThan(0);
  });

  it('accounts for elapsed time since issuance', () => {
    // Issued 30 min ago with a 1h lifetime: the 75% point is 15 min away.
    const half = account({ updatedAt: NOW_SEC - 1_800, accessExpiresAt: NOW_SEC + 1_800 });
    expect(msUntilRefresh(half)).toBe(15 * 60_000);
  });

  it('falls back to the floor when the lifetime is not positive (bad/missing iat)', () => {
    // updatedAt in the FUTURE relative to exp -> lifetime <= 0 -> floor only.
    const weird = account({ accessExpiresAt: NOW_SEC + 3_600, updatedAt: NOW_SEC + 7_200 });
    expect(msUntilRefresh(weird)).toBe((3_600 - 300) * 1000);
  });

  it('ignores an unparseable or non-JWT access token and uses the stored values', () => {
    const notAJwt = account({ accessToken: 'ya29.opaque-google-token' });
    expect(msUntilRefresh(notAJwt)).toBe(45 * 60_000);

    const brokenJwt = account({ accessToken: 'a.not-base64-json.c' });
    expect(msUntilRefresh(brokenJwt)).toBe(45 * 60_000);
  });

  it('ignores non-numeric JWT claims and falls back to the stored values', () => {
    const badClaims = account({ accessToken: jwt({ exp: 'soon', iat: null }) });
    expect(msUntilRefresh(badClaims)).toBe(45 * 60_000);
  });
});

describe('isTerminalOAuthError', () => {
  it.each([
    ['EMPTY_STORED_TOKEN'],
    ['EMPTY_REFRESH_TOKEN'],
  ])('treats OAuthError %s as terminal (nothing to refresh with)', (code) => {
    expect(isTerminalOAuthError(new OAuthError('no token', code))).toBe(true);
  });

  it('treats a network-class OAuthError as TRANSIENT', () => {
    expect(isTerminalOAuthError(new OAuthError('socket hang up', 'TOKEN_REFRESH_NETWORK_ERROR'))).toBe(false);
  });

  // A refresh we CANCELLED (sleep, deadline) or never sent (suspended) says
  // nothing about the grant — the server may even have rotated successfully.
  // Calling any of these terminal signs the user out over a closed lid.
  it.each([
    ['TOKEN_REFRESH_TIMEOUT'],
    ['TOKEN_REFRESH_ABORTED'],
    ['REFRESH_DEFERRED_SUSPENDED'],
  ])('treats a cancelled/deferred refresh (%s) as TRANSIENT', (code) => {
    expect(isTerminalOAuthError(new OAuthError('unknown outcome', code))).toBe(false);
  });

  it.each([
    ['invalid_grant'],
    ['invalid_client'],
    ['unauthorized_client'],
    ['invalid_token'],
  ])('treats a %s rejection from the token endpoint as terminal', (reason) => {
    expect(isTerminalOAuthError(new Error(`refresh failed: ${reason}`))).toBe(true);
    expect(isTerminalOAuthError({ message: 'refresh failed', serverResponse: reason.toUpperCase() })).toBe(true);
  });

  it('treats a 400 / 401 as terminal', () => {
    expect(isTerminalOAuthError(new Error('Token refresh failed (400)'))).toBe(true);
    expect(isTerminalOAuthError(new Error('Token refresh failed (401)'))).toBe(true);
  });

  it.each([
    ['Token refresh failed (429)'],
    ['Token refresh failed (500)'],
    ['Token refresh failed (503)'],
    ['ETIMEDOUT'],
    ['getaddrinfo ENOTFOUND oauth2.googleapis.com'],
  ])('keeps %s retryable', (message) => {
    expect(isTerminalOAuthError(new Error(message))).toBe(false);
  });

  it('is safe on a null / non-error value', () => {
    expect(isTerminalOAuthError(null)).toBe(false);
    expect(isTerminalOAuthError(undefined)).toBe(false);
    expect(isTerminalOAuthError('invalid_grant')).toBe(false); // a bare string carries no message
  });
});

describe('isAccountGoneError', () => {
  it('is true only for the ACCOUNT_NOT_FOUND OAuthError', () => {
    expect(isAccountGoneError(new OAuthError('gone', 'ACCOUNT_NOT_FOUND'))).toBe(true);
    expect(isAccountGoneError(new OAuthError('other', 'EMPTY_STORED_TOKEN'))).toBe(false);
    expect(isAccountGoneError(new Error('ACCOUNT_NOT_FOUND'))).toBe(false);
    expect(isAccountGoneError(null)).toBe(false);
  });
});
