import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The OAuth loopback callback listener.
 *
 * The regression that motivated these tests: the listener used to be owned by
 * the flow that started it, so every cancel (Back in the modal, a second click,
 * the five-minute timeout) closed the socket. The next attempt then raced the
 * OS to rebind, took the next preferred port, and the consent page already open
 * in the user's browser redirected to the port it had been issued — where
 * nothing was listening. The user finished signing in and landed on
 * "127.0.0.1:51823 refused to connect", with the app still spinning.
 *
 * So what is pinned here is lifetime, not plumbing: the port survives a cancel,
 * a late redirect is always ANSWERED, and a callback for a state we never
 * issued completes nothing.
 *
 * Real sockets on purpose — the bug lived in the bind/close sequence, which a
 * faked http module would have hidden. The tests never assume a specific port
 * (the running app may hold 51823); they read it back from the auth URL.
 */

const h = vi.hoisted(() => ({
  /** Every URL handed to the browser, in order. */
  opened: [] as string[],
  openExternalFails: false,
  exchange: vi.fn(async () => ({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    scope: 'openid email profile',
  })),
  saved: [] as Array<{ provider: string; email: string }>,
}));

vi.mock('electron', () => ({
  shell: {
    openExternal: async (url: string) => {
      h.opened.push(url);
      if (h.openExternalFails) throw new Error('no browser');
    },
  },
  app: {
    getPath: () => join(tmpdir(), 'sarvinbox-test'),
    getName: () => 'Sarv Inbox Test',
    isPackaged: false,
  },
}));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async () => null,
  saveAccount: async (account: { provider: string; email: string }) => {
    h.saved.push({ provider: account.provider, email: account.email });
  },
  removeAccount: async () => false,
  listAccounts: async () => [],
}));

// Only the token exchange is replaced: the loopback half of the flow — the part
// under test — stays real.
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  exchangeCodeForTokens: (...args: unknown[]) => h.exchange(...(args as [])),
}));

import {
  cancelOAuthFlow,
  closeOAuthCallbackServer,
  startOAuthFlow,
} from '../../../../electron/services/oauth-service';

/**
 * GET a URL over real HTTP, returning status + body (never throws on 4xx/5xx).
 *
 * `agent: false` is load-bearing, not tidiness. Node's global agent keeps
 * connections alive by default (>=19), so a socket pooled against the listener
 * one test used outlives the `closeOAuthCallbackServer()` in `afterEach`. The
 * next test rebinds a NEW server on the SAME port, the agent hands the pooled
 * socket to the next request, and it fails with "socket hang up" — a flake
 * that lands on whichever test happens to reuse first. A fresh connection per
 * request cannot reach a closed server.
 */
const get = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });

/**
 * Start a sign-in. The no-op catch only marks the promise handled — every
 * assertion still runs against `flow` — so an expected rejection that lands
 * between two statements is not reported as an unhandled one.
 */
const start = () => {
  const flow = startOAuthFlow('sarv');
  flow.catch(() => {});
  return flow;
};

/** Wait for the consent URL the flow opens, and pull its callback params out. */
const nextAuthUrl = async (): Promise<{ redirectUri: string; state: string }> => {
  for (let attempt = 0; attempt < 100 && h.opened.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const opened = h.opened.shift();
  if (!opened) throw new Error('the flow never opened a consent URL');
  const params = new URL(opened).searchParams;
  return {
    redirectUri: params.get('redirect_uri') ?? '',
    state: params.get('state') ?? '',
  };
};

/** The userinfo call that follows a successful code exchange. */
const stubUserInfo = (email: string) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ email, name: 'Test User' }),
    })),
  );
};

beforeEach(() => {
  h.opened = [];
  h.openExternalFails = false;
  h.saved = [];
  h.exchange.mockClear();
});

afterEach(() => {
  // Releases the loopback port between tests; normal cancellation deliberately
  // does not, which is the whole point of the fix.
  closeOAuthCallbackServer();
  vi.unstubAllGlobals();
});

describe('loopback callback listener', () => {
  // THE regression: a cancel used to close the socket, the next flow bound a
  // different port, and the consent page already open in the browser redirected
  // to a port with nothing on it — ERR_CONNECTION_REFUSED after a successful
  // sign-in.
  it('keeps the same redirect_uri across a cancelled sign-in', async () => {
    const first = start();
    const a = await nextAuthUrl();

    cancelOAuthFlow();
    await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    const second = start();
    const b = await nextAuthUrl();

    expect(b.redirectUri).toBe(a.redirectUri);
    expect(b.state).not.toBe(a.state); // a fresh CSRF state per attempt

    cancelOAuthFlow();
    await expect(second).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  });

  // The user is mid-consent in their browser when the app gives up on the flow.
  // Whatever we do, the redirect must reach something that can explain itself —
  // a refused connection reads as "the app is broken".
  it('answers a redirect whose flow was already cancelled instead of refusing it', async () => {
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    cancelOAuthFlow();
    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    const res = await get(`${redirectUri}?code=late-code&state=${state}`);

    expect(res.status).toBe(200);
    expect(res.body).toContain('expired');
  });

  // The happy path, end to end over a real socket: without it none of the
  // lifetime guarantees above mean anything.
  it('completes the sign-in when the redirect arrives', async () => {
    stubUserInfo('user@sarv.com');
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    const res = await get(`${redirectUri}?code=auth-code&state=${state}`);
    const account = await flow;

    expect(res.status).toBe(200);
    expect(res.body).toContain('Signed in');
    expect(account.email).toBe('user@sarv.com');
    expect(h.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth-code', redirectUri }),
    );
    // The redirect_uri sent to the token endpoint must be the one the browser
    // was sent to, or the provider rejects the exchange.
    expect(h.saved).toEqual([{ provider: 'sarv', email: 'user@sarv.com' }]);
  });

  // A second sign-in reuses the listener, so the first must still be able to
  // complete on its own port — and a stale state must not complete the new one.
  it('completes nothing for a state it never issued', async () => {
    const flow = start();
    const { redirectUri } = await nextAuthUrl();

    const res = await get(`${redirectUri}?code=forged&state=not-our-state`);

    expect(res.status).toBe(200);
    expect(res.body).toContain('expired');
    expect(h.exchange).not.toHaveBeenCalled();

    // The real flow is untouched and still waiting.
    cancelOAuthFlow();
    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  });

  // A provider that declines (user pressed Deny, consent revoked) must fail the
  // flow then and there rather than leaving the button spinning for 5 minutes.
  it('fails the flow when the provider redirects with an error', async () => {
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    const res = await get(`${redirectUri}?error=access_denied&state=${state}`);

    expect(res.status).toBe(200);
    expect(res.body).toContain('access_denied');
    await expect(flow).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  // A redirect carrying neither code nor error is a broken provider response;
  // report it rather than waiting out the timeout.
  it('fails the flow when the redirect carries no code', async () => {
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    await get(`${redirectUri}?state=${state}`);

    await expect(flow).rejects.toMatchObject({ code: 'BAD_CALLBACK' });
  });

  // Anything that is not the callback path is not ours to answer with a page.
  it('404s a request to any other path', async () => {
    const flow = start();
    const { redirectUri } = await nextAuthUrl();
    const origin = new URL(redirectUri).origin;

    const res = await get(`${origin}/`);

    expect(res.status).toBe(404);

    cancelOAuthFlow();
    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  });

  // Starting a second sign-in supersedes the first: two live flows would both
  // be waiting on one modal, and the loser would surface its error over the
  // winner.
  it('supersedes a pending sign-in when a new one starts', async () => {
    const first = start();
    await nextAuthUrl();

    const second = start();
    const { redirectUri, state } = await nextAuthUrl();

    await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    // ...and the port the superseded flow was using still serves the new one.
    stubUserInfo('second@sarv.com');
    await get(`${redirectUri}?code=second-code&state=${state}`);
    await expect(second).resolves.toMatchObject({ email: 'second@sarv.com' });
  });

  // Another process (a second copy of the app, a leftover dev instance) holding
  // the first preferred port must move us to the NEXT registered one — falling
  // through to an ephemeral port would fail Sarv's exact-match on redirect_uri.
  it('falls back to the next registered port when earlier ones are taken', async () => {
    const blockers = await Promise.all(
      [51823, 51824].map(
        (port) =>
          new Promise<http.Server | null>((resolve) => {
            const blocker = http.createServer();
            blocker.once('error', () => resolve(null)); // already held — same effect
            blocker.once('listening', () => resolve(blocker));
            blocker.listen(port, '127.0.0.1');
          }),
      ),
    );

    try {
      const flow = start();
      const { redirectUri } = await nextAuthUrl();

      expect(new URL(redirectUri).port).toBe('51825');

      cancelOAuthFlow();
      await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    } finally {
      blockers.forEach((blocker) => blocker?.close());
    }
  });

  // A browser that refuses to open is a dead end, not a five-minute wait.
  it('fails the flow when the browser cannot be opened', async () => {
    h.openExternalFails = true;

    await expect(startOAuthFlow('sarv')).rejects.toThrow('no browser');
  });
});
