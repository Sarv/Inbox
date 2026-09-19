import 'reflect-metadata'; // must precede @peculiar/x509
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  Extension,
  ExtendedKeyUsageExtension,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509Certificate,
  X509CertificateGenerator,
} from '@peculiar/x509';
import * as asn1js from 'asn1js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  BIMI_EKU_OID,
  BIMI_LOGO_MAX_BYTES,
  LOGOTYPE_EXTENSION_OID,
  checkBimiSvg,
  decodeLogoDataUri,
  dmarcEnforcesBimi,
  extractLogotypeEvidence,
  fingerprintHex,
  lookupBimi,
  parseBimiRecord,
  parseDmarcRecord,
  txtRecords,
  validateVmc,
  vmcDomains,
  type BimiDeps,
} from '../../../src/utils/bimi';
import { MVA_ROOTS, type MarkVerifyingAuthorityRoot } from '../../../src/utils/bimi-roots';

/**
 * BIMI and the Verified Mark Certificate behind the blue tick.
 *
 * What this protects: the tick is a promise that a third party checked who
 * owns this brand. Every shortcut in the chain — a root nobody pinned, a
 * certificate for another domain, a logo the certificate never saw, a policy
 * that lets spoofers through — is a way for a phisher to wear a bank's logo
 * with our blessing. So each requirement is pinned on BOTH sides: the real
 * thing verifies, and each single defect is named and refused.
 */
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Example</title><circle cx="5" cy="5" r="4" fill="#0a0"/></svg>');
const OTHER_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" baseProfile="tiny-ps"><title>Other</title></svg>');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
const toAb = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** An RFC 3709 logotype extension value binding `svg` — the shape MVAs issue. */
function logotypeDer(svg: Buffer, opts: { hash?: Buffer | null; embed?: boolean; dataUri?: string; hashOid?: string; nullParams?: boolean } = {}): ArrayBuffer {
  const hash = opts.hash === undefined ? sha256(svg) : opts.hash;
  const algParts: asn1js.BaseBlock[] = [new asn1js.ObjectIdentifier({ value: opts.hashOid ?? '2.16.840.1.101.3.4.2.1' })];
  if (opts.nullParams) algParts.push(new asn1js.Null());
  const hashes = hash ? [new asn1js.Sequence({ value: [
    new asn1js.Sequence({ value: algParts }),
    new asn1js.OctetString({ valueHex: toAb(hash) }),
  ] })] : [];
  const uris = opts.embed === false ? [] : [new asn1js.IA5String({ value: opts.dataUri ?? `data:image/svg+xml;base64,${gzipSync(svg).toString('base64')}` })];
  const details = new asn1js.Sequence({ value: [
    new asn1js.IA5String({ value: 'image/svg+xml' }),
    new asn1js.Sequence({ value: hashes }),
    new asn1js.Sequence({ value: uris }),
  ] });
  const logotypeData = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [details] })] })] });
  const direct = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [logotypeData] });
  const subjectLogo = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 2 }, value: [direct] });
  return new asn1js.Sequence({ value: [subjectLogo] }).toBER();
}

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const NOW = new Date('2026-06-01T00:00:00Z');
const past = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const future = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

interface Pki { root: X509Certificate; rootKeys: CryptoKeyPair; rootDesc: MarkVerifyingAuthorityRoot; otherRoot: X509Certificate; otherKeys: CryptoKeyPair }
let pki: Pki;

async function makeRoot(name: string): Promise<{ cert: X509Certificate; keys: CryptoKeyPair }> {
  const keys = await crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01', name, notBefore: past(365), notAfter: future(3650), signingAlgorithm: SIGN_ALG, keys,
    extensions: [new BasicConstraintsExtension(true, 1, true), await SubjectKeyIdentifierExtension.create(keys.publicKey)],
  });
  return { cert, keys };
}

interface LeafOptions {
  domains?: string[];
  /** false: no SubjectAltName extension at all. */
  san?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  eku?: boolean;
  logotype?: ArrayBuffer | null;
  issuer?: { cert: X509Certificate; keys: CryptoKeyPair };
  organization?: string;
}

async function makeLeaf(o: LeafOptions = {}): Promise<X509Certificate> {
  const issuer = o.issuer ?? { cert: pki.root, keys: pki.rootKeys };
  const keys = await crypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
  const extensions: Extension[] = [await AuthorityKeyIdentifierExtension.create(issuer.keys.publicKey)];
  if (o.san !== false) {
    extensions.push(new SubjectAlternativeNameExtension([...(o.domains ?? ['example.com']).map((d) => ({ type: 'dns' as const, value: d }))]));
  }
  if (o.eku !== false) extensions.push(new ExtendedKeyUsageExtension([BIMI_EKU_OID]));
  if (o.logotype !== null) extensions.push(new Extension(LOGOTYPE_EXTENSION_OID, false, o.logotype ?? logotypeDer(SVG)));
  return X509CertificateGenerator.create({
    serialNumber: '02',
    subject: `CN=Example Brand, O=${o.organization ?? 'Example Inc'}`,
    issuer: issuer.cert.subject,
    notBefore: o.notBefore ?? past(30),
    notAfter: o.notAfter ?? future(365),
    signingAlgorithm: SIGN_ALG,
    publicKey: keys.publicKey,
    signingKey: issuer.keys.privateKey,
    extensions,
  });
}

const pem = (...certs: X509Certificate[]) => certs.map((c) => c.toString('pem')).join('\n');

beforeAll(async () => {
  const r = await makeRoot('CN=Test Verified Mark Root, O=Test MVA');
  const other = await makeRoot('CN=Someone Else Root, O=Not An MVA');
  pki = {
    root: r.cert, rootKeys: r.keys,
    rootDesc: { name: 'Test Verified Mark Root', organization: 'Test MVA', source: 'test', sha256: fingerprintHex(await r.cert.getThumbprint('SHA-256')), pem: r.cert.toString('pem') },
    otherRoot: other.cert, otherKeys: other.keys,
  };
});

describe('parseBimiRecord', () => {
  it('reads the logo and evidence URLs, whatever the tag case and spacing', () => {
    expect(parseBimiRecord('v=BIMI1; l=https://x.example/logo.svg; a=https://x.example/vmc.pem')).toEqual({
      logoUrl: 'https://x.example/logo.svg', evidenceUrl: 'https://x.example/vmc.pem', declined: false,
    });
    expect(parseBimiRecord(' V=bimi1 ;L=https://x.example/l.svg ')).toMatchObject({ logoUrl: 'https://x.example/l.svg', evidenceUrl: null });
  });

  // `l=` present and empty is the spec's "we decline" — a different answer
  // from "no record", and one that must never fall through to a fetch.
  it('recognises an explicit decline', () => {
    expect(parseBimiRecord('v=BIMI1; l=;')).toEqual({ logoUrl: null, evidenceUrl: null, declined: true });
  });

  // A plain-http logo is a downgrade a spoofer on the path could swap.
  it('drops non-https URLs and rejects non-BIMI records', () => {
    expect(parseBimiRecord('v=BIMI1; l=http://x.example/logo.svg')).toMatchObject({ logoUrl: null, declined: false });
    expect(parseBimiRecord('v=spf1 include:_spf.google.com ~all')).toBeNull();
    expect(parseBimiRecord('')).toBeNull();
  });
});

describe('parseDmarcRecord / dmarcEnforcesBimi', () => {
  it('parses policy, subdomain policy and pct (defaulting to 100)', () => {
    expect(parseDmarcRecord('v=DMARC1; p=reject; sp=none; pct=50; rua=mailto:d@x.example')).toEqual({ policy: 'reject', subdomainPolicy: 'none', pct: 50 });
    expect(parseDmarcRecord('v=DMARC1; p=quarantine')).toEqual({ policy: 'quarantine', subdomainPolicy: null, pct: 100 });
    expect(parseDmarcRecord('v=DKIM1; k=rsa')).toBeNull();
  });

  // THE premise of BIMI: a logo only under a policy that stops spoofing.
  it('allows BIMI only under quarantine/reject applied to all mail', () => {
    expect(dmarcEnforcesBimi(parseDmarcRecord('v=DMARC1; p=reject'), false)).toBe(true);
    expect(dmarcEnforcesBimi(parseDmarcRecord('v=DMARC1; p=quarantine'), false)).toBe(true);
    expect(dmarcEnforcesBimi(parseDmarcRecord('v=DMARC1; p=none'), false)).toBe(false);
    expect(dmarcEnforcesBimi(parseDmarcRecord('v=DMARC1; p=reject; pct=50'), false)).toBe(false);
    expect(dmarcEnforcesBimi(null, false)).toBe(false);
  });

  it('uses the subdomain policy for a subdomain when one is published', () => {
    const rec = parseDmarcRecord('v=DMARC1; p=reject; sp=none');
    expect(dmarcEnforcesBimi(rec, true)).toBe(false);
    expect(dmarcEnforcesBimi(rec, false)).toBe(true);
    expect(dmarcEnforcesBimi(parseDmarcRecord('v=DMARC1; p=reject'), true)).toBe(true);
  });
});

describe('checkBimiSvg', () => {
  it('accepts a Tiny PS logo and notes the profile', () => {
    expect(checkBimiSvg(SVG)).toEqual({ ok: true, reason: null, tinyPs: true });
    expect(checkBimiSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toMatchObject({ ok: true, tinyPs: false });
  });

  // The logo is rendered as an <img>, where none of these would run — this is
  // the second line. It still has to hold on its own.
  it('rejects script, event handlers, embedded documents and external references', () => {
    expect(checkBimiSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).reason).toMatch(/script/);
    expect(checkBimiSvg(Buffer.from('<svg onload="alert(1)"></svg>')).reason).toMatch(/event handler/);
    expect(checkBimiSvg(Buffer.from('<svg><foreignObject><body/></foreignObject></svg>')).reason).toMatch(/foreignobject/);
    expect(checkBimiSvg(Buffer.from('<svg><image href="https://evil.example/track.png"/></svg>')).reason).toMatch(/external reference/);
    expect(checkBimiSvg(Buffer.from('<svg><use xlink:href="https://evil.example/x.svg#a"/></svg>')).reason).toMatch(/external reference/);
    expect(checkBimiSvg(Buffer.from('<svg><rect style="fill:url(https://evil.example/p)"/></svg>')).reason).toMatch(/style/);
    expect(checkBimiSvg(Buffer.from('<svg><style>@import url(https://evil.example/a.css);</style></svg>')).reason).toMatch(/stylesheet/);
  });

  it('allows same-document references', () => {
    expect(checkBimiSvg(Buffer.from('<svg><defs><linearGradient id="g"/></defs><use href="#g"/><rect fill="url(#g)"/></svg>')).ok).toBe(true);
  });

  it('rejects an oversized, empty or non-SVG file', () => {
    expect(checkBimiSvg(Buffer.alloc(BIMI_LOGO_MAX_BYTES + 1, 0x20)).reason).toMatch(/64 KB/);
    expect(checkBimiSvg(Buffer.alloc(0)).reason).toBe('empty file');
    expect(checkBimiSvg(Buffer.from('<html><body>not a logo</body></html>')).reason).toBe('not an SVG document');
    expect(checkBimiSvg(Buffer.from('plain text')).reason).toBe('not an SVG document');
  });
});

describe('logotype extension', () => {
  // THE real-world shape (Apple's, DigiCert's): the AlgorithmIdentifier carries
  // NULL parameters. The first version matched fine here — but see the next test.
  it('reads a hash whose AlgorithmIdentifier carries NULL parameters', () => {
    const ev = extractLogotypeEvidence(logotypeDer(SVG, { nullParams: true }));
    expect(ev.sha256).toEqual([sha256(SVG).toString('hex')]);
  });

  // THE crash on the first real VMC: an unknown hash algorithm made the walker
  // step INTO the ObjectIdentifier, whose "children" are arc records with no
  // valueBlock. It must walk past, report no SHA-256, and still find the URI.
  it('walks past an unknown hash algorithm without crashing', () => {
    const ev = extractLogotypeEvidence(logotypeDer(SVG, { hashOid: '2.16.840.1.101.3.4.2.3', nullParams: true })); // SHA-512: not read
    expect(ev.sha256).toEqual([]);
    expect(ev.sha1).toEqual([]);
    expect(ev.dataUris).toHaveLength(1);
  });

  // Apple's real VMC binds its logo with SHA-1, as RFC 3709's examples do.
  it('reads a SHA-1 hash as well', () => {
    const sha1 = createHash('sha1').update(SVG).digest();
    const ev = extractLogotypeEvidence(logotypeDer(SVG, { hash: sha1, hashOid: '1.3.14.3.2.26', nullParams: true, embed: false }));
    expect(ev.sha1).toEqual([sha1.toString('hex')]);
    expect(ev.sha256).toEqual([]);
  });

  it('extracts the SHA-256 and the embedded (gzipped) logo, walking the ASN.1 generically', () => {
    const ev = extractLogotypeEvidence(logotypeDer(SVG));
    expect(ev.sha256).toEqual([sha256(SVG).toString('hex')]);
    expect(ev.dataUris).toHaveLength(1);
    expect(decodeLogoDataUri(ev.dataUris[0])!.equals(SVG)).toBe(true);
  });

  it('is empty for garbage and tolerates an uncompressed or malformed data URI', () => {
    expect(extractLogotypeEvidence(new Uint8Array([0x30, 0x03, 0x02, 0x01]))).toEqual({ sha256: [], sha1: [], dataUris: [] });
    expect(decodeLogoDataUri('data:image/svg+xml;base64,' + SVG.toString('base64'))!.equals(SVG)).toBe(true);
    expect(decodeLogoDataUri('data:image/svg+xml,%3Csvg%3E')!.toString()).toBe('<svg>');
    expect(decodeLogoDataUri('nonsense')).toBeNull();
  });
});

describe('validateVmc', () => {
  const opts = () => ({ roots: [pki.rootDesc], now: NOW });

  // THE happy path: a real chain to a pinned MVA root, for this domain, for this logo.
  it('verifies a chain to a pinned root for the covered domain and the bound logo', async () => {
    const leaf = await makeLeaf();
    const r = await validateVmc(pem(leaf, pki.root), 'example.com', SVG, opts());
    expect(r.status).toBe('verified');
    expect(r.organization).toBe('Example Inc');
    expect(r.issuer).toBe('Test Verified Mark Root');
    expect(r.issuerOrganization).toBe('Test MVA');
    expect(r.detail).toContain('Example Inc');
    expect(r.notAfter).toBe(Math.floor(future(365).getTime() / 1000));
  });

  it('verifies a subdomain of a covered domain, and when the root is not in the file', async () => {
    const leaf = await makeLeaf({ domains: ['example.com'] });
    expect((await validateVmc(pem(leaf), 'mail.example.com', SVG, opts())).status).toBe('verified');
  });

  // THE forgery guard. Anyone can mint a chain with the right OIDs and names;
  // only the anchor tells a Mark Verifying Authority from a laptop.
  it('refuses a chain that ends at a root nobody pinned', async () => {
    const leaf = await makeLeaf({ issuer: { cert: pki.otherRoot, keys: pki.otherKeys } });
    const r = await validateVmc(pem(leaf, pki.otherRoot), 'example.com', SVG, opts());
    expect(r.status).toBe('untrusted-root');
    expect(r.detail).toContain('Someone Else Root');
  });

  it('refuses a leaf whose issuer cannot be found or verified', async () => {
    const leaf = await makeLeaf({ issuer: { cert: pki.otherRoot, keys: pki.otherKeys } });
    // The other root is neither in the file nor pinned: the chain stops at the leaf.
    const r = await validateVmc(pem(leaf), 'example.com', SVG, opts());
    expect(r.status).toBe('broken-chain');
  });

  it('refuses an expired or not-yet-valid certificate', async () => {
    expect((await validateVmc(pem(await makeLeaf({ notAfter: past(1) })), 'example.com', SVG, opts())).status).toBe('expired');
    expect((await validateVmc(pem(await makeLeaf({ notBefore: future(1) })), 'example.com', SVG, opts())).status).toBe('not-yet-valid');
  });

  // A bank's VMC must not verify a look-alike domain, however real the cert.
  it('refuses a certificate issued for another domain', async () => {
    const r = await validateVmc(pem(await makeLeaf({ domains: ['other.example'] })), 'example.com', SVG, opts());
    expect(r.status).toBe('domain-mismatch');
    expect(r.detail).toContain('other.example');
  });

  it('refuses a certificate without the BIMI key usage or without a logotype', async () => {
    expect((await validateVmc(pem(await makeLeaf({ eku: false })), 'example.com', SVG, opts())).status).toBe('not-vmc');
    expect((await validateVmc(pem(await makeLeaf({ logotype: null })), 'example.com', SVG, opts())).status).toBe('not-vmc');
  });

  // The tick vouches for a PICTURE. The domain may serve any SVG it likes,
  // but only the one the MVA saw is verified.
  it('refuses a logo the certificate was not issued for', async () => {
    const r = await validateVmc(pem(await makeLeaf()), 'example.com', OTHER_SVG, opts());
    expect(r.status).toBe('logo-mismatch');
  });

  it('accepts a logo bound by SHA-1 alone (Apple’s certificate shape)', async () => {
    const sha1 = createHash('sha1').update(SVG).digest();
    const leaf = await makeLeaf({ logotype: logotypeDer(SVG, { hash: sha1, hashOid: '1.3.14.3.2.26', nullParams: true, embed: false }) });
    expect((await validateVmc(pem(leaf), 'example.com', SVG, opts())).status).toBe('verified');
    expect((await validateVmc(pem(leaf), 'example.com', OTHER_SVG, opts())).status).toBe('logo-mismatch');
  });

  it('accepts the logo by hash alone, or by the embedded copy alone', async () => {
    const hashOnly = await makeLeaf({ logotype: logotypeDer(SVG, { embed: false }) });
    expect((await validateVmc(pem(hashOnly), 'example.com', SVG, opts())).status).toBe('verified');
    const embedOnly = await makeLeaf({ logotype: logotypeDer(SVG, { hash: null }) });
    expect((await validateVmc(pem(embedOnly), 'example.com', SVG, opts())).status).toBe('verified');
  });

  it('reports an unparseable file as such, never as verified', async () => {
    expect((await validateVmc('not a certificate', 'example.com', SVG, opts())).status).toBe('unparseable');
    expect((await validateVmc('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----', 'example.com', SVG, opts())).status).toBe('unparseable');
  });

  it('lists the SAN domains', async () => {
    expect(vmcDomains(await makeLeaf({ domains: ['A.example', 'b.example'] }))).toEqual(['a.example', 'b.example']);
  });

  // The pinned roots themselves: each must parse and match its recorded
  // fingerprint, or the anchor has silently rotted.
  it('ships pinned MVA roots whose fingerprints match their PEM', async () => {
    expect(MVA_ROOTS.length).toBeGreaterThanOrEqual(3);
    for (const root of MVA_ROOTS) {
      const cert = new X509Certificate(root.pem);
      expect(fingerprintHex(await cert.getThumbprint('SHA-256'))).toBe(root.sha256);
      expect(await cert.isSelfSigned()).toBe(true);
      expect(cert.notAfter.getTime()).toBeGreaterThan(Date.now());
    }
  });
});

describe('lookupBimi', () => {
  type Route = { status?: number; body?: Buffer | string; type?: string; length?: number; throws?: boolean };
  const fakeFetch = (routes: Record<string, Route>): BimiDeps['fetch'] => async (url) => {
    const r = routes[url];
    if (!r) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    if (r.throws) throw new Error('ECONNRESET');
    const body = typeof r.body === 'string' ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
    const status = r.status ?? 200;
    return {
      ok: status < 400, status, url,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.type ?? null) : n.toLowerCase() === 'content-length' ? String(r.length ?? body.length) : null) },
      arrayBuffer: async () => toAb(body),
    };
  };
  const notFound = () => Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
  const dns = (records: Record<string, string[]>): BimiDeps['resolveTxt'] => async (name) => {
    const r = records[name];
    if (!r) throw notFound();
    return r.map((s) => [s]);
  };
  const deps = (records: Record<string, string[]>, routes: Record<string, Route>): BimiDeps => ({
    resolveTxt: dns(records), fetch: fakeFetch(routes), now: () => NOW, roots: [pki.rootDesc],
  });
  const LOGO = 'https://brand.example/logo.svg';
  const VMC = 'https://brand.example/vmc.pem';

  it('is "none" for a domain with no record — a DNS miss is an answer, not an error', async () => {
    const r = await lookupBimi('plain.example', deps({}, {}));
    expect(r.status).toBe('none');
    expect(r.logo).toBeNull();
  });

  it('is "declined" when the domain publishes an empty l=', async () => {
    const r = await lookupBimi('brand.example', deps({ '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': ['v=BIMI1; l=;'] }, {}));
    expect(r.status).toBe('declined');
  });

  // THE premise, end to end: no enforcing DMARC, no logo — whatever the record says.
  it('refuses to show a logo under p=none or with no DMARC at all', async () => {
    const routes = { [LOGO]: { body: SVG, type: 'image/svg+xml' } };
    const weak = await lookupBimi('brand.example', deps({ '_dmarc.brand.example': ['v=DMARC1; p=none'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] }, routes));
    expect(weak.status).toBe('invalid');
    expect(weak.detail).toContain('p=none');
    expect(weak.logo).toBeNull();
    const none = await lookupBimi('brand.example', deps({ 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] }, routes));
    expect(none.status).toBe('invalid');
    expect(none.detail).toContain('publishes none');
  });

  it('returns the logo as a data URI when the record has no certificate', async () => {
    const r = await lookupBimi('brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=quarantine'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] },
      { [LOGO]: { body: SVG, type: 'image/svg+xml' } },
    ));
    expect(r.status).toBe('logo');
    expect(r.logo).toBe(`data:image/svg+xml;base64,${SVG.toString('base64')}`);
    expect(r.dmarcPolicy).toBe('quarantine');
    expect(r.recordDomain).toBe('brand.example');
  });

  // The whole feature: record + enforcing DMARC + logo + VMC to a pinned root.
  it('is "verified" with the organisation and issuer when the certificate checks out', async () => {
    const leaf = await makeLeaf({ domains: ['brand.example'] });
    const r = await lookupBimi('brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}; a=${VMC}`] },
      { [LOGO]: { body: SVG, type: 'image/svg+xml' }, [VMC]: { body: pem(leaf, pki.root), type: 'application/x-pem-file' } },
    ));
    expect(r.status).toBe('verified');
    expect(r.organization).toBe('Example Inc');
    expect(r.issuer).toBe('Test Verified Mark Root');
    expect(r.logo).toContain('data:image/svg+xml;base64,');
  });

  // A bad certificate demotes to "logo" with the reason — never to "verified",
  // and never to nothing: the logo still stands on its own (DMARC-gated).
  it('falls back to "logo" and says why when the certificate does not verify', async () => {
    const leaf = await makeLeaf({ domains: ['other.example'] });
    const r = await lookupBimi('brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}; a=${VMC}`] },
      { [LOGO]: { body: SVG, type: 'image/svg+xml' }, [VMC]: { body: pem(leaf, pki.root) } },
    ));
    expect(r.status).toBe('logo');
    expect(r.detail).toMatch(/Certificate not verified: .*other\.example/);
    expect(r.logo).not.toBeNull();
    const missing = await lookupBimi('brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}; a=${VMC}`] },
      { [LOGO]: { body: SVG, type: 'image/svg+xml' } },
    ));
    expect(missing.status).toBe('logo');
    expect(missing.detail).toContain('could not be downloaded');
  });

  it('rejects a logo that fails the SVG check or is too large', async () => {
    const records = { '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] };
    const scripted = await lookupBimi('brand.example', deps(records, { [LOGO]: { body: '<svg><script>x</script></svg>', type: 'image/svg+xml' } }));
    expect(scripted.status).toBe('invalid');
    expect(scripted.detail).toContain('script');
    const huge = await lookupBimi('brand.example', deps(records, { [LOGO]: { body: SVG, type: 'image/svg+xml', length: BIMI_LOGO_MAX_BYTES + 1 } }));
    expect(huge.status).toBe('invalid');
  });

  // Mail From a subdomain: BIMI falls back to the organisational domain's
  // record, and the org's `sp=` governs the subdomain.
  it('falls back to the organisational domain for a subdomain sender', async () => {
    const r = await lookupBimi('news.brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject; sp=quarantine'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] },
      { [LOGO]: { body: SVG, type: 'image/svg+xml' } },
    ));
    expect(r.status).toBe('logo');
    expect(r.recordDomain).toBe('brand.example');
    expect(r.dmarcPolicy).toBe('quarantine');
    const spNone = await lookupBimi('news.brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject; sp=none'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] },
      { [LOGO]: { body: SVG, type: 'image/svg+xml' } },
    ));
    expect(spNone.status).toBe('invalid');
  });

  // A network failure is NOT "no BIMI": cached as such for a week it would
  // hide a real logo. It is an error the caller retries soon.
  it('is "error" on a resolver failure or an unreachable logo, never "none"', async () => {
    const servfail: BimiDeps['resolveTxt'] = async () => { throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' }); };
    expect((await lookupBimi('brand.example', { ...deps({}, {}), resolveTxt: servfail })).status).toBe('error');
    const r = await lookupBimi('brand.example', deps(
      { '_dmarc.brand.example': ['v=DMARC1; p=reject'], 'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`] },
      { [LOGO]: { throws: true } },
    ));
    expect(r.status).toBe('error');
  });

  it('joins TXT chunks and skips non-BIMI records at the same name', async () => {
    const half = `v=BIMI1; l=${LOGO.slice(0, 12)}`;
    const rest = LOGO.slice(12);
    const resolveTxt: BimiDeps['resolveTxt'] = async (name) => {
      if (name === 'default._bimi.brand.example') return [['v=spf1 -all'], [half, rest]];
      if (name === '_dmarc.brand.example') return [['v=DMARC1; p=reject']];
      throw notFound();
    };
    expect(await txtRecords(resolveTxt, 'default._bimi.brand.example')).toEqual(['v=spf1 -all', `v=BIMI1; l=${LOGO}`]);
    const r = await lookupBimi('brand.example', { resolveTxt, fetch: fakeFetch({ [LOGO]: { body: SVG, type: 'image/svg+xml' } }), now: () => NOW, roots: [pki.rootDesc] });
    expect(r.status).toBe('logo');
  });

  it('is "none" for an empty domain', async () => {
    expect((await lookupBimi('', deps({}, {}))).status).toBe('none');
  });
});

describe('edges the main paths never reach', () => {
  it('parses garbage URLs and a non-numeric pct without throwing', () => {
    expect(parseBimiRecord('v=BIMI1; l=not a url; a=also not')).toEqual({ logoUrl: null, evidenceUrl: null, declined: false });
    expect(parseDmarcRecord('v=DMARC1; p=reject; pct=abc')?.pct).toBe(100);
  });

  it('checkBimiSvg reads a lower-cased baseprofile and an external src', () => {
    expect(checkBimiSvg(Buffer.from('<svg baseprofile="tiny-ps"><rect/></svg>')).tinyPs).toBe(true);
    expect(checkBimiSvg(Buffer.from('<svg><image src="http://evil.example/x.png"/></svg>')).reason).toMatch(/external reference in src/);
    expect(checkBimiSvg(Buffer.from('<svg><rect href=""/></svg>')).ok).toBe(true); // empty value is not a reference
  });

  it('decodeLogoDataUri returns null for malformed percent-encoding and corrupt gzip', () => {
    expect(decodeLogoDataUri('data:image/svg+xml,%E0%A4%A')).toBeNull();
    const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not gzip at all')]).toString('base64');
    expect(decodeLogoDataUri(`data:image/svg+xml;base64,${corrupt}`)).toBeNull();
  });

  it('fingerprintHex accepts an ArrayBuffer as well as a view', () => {
    const bytes = new Uint8Array([0xab, 0xcd]);
    expect(fingerprintHex(bytes)).toBe('AB:CD');
    expect(fingerprintHex(bytes.buffer)).toBe('AB:CD');
  });

  it('validateVmc refuses when a pinned root cannot even be loaded', async () => {
    const r = await validateVmc(pem(await makeLeaf()), 'example.com', SVG, { roots: [{ ...pki.rootDesc, pem: 'garbage' }], now: NOW });
    expect(r.status).toBe('untrusted-root');
    expect(r.detail).toContain('Pinned root could not be loaded');
  });

  it('validateVmc names the problem when the certificate lists no domain at all', async () => {
    const r = await validateVmc(pem(await makeLeaf({ san: false })), 'example.com', SVG, { roots: [pki.rootDesc], now: NOW });
    expect(r).toMatchObject({ status: 'domain-mismatch', detail: 'The certificate names no domain' });
  });

  it('validateVmc falls back to the hash when the embedded copy cannot be decoded', async () => {
    const withBadUri = await makeLeaf({ logotype: logotypeDer(SVG, { dataUri: 'data:image/svg+xml;base64,!!!!' }) });
    expect((await validateVmc(pem(withBadUri), 'example.com', SVG, { roots: [pki.rootDesc], now: NOW })).status).toBe('verified');
    const noBinding = await makeLeaf({ logotype: logotypeDer(SVG, { hash: null, dataUri: 'data:image/svg+xml;base64,!!!!' }) });
    expect((await validateVmc(pem(noBinding), 'example.com', SVG, { roots: [pki.rootDesc], now: NOW })).status).toBe('logo-mismatch');
  });

  it('validateVmc uses the wall clock when no "now" is given', async () => {
    const leaf = await makeLeaf({ notBefore: new Date(Date.now() - 86_400_000), notAfter: new Date(Date.now() + 86_400_000) });
    expect((await validateVmc(pem(leaf), 'example.com', SVG, { roots: [pki.rootDesc] })).status).toBe('verified');
  });

  it('lookupBimi rejects a record whose logo is not https, and treats ENODATA as no record', async () => {
    const enodata: BimiDeps['resolveTxt'] = async (name) => {
      if (name === 'default._bimi.brand.example') return [['v=BIMI1; l=http://brand.example/logo.svg']];
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    };
    expect(await txtRecords(enodata, '_dmarc.brand.example')).toEqual([]);
    const r = await lookupBimi('brand.example', { resolveTxt: enodata, fetch: async () => { throw new Error('unused'); }, now: () => NOW });
    expect(r.status).toBe('invalid');
    expect(r.detail).toContain('no https logo URL');
  });

  it('lookupBimi uses a subdomain’s own DMARC record when it publishes one', async () => {
    const resolveTxt: BimiDeps['resolveTxt'] = async (name) => {
      if (name === '_dmarc.news.brand.example') return [['v=spf1 -all'], ['v=DMARC1; p=quarantine']];
      if (name === 'default._bimi.news.brand.example') return [['v=BIMI1; l=https://brand.example/logo.svg']];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    const fetch: BimiDeps['fetch'] = async () => ({ ok: true, status: 200, headers: { get: (n: string) => (n === 'content-type' ? 'image/svg+xml' : null) }, arrayBuffer: async () => toAb(SVG) });
    const r = await lookupBimi('news.brand.example', { resolveTxt, fetch, now: () => NOW });
    expect(r).toMatchObject({ status: 'logo', dmarcPolicy: 'quarantine', recordDomain: 'news.brand.example' });
  });

  it('lookupBimi rejects a logo whose body exceeds the cap even when the server under-declares its length', async () => {
    const resolveTxt: BimiDeps['resolveTxt'] = async (name) => {
      if (name === '_dmarc.brand.example') return [['v=DMARC1; p=reject']];
      if (name === 'default._bimi.brand.example') return [['v=BIMI1; l=https://brand.example/logo.svg']];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    const big = Buffer.alloc(BIMI_LOGO_MAX_BYTES + 1, 0x20);
    const fetch: BimiDeps['fetch'] = async () => ({ ok: true, status: 200, headers: { get: (n: string) => (n === 'content-length' ? '100' : 'image/svg+xml') }, arrayBuffer: async () => toAb(big) });
    expect((await lookupBimi('brand.example', { resolveTxt, fetch, now: () => NOW })).status).toBe('invalid');
  });
});

describe('lookupBimi — resolver failures on a subdomain', () => {
  const ok = (body: Buffer): BimiDeps['fetch'] => async () => ({ ok: true, status: 200, headers: { get: (n: string) => (n === 'content-type' ? 'image/svg+xml' : null) }, arrayBuffer: async () => toAb(body) });
  const servfail = (name: string) => Object.assign(new Error(`queryTxt ESERVFAIL ${name}`), { code: 'ESERVFAIL' });

  // `_dmarc.mailer.brand.example` often is not a zone at all and the resolver
  // says SERVFAIL. The organisational domain still answers — use it.
  it('falls through to the organisational domain when the subdomain’s names fail to resolve', async () => {
    const resolveTxt: BimiDeps['resolveTxt'] = async (name) => {
      if (name.endsWith('.mailer.brand.example')) throw servfail(name);
      if (name === '_dmarc.brand.example') return [['v=DMARC1; p=reject']];
      if (name === 'default._bimi.brand.example') return [['v=BIMI1; l=https://brand.example/logo.svg']];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    const r = await lookupBimi('mailer.brand.example', { resolveTxt, fetch: ok(SVG), now: () => NOW });
    expect(r).toMatchObject({ status: 'logo', recordDomain: 'brand.example', dmarcPolicy: 'reject' });
  });

  it('is still an error when the organisational domain itself fails to resolve', async () => {
    const resolveTxt: BimiDeps['resolveTxt'] = async (name) => { throw servfail(name); };
    expect((await lookupBimi('mailer.brand.example', { resolveTxt, fetch: ok(SVG), now: () => NOW })).status).toBe('error');
    expect((await lookupBimi('brand.example', { resolveTxt, fetch: ok(SVG), now: () => NOW })).status).toBe('error');
  });
});
