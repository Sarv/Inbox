/**
 * The IP address that handed this message to the recipient's mail system —
 * the one input every reputation check (DNS blocklists, reverse DNS) needs.
 *
 * Two sources, in order of trust:
 *
 *   1. The receiving server's own SPF evaluation. `Received-SPF` carries the
 *      address it checked as `client-ip=`; `Authentication-Results` repeats it
 *      in the SPF comment ("sender IP is x", "designates x as permitted
 *      sender") or as `smtp.remote-ip=` (RFC 8601 iprev). This is authoritative:
 *      it IS the connecting client as the server saw it. Headers are prepended
 *      hop by hop, so the first match top-down is the verdict OUR server wrote,
 *      not one a forwarder carried along in an ARC header.
 *   2. The `Received:` trace, top down. The first hop written with a `from`
 *      clause naming a PUBLIC address is the last external handoff. This is
 *      the fallback for servers that record no SPF result at all. It is a
 *      heuristic — a provider whose internal relays use public addresses will
 *      name one of those first — which is why the SPF sources win when present.
 *
 * Private, loopback, link-local, carrier-NAT and IPv4-mapped-private addresses
 * are never returned: they are the receiving side's own plumbing, and a
 * blocklist has nothing to say about them.
 *
 * `ipaddr.js` owns the address grammar and the range classification; the code
 * here only finds candidate tokens and asks it. One address is recorded per
 * message today; the reputation stage may widen this to every external hop.
 */
import ipaddr from 'ipaddr.js';

const IPV4_SHAPE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A candidate token as a canonical address string, or null when it is not an
 * IP address at all. Strips the `[...]` and `IPv6:` decoration Received lines
 * use, and folds an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) to its IPv4.
 */
export function normalizeIp(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const s = candidate.trim().replace(/^\[|\]$/g, '').replace(/^ipv6:/i, '');
  if (!s) return null;
  // Validity is checked BEFORE parsing, so the parsers below cannot throw.
  if (IPV4_SHAPE.test(s)) {
    // Strict dotted-quad only: ipaddr.js also accepts octal, hex and short
    // forms, none of which a mail server writes into a header.
    return ipaddr.IPv4.isValidFourPartDecimal(s) ? ipaddr.IPv4.parse(s).toString() : null;
  }
  if (s.includes(':') && ipaddr.IPv6.isValid(s)) {
    return ipaddr.process(s).toString();
  }
  return null;
}

/** True for a routable public unicast address (v4 or v6). */
export function isPublicIp(candidate: string | null | undefined): boolean {
  const ip = normalizeIp(candidate);
  return ip !== null && ipaddr.process(ip).range() === 'unicast';
}

/** Where the SPF evaluator wrote the address it checked. Order = preference. */
const AUTH_IP_PATTERNS: readonly RegExp[] = [
  /\bclient-ip=([^;\s()]+)/gi,
  /\bsender ip is ([^;\s()]+)/gi,
  /\bdesignates ([^;\s()]+) as permitted sender/gi,
  /\bsmtp\.remote-ip=([^;\s()]+)/gi,
];

/** The connecting client's address from the authentication header block. */
export function originIpFromAuthHeaders(block: string | null | undefined): string | null {
  if (!block) return null;
  for (const pattern of AUTH_IP_PATTERNS) {
    for (const m of block.matchAll(pattern)) {
      const ip = normalizeIp(m[1]);
      if (ip && isPublicIp(ip)) return ip;
    }
  }
  return null;
}

/**
 * The last external hop from the `Received:` lines, top-down (the order the
 * header block lists them — newest first). Only the `from` clause of each line
 * is read: the `by` clause names the receiving side, whose address is not the
 * one being judged.
 */
export function originIpFromReceived(received: readonly string[] | null | undefined): string | null {
  if (!received?.length) return null;
  for (const raw of received) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const m = /^from\s+(.*?)(?:\s+by\s+|\s*;|$)/i.exec(line);
    if (!m) continue;
    for (const token of m[1].split(/[\s()[\]]+/)) {
      const ip = normalizeIp(token);
      if (ip && isPublicIp(ip)) return ip;
    }
  }
  return null;
}

export interface OriginIpSources {
  /** The `extractAuthHeaderBlock` output for this message, if any. */
  authHeaders?: string | null;
  /** Every `Received:` value, unfolded, in header order (newest first). */
  received?: readonly string[] | null;
}

/** The one address to record for this message, or null when no source names a public one. */
export function extractOriginIp(src: OriginIpSources): string | null {
  return originIpFromAuthHeaders(src.authHeaders) ?? originIpFromReceived(src.received);
}
