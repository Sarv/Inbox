import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeLoopbackServer,
  RESPONSE_FLUSH_GRACE_MS,
  trackLoopbackResponse,
  type AnsweringResponses,
} from '../../../../electron/utils/loopback-server-close';

/**
 * Closing an OAuth loopback listener, on real sockets. The two services that use it
 * have their own end-to-end suites (oauth-loopback, antivirus-oauth-service).
 *
 * What breaks if this fails: on Windows a socket closed straight after `res.end()`
 * can cancel the overlapped write, so the browser shows a connection reset instead
 * of the page; or a connection nobody finished keeps a closed listener alive. On
 * POSIX the write is synchronous, so only the ORDER of events shows the first one.
 * CI runs this file on Windows too.
 */

/** A listener whose handler is the test's, with every socket's destroy recorded. */
async function listen(handler: (res: http.ServerResponse, answering: AnsweringResponses, server: http.Server) => void) {
  const events: string[] = [];
  const answering: AnsweringResponses = new Map();
  const server = http.createServer((_req, res) => {
    trackLoopbackResponse(answering, res);
    res.once('finish', () => events.push('finish'));
    handler(res, answering, server);
  });
  server.on('connection', (socket) => {
    const destroy = socket.destroy.bind(socket);
    socket.destroy = ((error?: Error) => {
      events.push('destroy');
      return destroy(error);
    }) as typeof socket.destroy;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, answering, events, port: (server.address() as AddressInfo).port };
}

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(port, '127.0.0.1');
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });

/** A connection that never sends a request, as a browser's speculative preconnect is. */
async function connectIdle(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  let closed = false;
  socket.on('close', () => { closed = true; });
  return { closed: () => closed, destroy: () => socket.destroy() };
}

/** A request whose headers never finished: `server.close()` alone leaves this one open. */
async function connectHalfOpen(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  await new Promise((resolve) => socket.once('connect', resolve));
  let closed = false;
  socket.on('close', () => { closed = true; });
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  return { closed: () => closed, destroy: () => socket.destroy() };
}

const get = (port: number): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http.get({ port, host: '127.0.0.1', path: '/', agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    }).on('error', reject);
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('closeLoopbackServer', () => {
  // Breaks on Windows: the browser gets a reset instead of the page that tells the
  // user what happened, because the socket went before the write finished.
  it('lets a response written just before the close finish first', async () => {
    const { events, port } = await listen((res, answering, server) => {
      res.setHeader('Connection', 'close');
      res.end('the page');
      closeLoopbackServer(server, answering);
    });

    await expect(get(port)).resolves.toEqual({ status: 200, body: 'the page' });

    await vi.waitFor(() => expect(events).toContain('destroy'));
    expect(events[0]).toBe('finish');
  });

  // Breaks a retry: the port has to be free the moment the flow settles, even with a
  // response still going out, or the next sign-in meets EADDRINUSE.
  it('frees the port at once, before the response has finished', async () => {
    let close = () => {};
    const { server, answering, port } = await listen((_res, tracked, srv) => { close = () => closeLoopbackServer(srv, tracked); });
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await vi.waitFor(() => expect(answering.size).toBe(1));

    close();

    expect(await listening(port)).toBe(false);
    expect(server.listening).toBe(false);
    client.destroy();
  });

  // Breaks if the wait for answers turns into never dropping anything else: these
  // keep the closed listener and its handler alive with no port behind them.
  it('drops idle and half-open connections, with or without an answer in flight', async () => {
    const quiet = await listen(() => {});
    const silent = await connectIdle(quiet.port);
    const straggler = await connectHalfOpen(quiet.port);

    closeLoopbackServer(quiet.server, quiet.answering);

    await vi.waitFor(() => {
      expect(silent.closed()).toBe(true);
      expect(straggler.closed()).toBe(true);
    });
    silent.destroy();
    straggler.destroy();
  });

  // The same, for the path that waits on a response first.
  it('also drops them once the answer in flight has finished', async () => {
    const { port } = await listen((res, answering, server) => {
      res.setHeader('Connection', 'close');
      res.end('the page');
      closeLoopbackServer(server, answering);
    });
    const straggler = await connectHalfOpen(port);

    await expect(get(port)).resolves.toMatchObject({ body: 'the page' });

    await vi.waitFor(() => expect(straggler.closed()).toBe(true));
    straggler.destroy();
  });

  // Breaks if a client that stops reading can hold the listener's memory forever.
  // The wait is bounded, and short.
  it('drops a connection whose answer never finishes once the grace period is over', async () => {
    let stalled: http.ServerResponse | null = null;
    const { server, answering, port } = await listen((res) => { stalled = res; res.write('partial'); });
    let closed = false;
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.on('close', () => { closed = true; });
    client.resume(); // an unread 'partial' would hide the server's FIN behind it
    client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await vi.waitFor(() => expect(stalled).not.toBeNull());

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    closeLoopbackServer(server, answering);
    vi.advanceTimersByTime(RESPONSE_FLUSH_GRACE_MS - 1);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  // Breaks a timer leak: an answered close must not leave the backstop armed.
  it('stands the backstop down once the answers have finished', async () => {
    const { server, answering, port } = await listen((res, tracked, srv) => {
      res.setHeader('Connection', 'close');
      res.end('the page');
      closeLoopbackServer(srv, tracked);
    });
    const closeAll = vi.spyOn(server, 'closeAllConnections');
    const armed = vi.spyOn(globalThis, 'setTimeout');
    const cleared = vi.spyOn(globalThis, 'clearTimeout');

    await get(port);
    await vi.waitFor(() => expect(closeAll).toHaveBeenCalledOnce());

    const backstop = armed.mock.results[armed.mock.calls.findIndex(([, ms]) => ms === RESPONSE_FLUSH_GRACE_MS)]?.value;
    expect(backstop).toBeDefined();
    expect(cleared).toHaveBeenCalledWith(backstop);
    expect(answering.size).toBe(0);
  });

  // An idempotent re-run: a flow can be cancelled after it already settled.
  it('is safe to call twice', async () => {
    const { server, answering } = await listen(() => {});
    closeLoopbackServer(server, answering);
    expect(() => closeLoopbackServer(server, answering)).not.toThrow();
  });

  // A close before the bind finished has nothing to drop, and must not throw.
  it('is safe on a listener that never bound', () => {
    expect(() => closeLoopbackServer(http.createServer(), new Map())).not.toThrow();
  });
});

describe('trackLoopbackResponse', () => {
  // Breaks the wait: a connection reset mid-answer never fires 'finish', and only
  // 'close' can settle it, or the close would sit on the backstop every time.
  it('settles when the connection goes, not only when the answer finishes', async () => {
    let settled: Promise<void> | undefined;
    const { answering, port } = await listen((res, tracked) => { settled = tracked.get(res); });
    const client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await vi.waitFor(() => expect(settled).toBeDefined());
    expect(answering.size).toBe(1);

    client.destroy();

    await settled;
    expect(answering.size).toBe(0);
  });
});
