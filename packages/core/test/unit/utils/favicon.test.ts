import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../../../src/utils/bimi';
import {
  FAVICON_MAX_BYTES,
  discoverFavicon,
  extractIconLinks,
  faviconHosts,
  rankIconCandidates,
  sniffImageType,
} from '../../../src/utils/favicon';

/**
 * Domain favicons as the fallback sender avatar.
 *
 * What this protects: an avatar is trusted at a glance. A "favicon" that is
 * really a 200 HTML error page becomes a broken tile on every message from
 * that domain; a favicon fetched per message instead of per domain becomes a
 * tracking pixel we built ourselves. The discovery order and the byte-sniffing
 * are what keep both from happening.
 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const ICO = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), Buffer.alloc(16, 2)]);
const HTML_404 = '<!doctype html><html><body>Not found</body></html>';

type Route = { status?: number; body?: Buffer | string; type?: string; length?: number; throws?: boolean; url?: string };
const fakeFetch = (routes: Record<string, Route>, calls: string[] = []): FetchLike => async (url) => {
  calls.push(url);
  const r = routes[url];
  if (!r) return { ok: false, status: 404, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  if (r.throws) throw new Error('ECONNRESET');
  const body = typeof r.body === 'string' ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
  const status = r.status ?? 200;
  return {
    ok: status < 400, status, url: r.url ?? url,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.type ?? null) : n.toLowerCase() === 'content-length' ? String(r.length ?? body.length) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
};

describe('extractIconLinks', () => {
  it('collects icon links from the head, resolving relative URLs and <base>', () => {
    const html = `<html><head>
      <base href="https://cdn.shop.example/assets/">
      <link rel="icon" href="fav.png" sizes="32x32" type="image/png">
      <LINK REL="Shortcut Icon" HREF="/favicon.ico">
      <link rel="apple-touch-icon" href="https://shop.example/apple.png">
      <link rel="stylesheet" href="style.css">
    </head><body><link rel="icon" href="body-icon.png"></body></html>`;
    const icons = extractIconLinks(html, 'https://shop.example/');
    expect(icons.map((i) => i.href)).toEqual([
      'https://cdn.shop.example/assets/fav.png',
      'https://cdn.shop.example/favicon.ico',
      'https://shop.example/apple.png',
    ]);
    expect(icons[0]).toMatchObject({ sizes: '32x32', type: 'image/png', rel: 'icon' });
  });

  it('ignores non-web schemes and malformed hrefs', () => {
    expect(extractIconLinks('<head><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="javascript:alert(1)"><link rel="icon"></head>', 'https://x.example/')).toEqual([]);
  });
});

describe('rankIconCandidates', () => {
  it('prefers a scalable SVG, then the largest raster, treating apple-touch-icon as 180px', () => {
    const ranked = rankIconCandidates([
      { href: 'a', rel: 'icon', sizes: '16x16', type: null },
      { href: 'b', rel: 'apple-touch-icon', sizes: null, type: null },
      { href: 'c', rel: 'icon', sizes: '32x32 64x64', type: null },
      { href: 'd', rel: 'icon', sizes: null, type: 'image/svg+xml' },
      { href: 'e', rel: 'icon', sizes: 'any', type: null },
    ]);
    expect(ranked.map((c) => c.href)).toEqual(['d', 'e', 'b', 'c', 'a']);
  });
});

describe('sniffImageType', () => {
  it('recognises PNG, ICO and SVG bytes and refuses HTML', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(ICO)).toBe('image/x-icon');
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml');
    expect(sniffImageType(Buffer.from(HTML_404))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('discoverFavicon', () => {
  it('uses the best icon the homepage declares', async () => {
    const calls: string[] = [];
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><link rel="icon" href="/i16.png" sizes="16x16"><link rel="apple-touch-icon" href="/touch.png"></head>', type: 'text/html; charset=utf-8' },
      'https://shop.example/touch.png': { body: PNG, type: 'image/png' },
      'https://shop.example/i16.png': { body: PNG, type: 'image/png' },
    }, calls) });
    expect(r).toMatchObject({ status: 'found', source: 'declared' });
    expect(r.dataUri).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    // Best first, and it stopped there — one icon fetch, not all of them.
    expect(calls).toEqual(['https://shop.example/', 'https://shop.example/touch.png']);
  });

  it('falls back to /favicon.ico when the page declares nothing usable', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><title>x</title></head>', type: 'text/html' },
      'https://shop.example/favicon.ico': { body: ICO, type: 'image/vnd.microsoft.icon' },
    }) });
    expect(r).toMatchObject({ status: 'found', source: 'root' });
    expect(r.dataUri).toContain('data:image/x-icon;base64,');
  });

  // THE trap: a server that answers every unknown path with a 200 HTML page.
  // Trusting Content-Type or the status would put that page in the avatar.
  it('refuses a 200 that is not an image, then tries www.', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/favicon.ico': { body: HTML_404, type: 'image/x-icon' },
      'https://www.shop.example/favicon.ico': { body: PNG, type: 'text/plain' }, // wrong type, real bytes
    }) });
    expect(r).toMatchObject({ status: 'found', source: 'root', detail: 'www.shop.example/favicon.ico' });
  });

  it('skips an icon too large to cache and does not retry www. for a www. domain', async () => {
    const calls: string[] = [];
    const r = await discoverFavicon('www.shop.example', { fetch: fakeFetch({
      'https://www.shop.example/': { body: '<head><link rel="icon" href="/big.png"></head>', type: 'text/html' },
      'https://www.shop.example/big.png': { body: PNG, type: 'image/png', length: FAVICON_MAX_BYTES + 1 },
    }, calls) });
    expect(r.status).toBe('none');
    expect(calls.filter((u) => u.startsWith('https://www.www.'))).toEqual([]);
  });

  it('is "none" when nothing exists and "error" when the domain cannot be reached', async () => {
    expect((await discoverFavicon('shop.example', { fetch: fakeFetch({}) })).status).toBe('none');
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { throws: true }, 'https://shop.example/favicon.ico': { throws: true },
      'https://www.shop.example/': { throws: true }, 'https://www.shop.example/favicon.ico': { throws: true },
    }) });
    expect(r.status).toBe('error');
    expect((await discoverFavicon('  ', { fetch: fakeFetch({}) })).status).toBe('none');
  });

  it('resolves declared icons against the final URL after a redirect', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><link rel="icon" href="icon.png"></head>', type: 'text/html', url: 'https://www.shop.example/home/' },
      'https://www.shop.example/home/icon.png': { body: PNG, type: 'image/png' },
    }) });
    expect(r.status).toBe('found');
  });
});

describe('edges', () => {
  it('keeps the page URL when <base href> is malformed, and ignores links after <body>', () => {
    const icons = extractIconLinks('<head><base href="http://["><link rel="icon" href="/i.png"></head><body><link rel="icon" href="/late.png"></body>', 'https://x.example/');
    expect(icons.map((i) => i.href)).toEqual(['https://x.example/i.png']);
  });

  it('ranks an unsized plain icon and unparseable sizes lowest', () => {
    const ranked = rankIconCandidates([
      { href: 'a', rel: 'icon', sizes: null, type: null },
      { href: 'b', rel: 'icon', sizes: 'foo', type: null },
      { href: 'c', rel: 'icon', sizes: '48x48', type: null },
    ]);
    expect(ranked[0].href).toBe('c');
  });

  it('sniffs JPEG, GIF and WebP too', () => {
    expect(sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8)]))).toBe('image/jpeg');
    expect(sniffImageType(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)]))).toBe('image/gif');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))).toBe('image/webp');
  });

  it('skips a homepage that is not HTML or is declared too large, and an icon with an empty body', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: 'not html', type: 'application/json' },
      'https://shop.example/favicon.ico': { body: '' },
      'https://www.shop.example/': { body: '<head><link rel="icon" href="/i.png"></head>', type: 'text/html', length: 10_000_000 },
      'https://www.shop.example/favicon.ico': { body: ICO, type: 'image/x-icon' },
    }) });
    expect(r).toMatchObject({ status: 'found', source: 'root', detail: 'www.shop.example/favicon.ico' });
  });

  it('records a declared icon that cannot be fetched and still reaches the root icon', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><link rel="icon" href="/i.png"></head>', type: 'text/html' },
      'https://shop.example/i.png': { throws: true },
      'https://shop.example/favicon.ico': { body: PNG, type: 'image/png' },
    }) });
    expect(r).toMatchObject({ status: 'found', source: 'root' });
    // ...and when the root is missing too, the thrown fetch makes it an error, not "none".
    const r2 = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><link rel="icon" href="/i.png"></head>', type: 'text/html' },
      'https://shop.example/i.png': { throws: true },
    }) });
    expect(r2.status).toBe('error');
  });

  it('treats a homepage response without a content type as undeclared', async () => {
    const r = await discoverFavicon('shop.example', { fetch: fakeFetch({
      'https://shop.example/': { body: '<head><link rel="icon" href="/i.png"></head>' },
      'https://shop.example/i.png': { body: PNG, type: 'image/png' },
    }) });
    expect(r.status).toBe('none');
  });
});

describe('organisational-domain fallback', () => {
  // Mail comes from notify. / email. / mailer. subdomains that serve no site;
  // the brand's icon lives on the organisational domain.
  it('lists the domain, its www, then the organisational domain and its www — deduplicated', () => {
    expect(faviconHosts('notify.cloudflare.example')).toEqual(['notify.cloudflare.example', 'www.notify.cloudflare.example', 'cloudflare.example', 'www.cloudflare.example']);
    expect(faviconHosts('shop.example')).toEqual(['shop.example', 'www.shop.example']);
    expect(faviconHosts('www.shop.example')).toEqual(['www.shop.example', 'shop.example']);
    expect(faviconHosts('')).toEqual([]);
  });

  it('finds the organisational domain’s icon when the sending subdomain has no website', async () => {
    const r = await discoverFavicon('notify.cloudflare.example', { fetch: fakeFetch({
      'https://notify.cloudflare.example/': { throws: true },
      'https://notify.cloudflare.example/favicon.ico': { throws: true },
      'https://www.notify.cloudflare.example/': { throws: true },
      'https://www.notify.cloudflare.example/favicon.ico': { throws: true },
      'https://cloudflare.example/': { body: '<head><link rel="icon" href="/brand.png"></head>', type: 'text/html' },
      'https://cloudflare.example/brand.png': { body: PNG, type: 'image/png' },
    }) });
    expect(r).toMatchObject({ status: 'found', source: 'declared', detail: expect.stringContaining('cloudflare.example') });
  });
});
