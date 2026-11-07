import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OAuthError, setSarvBaseUrl } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Removing a Sarv account revokes its refresh token, and the app refreshes that
 * same token on its own schedule. Sarv rotates and runs a reuse detector: a token
 * presented twice reads as theft and revokes the whole session (the 2026-09-08
 * incident, see TOKEN_REQUEST_TIMEOUT_MS in core's token-refresher). So the two
 * must never overlap.
 *
 * What breaks if this file fails:
 *  - a refresh still in the air saves its tokens after the sign-out, so a removed
 *    account's tokens come back to disk and keep refreshing;
 *  - the revocation presents a token that refresh just rotated away, Sarv answers
 *    "not found", the app reports success, and the grant stays live under the new
 *    token nobody here ever saw;
 *  - a refresh presents a token that was just revoked;
 *  - the user is told to "Sign in again" to an account they just removed;
 *  - removing one Sarv account touches another;
 *  - a transient failure is logged or reported as revoked, or the token is logged.
 *
 * Only the store, the network gate and `fetch` are faked: the refresh and
 * revocation paths are the real oauth-service, refresh scheduler and core.
 */

const h = vi.hoisted(() => ({
  store: new Map<string, Record<string, any>>(),
  storeLocked: false,
  /** Rewriting the store fails: no OS key store to seal it with. */
  removeFails: false,
  /** Runs inside a save, as the store's own write would interleave. */
  duringSave: null as (() => void) | null,
  networkGate: null as Promise<void> | null,
  notifications: [] as string[],
  /** Refresh tokens presented to the token endpoint. */
  refreshed: [] as string[],
  /** Tokens presented to the revocation endpoint. */
  revoked: [] as string[],
  tokenAnswer: (_token: string): Promise<Response> => Promise.reject(new Error('no token answer set')),
  revokeAnswer: (_token: string): Promise<Response> => Promise.reject(new Error('no revoke answer set')),
}));

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => join(tmpdir(), 'sarvinbox-test'), getName: () => 'Sarv Inbox Test', isPackaged: false },
  powerMonitor: { on: () => {}, removeListener: () => {} },
  Notification: class {
    static isSupported() { return true; }
    constructor(o: { title: string }) { h.notifications.push(o.title); }
    on() {}
    show() {}
  },
}));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => null, getSystemSuspended: () => false }));
vi.mock('../../../../electron/services/network-readiness', () => ({
  waitForNetworkReady: async () => { await h.networkGate; return true; },
}));
vi.mock('../../../../electron/services/oauth-token-store', () => {
  const key = (p: string, e: string) => `${p}:${e.toLowerCase()}`;
  const guard = () => { if (h.storeLocked) throw new Error('Stored tokens are encrypted but safeStorage is unavailable'); };
  return {
    getAccount: async (p: string, e: string) => { guard(); return h.store.get(key(p, e)) ?? null; },
    saveAccount: async (a: Record<string, any>) => {
      guard();
      h.store.set(key(a.provider, a.email), a);
      const during = h.duringSave;
      h.duringSave = null;
      during?.();
    },
    removeAccount: async (p: string, e: string) => {
      guard();
      if (h.removeFails) throw new Error('macOS Keychain is unavailable.');
      return h.store.delete(key(p, e));
    },
    listAccounts: async () => [...h.store.values()],
  };
});

import { settleRevocation } from '../../../../electron/services/account-revocation';
import { scheduleAccount, signOutOAuthAccount, stopOAuthRefreshScheduler } from '../../../../electron/services/oauth-refresh-scheduler';
import { getValidAccessToken, signOut } from '../../../../electron/services/oauth-service';
import { listReauthRequired } from '../../../../electron/services/reauth-registry';

const A = 'a@sarv.com';
const B = 'b@sarv.com';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3_600;

const seed = (email: string, refreshToken: string, over: Record<string, unknown> = {}) => {
  h.store.set(`sarv:${email}`, {
    provider: 'sarv', email, accessToken: `access-${email}`, refreshToken, accessExpiresAt: FAR_FUTURE, scopes: [],
    updatedAt: Math.floor(Date.now() / 1000), ...over,
  });
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokens = (extra: Record<string, unknown> = {}) => json({ access_token: 'fresh-access', expires_in: 600, ...extra });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Let a request that is about to go out reach the fake network. */
const reach = (cond: () => boolean) => vi.waitFor(() => { if (!cond()) throw new Error('not yet'); });

beforeEach(() => {
  h.store.clear();
  h.storeLocked = false;
  h.removeFails = false;
  h.duringSave = null;
  h.networkGate = null;
  h.notifications.length = 0;
  h.refreshed.length = 0;
  h.revoked.length = 0;
  h.tokenAnswer = async () => tokens();
  h.revokeAnswer = async () => json({ revoked: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    if (String(url).endsWith('/revoke')) { h.revoked.push(body.token); return h.revokeAnswer(body.token); }
    h.refreshed.push(body.refresh_token);
    return h.tokenAnswer(body.refresh_token);
  });
  setSarvBaseUrl({ oauthBase: 'https://oauth.sarv.com' });
});
afterEach(() => {
  stopOAuthRefreshScheduler();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sign-out with a refresh in the air', () => {
  // THE race, on a rotating provider. The revocation must wait, then revoke the
  // token the refresh ended up with: revoking the old one would answer "not
  // found" while the grant lives on under the new one.
  it('waits for it, keeps nothing it returns, and revokes the rotated token', async () => {
    seed(A, 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const caller = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 1);

    const { revocation } = await signOut('sarv', A);
    expect(h.store.has(`sarv:${A}`)).toBe(false);
    // Breaks: revoking while the refresh is unresolved, the reuse-detector case.
    await new Promise((r) => setImmediate(r));
    expect(h.revoked).toEqual([]);

    answer.resolve(tokens({ refresh_token: 'R2' }));

    await expect(revocation).resolves.toBe('revoked');
    expect(h.revoked).toEqual(['R2']);
    // Breaks: the removed account's tokens are back on disk and keep refreshing.
    expect(h.store.has(`sarv:${A}`)).toBe(false);
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  // Sarv today returns no new refresh token. Breaks: the static token goes unrevoked.
  it('revokes the stored token when the refresh did not rotate it', async () => {
    seed(A, 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const caller = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 1);

    const { revocation } = await signOut('sarv', A);
    answer.resolve(tokens());

    await expect(revocation).resolves.toBe('revoked');
    expect(h.revoked).toEqual(['R1']);
    expect(h.store.has(`sarv:${A}`)).toBe(false);
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  // Partial run: the refresh fails transiently. Breaks: a failed refresh stops
  // the revocation, or surfaces its own error instead of "account gone".
  it('still revokes when the refresh fails, and reports the account as gone', async () => {
    seed(A, 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const caller = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 1);

    const { revocation } = await signOut('sarv', A);
    answer.reject(new TypeError('fetch failed'));

    await expect(revocation).resolves.toBe('revoked');
    expect(h.revoked).toEqual(['R1']);
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  // Lost by a hair: the sign-out lands while the refresh's save is being written.
  // Breaks: the save finishes after the removal and the tokens come back to disk.
  it('removes what a refresh was saving when the sign-out landed', async () => {
    seed(A, 'R1');
    h.tokenAnswer = async () => tokens({ refresh_token: 'R2' });
    let signingOut: ReturnType<typeof signOut> | undefined;
    h.duringSave = () => { signingOut = signOut('sarv', A); };

    const caller = getValidAccessToken('sarv', A, true);
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await (await signingOut!).revocation;

    expect(h.store.has(`sarv:${A}`)).toBe(false);
    expect(h.revoked).toEqual(['R2']);
  });

  // A signal-free hang the refresh's own deadline would not catch. Breaks: the
  // grant is never revoked because the sign-out waits forever.
  it('revokes anyway once a stuck refresh has had its time', async () => {
    seed(A, 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const caller = getValidAccessToken('sarv', A, true).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);

    const { revocation } = await signOut('sarv', A);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(revocation).resolves.toBe('revoked');
    expect(h.revoked).toEqual(['R1']);

    // It answers long after, with a rotated token, and the user has signed in
    // again meanwhile. Breaks: the next removal revokes that stale token instead
    // of the current one, and the current sign-in stays live at Sarv.
    answer.resolve(tokens({ refresh_token: 'LATE' }));
    await caller;
    seed(A, 'CURRENT');
    await (await signOut('sarv', A)).revocation;
    expect(h.revoked).toEqual(['R1', 'CURRENT']);
  });

  // The proactive scheduler's refresh loses to the removal with a dead token.
  // Breaks: "Sign in again" for an account the user just removed.
  it('never asks the user to sign in again to the removed account', async () => {
    seed(A, 'R1', { accessExpiresAt: 1, updatedAt: 0 });
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await scheduleAccount('sarv', A);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.refreshed).toEqual(['R1']);

    const { revocation } = await signOutOAuthAccount('sarv', A);
    answer.resolve(json({ error: 'invalid_grant' }, 400));
    await revocation;
    await vi.advanceTimersByTimeAsync(0);

    expect(h.notifications).toEqual([]);
    expect(listReauthRequired()).toEqual([]);
  });
});

// The server may have spent the token while nobody heard back. Then "not found"
// at the revocation does not mean the session ended: it may live on under a token
// we never saw. Breaks: the user is told the sign-in was ended when nothing says so.
describe('sign-out after a refresh nobody heard back from', () => {
  const NOT_FOUND = async () => json({ revoked: false, message: 'Token not found or already revoked' });
  const raceWith = async (end: (answer: ReturnType<typeof deferred<Response>>) => void) => {
    seed(A, 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const caller = getValidAccessToken('sarv', A, true).catch(() => {});
    await reach(() => h.refreshed.length === 1);
    const { revocation } = await signOut('sarv', A);
    end(answer);
    await caller;
    return revocation;
  };

  it('"not found" is a failure, not done, when the refresh dropped', async () => {
    h.revokeAnswer = NOT_FOUND;
    await expect(raceWith((answer) => answer.reject(new TypeError('fetch failed')))).resolves.toBe('failed');
    expect(h.revoked).toEqual(['R1']);
  });

  // An unreadable 200: the server processed something, and we cannot tell what.
  it('"not found" is a failure when the refresh answer was not readable', async () => {
    h.revokeAnswer = NOT_FOUND;
    await expect(raceWith((answer) => answer.resolve(new Response('<html>gateway</html>', { status: 200 })))).resolves.toBe('failed');
  });

  // The token was live and is now revoked, whatever the refresh did.
  it('a confirmed revocation still counts', async () => {
    await expect(raceWith((answer) => answer.reject(new TypeError('fetch failed')))).resolves.toBe('revoked');
  });

  // The server refused the refresh, so it did not rotate: "not found" means gone.
  it('"not found" stays already-invalid when the server answered the refresh', async () => {
    h.revokeAnswer = NOT_FOUND;
    await expect(raceWith((answer) => answer.resolve(json({ error: 'invalid_grant' }, 400)))).resolves.toBe('already-invalid');
  });

  // What the last sign-out could not tell is about an older sign-in. Breaks: the
  // next, clean removal of a new sign-in reports a failure that did not happen.
  it('does not carry over to the next sign-out', async () => {
    h.revokeAnswer = NOT_FOUND;
    await raceWith((answer) => answer.reject(new TypeError('fetch failed')));
    seed(A, 'R2');
    const { revocation } = await signOut('sarv', A);
    await expect(revocation).resolves.toBe('already-invalid');
  });
});

describe('a refresh that would start around the sign-out', () => {
  // Breaks: a late connect or AI call presents the token just revoked.
  it('sends nothing once the account is signed out', async () => {
    seed(A, 'R1');
    const { revocation } = await signOut('sarv', A);
    await revocation;
    await expect(getValidAccessToken('sarv', A, true)).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(h.refreshed).toEqual([]);
  });

  // Waiting for the link to settle at the moment of the sign-out. Breaks: it
  // wakes up and presents the token that is being revoked.
  it('sends nothing when the sign-out lands during its wait for the network', async () => {
    seed(A, 'R1');
    const gate = deferred<void>();
    h.networkGate = gate.promise;
    const caller = getValidAccessToken('sarv', A, true);
    await new Promise((r) => setImmediate(r));

    const { revocation } = await signOut('sarv', A);
    gate.resolve();

    await expect(revocation).resolves.toBe('revoked');
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(h.refreshed).toEqual([]);
    expect(h.revoked).toEqual(['R1']);
  });

  // Asked for in the same tick, in both orders. The second order is the gap between
  // the sign-out starting and the token being gone. Breaks: the refresh slips through,
  // or the sign-out misses it and revokes while it runs.
  it.each([
    ['just before', true],
    ['just after', false],
  ])('sends nothing when asked for %s the sign-out begins', async (_when, refreshFirst) => {
    seed(A, 'R1');
    let caller: Promise<string> | undefined;
    if (refreshFirst) caller = getValidAccessToken('sarv', A, true);
    const signingOut = signOut('sarv', A);
    if (!refreshFirst) caller = getValidAccessToken('sarv', A, true);

    const { revocation } = await signingOut;
    await expect(revocation).resolves.toBe('revoked');

    await expect(caller!).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(h.refreshed).toEqual([]);
    expect(h.store.has(`sarv:${A}`)).toBe(false);
  });
});

describe('a token asked for around the sign-out', () => {
  // The read that was already under way when the sign-out began. Breaks: the
  // cached token of an account being removed is handed to a new connection.
  it('is refused even when the cached one is still valid', async () => {
    seed(A, 'R1');
    const caller = getValidAccessToken('sarv', A);
    const signingOut = signOut('sarv', A);
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await (await signingOut).revocation;
    expect(h.refreshed).toEqual([]);
  });

  // Breaks: the fast path stops working for everyone else because of the check.
  it('still comes from the cache for an account nobody signed out', async () => {
    seed(B, 'RB');
    await expect(getValidAccessToken('sarv', B)).resolves.toBe(`access-${B}`);
    expect(h.refreshed).toEqual([]);
  });
});

describe('signing in again right after removing', () => {
  // Breaks: the old refresh overwrites the new sign-in, or the new tokens get revoked.
  it('keeps the new sign-in whatever the old refresh does, and revokes only the old token', async () => {
    seed(A, 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const caller = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 1);
    const { revocation } = await signOut('sarv', A);

    seed(A, 'NEW', { accessToken: 'new-access' });
    answer.resolve(tokens({ refresh_token: 'OLD-ROTATED' }));
    await revocation;
    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    expect(h.store.get(`sarv:${A}`)?.refreshToken).toBe('NEW');
    expect(h.revoked).toEqual(['OLD-ROTATED']);
    await expect(getValidAccessToken('sarv', A)).resolves.toBe('new-access');

    // And the new session refreshes normally: being signed out once is not a latch.
    h.tokenAnswer = async () => tokens();
    await expect(getValidAccessToken('sarv', A, true)).resolves.toBe('fresh-access');
    expect(h.refreshed).toEqual(['R1', 'NEW']);
  });
});

describe('signing in again while the old refresh is still in the air', () => {
  // Breaks: the new session joins the old refresh and is told its account is gone;
  // if the scheduler asked, that stops the new account's refresh timer for good.
  it('a forced refresh uses the new sign-in, not the old request', async () => {
    seed(A, 'R1');
    const old = deferred<Response>();
    h.tokenAnswer = () => old.promise;
    const oldCaller = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 1);
    const { revocation } = await signOut('sarv', A);

    seed(A, 'NEW');
    h.tokenAnswer = async () => tokens();
    await expect(getValidAccessToken('sarv', A, true)).resolves.toBe('fresh-access');
    expect(h.refreshed).toEqual(['R1', 'NEW']);

    old.resolve(tokens({ refresh_token: 'OLD-ROTATED' }));
    await revocation;
    await expect(oldCaller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(h.store.get(`sarv:${A}`)?.refreshToken).toBe('NEW');
  });
});

describe('the old refresh ending while the new sign-in refreshes', () => {
  // Breaks: its cleanup removes the NEW refresh from the single-flight map, so the
  // next caller fires a second refresh with the same token, which is what a
  // rotating provider reads as reuse.
  it('leaves the new refresh joinable', async () => {
    seed(A, 'R1');
    const old = deferred<Response>();
    h.tokenAnswer = () => old.promise;
    const oldCaller = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 1);
    const { revocation } = await signOut('sarv', A);

    seed(A, 'NEW');
    const current = deferred<Response>();
    h.tokenAnswer = () => current.promise;
    const first = getValidAccessToken('sarv', A, true);
    await reach(() => h.refreshed.length === 2);

    old.resolve(tokens());
    await revocation;
    await expect(oldCaller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    const second = getValidAccessToken('sarv', A, true);
    current.resolve(tokens());
    await expect(first).resolves.toBe('fresh-access');
    await expect(second).resolves.toBe('fresh-access');
    expect(h.refreshed).toEqual(['R1', 'NEW']);
  });
});

describe('two Sarv accounts', () => {
  // Breaks: removing one Sarv account signs another one out.
  it('removing one leaves the other\'s tokens and its in-flight refresh alone', async () => {
    seed(A, 'RA');
    seed(B, 'RB');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const other = getValidAccessToken('sarv', B, true);
    await reach(() => h.refreshed.length === 1);

    const { revocation } = await signOut('sarv', A);
    await expect(revocation).resolves.toBe('revoked');
    // A's token only, and without waiting for B's refresh.
    expect(h.revoked).toEqual(['RA']);

    answer.resolve(tokens({ refresh_token: 'RB2' }));
    await expect(other).resolves.toBe('fresh-access');
    expect(h.store.get(`sarv:${B}`)?.refreshToken).toBe('RB2');
    expect(h.store.has(`sarv:${A}`)).toBe(false);
    expect(h.revoked).toEqual(['RA']);
  });

  // The token store's key is case-insensitive; this one must be as well. Breaks:
  // a refresh keyed in another case outlives the sign-out and saves its tokens.
  it('treats addresses differing only in case as the same sign-in', async () => {
    seed('a@sarv.com', 'R1');
    const answer = deferred<Response>();
    h.tokenAnswer = () => answer.promise;
    const caller = getValidAccessToken('sarv', 'A@SARV.COM', true);
    await reach(() => h.refreshed.length === 1);

    const { revocation } = await signOut('sarv', 'a@sarv.com');
    answer.resolve(tokens());
    await revocation;

    await expect(caller).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    expect(h.store.size).toBe(0);
  });
});

describe('what the sign-out reports', () => {
  // Measured on oauth.sarv.com. Breaks: the removal tells the user it failed when
  // the state is exactly the one asked for, or the log claims it was revoked now.
  it('a token Sarv no longer knows is already-invalid, and counts as done for the user', async () => {
    seed(A, 'R1');
    h.revokeAnswer = async () => json({ revoked: false, message: 'Token not found or already revoked' });
    const { revocation } = await signOut('sarv', A);
    await expect(revocation).resolves.toBe('already-invalid');
    await expect(settleRevocation('sarv', revocation)).resolves.toBe('revoked');
  });

  // Idempotent re-run. Breaks: a second removal presents a token again, or
  // pretends it revoked something; it has nothing to send.
  it('a second sign-out sends nothing and reports no account', async () => {
    seed(A, 'R1');
    await (await signOut('sarv', A)).revocation;
    const again = await signOut('sarv', A);
    await expect(again.revocation).resolves.toBe('no-account');
    expect(h.revoked).toEqual(['R1']);
    // Sarv can revoke, so "no token to do it with" is not "done".
    await expect(settleRevocation('sarv', again.revocation)).resolves.toBe('failed');
  });

  // Transient: offline, a timeout, a server error. Breaks: local removal waits on
  // the network or is undone, the outcome or log says revoked, or the token is logged.
  it.each<[string, () => Promise<Response>]>([
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['a 503', async () => json({ detail: 'down' }, 503)],
    ['a 429', async () => json({ detail: 'slow down' }, 429)],
  ])('%s: removed locally, reported and logged as failed, token not logged', async (_what, answer) => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); }));
    try {
      seed(A, 'SECRET-RT');
      h.revokeAnswer = answer;
      const { revocation } = await signOut('sarv', A);
      expect(h.store.has(`sarv:${A}`)).toBe(false);
      await expect(revocation).resolves.toBe('failed');
      await expect(settleRevocation('sarv', revocation)).resolves.toBe('failed');

      const log = lines.join('\n');
      expect(log).toContain('revocation failed');
      expect(log).not.toContain('revocation revoked');
      expect(log).not.toContain('SECRET-RT');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  // Locked keychain: unreadable, not empty. Breaks: a token we could not read is
  // treated as gone and nothing is reported, or the later retry is latched off.
  it('a locked token store fails the sign-out without revoking, and does not latch', async () => {
    seed(A, 'R1');
    h.storeLocked = true;
    await expect(signOut('sarv', A)).rejects.toThrow('safeStorage is unavailable');
    expect(h.revoked).toEqual([]);

    h.storeLocked = false;
    await expect(getValidAccessToken('sarv', A, true)).resolves.toBe('fresh-access');
    expect(h.store.has(`sarv:${A}`)).toBe(true);
  });

  // No OS key store to re-seal the store with (macOS denied, Linux with no keyring
  // and legacy tokens). Breaks: the token we hold is never revoked, so what stays
  // on disk stays live at the provider, and the removal never says anything.
  it('still revokes with the token in hand when the tokens cannot be deleted', async () => {
    seed(A, 'R1');
    h.removeFails = true;
    const { revocation } = await signOut('sarv', A);
    await expect(revocation).resolves.toBe('revoked');
    expect(h.revoked).toEqual(['R1']);
  });

  // Sanity on the error class the scheduler's "stop quietly" branch keys on.
  it('reports a removed account with the code the scheduler recognises', async () => {
    const err = await getValidAccessToken('sarv', 'nobody@sarv.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });
});
