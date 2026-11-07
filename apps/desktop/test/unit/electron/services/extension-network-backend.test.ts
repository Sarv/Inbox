import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createExtensionNetworkBackend,
  DEFAULT_NETWORK_TIMEOUT_MS,
  MAX_CONCURRENT_REQUESTS,
  MAX_NETWORK_BODY_BYTES,
  MAX_NETWORK_REDIRECTS,
  MAX_NETWORK_TIMEOUT_MS,
} from '../../../../electron/services/extension-network-backend';
import type { HttpsRequest, Resolver } from '../../../../electron/services/sender-identity-fetch';

/**
 * The one way out of the extension sandbox. An extension chooses the URL, so if a rule
 * here fails it can reach the reader's router, localhost, or a cloud metadata address
 * through the app. The permission itself is checked before this is reached, in core.
 *
 * The network is faked at the `https.request` boundary, so the guarded lookup runs as
 * Node would call it.
 */

const PUBLIC = '93.184.216.34';

interface Route {
  status?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  error?: Error;
  hang?: boolean;
  hangBody?: boolean;
  respondIf?: (options: RequestOptions, body: unknown) => boolean;
}

function fakeNet(routes: Record<string, Route>, dns: Record<string, string[]> = { 'x.example': [PUBLIC], 'y.example': [PUBLIC] }) {
  const sent: { options: RequestOptions; body: unknown; url: string }[] = [];
  const resolve: Resolver = (hostname, _options, callback) => {
    setImmediate(() => {
      const addresses = dns[hostname];
      if (!addresses) {
        callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
        return;
      }
      callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
    });
  };
  const request: HttpsRequest = (options) => {
    const req = new EventEmitter() as EventEmitter & { end: (body?: unknown) => void; destroy: () => void; destroyed: boolean };
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
    };
    const url = `https://${options.hostname}${options.path}`;
    req.end = (body) => {
      sent.push({ options, body, url });
      const route = routes[url] ?? { status: 404 };
      // The guarded lookup, exactly where Node would run it, IP literals excepted.
      const connect = (done: () => void) => {
        if (isIP(String(options.hostname))) {
          done();
          return;
        }
        (options.lookup as (h: string, o: object, cb: (e: Error | null) => void) => void)(String(options.hostname), {}, (error) => {
          if (error) req.emit('error', error);
          else done();
        });
      };
      connect(() => {
        if (route.error) {
          req.emit('error', route.error);
          return;
        }
        if (route.hang) return;
        const res = new Readable({
          read() {
            if (route.hangBody) return;
            const data = route.body;
            if (data !== undefined) this.push(typeof data === 'string' ? Buffer.from(data) : data);
            this.push(null);
          },
        }) as Readable & { statusCode?: number; statusMessage?: string; headers: Record<string, unknown> };
        res.statusCode = route.status ?? 200;
        res.statusMessage = route.statusMessage ?? 'OK';
        res.headers = route.headers ?? {};
        req.emit('response', res);
      });
    };
    return req as unknown as ClientRequest;
  };
  return { sent, backend: createExtensionNetworkBackend({ resolve, request }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('extension network: where it may go', () => {
  // Each of these is the reader's own machine or network, or a request that could be
  // read in transit. The extension has no other way to reach any of them.
  it.each([
    ['plain http', 'http://x.example/', 'not-https'],
    ['another port', 'https://x.example:8443/', 'non-default-port'],
    ['loopback', 'https://127.0.0.1/', 'private-address'],
    ['the router', 'https://192.168.1.1/', 'private-address'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/', 'private-address'],
    ['IPv6 loopback', 'https://[::1]/', 'private-address'],
    ['a file', 'file:///etc/passwd', 'not-https'],
    ['not a URL', 'nonsense', 'invalid-url'],
  ])('refuses %s before anything is sent', async (_name, url, reason) => {
    const { backend, sent } = fakeNet({});
    await expect(backend.fetch('ext', url, {})).rejects.toThrow(reason);
    expect(sent).toHaveLength(0);
  });

  // DNS rebinding: a name that looks public and answers with a private address.
  it('refuses a name that resolves to a private address', async () => {
    const { backend } = fakeNet({ 'https://evil.example/': { status: 200 } }, { 'evil.example': ['10.0.0.1'] });
    await expect(backend.fetch('ext', 'https://evil.example/', {})).rejects.toThrow('private-address');
  });

  // An answer mixing a public and a private address could win the race to the private one.
  it('refuses a name with any private address in its answer', async () => {
    const { backend } = fakeNet({ 'https://evil.example/': {} }, { 'evil.example': [PUBLIC, '127.0.0.1'] });
    await expect(backend.fetch('ext', 'https://evil.example/', {})).rejects.toThrow('private-address');
  });

  // A redirect is how a public URL reaches a private one, and each hop is a new
  // destination held to the same rules.
  it.each([
    ['http://x.example/', 'not-https'],
    ['https://127.0.0.1/admin', 'private-address'],
    ['https://x.example:8443/', 'non-default-port'],
  ])('refuses a redirect to %s', async (location, reason) => {
    const { backend, sent } = fakeNet({
      'https://x.example/': { status: 302, headers: { location } },
    });
    await expect(backend.fetch('ext', 'https://x.example/', {})).rejects.toThrow(reason);
    expect(sent).toHaveLength(1);
  });

  // A network failure stays a failure the extension can see.
  it('rejects on a real network failure', async () => {
    const { backend } = fakeNet({ 'https://x.example/': { error: new Error('ECONNRESET') } });
    await expect(backend.fetch('ext', 'https://x.example/', {})).rejects.toThrow('ECONNRESET');
  });
});

describe('extension network: what it sends', () => {
  // The whole reason for Node's stack over Chromium's: nothing of the app's sessions
  // goes along, and it connects through the guarded lookup on a socket of its own.
  it('carries no cookies, uses the guarded lookup and a private socket', async () => {
    const { backend, sent } = fakeNet({ 'https://x.example/': { body: 'ok' } });
    await backend.fetch('ext', 'https://x.example/', {});

    const { options } = sent[0];
    expect(options.agent).toBe(false);
    expect(options.lookup).toBeTypeOf('function');
    expect(options.port).toBe(443);
    expect(Object.keys(options.headers as object)).not.toContain('cookie');
    expect((options.headers as Record<string, string>)['accept-encoding']).toBe('identity');
  });

  it('sends the method, headers and body it was given', async () => {
    const { backend, sent } = fakeNet({ 'https://x.example/a?b=1': { status: 201, body: '{}' } });
    const result = await backend.fetch('ext', 'https://x.example/a?b=1', {
      method: 'POST',
      headers: { 'X-Key': 'k', Authorization: 'Bearer t' },
      body: 'héllo',
    });

    const headers = sent[0].options.headers as Record<string, string>;
    expect(sent[0].options.method).toBe('POST');
    expect(sent[0].options.path).toBe('/a?b=1');
    expect(headers['x-key']).toBe('k');
    expect(headers.authorization).toBe('Bearer t');
    expect(headers['content-length']).toBe(String(Buffer.byteLength('héllo')));
    expect(Buffer.from(sent[0].body as Uint8Array).toString()).toBe('héllo');
    expect(result.status).toBe(201);
    expect(result.ok).toBe(true);
  });

  it('sends bytes as they are', async () => {
    const { backend, sent } = fakeNet({ 'https://x.example/': {} });
    await backend.fetch('ext', 'https://x.example/', { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect(Array.from(sent[0].body as Uint8Array)).toEqual([1, 2, 3]);
  });

  // These describe the connection. Setting `Host` is how a request reaches one site
  // while naming another; refused rather than dropped, so it is never quietly different.
  it.each(['Host', 'host', 'Connection', 'Content-Length', 'Transfer-Encoding', 'Upgrade', 'Proxy-Authorization'])(
    'refuses to let an extension set %s',
    async (name) => {
      const { backend, sent } = fakeNet({});
      await expect(backend.fetch('ext', 'https://x.example/', { headers: { [name]: 'x' } })).rejects.toThrow('cannot be set');
      expect(sent).toHaveLength(0);
    }
  );

  it('refuses a request body over the limit', async () => {
    const { backend, sent } = fakeNet({});
    await expect(
      backend.fetch('ext', 'https://x.example/', { method: 'POST', body: new Uint8Array(MAX_NETWORK_BODY_BYTES + 1) })
    ).rejects.toThrow('request body');
    expect(sent).toHaveLength(0);
  });
});

describe('extension network: what comes back', () => {
  // The contract with the sandbox: plain data. A Buffer can be a window onto a larger
  // pool, and all of that pool would cross into the sandbox with it.
  it('answers with plain data and a plain copy of the body', async () => {
    const { backend } = fakeNet({
      'https://x.example/': {
        status: 200,
        statusMessage: 'Fine',
        headers: { 'content-type': 'text/plain', 'x-many': ['a', 'b'] },
        body: 'hello',
      },
    });

    const result = await backend.fetch('ext', 'https://x.example/', {});

    expect(result).toMatchObject({ ok: true, status: 200, statusText: 'Fine', url: 'https://x.example/' });
    expect(result.headers).toEqual({ 'content-type': 'text/plain', 'x-many': 'a, b' });
    expect(result.body.constructor).toBe(Uint8Array);
    expect(result.body.buffer.byteLength).toBe(5);
    expect(new TextDecoder().decode(result.body)).toBe('hello');
    expect(() => structuredClone(result)).not.toThrow();
  });

  // An error status is an answer, like `fetch`: the extension decides what it means.
  it('resolves an error status', async () => {
    const { backend } = fakeNet({ 'https://x.example/': { status: 500, body: 'oops' } });
    await expect(backend.fetch('ext', 'https://x.example/', {})).resolves.toMatchObject({ ok: false, status: 500 });
  });

  // A declared 5 GB answer must not be read at all.
  it('refuses a response that declares itself too large, without reading it', async () => {
    const { backend } = fakeNet({
      'https://x.example/': { headers: { 'content-length': String(MAX_NETWORK_BODY_BYTES + 1) }, hangBody: true },
    });
    await expect(backend.fetch('ext', 'https://x.example/', {})).rejects.toThrow('is over');
  });

  // One that lies about its size, or says nothing, is cut off at the limit.
  it('refuses a response that turns out too large', async () => {
    const { backend } = fakeNet({ 'https://x.example/': { body: Buffer.alloc(MAX_NETWORK_BODY_BYTES + 5) } });
    await expect(backend.fetch('ext', 'https://x.example/', {})).rejects.toThrow('is over');
  });
});

describe('extension network: redirects', () => {
  it('follows one and reports the final URL', async () => {
    const { backend } = fakeNet({
      'https://x.example/': { status: 301, headers: { location: '/moved' } },
      'https://x.example/moved': { body: 'here' },
    });
    const result = await backend.fetch('ext', 'https://x.example/', {});
    expect(result.url).toBe('https://x.example/moved');
    expect(new TextDecoder().decode(result.body)).toBe('here');
  });

  // An extension's API key must not follow a redirect to someone else's site.
  it('drops credentials on a redirect to another site, and keeps them on the same one', async () => {
    const { backend, sent } = fakeNet({
      'https://x.example/': { status: 302, headers: { location: '/same' } },
      'https://x.example/same': { status: 302, headers: { location: 'https://y.example/other' } },
      'https://y.example/other': { body: 'ok' },
    });
    await backend.fetch('ext', 'https://x.example/', {
      headers: { Authorization: 'Bearer secret', Cookie: 'a=b', 'X-Kept': 'yes' },
    });

    const header = (i: number) => sent[i].options.headers as Record<string, string>;
    expect(header(1).authorization).toBe('Bearer secret');
    expect(header(2).authorization).toBeUndefined();
    expect(header(2).cookie).toBeUndefined();
    expect(header(2)['x-kept']).toBe('yes');
  });

  // The fetch standard's rules, or a POST is repeated where it was never meant to be.
  it.each([
    [303, 'POST', 'GET', false],
    [302, 'POST', 'GET', false],
    [301, 'POST', 'GET', false],
    [303, 'PUT', 'GET', false],
    [303, 'HEAD', 'HEAD', false],
    [307, 'POST', 'POST', true],
    [308, 'POST', 'POST', true],
    [302, 'PUT', 'PUT', true],
  ] as const)('after a %i, %s becomes %s', async (status, method, after, keepsBody) => {
    const { backend, sent } = fakeNet({
      'https://x.example/': { status, headers: { location: '/next' } },
      'https://x.example/next': {},
    });
    await backend.fetch('ext', 'https://x.example/', { method, body: 'data' });

    expect(sent[1].options.method).toBe(after);
    expect(sent[1].body !== undefined).toBe(keepsBody);
  });

  it('gives up on a chain that will not end', async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i <= MAX_NETWORK_REDIRECTS + 1; i += 1) {
      routes[`https://x.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    }
    const { backend, sent } = fakeNet(routes);
    await expect(backend.fetch('ext', 'https://x.example/0', {})).rejects.toThrow('too many redirects');
    expect(sent).toHaveLength(MAX_NETWORK_REDIRECTS + 1);
  });

  // A redirect with no Location is an answer, not a hop.
  it('returns a redirect status with no location as it is', async () => {
    const { backend } = fakeNet({ 'https://x.example/': { status: 302 } });
    await expect(backend.fetch('ext', 'https://x.example/', {})).resolves.toMatchObject({ status: 302 });
  });
});

describe('extension network: limits on time and concurrency', () => {
  // Without a bound a server that never answers holds a slot in main forever.
  it('times out a server that never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { backend } = fakeNet({ 'https://x.example/': { hang: true } });
    const pending = backend.fetch('ext', 'https://x.example/', {}).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(DEFAULT_NETWORK_TIMEOUT_MS + 1);
    expect(await pending).toContain('timed out waiting');
  });

  it('times out a body that never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { backend } = fakeNet({ 'https://x.example/': { hangBody: true } });
    const pending = backend.fetch('ext', 'https://x.example/', { timeoutMs: 1_000 }).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await pending).toContain('timed out reading');
  });

  // An extension may wait less, never longer than the host allows.
  it('caps the timeout an extension asks for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { backend } = fakeNet({ 'https://x.example/': { hang: true } });
    const pending = backend
      .fetch('ext', 'https://x.example/', { timeoutMs: MAX_NETWORK_TIMEOUT_MS * 10 })
      .catch((error: Error) => error.message);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(MAX_NETWORK_TIMEOUT_MS + 1);
    expect(await pending).toContain('timed out');
  });

  // Requests are held in the process running everything else, so their number is capped
  // per extension: one extension's flood must not take a slot from another's.
  it('refuses past the concurrency limit, per extension, and frees a slot when one ends', async () => {
    const { backend } = fakeNet({
      'https://x.example/slow': { hang: true },
      'https://x.example/fast': { body: 'ok' },
    });
    const held = Array.from({ length: MAX_CONCURRENT_REQUESTS }, () => {
      void backend.fetch('ext', 'https://x.example/slow', { timeoutMs: 50 }).catch(() => undefined);
    });
    void held;

    await expect(backend.fetch('ext', 'https://x.example/fast', {})).rejects.toThrow('at a time');
    await expect(backend.fetch('other', 'https://x.example/fast', {})).resolves.toMatchObject({ ok: true });

    await vi.waitFor(async () => {
      await expect(backend.fetch('ext', 'https://x.example/fast', {})).resolves.toMatchObject({ ok: true });
    }, { timeout: 2_000 });
  });
});
