/**
 * Where the app may connect when a STRANGER names the address.
 *
 * Sender identity fetches URLs that arrive with mail: the `<link rel="icon">`
 * on a sender's homepage, and the `l=` / `a=` tags in the sender's BIMI record.
 * Left unchecked, that is a blind GET from inside the reader's network to
 * wherever the sender points: `https://127.0.0.1:<port>/…`, the router at
 * 192.168.1.1, or a cloud metadata address (CASA audit L-6). These are the rules
 * such a fetch is held to. They are pure, so the main-process transport
 * (apps/desktop `sender-identity-fetch.ts`) and its tests share one definition:
 *
 *   - an ADDRESS is acceptable only when the open internet routes to it
 *     ({@link isPublicAddress});
 *   - a URL is acceptable only when it is https on the default port, and when
 *     its host, if it is an IP literal, is itself a public address
 *     ({@link checkPublicHttpsUrl}). A host NAME cannot be judged here: it is
 *     judged by the address it resolves to, where the socket connects, because
 *     a check made ahead of time can be answered differently a moment later
 *     (DNS rebinding);
 *   - a caller may also keep every URL on one site: the same registrable
 *     domain.
 *
 * The address ranges are ipaddr.js's (through mailguard's `isPublicIp`), so
 * nothing here hand-rolls CIDR math.
 */
import { isPublicIp, normalizeIp, registrableDomain } from '@sarv-in/mailguard';
import ipaddr from 'ipaddr.js';

/** RFC 6052's well-known NAT64 prefix: the IPv4 address sits in the last 32 bits. */
const NAT64_WELL_KNOWN_PREFIX = ipaddr.IPv6.parseCIDR('64:ff9b::/96');

/**
 * Is `candidate` an address the open internet routes to, and so one a
 * stranger may make us connect to?
 *
 * "Public" means ipaddr.js's `unicast`. That excludes loopback, RFC 1918,
 * link-local (which includes the 169.254.169.254 metadata service), CGNAT,
 * unique-local, multicast, unspecified, broadcast, the reserved and
 * documentation ranges, and the 6to4 and Teredo tunnels. An IPv4-mapped IPv6
 * address (`::ffff:127.0.0.1`) is judged as the IPv4 address it carries.
 *
 * The one exception is NAT64 (`64:ff9b::/96`). On an IPv6-only network with
 * DNS64, EVERY IPv4-only site resolves to such an address, so refusing the
 * prefix outright would break logos and favicons there. It is accepted only
 * when the IPv4 address embedded in it is public itself. RFC 8215's local-use
 * prefix (`64:ff9b:1::/48`) is not accepted: where it carries the IPv4 address
 * depends on how that network configured it.
 *
 * Null, an empty string or anything that is not an IP address is not public.
 */
export function isPublicAddress(candidate: string | null | undefined): boolean {
  const ip = normalizeIp(candidate);
  if (ip === null) return false;
  if (isPublicIp(ip)) return true;
  const parsed = ipaddr.parse(ip);
  if (parsed.kind() !== 'ipv6' || !(parsed as ipaddr.IPv6).match(NAT64_WELL_KNOWN_PREFIX)) return false;
  return isPublicIp(ipaddr.fromByteArray(parsed.toByteArray().slice(12)).toString());
}

/** Why {@link checkPublicHttpsUrl} turned a URL down. */
export type DestinationRefusal =
  /** Not a URL at all. */
  | 'invalid-url'
  /** Anything but https: plain http can be read and rewritten in transit. */
  | 'not-https'
  /**
   * An explicit port other than 443. Chromium refuses its list of "unsafe"
   * ports (SMTP, SSH and so on) by itself, but a plain Node socket does not.
   * No brand serves its logo or favicon anywhere but the default port.
   */
  | 'non-default-port'
  /** An IP-literal host that is not a public address. */
  | 'private-address'
  /** A host on a different site (registrable domain) from the one required. */
  | 'other-site';

export type DestinationCheck =
  | {
      ok: true;
      url: URL;
      /** The host to connect to, without the brackets an IPv6 literal carries in a URL. */
      host: string;
      /** The host is an IP address, so no name resolution (and no lookup check) will happen. */
      ipLiteral: boolean;
    }
  | { ok: false; reason: DestinationRefusal };

export interface DestinationRules {
  /**
   * Accept only hosts on this domain's site (registrable domain), such as
   * `www.brand.co.uk` for `mail.brand.co.uk`. Unset means any host.
   */
  site?: string;
}

/** The registrable domain of an ASCII host name, or the host itself when there is none (an IP, a public suffix). */
const siteOf = (hostname: string): string => registrableDomain(hostname) ?? hostname;

/**
 * Site key for a domain as the caller spelled it. The WHATWG URL parser
 * converts it to the same ASCII (punycode) form a URL's host takes, so a
 * Unicode domain matches its own links.
 */
function siteOfDomain(domain: string): string | null {
  try {
    return siteOf(new URL(`https://${domain.trim()}/`).hostname);
  } catch {
    return null;
  }
}

/**
 * May a fetch named by a stranger go to `input`? Checks everything that can be
 * known BEFORE resolving the host: the scheme, the port, an IP-literal host,
 * and the optional site rule. A host name still has to resolve to public
 * addresses only. That check belongs at connect time, in the transport's
 * `lookup`.
 *
 * The WHATWG parser canonicalises every IPv4 spelling (`0x7f.1`, `2130706433`,
 * `127.1`) to dotted decimal, so a literal cannot hide as a name here.
 */
export function checkPublicHttpsUrl(input: string | URL, rules: DestinationRules = {}): DestinationCheck {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  // The parser drops an explicit `:443`, so any port left here is another one.
  if (url.port !== '') return { ok: false, reason: 'non-default-port' };
  const ipLiteral = normalizeIp(url.hostname) !== null;
  if (ipLiteral && !isPublicAddress(url.hostname)) return { ok: false, reason: 'private-address' };
  if (rules.site !== undefined && siteOf(url.hostname) !== siteOfDomain(rules.site)) {
    return { ok: false, reason: 'other-site' };
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return { ok: true, url, host, ipLiteral };
}
