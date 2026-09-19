/**
 * A sender domain's favicon — the fallback avatar when a sender has no photo
 * and the domain publishes no BIMI logo.
 *
 * Fetched ONCE per domain by the main process and cached as a `data:` URI;
 * the renderer never talks to the domain. Fetching a favicon tells the domain
 * that some client at this address looked it up, once — far less than the
 * per-message tracking pixel that remote images are, but not nothing, which is
 * why it sits behind a setting. Same injected-fetch shape as the BIMI lookup.
 *
 * Discovery order mirrors what browsers do: the icons the homepage declares
 * (`<link rel="icon">`, `apple-touch-icon`, …), best first, then `/favicon.ico`.
 */
import { Parser } from 'htmlparser2';

import type { FetchLike } from './bimi';
import { registrableDomain } from './sender-spoof';

export const FAVICON_MAX_BYTES = 64 * 1024;
export const HOMEPAGE_MAX_BYTES = 256 * 1024;
/** Declared icons tried before falling back to /favicon.ico. */
const MAX_DECLARED_ICONS = 3;

export interface IconCandidate {
  /** Absolute URL. */
  href: string;
  rel: string;
  sizes: string | null;
  type: string | null;
}

/**
 * The icons a page declares in its <head>, resolved to absolute URLs (honouring
 * <base href>). Parsed with a real HTML parser: attribute order, quoting and
 * case all vary in the wild, and a regex over `<link …>` gets every one of them
 * wrong somewhere.
 */
export function extractIconLinks(html: string, pageUrl: string): IconCandidate[] {
  const out: IconCandidate[] = [];
  let base = pageUrl;
  let inHead = true;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (!inHead) return;
        const tag = name.toLowerCase();
        if (tag === 'body') { inHead = false; return; }
        if (tag === 'base' && attribs.href) {
          try { base = new URL(attribs.href, pageUrl).toString(); } catch { /* keep the page URL */ }
          return;
        }
        if (tag !== 'link') return;
        const rel = (attribs.rel || '').toLowerCase().trim();
        const rels = rel.split(/\s+/);
        if (!rels.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) return;
        if (!attribs.href) return;
        let href: string;
        try {
          const u = new URL(attribs.href, base);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
          href = u.toString();
        } catch {
          return;
        }
        out.push({ href, rel, sizes: attribs.sizes?.toLowerCase().trim() || null, type: attribs.type?.toLowerCase().trim() || null });
      },
      onclosetag(name) {
        if (name.toLowerCase() === 'head') inHead = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return out;
}

/** The largest declared pixel size, or 0 when unknown (`any` counts as scalable = large). */
function sizeRank(c: IconCandidate): number {
  if (c.type === 'image/svg+xml') return 10_000;
  if (!c.sizes) return c.rel.includes('apple-touch-icon') ? 180 : 0;
  if (c.sizes === 'any') return 9_999;
  let best = 0;
  for (const s of c.sizes.split(/\s+/)) {
    const n = Number.parseInt(s.split('x')[0], 10);
    if (Number.isFinite(n)) best = Math.max(best, n);
  }
  return best;
}

/**
 * Best first: a scalable SVG, then the largest raster, with apple-touch-icons
 * (180px by convention) ahead of an unsized `rel=icon` (typically 16px). An
 * avatar is drawn at 40-48px, so "largest" is the right default.
 */
export function rankIconCandidates(candidates: IconCandidate[]): IconCandidate[] {
  return [...candidates].sort((a, b) => sizeRank(b) - sizeRank(a));
}

const IMAGE_MAGIC: Array<{ ct: string; test: (b: Buffer) => boolean }> = [
  { ct: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ct: 'image/x-icon', test: (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
  { ct: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ct: 'image/gif', test: (b) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { ct: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ct: 'image/svg+xml', test: (b) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(b.subarray(0, 512).toString('utf8')) },
];

/**
 * The image type the BYTES say they are. A server that answers a missing
 * favicon with a 200 and an HTML page (common) must not become an avatar,
 * and a wrong or missing Content-Type must not lose a real icon.
 */
export function sniffImageType(bytes: Buffer): string | null {
  return IMAGE_MAGIC.find((m) => m.test(bytes))?.ct ?? null;
}

export type FaviconStatus = 'found' | 'none' | 'error';

export interface FaviconResult {
  status: FaviconStatus;
  /** `data:<type>;base64,…` when found. */
  dataUri: string | null;
  /** Where it came from. */
  source: 'declared' | 'root' | null;
  detail: string;
}

async function fetchImage(fetch: FetchLike, url: string): Promise<{ dataUri: string } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > FAVICON_MAX_BYTES) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > FAVICON_MAX_BYTES) return null;
  const type = sniffImageType(bytes);
  if (!type) return null;
  return { dataUri: `data:${type};base64,${bytes.toString('base64')}` };
}

/**
 * The hosts worth asking for a domain's favicon, in order: the domain itself,
 * its `www.`, then — because mail so often comes from `notify.`, `email.`,
 * `mailer.` subdomains that serve no website — the organisational domain and
 * its `www.`. Deduplicated, so `www.example.com` is asked once.
 */
export function faviconHosts(domain: string): string[] {
  const d = domain.trim().toLowerCase();
  if (!d) return [];
  const org = registrableDomain(d);
  const candidates = [d, `www.${d}`];
  if (org && org !== d) candidates.push(org, `www.${org}`);
  const out: string[] = [];
  for (const h of candidates) {
    const host = h.startsWith('www.www.') ? h.slice(4) : h;
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * Find a domain's favicon. On each host from {@link faviconHosts}: the
 * homepage's declared icons (best first, a few at most), then `/favicon.ico`.
 * At most a handful of requests per domain, ever — the result is cached.
 */
export async function discoverFavicon(domain: string, deps: { fetch: FetchLike }): Promise<FaviconResult> {
  const d = domain.trim().toLowerCase();
  if (!d) return { status: 'none', dataUri: null, source: null, detail: 'No domain' };
  const hosts = faviconHosts(d);
  let sawNetworkError = false;

  for (const host of hosts) {
    const pageUrl = `https://${host}/`;
    // 1. Declared icons.
    try {
      const res = await deps.fetch(pageUrl);
      if (res.ok && (res.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
        const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
        if (!(Number.isFinite(declared) && declared > HOMEPAGE_MAX_BYTES)) {
          const html = Buffer.from(await res.arrayBuffer()).subarray(0, HOMEPAGE_MAX_BYTES).toString('utf8');
          const candidates = rankIconCandidates(extractIconLinks(html, res.url || pageUrl)).slice(0, MAX_DECLARED_ICONS);
          for (const c of candidates) {
            try {
              const img = await fetchImage(deps.fetch, c.href);
              if (img) return { status: 'found', dataUri: img.dataUri, source: 'declared', detail: `Declared by ${host} (${c.rel})` };
            } catch {
              sawNetworkError = true;
            }
          }
        }
      }
    } catch {
      sawNetworkError = true;
    }
    // 2. The conventional location.
    try {
      const img = await fetchImage(deps.fetch, `${pageUrl}favicon.ico`);
      if (img) return { status: 'found', dataUri: img.dataUri, source: 'root', detail: `${host}/favicon.ico` };
    } catch {
      sawNetworkError = true;
    }
  }
  return sawNetworkError
    ? { status: 'error', dataUri: null, source: null, detail: 'The domain could not be reached' }
    : { status: 'none', dataUri: null, source: null, detail: 'The domain publishes no favicon' };
}
