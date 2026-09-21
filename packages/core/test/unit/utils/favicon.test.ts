import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../../../src/utils/bimi';
import {
  FAVICON_MAX_BYTES,
  HOMEPAGE_MAX_BYTES,
  discoverFavicon,
  extractIconLinks,
  faviconHosts,
  rankIconCandidates,
  sniffImageType,
} from '../../../src/utils/favicon';

/**
 * Domain favicons as the fallback sender avatar — as Inbox sees them, now that
 * discovery, ranking and byte-sniffing are `@sarv-in/email-spam-scan/brand`.
 *
 * The behaviour coverage moved with the code: the library's 372-line
 * `brand-favicon` suite pins the whole `<link>` grammar, the redirect base,
 * every sniffable image type and each failure path. What is pinned HERE is the
 * seam and the two properties the domain-identity store depends on, either of
 * which could rot in a library upgrade without a type error:
 *
 *   1. an avatar is trusted at a glance, so a 200 that is really an HTML error
 *      page must never become one — bytes decide, never Content-Type; and
 *   2. "none" (nothing published — cacheable) and "error" (unreachable — must
 *      be retried) stay different answers.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const HTML_404 = '<!doctype html><html><body>Not found</body></html>';

type Route = { status?: number; body?: Buffer | string; type?: string; length?: number; throws?: boolean };
const fakeFetch = (routes: Record<string, Route>, calls: string[] = []): FetchLike => async (url) => {
  calls.push(url);
  const route = routes[url];
  if (!route) return { ok: false, status: 404, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  if (route.throws) throw new Error('ECONNRESET');
  const body = typeof route.body === 'string' ? Buffer.from(route.body) : (route.body ?? Buffer.alloc(0));
  const status = route.status ?? 200;
  return {
    ok: status < 400, status, url,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (route.type ?? null) : n.toLowerCase() === 'content-length' ? String(route.length ?? body.length) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
};

describe('the favicon seam', () => {
  it('re-exports what the identity service and its store call', () => {
    for (const fn of [extractIconLinks, rankIconCandidates, sniffImageType, faviconHosts, discoverFavicon]) {
      expect(typeof fn).toBe('function');
    }
    expect(FAVICON_MAX_BYTES).toBe(64 * 1024);
    expect(HOMEPAGE_MAX_BYTES).toBeGreaterThan(FAVICON_MAX_BYTES);
  });

  // The order the store walks: the sending domain, its www, then the
  // organisational domain — so mail from a subdomain that has no website of
  // its own still gets the company's icon rather than none.
  it('lists the hosts to try, organisational domain last and deduplicated', () => {
    expect(faviconHosts('mailer.shop.example')).toEqual([
      'mailer.shop.example', 'www.mailer.shop.example', 'shop.example', 'www.shop.example',
    ]);
    expect(faviconHosts('www.shop.example')).toEqual(['www.shop.example', 'shop.example']);
  });
});

describe('discoverFavicon through the seam', () => {
  it('takes the best declared icon, and stops at the first one that is really an image', async () => {
    const calls: string[] = [];
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><link rel="icon" href="/i16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png"></head>', type: 'text/html; charset=utf-8' },
      'https://shop.example/touch.png': { body: PNG, type: 'image/png' },
      'https://shop.example/i16.png': { body: PNG, type: 'image/png' },
    }, calls) });
    expect(r).toMatchObject({ status: 'found', source: 'declared' });
    expect(r.dataUri).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(calls).toEqual(['https://shop.example/', 'https://shop.example/touch.png']);
  });

  // THE trap: a server that answers every unknown path with a 200 HTML page.
  // Trusting the status or the declared type would put that page in the avatar.
  it('refuses a 200 that is not an image and trusts bytes over Content-Type', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/favicon.ico': { body: HTML_404, type: 'image/x-icon' },
      'https://www.shop.example/favicon.ico': { body: PNG, type: 'text/plain' }, // wrong type, real bytes
    }) });
    expect(r).toMatchObject({ status: 'found', source: 'root', detail: 'www.shop.example/favicon.ico' });
  });

  // Cached for weeks vs retried: a domain that publishes no icon is settled,
  // one we could not reach is not, and reading the second as the first leaves
  // a sender permanently blank.
  it('says "none" when nothing is published and "error" when nothing could be reached', async () => {
    expect((await discoverFavicon('shop.example', { fetch: fakeFetch({}) })).status).toBe('none');
    const unreachable = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { throws: true }, 'https://shop.example/favicon.ico': { throws: true },
      'https://www.shop.example/': { throws: true }, 'https://www.shop.example/favicon.ico': { throws: true },
    }) });
    expect(unreachable.status).toBe('error');
  });

  it('skips an icon too large to cache', async () => {
    const r = await discoverFavicon('www.shop.example', { fetch: fakeFetch({
      'https://www.shop.example/': { body: '<head><link rel="icon" href="/big.png"></head>', type: 'text/html' },
      'https://www.shop.example/big.png': { body: PNG, type: 'image/png', length: FAVICON_MAX_BYTES + 1 },
    }) });
    expect(r.status).toBe('none');
  });
});
