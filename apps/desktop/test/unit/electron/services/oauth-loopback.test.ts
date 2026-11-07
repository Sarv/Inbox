import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The OAuth loopback callback listener.
 *
 * Two regressions shape these tests.
 *
 * 1. The listener used to be owned by the flow that started it, and was closed
 *    and rebound around every cancel. The next attempt could come up on the next
 *    preferred port while the consent page already open in the browser still
 *    redirected to the old one — "127.0.0.1:51823 refused to connect" after a
 *    successful sign-in. So the port must never move under a PENDING sign-in.
 * 2. The fix for that kept the listener open for the life of the process, which
 *    CASA 3.2.2 rejects: a local port answering when no sign-in needs it. So the
 *    listener must close when the last pending sign-in settles, and come back
 *    on the same preferred port for the next one.
 *
 * What is pinned is lifetime, not plumbing. Real sockets on purpose — the bugs
 * lived in the bind/close sequence, which a faked http module would hide.
 *
 * Each test file gets its OWN "preferred" ports (OS-assigned free ports): the
 * listener now opens and closes with every sign-in, and another file in the
 * same parallel run (oauth-service-microsoft) binding the real 51823 between
 * two of our flows would move us to 51824 and fail the port assertions. The
 * real registered list is pinned separately at the bottom.
 */

const h = vi.hoisted(() => ({
  /** Every URL handed to the browser, in order. */
  opened: [] as string[],
  /** Woken each time a URL is handed to the browser. */
  waiting: [] as Array<() => void>,
  openExternalFails: false,
  openExternalThrows: false,
  /** When set, the next launch returns a promise the test rejects by hand. */
  deferNextLaunch: null as null | ((reject: (err: Error) => void) => void),
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
    openExternal: (url: string) => {
      h.opened.push(url);
      h.waiting.splice(0).forEach((wake) => wake());
      if (h.openExternalThrows) throw new Error('launcher crashed');
      const defer = h.deferNextLaunch;
      if (defer) {
        h.deferNextLaunch = null;
        return new Promise<void>((_resolve, reject) => defer(reject));
      }
      return h.openExternalFails ? Promise.reject(new Error('no browser')) : Promise.resolve();
    },
  },
  app: {
    getPath: () => join(tmpdir(), 'sarvinbox-test'),
    getName: () => 'Sarv Inbox Test',
    isPackaged: false,
  },
}));

// Three ports nobody else in this run is using, standing in for 51823-51825.
// Bound together (so they are distinct), then released for the listener.
vi.mock('../../../../electron/services/oauth-callback-ports', async () => {
  const { createServer } = await import('node:net');
  const servers = [createServer(), createServer(), createServer()];
  const ports = await Promise.all(
    servers.map(
      (server) =>
        new Promise<number>((resolve) => {
          server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
        }),
    ),
  );
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return { OAUTH_CALLBACK_PORTS: ports };
});

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

import { OAUTH_CALLBACK_PORTS } from '../../../../electron/services/oauth-callback-ports';
import {
  cancelOAuthFlow,
  closeOAuthCallbackServer,
  startOAuthFlow,
} from '../../../../electron/services/oauth-service';
import { RESPONSE_FLUSH_GRACE_MS } from '../../../../electron/utils/loopback-server-close';

/** The ports this file's listener tries, as a mutable list a test can doctor. */
const ports = OAUTH_CALLBACK_PORTS as number[];

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Send one request over real HTTP, returning status, headers and body (never
 * throws on 4xx/5xx).
 *
 * `agent: false` is load-bearing, not tidiness. Node's global agent keeps
 * connections alive by default (>=19), so a socket pooled against one listener
 * outlives it; the next listener comes up on the SAME port, the agent hands the
 * pooled socket to the next request, and it fails with "socket hang up". A
 * fresh connection per request cannot reach a closed server.
 */
const send = (url: string, method = 'GET', path?: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    http
      .request(
        {
          host: target.hostname,
          port: target.port,
          path: path ?? `${target.pathname}${target.search}`,
          method,
          agent: false,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      )
      .on('error', reject)
      .end();
  });

const get = (url: string) => send(url);

/** Whether anything accepts a TCP connection on 127.0.0.1:`port` right now. */
const isListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/**
 * A raw connection to the listener that sends nothing. The server counts it as
 * idle, so closing the listener drops it — which makes it a probe for "was the
 * listener closed at any point while this was open".
 */
const openIdleProbe = (port: number): Promise<{ dropped: () => boolean; close: () => void }> =>
  new Promise((resolve, reject) => {
    let dropped = false;
    const socket = net.connect(port, '127.0.0.1');
    socket.on('close', () => {
      dropped = true;
    });
    // Before 'connect' an error is a failed probe; after it, a reset is just how
    // the drop may arrive (rejecting a settled promise is a no-op).
    socket.on('error', reject);
    socket.once('connect', () => resolve({ dropped: () => dropped, close: () => socket.destroy() }));
  });

/**
 * A connection that starts a request and never finishes its headers. The
 * server counts it as active, so only dropping every connection — not just the
 * idle ones — closes it.
 */
const openHalfOpenRequest = async (port: number): Promise<{ closed: () => boolean; destroy: () => void }> => {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {}); // a reset is how the drop may arrive
  await new Promise((resolve) => socket.once('connect', resolve));
  let closed = false;
  socket.on('close', () => {
    closed = true;
  });
  socket.write('GET /cb HTTP/1.1\r\nHost: 127.0.0.1\r\n'); // headers never finished
  return { closed: () => closed, destroy: () => socket.destroy() };
};

/**
 * Hold the listener's next bind until `release()`: the window in which a
 * sign-in has started but is in no list a cancel can reach. The bind itself
 * then goes ahead as normal.
 */
const holdNextBind = () => {
  const realListen = net.Server.prototype.listen;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(net.Server.prototype, 'listen').mockImplementationOnce(function (this: net.Server, ...args: unknown[]) {
    void gate.then(() => realListen.apply(this, args as Parameters<typeof realListen>));
    return this;
  });
  return { held: () => spy.mock.calls.length === 1, release: () => release(), restore: () => spy.mockRestore() };
};

/**
 * Watch the next listener the service creates: `destroy` each time one of its
 * sockets is destroyed, `finish` when a response it wrote has reached the OS.
 * With `stall`, its responses are never ended — a client that stops reading,
 * as far as the server can tell.
 */
const watchNextListener = (options: { stall?: boolean } = {}) => {
  const events: Array<'destroy' | 'finish'> = [];
  const realCreateServer = http.createServer;
  const spy = vi.spyOn(http, 'createServer').mockImplementationOnce(() => {
    const server = realCreateServer();
    server.on('connection', (socket: net.Socket) => {
      const destroy = socket.destroy.bind(socket);
      socket.destroy = ((error?: Error) => {
        events.push('destroy');
        return destroy(error);
      }) as typeof socket.destroy;
    });
    // Registered before the service's own handler, so it sees every response first.
    server.on('request', (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.once('finish', () => events.push('finish'));
      if (options.stall) res.end = (() => res) as typeof res.end;
    });
    return server;
  });
  return { events, restore: () => spy.mockRestore() };
};

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
const nextAuthUrl = async (): Promise<{ redirectUri: string; state: string; port: number }> => {
  if (h.opened.length === 0) await new Promise<void>((resolve) => h.waiting.push(resolve));
  const opened = h.opened.shift()!;
  const params = new URL(opened).searchParams;
  const redirectUri = params.get('redirect_uri') ?? '';
  return { redirectUri, state: params.get('state') ?? '', port: Number(new URL(redirectUri).port) };
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

/** Bind `port` from outside the service, as another process would. */
const occupy = (port: number): Promise<http.Server> =>
  new Promise((resolve, reject) => {
    const blocker = http.createServer();
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve(blocker));
  });

const release = (server: http.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

beforeEach(() => {
  h.opened = [];
  h.waiting = [];
  h.openExternalFails = false;
  h.openExternalThrows = false;
  h.deferNextLaunch = null;
  h.saved = [];
  h.exchange.mockClear();
});

afterEach(() => {
  // A test that failed half-way must not leave a sign-in holding the port for
  // the next one.
  closeOAuthCallbackServer();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('loopback callback listener', () => {
  // THE original regression, now across a close and reopen: the next attempt
  // must come back on the port the provider has registered and the user's
  // browser already knows, not drift to the next one.
  it('keeps the same redirect_uri across a cancelled sign-in', async () => {
    const first = start();
    const a = await nextAuthUrl();

    cancelOAuthFlow();
    await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    const second = start();
    const b = await nextAuthUrl();

    expect(a.port).toBe(ports[0]);
    expect(b.redirectUri).toBe(a.redirectUri);
    expect(b.state).not.toBe(a.state); // a fresh CSRF state per attempt

    cancelOAuthFlow();
    await expect(second).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  });

  // While ANY sign-in is pending, a redirect for a finished one must reach
  // something that can explain itself — a refused connection reads as "the app
  // is broken". (Behaviour change: this used to hold with nothing pending at
  // all; see the next test for why it no longer does.)
  it('answers a superseded sign-in\'s late redirect with the "expired" page while another is pending', async () => {
    const superseded = start();
    const old = await nextAuthUrl();

    const current = start();
    await nextAuthUrl();
    await expect(superseded).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    const res = await get(`${old.redirectUri}?code=late-code&state=${old.state}`);

    expect(res.status).toBe(200);
    expect(res.body).toContain('expired');
    expect(h.exchange).not.toHaveBeenCalled();

    cancelOAuthFlow();
    await expect(current).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  });

  // DELIBERATE LIMITATION (CASA 3.2.2), not an accident: with no sign-in
  // pending nothing listens, so a consent finished in the browser after the user
  // pressed Back is refused instead of shown the "expired" page. If this starts
  // answering, the listener is being left open between sign-ins again.
  it('refuses a late redirect once every sign-in has settled — the listener is closed', async () => {
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    cancelOAuthFlow();
    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    await expect(get(`${redirectUri}?code=late-code&state=${state}`)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  // The happy path, end to end over a real socket: without it none of the
  // lifetime guarantees mean anything.
  it('completes the sign-in when the redirect arrives', async () => {
    stubUserInfo('user@sarv.com');
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    const res = await get(`${redirectUri}?code=auth-code&state=${state}`);
    const account = await flow;

    expect(res.status).toBe(200);
    expect(res.body).toContain('Signed in');
    expect(account.email).toBe('user@sarv.com');
    // The redirect_uri sent to the token endpoint must be the one the browser
    // was sent to, or the provider rejects the exchange.
    expect(h.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth-code', redirectUri }),
    );
    expect(h.saved).toEqual([{ provider: 'sarv', email: 'user@sarv.com' }]);
  });

  // CSRF: a callback for a state we never issued completes nothing, and must
  // not settle (or close the listener under) the sign-in that is really waiting.
  it('completes nothing for a state it never issued, and leaves the real sign-in waiting', async () => {
    stubUserInfo('real@sarv.com');
    const flow = start();
    const { redirectUri, state, port } = await nextAuthUrl();

    const res = await get(`${redirectUri}?code=forged&state=not-our-state`);
    const stateless = await get(`${redirectUri}?code=forged`);

    expect(res.status).toBe(200);
    expect(res.body).toContain('expired');
    expect(stateless.body).toContain('expired');
    expect(h.exchange).not.toHaveBeenCalled();
    expect(await isListening(port)).toBe(true);

    // The real flow is untouched and still completes.
    await get(`${redirectUri}?code=genuine&state=${state}`);
    await expect(flow).resolves.toMatchObject({ email: 'real@sarv.com' });
    expect(h.exchange).toHaveBeenCalledWith(expect.objectContaining({ code: 'genuine' }));
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
    const blockers = await Promise.all([occupy(ports[0]), occupy(ports[1])]);

    try {
      const flow = start();
      const { port } = await nextAuthUrl();

      expect(port).toBe(ports[2]);

      cancelOAuthFlow();
      await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    } finally {
      await Promise.all(blockers.map(release));
    }
  });

  // With every registered port held, the sign-in must still get a listener
  // (Google accepts any loopback port) rather than failing outright.
  it('falls back to an ephemeral port when every preferred port is taken', async () => {
    const blockers = await Promise.all(ports.map(occupy));

    try {
      const flow = start();
      const { port } = await nextAuthUrl();

      expect(ports).not.toContain(port);
      expect(await isListening(port)).toBe(true);

      cancelOAuthFlow();
      await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
      expect(await isListening(port)).toBe(false);
    } finally {
      await Promise.all(blockers.map(release));
    }
  });

  // A browser that refuses to open is a dead end, not a five-minute wait.
  it('fails the flow when the browser cannot be opened', async () => {
    h.openExternalFails = true;

    await expect(startOAuthFlow('sarv')).rejects.toThrow('no browser');
  });
});

describe('listener lifetime — open only while a sign-in is pending (CASA 3.2.2)', () => {
  // Breaks: the listener is bound at startup / module load again, i.e. a local
  // port answers before anyone has asked to sign in.
  it('listens on nothing before a sign-in starts', async () => {
    for (const port of ports) expect(await isListening(port)).toBe(false);
  });

  // Breaks: one of the ways a sign-in can end forgets to release the listener,
  // and the port stays open for the rest of the process.
  it.each([
    'success',
    'provider error',
    'missing code',
    'cancel',
    'browser rejects',
    'launcher throws',
  ] as const)('closes the listener when the only sign-in settles — %s', async (kind) => {
    stubUserInfo('user@sarv.com');
    if (kind === 'browser rejects') h.openExternalFails = true;
    if (kind === 'launcher throws') h.openExternalThrows = true;
    const flow = start();
    const { redirectUri, state, port } = await nextAuthUrl();

    if (kind === 'success') await get(`${redirectUri}?code=c&state=${state}`);
    if (kind === 'provider error') await get(`${redirectUri}?error=access_denied&state=${state}`);
    if (kind === 'missing code') await get(`${redirectUri}?state=${state}`);
    if (kind === 'cancel') cancelOAuthFlow();
    await flow.catch(() => {});

    expect(await isListening(port)).toBe(false);
  });

  // Breaks: the five-minute timeout settles the sign-in but leaves the port
  // open — the case nobody is watching when it happens.
  it('closes the listener when the sign-in times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flow = start();
    const { port } = await nextAuthUrl();
    expect(await isListening(port)).toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1000);

    await expect(flow).rejects.toMatchObject({ code: 'FLOW_TIMEOUT' });
    expect(await isListening(port)).toBe(false);
  });

  // Breaks: the hold count (or the order "hold, then supersede"). Two sign-ins
  // started together both wait on the same bind; the later must still cancel the
  // earlier once the listener is up — or the earlier is orphaned, uncancellable,
  // with its own consent tab — and the listener must stay open until the
  // survivor settles, not close when the first one does.
  it('keeps the listener open until both of two sign-ins started together have settled', async () => {
    stubUserInfo('second@sarv.com');
    const first = start();
    const second = start();
    const a = await nextAuthUrl();
    const b = await nextAuthUrl();

    await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    expect(b.port).toBe(a.port);
    expect(await isListening(b.port)).toBe(true);

    await get(`${b.redirectUri}?code=second-code&state=${b.state}`);
    await expect(second).resolves.toMatchObject({ email: 'second@sarv.com' });
    expect(await isListening(b.port)).toBe(false);
  });

  // Breaks: superseding closes and rebinds the listener — the race behind
  // "127.0.0.1:51823 refused to connect" after a successful sign-in. The SAME
  // socket must stay up through it: a connection made before the supersede
  // survives it, and is dropped only when the last sign-in settles.
  it('does not close the listener while a new sign-in supersedes a pending one', async () => {
    const first = start();
    const { port } = await nextAuthUrl();
    const probe = await openIdleProbe(port);

    try {
      const second = start();
      await nextAuthUrl();
      await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(probe.dropped()).toBe(false);

      cancelOAuthFlow();
      await expect(second).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
      await vi.waitFor(() => expect(probe.dropped()).toBe(true));
    } finally {
      probe.close();
    }
  });

  // Breaks: a reopen walks the port list from where the last one ended, or
  // skips the first preferred port, moving the redirect_uri for no reason.
  it('reopens on the first preferred port after a completed sign-in', async () => {
    stubUserInfo('user@sarv.com');
    const first = start();
    const a = await nextAuthUrl();
    await get(`${a.redirectUri}?code=c&state=${a.state}`);
    await first;
    expect(await isListening(a.port)).toBe(false);

    const second = start();
    const b = await nextAuthUrl();

    expect(b.port).toBe(ports[0]);
    expect(b.port).toBe(a.port);
    await get(`${b.redirectUri}?code=c2&state=${b.state}`);
    await expect(second).resolves.toMatchObject({ email: 'user@sarv.com' });
  });

  // Breaks: a reopen gives up (or goes straight to an ephemeral port) when the
  // port it used last time was taken while it was closed, instead of moving to
  // the next registered one as the first bind does.
  it('falls back to the next preferred port when the last one was taken while closed', async () => {
    const first = start();
    const a = await nextAuthUrl();
    cancelOAuthFlow();
    await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    const blocker = await occupy(a.port);
    try {
      const second = start();
      const b = await nextAuthUrl();

      expect(a.port).toBe(ports[0]);
      expect(b.port).toBe(ports[1]);

      cancelOAuthFlow();
      await expect(second).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    } finally {
      await release(blocker);
    }
  });

  // Breaks: closing the listener only stops new connections. A browser's
  // speculative preconnect, or a request that never finished, then keeps the
  // old server — request handler and all — alive with no port behind it, past
  // the point where "no sign-in pending" is supposed to mean nothing listens.
  it('drops connections that never finished a request when it closes', async () => {
    const flow = start();
    const { port } = await nextAuthUrl();
    const silent = await openIdleProbe(port);
    const straggler = await openHalfOpenRequest(port);

    try {
      cancelOAuthFlow();
      await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

      await vi.waitFor(() => {
        expect(silent.dropped()).toBe(true);
        expect(straggler.closed()).toBe(true);
      });
    } finally {
      silent.close();
      straggler.destroy();
    }
  });

  // Breaks: waiting for the "Signed in" answer to finish turned into never
  // dropping the rest — a silent preconnect or a request whose headers never
  // finished outlives a SUCCESSFUL sign-in and keeps the closed listener alive.
  it('drops silent and half-open connections after a successful sign-in too', async () => {
    stubUserInfo('user@sarv.com');
    const flow = start();
    const { redirectUri, state, port } = await nextAuthUrl();
    const silent = await openIdleProbe(port);
    const straggler = await openHalfOpenRequest(port);

    try {
      expect((await get(`${redirectUri}?code=c&state=${state}`)).body).toContain('Signed in');
      await expect(flow).resolves.toMatchObject({ email: 'user@sarv.com' });

      await vi.waitFor(() => {
        expect(silent.dropped()).toBe(true);
        expect(straggler.closed()).toBe(true);
      });
      expect(await isListening(port)).toBe(false);
    } finally {
      silent.close();
      straggler.destroy();
    }
  });

  // Breaks (Windows): a successful sign-in closes the listener from inside the
  // request handler that just answered it. Destroying that socket before its
  // write completes can cancel the write — overlapped I/O on Windows — and the
  // browser shows a reset instead of "Signed in". The answer must reach the OS
  // first. (On POSIX the write is synchronous, so only the order shows it.)
  it('lets the "Signed in" response finish before its socket is destroyed', async () => {
    stubUserInfo('user@sarv.com');
    const watch = watchNextListener();
    try {
      const flow = start();
      const { redirectUri, state, port } = await nextAuthUrl();

      const res = await get(`${redirectUri}?code=c&state=${state}`);
      await expect(flow).resolves.toMatchObject({ email: 'user@sarv.com' });

      expect(res.body).toContain('Signed in');
      await vi.waitFor(() => expect(watch.events).toContain('destroy'));
      expect(watch.events[0]).toBe('finish');
      expect(await isListening(port)).toBe(false);
    } finally {
      watch.restore();
    }
  });

  // Breaks: an answer that never finishes (a client that stops reading) keeps
  // its connection — and the closed listener behind it — alive for good. The
  // wait for it is bounded, and short.
  it('drops a connection whose answer never finishes once the grace period is over', async () => {
    stubUserInfo('user@sarv.com');
    const watch = watchNextListener({ stall: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const flow = start();
      const { state, port } = await nextAuthUrl();
      const client = net.connect(port, '127.0.0.1');
      client.on('error', () => {});
      let closed = false;
      client.on('close', () => {
        closed = true;
      });
      client.write(`GET /cb?code=c&state=${state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);

      await expect(flow).resolves.toMatchObject({ email: 'user@sarv.com' });
      expect(await isListening(port)).toBe(false); // the port is freed at once
      vi.advanceTimersByTime(RESPONSE_FLUSH_GRACE_MS - 1);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(watch.events).not.toContain('finish');

      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      watch.restore();
    }
  });

  // Breaks: a sign-in cancelled — the user's Back, or teardown — while its
  // listener is still binding is in no list the cancel can reach. It then
  // registers, opens the consent page anyway, and holds the port until the
  // five-minute timeout.
  it.each(['Back', 'teardown'] as const)('stops a sign-in cancelled by %s while its listener is binding, before the browser opens', async (kind) => {
    const bind = holdNextBind();
    try {
      const flow = start();
      expect(bind.held()).toBe(true);

      if (kind === 'Back') cancelOAuthFlow();
      else closeOAuthCallbackServer();
      bind.release();

      await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
      expect(h.opened).toEqual([]);
      expect(await isListening(ports[0])).toBe(false);
    } finally {
      bind.restore();
    }

    // The cancel was for THAT sign-in: the next one runs, on the same port.
    stubUserInfo('next@sarv.com');
    const next = start();
    const { redirectUri, state, port } = await nextAuthUrl();
    expect(port).toBe(ports[0]);
    await get(`${redirectUri}?code=c&state=${state}`);
    await expect(next).resolves.toMatchObject({ email: 'next@sarv.com' });
  });

  // Breaks: a flow that has already settled releases its hold AGAIN when its
  // browser launch fails late (the launcher's promise outlives a supersede) —
  // dropping the count to zero and closing the listener under the sign-in that
  // replaced it, whose consent page is open in the browser.
  it('does not release a second hold when a settled sign-in\'s browser launch fails late', async () => {
    let rejectLaunch: (err: Error) => void = () => {};
    h.deferNextLaunch = (reject) => {
      rejectLaunch = reject;
    };
    const first = start();
    await nextAuthUrl();
    const second = start();
    const { port } = await nextAuthUrl();
    await expect(first).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });

    rejectLaunch(new Error('browser gave up'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(await isListening(port)).toBe(true);
    cancelOAuthFlow();
    await expect(second).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    expect(await isListening(port)).toBe(false);
  });

  // Breaks: the test/shutdown teardown leaves a sign-in pending — and with it
  // the port — so the next suite (or the next launch's first sign-in) starts on
  // someone else's listener.
  it('cancels every pending sign-in, and so closes the listener, on teardown', async () => {
    const flow = start();
    const { port } = await nextAuthUrl();

    closeOAuthCallbackServer();

    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    expect(await isListening(port)).toBe(false);
  });

  // Breaks: a bind that fails outright (not "port taken") leaks the hold it
  // took, so every later sign-in leaves the listener open when it settles.
  it('releases its hold when the listener cannot be opened at all', async () => {
    ports.unshift(70000); // not a port: listen() throws, which is not EADDRINUSE
    try {
      await expect(startOAuthFlow('sarv')).rejects.toMatchObject({ code: 'ERR_SOCKET_BAD_PORT' });
    } finally {
      ports.shift();
    }

    const flow = start();
    const { port } = await nextAuthUrl();
    cancelOAuthFlow();
    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
    expect(await isListening(port)).toBe(false);
  });
});

describe('callback responses', () => {
  // Breaks: a non-GET reaches the state lookup. A redirect is a top-level GET;
  // a POST from some page to 127.0.0.1 must neither complete nor fail a sign-in.
  it('refuses anything but GET with 405 and leaves the sign-in untouched', async () => {
    stubUserInfo('user@sarv.com');
    const flow = start();
    const { redirectUri, state } = await nextAuthUrl();

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const res = await send(`${redirectUri}?code=forged&state=${state}`, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.allow, method).toBe('GET');
    }
    expect(h.exchange).not.toHaveBeenCalled();

    // Still pending, with its state intact: the real redirect completes it.
    await get(`${redirectUri}?code=genuine&state=${state}`);
    await expect(flow).resolves.toMatchObject({ email: 'user@sarv.com' });
    expect(h.exchange).toHaveBeenCalledWith(expect.objectContaining({ code: 'genuine' }));
  });

  // Breaks: some branch answers before the headers are set — the page carrying
  // (or reached with) an authorization code gets cached, leaks its URL as a
  // Referer, or can run or load something.
  it('sends no-store, no-referrer and a locked-down CSP on every response', async () => {
    stubUserInfo('user@sarv.com');
    const replies: Array<[string, Reply]> = [];

    const first = start();
    const a = await nextAuthUrl();
    const origin = new URL(a.redirectUri).origin;
    replies.push(['404', await get(`${origin}/elsewhere`)]);
    replies.push(['405', await send(a.redirectUri, 'POST')]);
    replies.push(['expired', await get(`${a.redirectUri}?code=x&state=not-ours`)]);
    replies.push(['callback_failed', await send(a.redirectUri, 'GET', '//')]);
    replies.push(['provider error', await get(`${a.redirectUri}?error=access_denied&state=${a.state}`)]);
    await first.catch(() => {});

    const second = start();
    const b = await nextAuthUrl();
    replies.push(['missing code', await get(`${b.redirectUri}?state=${b.state}`)]);
    await second.catch(() => {});

    const third = start();
    const c = await nextAuthUrl();
    replies.push(['ok', await get(`${c.redirectUri}?code=c&state=${c.state}`)]);
    await third;

    expect(replies.map(([kind, r]) => [kind, r.status])).toEqual([
      ['404', 404],
      ['405', 405],
      ['expired', 200],
      ['callback_failed', 200],
      ['provider error', 200],
      ['missing code', 200],
      ['ok', 200],
    ]);
    expect(replies.find(([kind]) => kind === 'callback_failed')![1].body).toContain('callback_failed');
    for (const [kind, { headers }] of replies) {
      expect(headers['cache-control'], kind).toBe('no-store');
      expect(headers['referrer-policy'], kind).toBe('no-referrer');
      expect(headers['x-content-type-options'], kind).toBe('nosniff');
      expect(headers.connection, kind).toBe('close');
      const csp = headers['content-security-policy'] ?? '';
      expect(csp, kind).toContain("default-src 'none'");
      expect(csp, kind).toContain("frame-ancestors 'none'");
      expect(csp, kind).toContain("form-action 'none'");
      expect(csp, kind).toContain("base-uri 'none'");
      expect(csp, kind).not.toContain('unsafe-inline');
    }
  });

  // Breaks: the page's <style> and the hash in its CSP drift apart, and every
  // callback page renders unstyled (or someone "fixes" it with 'unsafe-inline').
  it('admits exactly the page\'s own inline style through its CSP hash', async () => {
    const flow = start();
    const { redirectUri } = await nextAuthUrl();

    const res = await get(`${redirectUri}?code=x&state=not-ours`);
    const style = /<style>([\s\S]*?)<\/style>/.exec(res.body)?.[1];
    const hash = createHash('sha256').update(style ?? '', 'utf8').digest('base64');

    expect(style).toBeTruthy();
    expect(res.headers['content-security-policy']).toContain(`style-src 'sha256-${hash}'`);

    cancelOAuthFlow();
    await expect(flow).rejects.toMatchObject({ code: 'FLOW_CANCELLED' });
  });
});

describe('registered callback ports', () => {
  // Breaks: Sarv matches redirect_uri EXACTLY against its registration. A port
  // added, dropped or reordered here without the matching registration change
  // makes sign-in fail with redirect_uri_mismatch — or come up on an
  // unregistered port first.
  it('tries 51823, 51824 and 51825, in that order', async () => {
    const actual = await vi.importActual<typeof import('../../../../electron/services/oauth-callback-ports')>(
      '../../../../electron/services/oauth-callback-ports',
    );
    expect(actual.OAUTH_CALLBACK_PORTS).toEqual([51823, 51824, 51825]);
  });
});
