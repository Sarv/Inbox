import {
  extractOriginIp,
  isPublicIp,
  normalizeIp,
  originIpFromAuthHeaders,
  originIpFromReceived,
} from '@sarv-in/email-spam-scan';
import { describe, expect, it } from 'vitest';


/**
 * The connecting client's IP, recorded per message for the reputation stage.
 *
 * What this protects: a blocklist lookup on the WRONG address is worse than
 * none — it clears a spammer (we asked about our own relay) or condemns a
 * neighbour (we asked about the recipient's provider). So the tests pin which
 * address wins from real header shapes (Gmail, Microsoft 365, Postfix,
 * qmail), and that no private or reserved address ever comes out.
 */

// Genuinely public addresses. The RFC 5737 documentation ranges (203.0.113/24
// etc.) are classified RESERVED by ipaddr.js — correctly — so they cannot be
// used as the "public" fixture here.
const GOOGLE = '209.85.220.41';
const M365 = '40.107.22.33';
const HOST = '185.199.108.1';
const GOOGLE6 = '2a00:1450:4864:20::32a';

describe('normalizeIp', () => {
  it('strips Received-line decoration and canonicalises', () => {
    expect(normalizeIp(`[${GOOGLE}]`)).toBe(GOOGLE);
    expect(normalizeIp(`IPv6:${GOOGLE6}`)).toBe(GOOGLE6);
    expect(normalizeIp(`[IPv6:${GOOGLE6}]`)).toBe(GOOGLE6);
    expect(normalizeIp(` ${HOST} `)).toBe(HOST);
  });

  it('folds an IPv4-mapped IPv6 address to its IPv4', () => {
    expect(normalizeIp(`::ffff:${HOST}`)).toBe(HOST);
  });

  // Hostnames, short forms and out-of-range octets are not addresses. ipaddr.js
  // would accept `1.2.3` and octal forms; a mail server never writes those.
  it('rejects anything that is not a dotted quad or an IPv6 literal', () => {
    for (const bad of ['mail.example.com', '1.2.3', '999.1.1.1', '0x7f.1', 'port=25', '', null, undefined]) {
      expect(normalizeIp(bad)).toBeNull();
    }
  });
});

describe('isPublicIp', () => {
  it('accepts routable unicast addresses, v4 and v6', () => {
    expect(isPublicIp(GOOGLE)).toBe(true);
    expect(isPublicIp(GOOGLE6)).toBe(true);
    expect(isPublicIp(`::ffff:${HOST}`)).toBe(true);
  });

  // The receiving side's own plumbing. A blocklist has nothing to say about
  // these, and returning one would make the reputation stage look up nothing.
  it('rejects private, loopback, link-local, carrier-NAT, reserved and mapped-private addresses', () => {
    for (const bad of [
      '10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1',
      '203.0.113.5', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '2002:c000:0204::',
    ]) {
      expect(isPublicIp(bad), bad).toBe(false);
    }
  });
});

describe('originIpFromAuthHeaders', () => {
  it('reads client-ip= from Received-SPF (Gmail, Zoho, Postfix policyd)', () => {
    const block = `Received-SPF: pass (google.com: domain of x@sarv.com designates ${GOOGLE} as permitted sender) client-ip=${GOOGLE};`;
    expect(originIpFromAuthHeaders(block)).toBe(GOOGLE);
  });

  it('reads "sender IP is" from a Microsoft 365 Authentication-Results', () => {
    expect(originIpFromAuthHeaders(`Authentication-Results: spf=pass (sender IP is ${M365}) smtp.mailfrom=sarv.com; dkim=pass`)).toBe(M365);
  });

  it('reads the SPF comment "designates x as permitted sender" when nothing else names it', () => {
    expect(originIpFromAuthHeaders(`Authentication-Results: mx.google.com; spf=pass (google.com: domain of a@b.c designates ${GOOGLE} as permitted sender) smtp.mailfrom=a@b.c`)).toBe(GOOGLE);
  });

  it('reads RFC 8601 smtp.remote-ip=', () => {
    expect(originIpFromAuthHeaders(`Authentication-Results: mx; iprev=pass policy.iprev=${HOST} smtp.remote-ip=${HOST}`)).toBe(HOST);
  });

  // Headers are prepended per hop, so the first line is OUR server's verdict.
  // An ARC header a forwarder carried along names the hop before it; that is
  // not the client that connected to us.
  it('prefers the newest hop — the receiving server’s own — over a forwarder’s ARC line', () => {
    const block = [
      `Received-SPF: pass (sarv.com: domain designates ${HOST}) client-ip=${HOST};`,
      `ARC-Authentication-Results: i=1; mx.google.com; spf=pass client-ip=${GOOGLE}`,
    ].join('\n');
    expect(originIpFromAuthHeaders(block)).toBe(HOST);
  });

  it('skips a private client-ip and falls through to the next public one', () => {
    const block = [
      'Received-SPF: none client-ip=10.1.2.3;',
      `Authentication-Results: mx; spf=pass (sender IP is ${M365})`,
    ].join('\n');
    expect(originIpFromAuthHeaders(block)).toBe(M365);
  });

  it('is null when the block names no public address', () => {
    expect(originIpFromAuthHeaders('Authentication-Results: mx; dkim=pass; client-ip=127.0.0.1')).toBeNull();
    expect(originIpFromAuthHeaders('')).toBeNull();
    expect(originIpFromAuthHeaders(undefined)).toBeNull();
  });
});

describe('originIpFromReceived', () => {
  it('skips Gmail’s internal "by" hop and reads the bracketed address of the first "from" hop', () => {
    expect(originIpFromReceived([
      'by 2002:a05:6a00:1a1c:b0:1d1:6d5c:6b7f with SMTP id q28csp123; Thu, 9 Oct 2025 01:53:20 -0700 (PDT)',
      `from mail-sor-f41.google.com (mail-sor-f41.google.com. [${GOOGLE}]) by mx.google.com with SMTPS id abc`,
    ])).toBe(GOOGLE);
  });

  // Microsoft writes the address bare in parentheses, and the `by` side has
  // one too — only the `from` side is the client being judged.
  it('reads the parenthesised address of a Microsoft hop and ignores the "by" side', () => {
    expect(originIpFromReceived([
      `from mail.sender.example (${HOST}) by AM0PR01.mail.protection.outlook.com (${M365}) with Microsoft SMTP Server`,
    ])).toBe(HOST);
  });

  it('skips a loopback content-filter hop to reach the external one', () => {
    expect(originIpFromReceived([
      'from localhost (localhost [127.0.0.1]) by mail.sarv.com (Postfix) with ESMTP id 1',
      `from mta.example.net (unknown [${HOST}]) by mail.sarv.com (Postfix) with ESMTPS id 2`,
    ])).toBe(HOST);
  });

  it('reads the bracket-first and IPv6 forms', () => {
    expect(originIpFromReceived([`from [${HOST}] (port=25 helo=mta.example.net) by mail.sarv.com`])).toBe(HOST);
    expect(originIpFromReceived([`from mail-x.google.com (mail-x.google.com. [IPv6:${GOOGLE6}]) by mx.google.com`])).toBe(GOOGLE6);
  });

  // A hostname that starts with a dotted quad (reverse-DNS style names) is a
  // hostname, not an address. Tokenising, rather than substring-matching,
  // is what keeps it out.
  it('does not mistake a dotted-quad hostname for an address', () => {
    expect(originIpFromReceived([`from ${HOST}.static.example.net (unknown [10.0.0.9]) by mail.sarv.com`])).toBeNull();
  });

  it('ignores lines that do not start with "from", such as qmail’s, and is null when nothing qualifies', () => {
    expect(originIpFromReceived(['(qmail 12345 invoked from network); 9 Oct 2025 08:53:20 -0000'])).toBeNull();
    expect(originIpFromReceived([])).toBeNull();
    expect(originIpFromReceived(null)).toBeNull();
  });
});

describe('extractOriginIp', () => {
  it('prefers the SPF evaluator’s address over the Received trace', () => {
    expect(extractOriginIp({
      authHeaders: `Received-SPF: pass client-ip=${M365};`,
      received: [`from x (x [${HOST}]) by y`],
    })).toBe(M365);
  });

  it('falls back to the Received trace when the SPF headers name nothing', () => {
    expect(extractOriginIp({ authHeaders: 'Authentication-Results: mx; dkim=pass', received: [`from x (x [${HOST}]) by y`] })).toBe(HOST);
    expect(extractOriginIp({ authHeaders: undefined, received: [`from x (x [${HOST}]) by y`] })).toBe(HOST);
  });

  it('is null when neither source names a public address', () => {
    expect(extractOriginIp({ authHeaders: undefined, received: null })).toBeNull();
    expect(extractOriginIp({ authHeaders: '', received: ['from localhost (localhost [127.0.0.1]) by x'] })).toBeNull();
  });
});
