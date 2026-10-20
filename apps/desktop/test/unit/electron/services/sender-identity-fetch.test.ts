import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { request as realHttpsRequest, type RequestOptions } from 'node:https';
import { createServer, isIP, type LookupFunction, type Server } from 'node:net';
import { Readable } from 'node:stream';

import { discoverFavicon, lookupBimi } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  RefusedDestinationError,
  USER_AGENT,
  publicOnlyLookup,
  senderIdentityFetch,
  type HttpsRequest,
  type Resolver,
} from '../../../../electron/services/sender-identity-fetch';

/**
 * The sender-identity transport (CASA audit L-6): BIMI logos, BIMI
 * certificates and favicons are fetched from URLs a stranger chose, so none of
 * those fetches may reach the reader's own machine or network.
 *
 * What this protects: a homepage `<link rel="icon" href="https://127.0.0.1:631/…">`
 * or a BIMI `l=` aimed at the router turns every incoming message into a blind
 * GET inside the reader's LAN. Each test names the hole it keeps shut, or the
 * normal behaviour (a logo, an icon) it keeps working. A guard that also
 * blocked real brands would be "fixed" by being switched off.
 *
 * The network is faked at the `https.request` boundary, so the guarded lookup
 * runs exactly as Node would call it: once per name, never for an IP literal.
 * The last block uses REAL sockets to prove the refusal happens before any
 * TCP connection is made.
 */

const PUBLIC = '209.85.220.41';
const PUBLIC_B = '185.199.108.1';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Brand</title><circle cx="5" cy="5" r="4" fill="#0a0"/></svg>';

interface Route {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: Buffer | string;
  /** Emit this on the request instead of answering. */
  error?: NodeJS.ErrnoException;
  /** Never answer. */
  hang?: boolean;
  /** Answer the headers after this long (fake timers). */
  delayMs?: number;
  /** Send the headers, then never send the body. */
  hangBody?: boolean;
  /** Send part of the body, then drop the connection. */
  dropAfter?: number;
  /** With dropAfter: the error the dropped body is destroyed with. */
  dropWith?: string;
  /** Leave statusCode unset, as a malformed response would. */
  noStatus?: boolean;
}

class FakeResponse extends Readable {
  statusCode?: number;
  headers: Record<string, string | string[]> = {};
  /** Bytes the server side has pushed so far. */
  pushed = 0;
}

/** A fake https + DNS: `routes` by full URL, `dns` by host name. */
function fakeNet(routes: Record<string, Route>, dns: Record<string, string[]> = {}) {
  const sent: RequestOptions[] = [];
  /** URLs that produced a response, in order. */
  const answered: string[] = [];
  const lookedUp: string[] = [];
  const bodies: FakeResponse[] = [];
  const requests: Array<{ destroyed: boolean }> = [];

  const resolve: Resolver = (hostname, _options, callback) => {
    lookedUp.push(hostname);
    setImmediate(() => {
      const addresses = dns[hostname];
      if (!addresses) {
        callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
        return;
      }
      callback(null, addresses.map((address) => ({ address, family: isIP(address) })));
    });
  };

  const respond = (route: Route): FakeResponse => {
    const body = typeof route.body === 'string' ? Buffer.from(route.body) : (route.body ?? Buffer.alloc(0));
    let offset = 0;
    const res = new FakeResponse({
      read() {
        if (route.hangBody) return;
        if (route.dropAfter !== undefined && offset >= route.dropAfter) {
          this.destroy(route.dropWith ? new Error(route.dropWith) : undefined);
          return;
        }
        if (offset >= body.length) {
          this.push(null);
          return;
        }
        const next = body.subarray(offset, offset + 16 * 1024);
        offset += next.length;
        res.pushed = offset;
        this.push(next);
      },
    });
    if (!route.noStatus) res.statusCode = route.status ?? 200;
    res.headers = Object.fromEntries(Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    bodies.push(res);
    return res;
  };

  const request: HttpsRequest = (options) => {
    sent.push(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => unknown; destroyed: boolean; res?: FakeResponse };
    req.destroyed = false;
    // As in Node: destroying the request closes the socket, and with it the response.
    req.destroy = () => { req.destroyed = true; req.res?.destroy(); return req; };
    requests.push(req);
    req.end = () => {
      const host = String(options.hostname);
      const url = `https://${isIP(host) === 6 ? `[${host}]` : host}${options.path}`;
      const deliver = () => {
        const route = routes[url] ?? { status: 404, body: 'not found' };
        if (route.error) { req.emit('error', route.error); return; }
        if (route.hang) return;
        const answer = () => {
          answered.push(url);
          req.res = respond(route);
          req.emit('response', req.res);
        };
        if (route.delayMs) setTimeout(answer, route.delayMs);
        else answer();
      };
      // Node skips `lookup` for an IP literal, and so does this fake.
      if (isIP(host)) { setImmediate(deliver); return; }
      (options.lookup as LookupFunction)(host, { all: true }, (err) => {
        if (err) req.emit('error', err);
        else deliver();
      });
    };
    return req as unknown as ClientRequest;
  };

  const fetchFor = (extra: { site?: string; timeoutMs?: number } = {}) =>
    senderIdentityFetch({ timeoutMs: extra.timeoutMs ?? 15_000, site: extra.site, resolve, request });
  const urls = () => sent.map((o) => `${String(o.hostname)}${o.path}`);
  return { fetchFor, sent, urls, answered, lookedUp, bodies, requests, resolve, request };
}

const text = async (res: { arrayBuffer(): Promise<ArrayBuffer> }) => Buffer.from(await res.arrayBuffer()).toString('utf8');

afterEach(() => {
  vi.useRealTimers();
});

describe('publicOnlyLookup', () => {
  const resolverWith = (answer: Array<{ address: string; family: number }> | Error) => {
    const asked: unknown[] = [];
    const resolve: Resolver = (_host, options, callback) => {
      asked.push(options);
      setImmediate(() => (answer instanceof Error ? callback(answer, []) : callback(null, answer)));
    };
    return { resolve, asked };
  };
  const run = (lookup: LookupFunction, options: Parameters<LookupFunction>[1]) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((done) => {
      lookup('brand.example', options, (err, address, family) => done({ err, address, family }));
    });

  // Breaks if a name that resolves to public addresses is refused. That would
  // be every logo and favicon.
  it('passes a public answer through, in the form Node asked for', async () => {
    const answer = [{ address: PUBLIC, family: 4 }, { address: '2a00:1450:4864:20::32a', family: 6 }];
    const single = await run(publicOnlyLookup(resolverWith(answer).resolve), { family: 0 });
    expect(single).toEqual({ err: null, address: PUBLIC, family: 4 });
    const all = await run(publicOnlyLookup(resolverWith(answer).resolve), { all: true });
    expect(all).toMatchObject({ err: null, address: answer });
  });

  // Breaks if the check sees only the FIRST address while Node connects to
  // another. Every address is fetched and judged, whatever form Node asked
  // for, and the family Node asked for is still honoured.
  it('always asks the resolver for every address, keeping the requested family', async () => {
    const { resolve, asked } = resolverWith([{ address: PUBLIC, family: 4 }]);
    await run(publicOnlyLookup(resolve), { family: 4, hints: 0 });
    expect(asked).toEqual([{ family: 4, hints: 0, all: true }]);
  });

  // Breaks if a name that resolves to loopback, a private range or the
  // metadata service is let through. This is the DNS-rebinding hole: the
  // check runs on the very answer the socket connects to.
  it.each([['127.0.0.1', 4], ['10.0.0.5', 4], ['169.254.169.254', 4], ['::1', 6], ['::ffff:127.0.0.1', 6], ['64:ff9b::7f00:1', 6]])(
    'refuses an answer containing %s',
    async (address, family) => {
      const { err } = await run(publicOnlyLookup(resolverWith([{ address, family }]).resolve), { all: true });
      expect(err).toBeInstanceOf(RefusedDestinationError);
      expect(err).toMatchObject({ reason: 'private-address', host: 'brand.example' });
    },
  );

  // Breaks if an answer mixing a public address with a private one passes
  // because the public one is listed first. Node may race to either.
  it('refuses the whole answer when any one address is private', async () => {
    const mixed = [{ address: PUBLIC, family: 4 }, { address: '192.168.1.1', family: 4 }];
    const { err } = await run(publicOnlyLookup(resolverWith(mixed).resolve), { family: 0 });
    expect(err).toBeInstanceOf(RefusedDestinationError);
  });

  // Breaks one of two ways. If NAT64 is refused, nothing loads on IPv6-only
  // networks. If it is accepted wholesale, the gateway forwards to a private
  // IPv4 address.
  it('accepts a NAT64 address that carries a public IPv4', async () => {
    const { err, address } = await run(publicOnlyLookup(resolverWith([{ address: '64:ff9b::808:808', family: 6 }]).resolve), { family: 0 });
    expect(err).toBeNull();
    expect(address).toBe('64:ff9b::808:808');
  });

  // Breaks if a DNS failure is turned into a refusal. A refusal is cached for
  // a month, so one bad network afternoon would hide a brand's favicon for
  // weeks. The resolver's own error must come through untouched.
  it('passes a resolver error through as it is', async () => {
    const failure = Object.assign(new Error('getaddrinfo EAI_AGAIN brand.example'), { code: 'EAI_AGAIN' });
    const { err } = await run(publicOnlyLookup(resolverWith(failure).resolve), { family: 0 });
    expect(err).toBe(failure);
  });

  // Breaks if an empty answer reaches Node: its multi-address connect reads
  // the first entry unconditionally and would throw outside any handler.
  it('turns an empty answer into a not-found error', async () => {
    const { err } = await run(publicOnlyLookup(resolverWith([]).resolve), { all: true });
    expect(err).toMatchObject({ code: 'ENOTFOUND' });
    expect(err).not.toBeInstanceOf(RefusedDestinationError);
  });
});

describe('senderIdentityFetch', () => {
  // Breaks if the FetchLike contract the brand readers depend on changes:
  // status, the final URL, headers and the body bytes. Also pins how each
  // request is sent: GET to port 443, our own lookup, no pooled socket, and
  // an uncompressed body, since nothing here decompresses.
  it('fetches a public https URL and answers in the FetchLike shape', async () => {
    const net = fakeNet(
      { 'https://brand.example/favicon.ico?v=2': { headers: { 'Content-Type': 'image/png', 'Set-Cookie': ['a=1', 'b=2'] }, body: PNG } },
      { 'brand.example': [PUBLIC] },
    );
    const res = await net.fetchFor()('https://brand.example/favicon.ico?v=2');
    expect(res).toMatchObject({ ok: true, status: 200, url: 'https://brand.example/favicon.ico?v=2' });
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('SET-COOKIE')).toBe('a=1, b=2');
    expect(res.headers.get('x-missing')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(net.sent[0]).toMatchObject({
      hostname: 'brand.example', port: 443, path: '/favicon.ico?v=2', method: 'GET', agent: false,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
    });
    expect(typeof net.sent[0].lookup).toBe('function');
    expect(net.requests[0].destroyed).toBe(true); // the socket is not left open
  });

  // Breaks if a 404 or 500 reads as success. The brand readers then turn it
  // into "nothing published here", which is the right negative answer.
  it('reports a non-2xx answer as not ok, with its status', async () => {
    const net = fakeNet({ 'https://brand.example/logo.svg': { status: 500, body: 'oops' } }, { 'brand.example': [PUBLIC] });
    const res = await net.fetchFor()('https://brand.example/logo.svg');
    expect(res).toMatchObject({ ok: false, status: 500 });
    expect(await text(res)).toBe('oops');
  });

  // Breaks if a malformed response without a status line passes as success.
  it('treats a response without a status as status 0, not ok', async () => {
    const net = fakeNet({ 'https://brand.example/': { noStatus: true } }, { 'brand.example': [PUBLIC] });
    expect(await net.fetchFor()('https://brand.example/')).toMatchObject({ ok: false, status: 0 });
  });

  describe('refusals answer status 0 and never throw', () => {
    // Breaks if a refusal THROWS. The lookup would then record an "error"
    // and retry the hostile address every hour, instead of recording an
    // ordinary negative answer.
    it.each([
      ['plain http', 'http://brand.example/favicon.ico'],
      ['a private IP literal', 'https://127.0.0.1/admin'],
      ['the metadata service', 'https://169.254.169.254/latest/meta-data/'],
      ['an IPv4-mapped loopback literal', 'https://[::ffff:127.0.0.1]/'],
      ['a non-default port', 'https://brand.example:8080/'],
      ['something that is not a URL', 'not a url'],
    ])('refuses %s without sending anything', async (_label, url) => {
      const net = fakeNet({}, { 'brand.example': [PUBLIC] });
      const res = await net.fetchFor()(url);
      expect(res).toMatchObject({ ok: false, status: 0, url });
      expect(res.headers.get('content-type')).toBeNull();
      expect((await res.arrayBuffer()).byteLength).toBe(0);
      expect(net.sent).toHaveLength(0);
    });

    // Breaks if a host NAME that resolves to loopback is fetched. Only the
    // connect-time lookup can catch this; no URL check can. It throws, like a
    // network failure, so the lookup is retried later (a captive portal
    // answers every name with a private address until you sign in).
    it('refuses a name that resolves to a private address, at connect time', async () => {
      const net = fakeNet({ 'https://rebind.example/': { body: 'secret' } }, { 'rebind.example': ['127.0.0.1'] });
      await expect(net.fetchFor()('https://rebind.example/')).rejects.toMatchObject({ name: 'RefusedDestinationError', reason: 'private-address' });
      expect(net.lookedUp).toEqual(['rebind.example']);
      expect(net.bodies).toHaveLength(0); // no response was ever produced
      expect(net.requests[0].destroyed).toBe(true);
    });

    // Breaks if a public IP literal goes through the lookup. Node never calls
    // `lookup` for a literal, so the URL check is the one that must judge it.
    it('connects to a public IP literal directly, checked by the URL rule alone', async () => {
      const net = fakeNet({ [`https://${PUBLIC}/logo.svg`]: { body: SVG } });
      const res = await net.fetchFor()(`https://${PUBLIC}/logo.svg`);
      expect(res).toMatchObject({ ok: true, status: 200 });
      expect(net.lookedUp).toEqual([]);
    });

    // Breaks if an IPv6 literal is sent with its URL brackets. Node would
    // then treat "[2a00:…]" as a NAME and fail to resolve it.
    it('sends a public IPv6 literal without its brackets', async () => {
      const v6 = '2a00:1450:4864:20::32a';
      const net = fakeNet({ [`https://[${v6}]/logo.svg`]: { body: SVG } });
      expect(await net.fetchFor()(`https://[${v6}]/logo.svg`)).toMatchObject({ ok: true, status: 200 });
      expect(net.sent[0].hostname).toBe(v6);
      expect(net.lookedUp).toEqual([]);
    });
  });

  describe('redirects', () => {
    // Breaks if relative icon links resolve against the URL that was asked
    // for instead of the one that answered.
    it('follows a redirect and reports the final URL', async () => {
      const net = fakeNet(
        {
          'https://brand.example/': { status: 301, headers: { Location: 'https://www.brand.example/home' } },
          'https://www.brand.example/home': { body: '<html></html>', headers: { 'content-type': 'text/html' } },
        },
        { 'brand.example': [PUBLIC], 'www.brand.example': [PUBLIC_B] },
      );
      const res = await net.fetchFor()('https://brand.example/');
      expect(res).toMatchObject({ ok: true, status: 200, url: 'https://www.brand.example/home' });
      expect(net.urls()).toEqual(['brand.example/', 'www.brand.example/home']);
      expect(net.requests[0].destroyed).toBe(true); // the redirect's own connection is closed
    });

    // Breaks if a relative Location is resolved against anything but the
    // response's own URL.
    it('resolves a relative Location against the URL that answered', async () => {
      const net = fakeNet(
        {
          'https://brand.example/a/b': { status: 302, headers: { location: '../c?x=1' } },
          'https://brand.example/c?x=1': { body: 'ok' },
        },
        { 'brand.example': [PUBLIC] },
      );
      expect(await net.fetchFor()('https://brand.example/a/b')).toMatchObject({ ok: true, url: 'https://brand.example/c?x=1' });
    });

    // Breaks if a public page can bounce the fetch into the LAN. Each
    // Location is held to the same rules as the first URL. (A NAME that
    // resolves privately throws instead: see the connect-time test.)
    it.each([
      ['a private literal', 'https://192.168.1.1/'],
      ['plain http', 'http://www.brand.example/'],
      ['a non-default port', 'https://www.brand.example:22/'],
    ])('refuses a redirect to %s', async (_label, location) => {
      const net = fakeNet(
        {
          'https://brand.example/': { status: 307, headers: { location } },
          'https://internal.brand.example/': { body: 'router admin' },
          'https://192.168.1.1/': { body: 'router admin' },
        },
        { 'brand.example': [PUBLIC], 'internal.brand.example': ['10.1.2.3'] },
      );
      const res = await net.fetchFor()('https://brand.example/');
      expect(res).toMatchObject({ ok: false, status: 0 });
      expect(net.bodies.filter((b) => b.statusCode === 200)).toHaveLength(0);
    });

    it('refuses a redirect to a name that resolves to loopback, without fetching it', async () => {
      const net = fakeNet(
        {
          'https://brand.example/': { status: 307, headers: { location: 'https://internal.brand.example/' } },
          'https://internal.brand.example/': { body: 'router admin' },
        },
        { 'brand.example': [PUBLIC], 'internal.brand.example': ['10.1.2.3'] },
      );
      await expect(net.fetchFor()('https://brand.example/')).rejects.toMatchObject({ reason: 'private-address' });
      expect(net.bodies.filter((b) => b.statusCode === 200)).toHaveLength(0);
    });

    // Breaks if a redirect loop holds a lookup slot forever, or if the limit
    // is off by one so a legitimate three-hop chain fails.
    it(`follows at most ${MAX_REDIRECTS} redirects`, async () => {
      const hops = (n: number) => Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`https://brand.example/${i}`, { status: 302, headers: { location: `/${i + 1}` } }]),
      );
      const three = fakeNet({ ...hops(MAX_REDIRECTS), [`https://brand.example/${MAX_REDIRECTS}`]: { body: 'end' } }, { 'brand.example': [PUBLIC] });
      expect(await three.fetchFor()('https://brand.example/0')).toMatchObject({ ok: true, url: `https://brand.example/${MAX_REDIRECTS}` });

      const four = fakeNet({ ...hops(MAX_REDIRECTS + 1), [`https://brand.example/${MAX_REDIRECTS + 1}`]: { body: 'end' } }, { 'brand.example': [PUBLIC] });
      expect(await four.fetchFor()('https://brand.example/0')).toMatchObject({ ok: false, status: 0 });
      expect(four.sent).toHaveLength(MAX_REDIRECTS + 1);
    });

    // Breaks if an unparseable Location throws (an "error", retried hourly)
    // instead of being refused.
    it('refuses a Location that is not a URL', async () => {
      const net = fakeNet({ 'https://brand.example/': { status: 301, headers: { location: 'https://[oops/' } } }, { 'brand.example': [PUBLIC] });
      expect(await net.fetchFor()('https://brand.example/')).toMatchObject({ ok: false, status: 0, url: 'https://[oops/' });
    });

    // Breaks if a 3xx with nowhere to go is treated as a redirect.
    it('answers a redirect status without a Location as it stands', async () => {
      const net = fakeNet({ 'https://brand.example/': { status: 302, body: 'moved?' } }, { 'brand.example': [PUBLIC] });
      expect(await net.fetchFor()('https://brand.example/')).toMatchObject({ ok: false, status: 302 });
    });

    // Breaks if any response carrying a Location header is followed. Only the
    // redirect statuses are redirects.
    it('does not follow a Location on a status that is not a redirect', async () => {
      const net = fakeNet(
        {
          'https://brand.example/': { status: 200, headers: { location: 'https://brand.example/elsewhere' }, body: 'here' },
          'https://brand.example/elsewhere': { body: 'there' },
        },
        { 'brand.example': [PUBLIC] },
      );
      const res = await net.fetchFor()('https://brand.example/');
      expect(await text(res)).toBe('here');
      expect(net.sent).toHaveLength(1);
    });
  });

  describe('with a site (favicons)', () => {
    // Breaks if a sender's homepage can point the favicon fetch at another
    // company's host or a tracker, directly or through a redirect.
    it('keeps every request, redirects included, on the sender’s registrable domain', async () => {
      const net = fakeNet(
        {
          'https://www.brand.example/': { status: 302, headers: { location: 'https://tracker.example/pixel' } },
          'https://static.brand.example/i.png': { body: PNG },
        },
        { 'www.brand.example': [PUBLIC], 'static.brand.example': [PUBLIC], 'tracker.example': [PUBLIC_B] },
      );
      const fetch = net.fetchFor({ site: 'mail.brand.example' });
      expect(await fetch('https://static.brand.example/i.png')).toMatchObject({ ok: true });
      expect(await fetch('https://cdn.other.example/i.png')).toMatchObject({ ok: false, status: 0 });
      expect(await fetch('https://www.brand.example/')).toMatchObject({ ok: false, status: 0 });
      expect(net.lookedUp).not.toContain('tracker.example');
      expect(net.lookedUp).not.toContain('cdn.other.example');
    });
  });

  describe('the body', () => {
    // Breaks if a server that streams forever is read to exhaustion. The
    // read stops one byte past the cap and the connection is closed.
    it(`reads at most ${MAX_BODY_BYTES} bytes plus one, then stops`, async () => {
      const net = fakeNet({ 'https://brand.example/': { body: Buffer.alloc(MAX_BODY_BYTES * 3, 0x61) } }, { 'brand.example': [PUBLIC] });
      const res = await net.fetchFor()('https://brand.example/');
      expect((await res.arrayBuffer()).byteLength).toBe(MAX_BODY_BYTES + 1);
      expect(net.bodies[0].destroyed).toBe(true);
      // Reading stopped at the cap (give or take the stream's read-ahead),
      // not after draining the rest of the 768 KB body.
      expect(net.bodies[0].pushed).toBeLessThan(MAX_BODY_BYTES * 2);
    });

    // Breaks if the cap clips a body that fits exactly.
    it('keeps a body of exactly the cap whole, declared or not', async () => {
      const declared = fakeNet(
        { 'https://brand.example/': { headers: { 'content-length': String(MAX_BODY_BYTES) }, body: Buffer.alloc(MAX_BODY_BYTES, 0x62) } },
        { 'brand.example': [PUBLIC] },
      );
      expect((await (await declared.fetchFor()('https://brand.example/')).arrayBuffer()).byteLength).toBe(MAX_BODY_BYTES);
      const net = fakeNet({ 'https://brand.example/': { body: Buffer.alloc(MAX_BODY_BYTES, 0x62) } }, { 'brand.example': [PUBLIC] });
      expect((await (await net.fetchFor()('https://brand.example/')).arrayBuffer()).byteLength).toBe(MAX_BODY_BYTES);
    });

    // Breaks if the cap is smaller than the largest limit a brand reader
    // applies. A homepage would then be cut short of its own 256 KB scan.
    it('is the largest brand-reader limit', () => {
      expect(MAX_BODY_BYTES).toBe(256 * 1024);
    });

    // Breaks if a server that DECLARES a huge body is downloaded anyway. Its
    // body is never read, and reading it from the response says why.
    it('does not read a body declared larger than the cap', async () => {
      const net = fakeNet(
        { 'https://brand.example/big.svg': { headers: { 'content-length': String(MAX_BODY_BYTES + 1) }, body: Buffer.alloc(MAX_BODY_BYTES + 1) } },
        { 'brand.example': [PUBLIC] },
      );
      const res = await net.fetchFor()('https://brand.example/big.svg');
      expect(res).toMatchObject({ ok: true, status: 200 });
      expect(res.headers.get('content-length')).toBe(String(MAX_BODY_BYTES + 1));
      await expect(res.arrayBuffer()).rejects.toThrow(/declares a body larger than/);
      expect(net.bodies[0].readableFlowing).toBeNull(); // never consumed
      expect(net.requests[0].destroyed).toBe(true);
    });

    // Breaks if a body cut off mid-transfer is handed over as complete. A
    // half PNG is a corrupt avatar. The drop is a network failure and throws.
    it('throws when the connection drops before the body is complete', async () => {
      const net = fakeNet({ 'https://brand.example/i.png': { body: Buffer.alloc(64 * 1024, 1), dropAfter: 16 * 1024 } }, { 'brand.example': [PUBLIC] });
      await expect(net.fetchFor()('https://brand.example/i.png')).rejects.toThrow(/closed before the body was complete/);
    });

    // Breaks if the response's own error (Node's "aborted") goes unheard. An
    // unheard 'error' event would crash the main process.
    it('throws the response’s own error when the body fails', async () => {
      const net = fakeNet(
        { 'https://brand.example/i.png': { body: Buffer.alloc(64 * 1024, 1), dropAfter: 16 * 1024, dropWith: 'aborted' } },
        { 'brand.example': [PUBLIC] },
      );
      await expect(net.fetchFor()('https://brand.example/i.png')).rejects.toThrow('aborted');
    });
  });

  describe('failures that are not refusals still throw', () => {
    // Breaks if a transient failure becomes a cached negative answer. A reset
    // connection must be retried within the hour, as it was through Chromium.
    it('throws a connection error', async () => {
      const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const net = fakeNet({ 'https://brand.example/': { error: reset } }, { 'brand.example': [PUBLIC] });
      await expect(net.fetchFor()('https://brand.example/')).rejects.toBe(reset);
      expect(net.requests[0].destroyed).toBe(true);
    });

    // Breaks if a DNS failure is mistaken for a refusal and cached for a month.
    it('throws a DNS failure', async () => {
      const net = fakeNet({}, {});
      await expect(net.fetchFor()('https://gone.example/')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    // Breaks if a server that accepts the connection and never answers holds
    // a lookup slot indefinitely. The request is torn down when time is up.
    it('times out a request that never answers, and tears it down', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const net = fakeNet({ 'https://slow.example/': { hang: true } }, { 'slow.example': [PUBLIC] });
      const pending = expect(net.fetchFor({ timeoutMs: 100 })('https://slow.example/')).rejects.toThrow(/Timed out fetching https:\/\/slow.example\//);
      await vi.advanceTimersByTimeAsync(150);
      await pending;
      expect(net.requests[0].destroyed).toBe(true);
    });

    // Breaks if a chain of slow redirects gets a fresh budget at every hop.
    // The answer deadline covers the whole chain.
    it('gives the whole redirect chain one answer deadline', async () => {
      // setImmediate too: the fake resolver answers on it, and each hop's
      // lookup must run on the fake clock for the hops to add up.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
      const routes: Record<string, Route> = {
        'https://slow.example/': { status: 302, headers: { location: '/next' }, delayMs: 60 },
        'https://slow.example/next': { body: 'late', delayMs: 60 },
      };
      const dns = { 'slow.example': [PUBLIC] };
      // Each hop answers within 100 ms; the chain takes 120.
      const pending = expect(fakeNet(routes, dns).fetchFor({ timeoutMs: 100 })('https://slow.example/')).rejects.toThrow(/Timed out fetching/);
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      // Control: the same chain completes when the deadline covers both hops.
      const ok = fakeNet(routes, dns).fetchFor({ timeoutMs: 150 })('https://slow.example/');
      await vi.advanceTimersByTimeAsync(200);
      await expect(ok).resolves.toMatchObject({ ok: true, url: 'https://slow.example/next' });
    });

    // Breaks if a server that sends headers and then stalls the body holds
    // the slot forever.
    it('times out a body that never arrives, and tears it down', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const net = fakeNet({ 'https://slow.example/': { hangBody: true } }, { 'slow.example': [PUBLIC] });
      const pending = expect(net.fetchFor({ timeoutMs: 100 })('https://slow.example/')).rejects.toThrow(/Timed out reading https:\/\/slow.example\//);
      await vi.advanceTimersByTimeAsync(150);
      await pending;
      expect(net.requests[0].destroyed).toBe(true);
    });
  });

  describe('through the brand readers (mailguard)', () => {
    const query = (records: Record<string, string[]>) => async (name: string): Promise<string[]> => records[name] ?? [];

    // Breaks if the body cap changes what the favicon reader sees. A homepage
    // longer than 256 KB must still be scanned for the icons in its <head>,
    // as it was when the whole body was read.
    it('still finds the icon declared by a homepage longer than the cap', async () => {
      const page = `<html><head><link rel="icon" href="/i.png"></head><body>${'x'.repeat(MAX_BODY_BYTES * 2)}</body></html>`;
      const net = fakeNet(
        {
          'https://brand.example/': { headers: { 'content-type': 'text/html' }, body: page },
          'https://brand.example/i.png': { body: PNG },
        },
        { 'brand.example': [PUBLIC] },
      );
      const result = await discoverFavicon('brand.example', { fetch: net.fetchFor({ site: 'brand.example' }) });
      expect(result).toMatchObject({ status: 'found', source: 'declared' });
    });

    // Breaks if an icon declared on another site is fetched. It is skipped
    // and discovery falls back to the site's own /favicon.ico.
    it('skips an off-site declared icon and falls back to /favicon.ico', async () => {
      const net = fakeNet(
        {
          'https://brand.example/': { headers: { 'content-type': 'text/html' }, body: '<link rel="icon" href="https://cdn.other.example/i.png">' },
          'https://cdn.other.example/i.png': { body: PNG },
          'https://brand.example/favicon.ico': { body: PNG },
        },
        { 'brand.example': [PUBLIC], 'cdn.other.example': [PUBLIC_B] },
      );
      const result = await discoverFavicon('brand.example', { fetch: net.fetchFor({ site: 'brand.example' }) });
      expect(result).toMatchObject({ status: 'found', source: 'root' });
      expect(net.lookedUp).not.toContain('cdn.other.example');
    });

    // Breaks if a homepage pointing its icon at the LAN gets that icon
    // fetched. The http link is refused too: extractIconLinks accepts http.
    it('never fetches a declared icon on a private address or over http', async () => {
      const net = fakeNet(
        {
          'https://brand.example/': {
            headers: { 'content-type': 'text/html' },
            body: '<link rel="icon" sizes="512x512" href="https://192.168.1.1/i.png"><link rel="icon" sizes="256x256" href="http://brand.example/i.png"><link rel="icon" sizes="128x128" href="https://lan.brand.example/i.png">',
          },
        },
        { 'brand.example': [PUBLIC], 'www.brand.example': [PUBLIC], 'lan.brand.example': ['192.168.1.1'] },
      );
      const result = await discoverFavicon('brand.example', { fetch: net.fetchFor({ site: 'brand.example' }) });
      // The LAN name's refusal counts as a network failure: retried, never fetched.
      expect(result.status).toBe('error');
      // Only the sender's own public hosts ever answered; the LAN name was
      // looked up and refused, and the literal and the http link were never sent.
      expect(net.answered).toEqual([
        'https://brand.example/', 'https://brand.example/favicon.ico',
        'https://www.brand.example/', 'https://www.brand.example/favicon.ico',
      ]);
      expect(net.lookedUp).toContain('lan.brand.example');
      expect(net.sent.map((o) => o.hostname)).not.toContain('192.168.1.1');
    });

    // Adversarial review: a mail domain often redirects to its brand's site,
    // whose icon sits on a CDN (facebookmail.com → www.facebook.com, icon on
    // static.xx.fbcdn.net). Breaks if favicons are held to the sender's own
    // site again: such senders show initials for a month.
    it('finds an icon across a redirect to the brand and on its CDN, through the fetch the app uses', async () => {
      const net = fakeNet(
        {
          'https://brandmail.example/': { status: 301, headers: { location: 'https://www.brand.example/help' } },
          'https://www.brand.example/help': {
            headers: { 'content-type': 'text/html' },
            body: '<link rel="icon" href="https://static.cdn.example/brand.png">',
          },
          'https://static.cdn.example/brand.png': { headers: { 'content-type': 'image/png' }, body: PNG },
        },
        { 'brandmail.example': [PUBLIC], 'www.brand.example': [PUBLIC], 'static.cdn.example': [PUBLIC_B] },
      );
      const result = await discoverFavicon('brandmail.example', { fetch: net.fetchFor() });
      expect(result.status).toBe('found');
    });

    // THE caching property (adversarial review). A captive portal answers
    // every name with a private address until the reader signs in. Breaks if
    // that is recorded as "none" (no favicon for a month for every sender
    // refreshed meanwhile) instead of "error" (retried in an hour). A hostile
    // name costs one refused DNS answer an hour and is never connected to.
    it('records a domain that only resolves to private addresses as error, retried soon, never fetched', async () => {
      const net = fakeNet({}, { 'brand.example': ['10.0.0.1'], 'www.brand.example': ['10.0.0.1'] });
      const result = await discoverFavicon('brand.example', { fetch: net.fetchFor({ site: 'brand.example' }) });
      expect(result.status).toBe('error');
      expect(net.bodies).toHaveLength(0);
    });

    // Breaks if an unreachable domain stops being retried soon. A DNS failure
    // is still "error", as before.
    it('still records an unreachable domain as error', async () => {
      const net = fakeNet({}, {});
      expect((await discoverFavicon('brand.example', { fetch: net.fetchFor({ site: 'brand.example' }) })).status).toBe('error');
    });

    // Breaks if BIMI is held to the favicon site rule. A logo on a CDN is
    // normal, and must still load from any public https host.
    it('loads a BIMI logo from a public host on another site', async () => {
      const net = fakeNet(
        { 'https://cdn.logos.example/brand.svg': { headers: { 'content-type': 'image/svg+xml' }, body: SVG } },
        { 'cdn.logos.example': [PUBLIC_B] },
      );
      const result = await lookupBimi('brand.example', {
        query: query({ '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': ['v=BIMI1; l=https://cdn.logos.example/brand.svg'] }),
        fetch: net.fetchFor(),
      });
      expect(result.status).toBe('logo');
    });

    // Breaks if a BIMI record can aim the logo fetch into the LAN, or if the
    // refusal is recorded as "error" (retried hourly) instead of an ordinary
    // "invalid" answer.
    it('refuses a BIMI logo on a private address as invalid, not error', async () => {
      const net = fakeNet({ 'https://127.0.0.1/logo.svg': { body: SVG } }, {});
      const result = await lookupBimi('brand.example', {
        query: query({ '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': ['v=BIMI1; l=https://127.0.0.1/logo.svg'] }),
        fetch: net.fetchFor(),
      });
      expect(result.status).toBe('invalid');
      expect(net.sent).toHaveLength(0);
    });
  });
});

describe('on real sockets: a refusal happens before any connection', () => {
  let server: Server | null = null;
  let connections = 0;

  const listen = () => new Promise<number>((resolve) => {
    connections = 0;
    server = createServer((socket) => { connections += 1; socket.destroy(); });
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });
  /** The real `https.request`, aimed at the local server's port (the URL rule only allows 443). */
  const toPort = (port: number): HttpsRequest => (options) => realHttpsRequest({ ...options, port });

  // The control. Breaks (this test, not the product) if the server does not
  // count connections, which would let the refusal tests below pass vacuously.
  it('counts a connection when nothing refuses it', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => {
      const req = realHttpsRequest({ hostname: '127.0.0.1', port, path: '/', agent: false });
      req.on('error', () => resolve());
      req.end();
    });
    expect(connections).toBe(1);
  });

  // Breaks if `localhost`, resolved by the REAL system resolver, is connected
  // to. The guarded lookup must refuse before the TCP handshake.
  it('refuses localhost through the system resolver, with no connection made', async () => {
    const port = await listen();
    await expect(senderIdentityFetch({ timeoutMs: 5_000, request: toPort(port) })('https://localhost/')).rejects.toBeInstanceOf(RefusedDestinationError);
    expect(connections).toBe(0);
  });

  // Breaks if a public-looking name whose DNS answer is 127.0.0.1 (DNS
  // rebinding) is connected to.
  it('refuses a name that resolves to 127.0.0.1, with no connection made', async () => {
    const port = await listen();
    const resolve: Resolver = (_host, _options, callback) => setImmediate(() => callback(null, [{ address: '127.0.0.1', family: 4 }]));
    await expect(senderIdentityFetch({ timeoutMs: 5_000, resolve, request: toPort(port) })('https://brand.example/')).rejects.toBeInstanceOf(RefusedDestinationError);
    expect(connections).toBe(0);
  });
});
