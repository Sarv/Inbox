import { describe, expect, it } from 'vitest';

import { checkPublicHttpsUrl, isPublicAddress } from '../../../src/utils/public-destination';

/**
 * The rules a stranger-named fetch is held to (sender identity: BIMI logos and
 * certificates, favicons). CASA audit L-6.
 *
 * What this protects: a URL that arrives with mail must not reach anything on
 * the reader's own machine or network. That means a printer's admin page on
 * 127.0.0.1:631, the router, or the cloud metadata service at
 * 169.254.169.254. The transport enforces these rules at connect time, and
 * every one of them is defined here. A range dropped from the deny side is a
 * silent SSRF. A public range added to it is a logo that silently never loads.
 */

// Genuinely public addresses. ipaddr.js classes the RFC 5737 documentation
// ranges (203.0.113/24 etc.) as RESERVED, so they are not public fixtures.
const PUBLIC4 = '209.85.220.41';
const PUBLIC6 = '2a00:1450:4864:20::32a';

describe('isPublicAddress', () => {
  // Breaks if a sender can make the client reach the open internet only. This
  // is the positive control: without it, a function that refuses everything
  // would pass the deny tests below.
  it('accepts public IPv4 and IPv6 addresses', () => {
    expect(isPublicAddress(PUBLIC4)).toBe(true);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress(PUBLIC6)).toBe(true);
    expect(isPublicAddress(`[${PUBLIC6}]`)).toBe(true);
  });

  // Breaks if any local, private or special-purpose IPv4 range becomes
  // reachable by naming it in a homepage or a BIMI record.
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback, elsewhere in 127/8', '127.10.20.30'],
    ['RFC 1918 10/8', '10.0.0.5'],
    ['RFC 1918 172.16/12', '172.16.4.4'],
    ['RFC 1918 192.168/16', '192.168.1.1'],
    ['link-local, including the cloud metadata service', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['unspecified', '0.0.0.0'],
    ['broadcast', '255.255.255.255'],
    ['multicast', '224.0.0.251'],
    ['documentation range', '203.0.113.7'],
  ])('refuses IPv4 %s (%s)', (_label, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  // Breaks if the IPv6 spellings of a local destination slip through, the
  // IPv4-mapped forms of 127.0.0.1 and 10/8 included.
  it.each([
    ['loopback', '::1'],
    ['loopback in brackets', '[::1]'],
    ['unspecified', '::'],
    ['link-local', 'fe80::1'],
    ['unique-local', 'fd00::1'],
    ['multicast', 'ff02::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped loopback, hex form', '::ffff:7f00:1'],
    ['IPv4-mapped RFC 1918', '::ffff:10.0.0.5'],
    ['6to4 wrapping loopback', '2002:7f00:1::1'],
  ])('refuses IPv6 %s (%s)', (_label, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  // Breaks if the IPv4-mapped form of a PUBLIC address is refused. It is the
  // same destination as the IPv4 address it carries.
  it('judges an IPv4-mapped address by the IPv4 address inside it', () => {
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  // Breaks one of two ways. If NAT64 is refused wholesale, every IPv4-only
  // brand shows no logo on an IPv6-only network with DNS64. If it is accepted
  // wholesale, 64:ff9b::7f00:1 reaches the NAT64 gateway's view of 127.0.0.1.
  it('accepts a well-known-prefix NAT64 address only when its embedded IPv4 is public', () => {
    expect(isPublicAddress('64:ff9b::808:808')).toBe(true); // 8.8.8.8
    expect(isPublicAddress('64:ff9b::8.8.8.8')).toBe(true);
    expect(isPublicAddress('64:ff9b::7f00:1')).toBe(false); // 127.0.0.1
    expect(isPublicAddress('64:ff9b::a00:5')).toBe(false); // 10.0.0.5
    expect(isPublicAddress('64:ff9b::a9fe:a9fe')).toBe(false); // 169.254.169.254
  });

  // Breaks if the RFC 8215 local-use prefix is treated like the well-known
  // one. Where it carries the IPv4 address depends on the local network's
  // configuration, so its embedded "public" IPv4 cannot be trusted.
  it('refuses the RFC 8215 local-use NAT64 prefix', () => {
    expect(isPublicAddress('64:ff9b:1::808:808')).toBe(false);
  });

  // Breaks if a host NAME, or nothing at all, is taken for a public address.
  // Names are judged by what they resolve to, never by their spelling.
  it('refuses anything that is not an IP address', () => {
    for (const junk of ['localhost', 'brand.example', '', '   ', null, undefined, '999.1.1.1']) {
      expect(isPublicAddress(junk)).toBe(false);
    }
  });
});

describe('checkPublicHttpsUrl', () => {
  // Breaks if an ordinary brand URL is refused. Every favicon and BIMI logo
  // would then disappear.
  it('accepts an https URL on a host name, and says it still needs resolving', () => {
    const check = checkPublicHttpsUrl('https://www.brand.example/favicon.ico?v=2');
    expect(check).toMatchObject({ ok: true, host: 'www.brand.example', ipLiteral: false });
    expect(check.ok && check.url.pathname).toBe('/favicon.ico');
  });

  // Breaks if a plain-http URL (readable and rewritable on the wire) or
  // another scheme is fetched. extractIconLinks accepts http icons, so this
  // check is the only thing that stops them.
  it.each(['http://brand.example/favicon.ico', 'ftp://brand.example/x', 'file:///etc/passwd', 'data:image/png;base64,AAAA'])(
    'refuses %s as not https',
    (url) => {
      expect(checkPublicHttpsUrl(url)).toEqual({ ok: false, reason: 'not-https' });
    },
  );

  // Breaks if a URL that does not parse reaches the transport.
  it('refuses something that is not a URL', () => {
    expect(checkPublicHttpsUrl('not a url')).toEqual({ ok: false, reason: 'invalid-url' });
    expect(checkPublicHttpsUrl('https://')).toEqual({ ok: false, reason: 'invalid-url' });
  });

  // Breaks if a stranger can aim a TLS handshake at an arbitrary port, such as
  // SMTP or SSH, on a public host. Chromium refused these ports; a Node socket
  // does not. An explicit :443 is the default port, so it is still accepted.
  it('accepts only the default https port', () => {
    expect(checkPublicHttpsUrl('https://brand.example:8443/logo.svg')).toEqual({ ok: false, reason: 'non-default-port' });
    expect(checkPublicHttpsUrl('https://brand.example:25/')).toEqual({ ok: false, reason: 'non-default-port' });
    expect(checkPublicHttpsUrl('https://brand.example:443/logo.svg')).toMatchObject({ ok: true });
  });

  // Breaks if an IP-literal URL reaches a private address. Node does not call
  // `lookup` for a literal, so the transport's connect-time check never sees
  // one, and this is the only check that does.
  it.each([
    'https://127.0.0.1/',
    'https://10.0.0.5/icon.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://2130706433/', // 127.0.0.1 as one number
    'https://0x7f.1/', // 127.0.0.1, hex and short form
    'https://127.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[64:ff9b::7f00:1]/',
  ])('refuses the private literal %s', (url) => {
    expect(checkPublicHttpsUrl(url)).toEqual({ ok: false, reason: 'private-address' });
  });

  // Breaks if a public IP-literal URL is refused, or keeps the brackets that
  // Node would then try to resolve as a name.
  it('accepts a public literal and hands back the bare address to connect to', () => {
    expect(checkPublicHttpsUrl(`https://${PUBLIC4}/logo.svg`)).toMatchObject({ ok: true, host: PUBLIC4, ipLiteral: true });
    expect(checkPublicHttpsUrl(`https://[${PUBLIC6}]/logo.svg`)).toMatchObject({ ok: true, host: PUBLIC6, ipLiteral: true });
  });

  describe('with a site rule (favicons: the sender’s own registrable domain)', () => {
    // Breaks if a sender's homepage can send the favicon fetch anywhere it
    // likes: another company's host, a tracker, a host that resolves internally.
    it('accepts the site and its subdomains, and refuses everything else', () => {
      const site = 'mail.brand.co.uk';
      expect(checkPublicHttpsUrl('https://brand.co.uk/', { site })).toMatchObject({ ok: true });
      expect(checkPublicHttpsUrl('https://www.brand.co.uk/favicon.ico', { site })).toMatchObject({ ok: true });
      expect(checkPublicHttpsUrl('https://cdn.static.brand.co.uk/i.png', { site })).toMatchObject({ ok: true });
      expect(checkPublicHttpsUrl('https://other.co.uk/', { site })).toEqual({ ok: false, reason: 'other-site' });
      expect(checkPublicHttpsUrl('https://brand.co.uk.evil.example/', { site })).toEqual({ ok: false, reason: 'other-site' });
      expect(checkPublicHttpsUrl(`https://${PUBLIC4}/`, { site })).toEqual({ ok: false, reason: 'other-site' });
    });

    // Breaks if two different registrants under one public suffix count as
    // one site. On github.io or co.uk, everyone shares the suffix.
    it('compares registrable domains, never public suffixes', () => {
      expect(checkPublicHttpsUrl('https://evil.co.uk/', { site: 'brand.co.uk' })).toEqual({ ok: false, reason: 'other-site' });
    });

    // Breaks if an internationalised sender domain never matches its own
    // links. The URL parser punycodes the host, so the site must be compared
    // in the same form.
    it('matches a Unicode sender domain against its punycoded links', () => {
      expect(checkPublicHttpsUrl('https://www.bücher.de/favicon.ico', { site: 'bücher.de' })).toMatchObject({ ok: true });
      expect(checkPublicHttpsUrl('https://www.xn--bcher-kva.de/favicon.ico', { site: 'BÜCHER.de' })).toMatchObject({ ok: true });
    });

    // Breaks if a site with no registrable domain (a bare public suffix)
    // matches a sibling host, or matches ANY other host that has none either
    // (another suffix, an IP literal). Only the exact host matches it.
    it('requires the exact host when the site has no registrable domain', () => {
      expect(checkPublicHttpsUrl('https://co.uk/', { site: 'co.uk' })).toMatchObject({ ok: true });
      expect(checkPublicHttpsUrl('https://www.co.uk/', { site: 'co.uk' })).toEqual({ ok: false, reason: 'other-site' });
      expect(checkPublicHttpsUrl('https://org.uk/', { site: 'co.uk' })).toEqual({ ok: false, reason: 'other-site' });
      expect(checkPublicHttpsUrl(`https://${PUBLIC4}/`, { site: 'co.uk' })).toEqual({ ok: false, reason: 'other-site' });
    });

    // Breaks if a site value that is not a domain matches anything at all.
    it('refuses everything when the site itself is not a domain', () => {
      expect(checkPublicHttpsUrl('https://brand.example/', { site: 'bad host' })).toEqual({ ok: false, reason: 'other-site' });
    });

    // Breaks if the private-address refusal is skipped when a site rule is set.
    it('still refuses a private literal first', () => {
      expect(checkPublicHttpsUrl('https://10.0.0.5/', { site: 'brand.example' })).toEqual({ ok: false, reason: 'private-address' });
    });
  });
});
