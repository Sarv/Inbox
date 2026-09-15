import { describe, expect, it } from 'vitest';

import { selfRefererFor, unwrapProxiedImageUrl } from '../../../src/utils/remote-image-requests';

// The reported bug: an avatar in a Bitbucket notification rendered broken here
// and fine in Gmail. Measured cause — the image host answers a request carrying
// NO `Referer` with 429, permanently and regardless of rate, while the same URL
// with any referer at all returns 200. We send no referer twice over:
// `referrerpolicy="no-referrer"` on every email image, and a packaged build that
// loads from file:// (which sends none whatever the attribute says). These pin
// the two repairs.

const PROXIED =
  'https://i0.wp.com/avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/RG-1.png?ssl=1';
const DIRECT =
  'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/initials/RG-1.png';

describe('unwrapProxiedImageUrl', () => {
  // Breaks: every image the sender routed through the proxy keeps telling that
  // third party which message the reader has open — and keeps depending on a
  // hop we've measured answering 429.
  it('unwraps the reported URL to the origin it names', () => {
    expect(unwrapProxiedImageUrl(PROXIED)).toBe(DIRECT);
  });

  // Breaks: only one of Photon's four edge hosts is repaired, so the same image
  // works or doesn't depending on which edge the sender's HTML happened to name.
  it.each(['i0', 'i1', 'i2', 'i3'])('handles the %s edge host', (host) => {
    expect(unwrapProxiedImageUrl(PROXIED.replace('i0', host))).toBe(DIRECT);
  });

  // Breaks: a resized image comes back at its proxy dimensions, or — worse — a
  // parameter the ORIGIN needed is dropped and the request 404s. Photon's own
  // parameters go; everything else belongs to the wrapped URL and stays.
  it('drops the proxy\'s parameters and keeps the origin\'s', () => {
    const url = unwrapProxiedImageUrl(
      'https://i0.wp.com/cdn.example.com/pic.jpg?ssl=1&w=64&h=64&quality=80&token=abc&v=2',
    );
    expect(url).toBe('https://cdn.example.com/pic.jpg?token=abc&v=2');
  });

  // Breaks: an https image request is quietly downgraded to http to save a hop.
  // No `ssl=1` means the wrapped origin is plain http — not a trade worth making.
  it('refuses to unwrap when the origin is not https', () => {
    expect(unwrapProxiedImageUrl('https://i0.wp.com/cdn.example.com/pic.jpg')).toBeNull();
    expect(unwrapProxiedImageUrl('https://i0.wp.com/cdn.example.com/pic.jpg?ssl=0')).toBeNull();
  });

  // Breaks: the rewrite becomes a redirector. Each of these is a path that LOOKS
  // like it names one host while resolving to another — the whole reason the
  // host is validated rather than trusted.
  it.each([
    ['credentials in the host', 'https://i0.wp.com/evil.example.com@real.example.com/p.png?ssl=1'],
    ['a port in the host', 'https://i0.wp.com/real.example.com:8080/p.png?ssl=1'],
    ['a dotless host', 'https://i0.wp.com/localhost/p.png?ssl=1'],
    ['no path after the host', 'https://i0.wp.com/real.example.com?ssl=1'],
    ['no host at all', 'https://i0.wp.com/?ssl=1'],
    ['an encoded separator', 'https://i0.wp.com/real.example.com%2F..%2Fevil/p.png?ssl=1'],
  ])('refuses %s', (_name, url) => {
    expect(unwrapProxiedImageUrl(url)).toBeNull();
  });

  // Breaks: ordinary image URLs get rewritten too — the rule must fire only on
  // the proxy it understands, and never on a lookalike hostname.
  it.each([
    DIRECT,
    'https://i0.wp.com.evil.example/real.example.com/p.png?ssl=1',
    'https://notwp.com/real.example.com/p.png?ssl=1',
    'https://i9.wp.com/real.example.com/p.png?ssl=1',
    'data:image/png;base64,AAA',
    'not a url at all',
    '',
  ])('leaves %s alone', (url) => {
    expect(unwrapProxiedImageUrl(url)).toBeNull();
  });
});

describe('selfRefererFor', () => {
  // Breaks: the refererless request comes back 429 and the image stays broken.
  // The value is the image's OWN origin on purpose: it carries no information
  // the host doesn't already have, so the privacy `no-referrer` was protecting
  // is not spent to get the picture.
  it('answers the image\'s own origin, and nothing about us', () => {
    expect(selfRefererFor(DIRECT)).toBe('https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/');
    expect(selfRefererFor('https://cdn.example.com/a/b/c.png?x=1#frag')).toBe('https://cdn.example.com/');
    // A non-default port is part of the origin — dropping it would name a
    // different server than the one being asked.
    expect(selfRefererFor('http://cdn.example.com:8080/p.png')).toBe('http://cdn.example.com:8080/');
  });

  // Breaks: a header is invented for requests that never touch the network —
  // our own attachment/inline schemes and inline data, none of which have an
  // origin to name.
  it.each([
    'data:image/png;base64,AAA',
    'blob:file:///abc',
    'sarv-attachment://email/file.png',
    'sarv-inline:0123456789abcdef',
    'not a url at all',
    '',
  ])('answers null for %s', (url) => {
    expect(selfRefererFor(url)).toBeNull();
  });
});
