import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthError } from '../../../src/oauth/types';

// Right after a user changes their Google or Microsoft password the provider
// revokes the refresh token, and every connect then fails BEFORE a socket opens:
// the IMAP client cannot mint a bearer, and re-throws that under its own code
// (OAUTH_REFRESH_FAILED). These run the REAL ImapFlowClient and the REAL
// ConnectionManager against a fake ImapFlow, because the bug lives in the hand-off
// between the two. What breaks if this file fails: the wrapper hides the token
// layer's verdict again, the auth latch never fires, and every reconnect POSTs
// the dead refresh token to the provider until the refresh scheduler's own next
// run notices (up to ~45 min for Google). Or the other way round: a refresh that
// merely failed to COMPLETE (Wi-Fi blip, timeout, 5xx) latches a healthy account
// into "sign in again", and it stops syncing until the user does.

/** Every ImapFlow the client built, in order. */
const flows: FakeFlow[] = [];
/** The outcome of each next dial, consumed in order; an empty script connects. */
const dialScript: Array<() => Promise<void>> = [];

class FakeFlow extends EventEmitter {
  capabilities = new Map<string, boolean>();
  usable = true;
  constructor(readonly opts: { auth: { user: string } }) {
    super();
    flows.push(this);
  }
  connect(): Promise<void> { return (dialScript.shift() ?? (async () => {}))(); }
  close(): void { this.usable = false; }
  async logout(): Promise<void> { /* clean */ }
  /** The server drops the session — what starts the reconnect ladder. */
  drop(): void { this.usable = false; this.emit('close'); }
}

vi.mock('imapflow', () => ({ ImapFlow: FakeFlow }));

const { ImapFlowClient } = await import('../../../src/imap/imapflow-client');
const { ConnectionManager } = await import('../../../src/imap/connection-manager');
const { __resetConnectionBudgets } = await import('../../../src/imap/connection-budget');
const { isAuthError, isConnectionError } = await import('../../../src/imap/imap-errors');

type Resolver = (forceRefresh?: boolean) => Promise<string>;
type WrappedError = Error & { code?: string; cause?: unknown };

const oauthConfig = (resolveBearer: Resolver, username = 'alice@example.org') => ({
  host: 'mail.example.org', port: 993, secure: true, username,
  authMethod: 'oauth2' as const, resolveBearer, connectionTimeout: 10_000,
}) as never;

// The token layer's errors, in the shapes it actually throws (token-refresher.ts,
// the desktop fast-fail gate, token-destinations.ts).
const GOOGLE_REVOKED = '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}';
const MICROSOFT_REVOKED = '{"error":"invalid_grant","error_description":"AADSTS50173: The provided grant has expired due to it being revoked."}';
const refreshRejected = (status: number, body: string) =>
  new OAuthError(`Token refresh failed (${status}): ${body}`, 'TOKEN_REFRESH_FAILED', body);
const revoked = () => refreshRejected(400, GOOGLE_REVOKED);
const unreachable = () => new OAuthError(
  'Cannot reach OAuth server [ENOTFOUND] at https://oauth2.googleapis.com/token: getaddrinfo ENOTFOUND oauth2.googleapis.com',
  'TOKEN_REFRESH_NETWORK_ERROR',
);

const TERMINAL: Array<[string, () => Error]> = [
  ['Google revoking the grant after a password change', revoked],
  ['Microsoft revoking the grant after a password change', () => refreshRejected(400, MICROSOFT_REVOKED)],
  // The fast-fail gate replays an earlier terminal verdict without a request.
  ['the reauth gate replaying an earlier verdict', () => new OAuthError('OAuth session for gmail:alice@example.org needs an interactive sign-in — invalid_grant', 'REAUTH_REQUIRED')],
  ['a bearer refused for the host it was bound for', () => new OAuthError('Refusing to send the gmail token to mail.example.org', 'TOKEN_DESTINATION_REFUSED')],
  // Core and the Electron main process are bundled separately, so the token
  // error can arrive as a plain Error with the code and no OAuthError class.
  ['the revoked grant after crossing the bundle boundary (code, no class)', () =>
    Object.assign(new Error(`Token refresh failed (400): ${GOOGLE_REVOKED}`), { code: 'TOKEN_REFRESH_FAILED' })],
];

const TRANSIENT: Array<[string, () => Error]> = [
  ['the token endpoint being unreachable (DNS / Wi-Fi blip)', unreachable],
  ['the token request timing out', () => new OAuthError('OAuth token request to https://oauth2.googleapis.com/token timed out after 8000ms — the server may still have processed it, so the token state is unknown', 'TOKEN_REFRESH_TIMEOUT')],
  ['the token request being cancelled', () => new OAuthError('OAuth token request to https://oauth2.googleapis.com/token was cancelled (shutdown)', 'TOKEN_REFRESH_ABORTED')],
  ['the provider answering 503', () => refreshRejected(503, 'Service Unavailable')],
  ['the provider rate-limiting the refresh (429)', () => refreshRejected(429, '{"error":"rate_limit_exceeded"}')],
  ['a refresh deferred while the machine sleeps', () => new OAuthError('Token refresh for gmail:alice@example.org deferred — the system is suspended; it will refresh on the next real wake', 'REFRESH_DEFERRED_SUSPENDED')],
];

/** ImapFlow's rejection of a token at AUTHENTICATE. */
const rejectedAtAuthenticate = () => Object.assign(new Error('Authentication failed'), {
  authenticationFailed: true,
  serverResponseCode: 'AUTHENTICATIONFAILED',
  responseText: 'Invalid credentials (Failure)',
});

const connectError = (resolveBearer: Resolver, username?: string): Promise<WrappedError> =>
  new ImapFlowClient().connect(oauthConfig(resolveBearer, username)).then(
    () => { throw new Error('connect() resolved, but it was expected to fail'); },
    (e: unknown) => e as WrappedError,
  );

function makeManager() {
  const manager = new ConnectionManager({
    maxReconnectAttempts: 3,
    reconnectDelay: 1000,
    reconnectBackoffMultiplier: 2,
    maxReconnectDelay: 3000,
    healthCheckInterval: 10_000_000, // off for the length of any test here
    connectionTimeout: 30_000,
  });
  const events: string[] = [];
  // 'error' needs a listener: an EventEmitter throws on an unheard one.
  for (const name of ['auth-error', 'max-attempts-reached', 'reconnected', 'error'] as const) {
    manager.on(name, () => events.push(name));
  }
  return { manager, events };
}

const countOf = (events: string[], name: string) => events.filter((e) => e === name).length;
const flowFor = (username: string) => flows.find((f) => f.opts.auth.user === username)!;

beforeEach(() => {
  flows.length = 0;
  dialScript.length = 0;
  __resetConnectionBudgets();
});

afterEach(() => {
  vi.useRealTimers();
  __resetConnectionBudgets();
});

describe('ImapFlowClient — a bearer that could not be minted', () => {
  // The wrapper must keep what the token layer said. Breaks: it drops `cause`
  // again, and nothing downstream can tell "revoked" from "offline".
  it('re-throws under OAUTH_REFRESH_FAILED, keeping the token error as its cause, before any socket opens', async () => {
    const tokenError = revoked();
    const error = await connectError(async () => { throw tokenError; });
    expect(error.code).toBe('OAUTH_REFRESH_FAILED');
    expect(error.message).toBe(`OAuth token refresh failed: ${tokenError.message}`);
    expect(error.cause).toBe(tokenError);
    expect(flows).toHaveLength(0);
  });

  // The latch keys off isAuthError. Breaks: a revoked session reads as "not an
  // auth failure" and the reconnect ladder keeps minting.
  it.each(TERMINAL)('reads %s as an auth failure', async (_label, make) => {
    expect(isAuthError(await connectError(async () => { throw make(); }))).toBe(true);
  });

  // Breaks: a blip signs a healthy account out until the user signs in again.
  it.each(TRANSIENT)('does NOT read %s as an auth failure', async (_label, make) => {
    expect(isAuthError(await connectError(async () => { throw make(); }))).toBe(false);
  });

  // A resolve that HANGS (cold DNS) is cut by the client's own deadline. That
  // says nothing about the grant. Breaks: the timeout latches, or stops being a
  // connection error and drops out of the reconnect ladder.
  it('does NOT read a resolve cut short by its own deadline as an auth failure', async () => {
    vi.useFakeTimers();
    const pending = connectError(() => new Promise<string>(() => { /* never settles */ }));
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await pending;
    expect(error.code).toBe('OAUTH_REFRESH_FAILED');
    expect(isAuthError(error)).toBe(false);
    expect(isConnectionError(error)).toBe(true);
  });

  // The second wrap site: the server refused the cached token at AUTHENTICATE,
  // the client forces ONE refresh, and the provider says the grant is gone.
  // Breaks: the latch only works for the first wrap site.
  it('reads a revoked grant on the forced refresh after a rejected token as an auth failure', async () => {
    dialScript.push(async () => { throw rejectedAtAuthenticate(); });
    const tokenError = revoked();
    const resolveBearer = vi.fn(async (force?: boolean) => {
      if (force) throw tokenError;
      return 'stale-access-token';
    });
    const error = await connectError(resolveBearer);
    expect(resolveBearer.mock.calls).toEqual([[], [true]]);
    expect(error.code).toBe('OAUTH_REFRESH_FAILED');
    expect(error.cause).toBe(tokenError);
    expect(isAuthError(error)).toBe(true);
  });

  it('does NOT read an unreachable provider on that forced refresh as an auth failure', async () => {
    dialScript.push(async () => { throw rejectedAtAuthenticate(); });
    const resolveBearer = vi.fn(async (force?: boolean) => {
      if (force) throw unreachable();
      return 'stale-access-token';
    });
    const error = await connectError(resolveBearer);
    expect(error.code).toBe('OAUTH_REFRESH_FAILED');
    expect(isAuthError(error)).toBe(false);
  });
});

describe('ConnectionManager — the auth latch on a revoked grant', () => {
  // The headline regression. Breaks: the latch stays open after a password
  // change, and the automatic paths (ensureConnection, the periodic
  // forceReconnect) each mint again — another POST of the dead refresh token.
  it('latches at connect, and no automatic path asks the provider again', async () => {
    const resolveBearer = vi.fn(async (): Promise<string> => { throw revoked(); });
    const { manager, events } = makeManager();

    await expect(manager.connect(oauthConfig(resolveBearer))).rejects.toMatchObject({ code: 'OAUTH_REFRESH_FAILED' });
    expect(manager.authFailed).toBe(true);
    expect(manager.isInAuthCooldown()).toBe(true);
    expect(countOf(events, 'auth-error')).toBe(1);

    expect(await manager.ensureConnection()).toBe(false);
    await manager.forceReconnect();
    manager.resetReconnectAttempts();
    expect(await manager.ensureConnection()).toBe(false);
    expect(resolveBearer).toHaveBeenCalledTimes(1);
    expect(countOf(events, 'auth-error')).toBe(1);
  });

  // The storm path: a LIVE session drops when the provider revokes the grant,
  // and the reconnect ladder takes over. Breaks: the ladder burns every attempt
  // (one dead-token POST each) instead of stopping at the first.
  it('stops the reconnect ladder at its first attempt when the grant is revoked mid-session', async () => {
    vi.useFakeTimers();
    let grantRevoked = false;
    const resolveBearer = vi.fn(async () => {
      if (grantRevoked) throw revoked();
      return 'access-token';
    });
    const { manager, events } = makeManager();
    await manager.connect(oauthConfig(resolveBearer));

    grantRevoked = true;
    flows[0].drop();
    // An hour: past the whole ladder, its cooldown and the auth cooldown.
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(resolveBearer).toHaveBeenCalledTimes(2); // the connect + ONE reconnect attempt
    expect(manager.authFailed).toBe(true);
    expect(countOf(events, 'auth-error')).toBe(1);
    expect(countOf(events, 'max-attempts-reached')).toBe(0);
  });

  // The other edge of the same rule. Breaks: a Wi-Fi blip during the ladder
  // latches the account, and it never reconnects on its own when the network
  // comes back.
  it('keeps the ladder going when the refresh only failed to reach the provider, and recovers on its own', async () => {
    vi.useFakeTimers();
    let offline = false;
    const resolveBearer = vi.fn(async () => {
      if (offline) throw unreachable();
      return 'access-token';
    });
    const { manager, events } = makeManager();
    await manager.connect(oauthConfig(resolveBearer));

    offline = true;
    flows[0].drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resolveBearer).toHaveBeenCalledTimes(1 + 3); // every rung of the ladder tried
    expect(manager.authFailed).toBe(false);
    expect(countOf(events, 'auth-error')).toBe(0);
    expect(countOf(events, 'max-attempts-reached')).toBe(1);

    // Back online, past the ladder's cooldown: the next automatic path reconnects.
    offline = false;
    await vi.advanceTimersByTimeAsync(60_000);
    const reconnected = manager.ensureConnection();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await reconnected).toBe(true);
    expect(manager.isConnected()).toBe(true);
  });

  // The latch is per account. Breaks: one account's dead grant stops (or a
  // shared latch is consulted by) another account's healthy connection.
  it("latches only the account whose grant was revoked, not the account beside it", async () => {
    vi.useFakeTimers();
    const aliceBearer = vi.fn(async (): Promise<string> => { throw revoked(); });
    const bobBearer = vi.fn(async () => 'bob-access-token');
    const alice = makeManager();
    const bob = makeManager();

    await expect(alice.manager.connect(oauthConfig(aliceBearer, 'alice@example.org'))).rejects.toThrow();
    await bob.manager.connect(oauthConfig(bobBearer, 'bob@example.org'));
    expect(alice.manager.authFailed).toBe(true);
    expect(bob.manager.authFailed).toBe(false);
    expect(bob.manager.isConnected()).toBe(true);

    // Bob's session drops: his ladder still runs, and reconnects.
    flowFor('bob@example.org').drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(countOf(bob.events, 'reconnected')).toBe(1);
    expect(bob.manager.isConnected()).toBe(true);
    expect(countOf(bob.events, 'auth-error')).toBe(0);
    expect(bobBearer).toHaveBeenCalledTimes(2);
    // ...while Alice's latch held and nothing asked her provider again.
    expect(await alice.manager.ensureConnection()).toBe(false);
    expect(aliceBearer).toHaveBeenCalledTimes(1);
  });

  // An explicit connect() (startup, the user retrying) against a still-dead
  // grant. Breaks: a re-run double-applies (two asks, two prompts) or leaves a
  // half-state the automatic paths then dial from.
  it('re-latches identically on each explicit re-run: one ask and one auth-error per run, never a socket', async () => {
    const resolveBearer = vi.fn(async (): Promise<string> => { throw revoked(); });
    const { manager, events } = makeManager();
    for (let run = 1; run <= 3; run++) {
      await expect(manager.connect(oauthConfig(resolveBearer))).rejects.toMatchObject({ code: 'OAUTH_REFRESH_FAILED' });
      expect(manager.authFailed).toBe(true);
      expect(await manager.ensureConnection()).toBe(false);
      expect(resolveBearer).toHaveBeenCalledTimes(run);
      expect(countOf(events, 'auth-error')).toBe(run);
    }
    expect(flows).toHaveLength(0);
  });

  // The latch is not a trap. Breaks: an account stays latched after the user
  // signs in again.
  it('clears on the explicit connect after the user signs in again', async () => {
    let signedIn = false;
    const resolveBearer = vi.fn(async () => {
      if (!signedIn) throw revoked();
      return 'fresh-access-token';
    });
    const { manager } = makeManager();
    await expect(manager.connect(oauthConfig(resolveBearer))).rejects.toThrow();
    expect(manager.authFailed).toBe(true);

    signedIn = true;
    await manager.connect(oauthConfig(resolveBearer));
    expect(manager.authFailed).toBe(false);
    expect(manager.isConnected()).toBe(true);
  });
});
