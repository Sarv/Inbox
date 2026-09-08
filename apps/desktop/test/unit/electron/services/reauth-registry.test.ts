import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllReauthRequired,
  clearReauthRequired,
  getReauthRequirement,
  listReauthRequired,
  markReauthRequired,
} from '../../../../electron/services/reauth-registry';

/**
 * The registry is what makes a re-auth prompt survivable: the OS notification is
 * a moment, this is the state a renderer can ask for later. Every test here
 * pins a way the banner could go missing, or refuse to leave.
 */
describe('reauth registry', () => {
  beforeEach(() => clearAllReauthRequired());

  // If a requirement isn't retrievable, a window that opens after the failure
  // shows nothing and mail stops arriving with no explanation on screen.
  it('records an account so it can be pulled later', () => {
    markReauthRequired('sarv', 'a@example.com', 'invalid_grant', '2026-09-08T00:00:00.000Z');
    expect(listReauthRequired()).toEqual([
      { provider: 'sarv', email: 'a@example.com', reason: 'invalid_grant', since: '2026-09-08T00:00:00.000Z' },
    ]);
  });

  // The caller only fires a native toast on `true`. If a repeat failure returned
  // true, one broken account could queue a toast per retry.
  it('reports first-time only, so repeat failures cannot re-notify', () => {
    expect(markReauthRequired('sarv', 'a@example.com', 'first')).toBe(true);
    expect(markReauthRequired('sarv', 'a@example.com', 'second')).toBe(false);
  });

  // The banner says how long an account has been broken; a retry must not make
  // a day-old failure look like it just happened.
  it('keeps the original since but updates the reason on a repeat', () => {
    markReauthRequired('sarv', 'a@example.com', 'first', '2026-09-08T00:00:00.000Z');
    markReauthRequired('sarv', 'a@example.com', 'second', '2026-09-08T06:00:00.000Z');
    expect(listReauthRequired()).toEqual([
      { provider: 'sarv', email: 'a@example.com', reason: 'second', since: '2026-09-08T00:00:00.000Z' },
    ]);
  });

  // Multi-account is the norm here. Keying by email alone would let a gmail
  // failure silence the identical sarv address, or vice versa.
  it('keys by provider AND email', () => {
    markReauthRequired('sarv', 'same@example.com', 'sarv died', '2026-09-08T00:00:00.000Z');
    markReauthRequired('gmail', 'same@example.com', 'gmail died', '2026-09-08T00:00:01.000Z');
    expect(listReauthRequired().map((r) => r.provider)).toEqual(['sarv', 'gmail']);
  });

  // Oldest first, so the banner's "Sign in" always targets the account that has
  // been broken longest rather than whichever failed most recently.
  it('lists oldest failure first regardless of insertion order', () => {
    markReauthRequired('sarv', 'new@example.com', 'x', '2026-09-08T09:00:00.000Z');
    markReauthRequired('sarv', 'old@example.com', 'x', '2026-09-08T01:00:00.000Z');
    expect(listReauthRequired().map((r) => r.email)).toEqual(['old@example.com', 'new@example.com']);
  });

  // A banner that cannot be cleared is worse than no banner: it would still be
  // demanding a sign-in for an account that already works.
  it('clears a resolved account and reports whether anything was cleared', () => {
    markReauthRequired('sarv', 'a@example.com', 'x');
    expect(clearReauthRequired('sarv', 'a@example.com')).toBe(true);
    expect(listReauthRequired()).toEqual([]);
  });

  // The scheduler clears on EVERY successful refresh. If that returned true for
  // a healthy account it would broadcast a pointless event on every refresh.
  it('reports false when the account was never broken', () => {
    expect(clearReauthRequired('sarv', 'never@example.com')).toBe(false);
  });

  // Clearing one account must not clear its siblings — a Gmail sign-in should
  // not make the Sarv banner disappear while that account is still broken.
  it('clears only the named account', () => {
    markReauthRequired('sarv', 'a@example.com', 'x', '2026-09-08T00:00:00.000Z');
    markReauthRequired('gmail', 'b@example.com', 'y', '2026-09-08T00:00:01.000Z');
    clearReauthRequired('sarv', 'a@example.com');
    expect(listReauthRequired().map((r) => r.email)).toEqual(['b@example.com']);
  });

  // Returned array must be a copy — a caller mutating it (sort, splice) would
  // otherwise corrupt the registry itself.
  it('returns a snapshot the caller cannot mutate into the registry', () => {
    markReauthRequired('sarv', 'a@example.com', 'x');
    listReauthRequired().pop();
    expect(listReauthRequired()).toHaveLength(1);
  });

  // The single-account lookup drives the fast-fail gate on the token path. If
  // it missed, every reconnect would resume POSTing a revoked refresh token.
  it('answers a single-account lookup with the recorded reason', () => {
    markReauthRequired('sarv', 'a@example.com', 'session revoked');
    expect(getReauthRequirement('sarv', 'a@example.com')?.reason).toBe('session revoked');
  });

  it('answers undefined for an account that is fine', () => {
    expect(getReauthRequirement('sarv', 'healthy@example.com')).toBeUndefined();
    markReauthRequired('gmail', 'other@example.com', 'x');
    expect(getReauthRequirement('sarv', 'other@example.com')).toBeUndefined();
  });

  // The scheduler reads addresses from the token store, the connect path from
  // the IMAP config, and the renderer from its own account list. A case
  // difference between any two would fork one broken account into two entries —
  // and let the gated one slip past the token-path check.
  it('treats an address as the same account whatever its case', () => {
    markReauthRequired('sarv', 'Ankur.D@Sarv.com', 'first');
    expect(getReauthRequirement('sarv', 'ankur.d@sarv.com')?.reason).toBe('first');

    markReauthRequired('sarv', 'ankur.d@sarv.com', 'second');
    expect(listReauthRequired()).toHaveLength(1);
    expect(clearReauthRequired('sarv', 'ANKUR.D@SARV.COM')).toBe(true);
    expect(listReauthRequired()).toHaveLength(0);
  });

  // …while still showing the address the way the user wrote it.
  it('keeps the original spelling for display', () => {
    markReauthRequired('sarv', 'Ankur.D@Sarv.com', 'x');
    expect(listReauthRequired()[0].email).toBe('Ankur.D@Sarv.com');
  });
});
