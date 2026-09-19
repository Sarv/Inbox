/**
 * BIMI — Brand Indicators for Message Identification — and the Verified Mark
 * Certificate (VMC) that turns a published logo into a verified identity.
 *
 * A domain publishes `default._bimi.<domain>` TXT: `v=BIMI1; l=<svg>; a=<pem>`.
 * `l=` points at an SVG Tiny PS logo; `a=` (optional) at a certificate chain
 * from a Mark Verifying Authority that has checked the trademark and the
 * domain. The two are different claims:
 *
 *   - the LOGO alone is what the domain says about itself; it is shown only
 *     for mail that passed DMARC under an enforcing policy, because that is
 *     the whole premise of BIMI (a spoofer must never wear the brand), and
 *
 *   - the CERTIFICATE is a third party vouching for the brand. It earns the
 *     blue tick, exactly as in Gmail — and only when the chain verifies to a
 *     pinned MVA root ({@link MVA_ROOTS}), the leaf carries the BIMI extended
 *     key usage, the SAN names the domain, the dates hold, and the logotype
 *     extension in the certificate binds THIS logo. A tick on anything less
 *     would be a tick anyone could mint.
 *
 * Everything network-shaped (DNS, HTTPS) is injected, so the whole policy is
 * unit-testable with a fake resolver and fetch, and the main process can hand
 * in Chromium's `net.fetch`. Nothing here caches; the caller does.
 */
import 'reflect-metadata'; // @peculiar/x509's DI container needs the polyfill loaded first
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import {
  ExtendedKeyUsageExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509ChainBuilder,
} from '@peculiar/x509';
import * as asn1js from 'asn1js';
import { Parser } from 'htmlparser2';

import { MVA_ROOTS, type MarkVerifyingAuthorityRoot } from './bimi-roots';
import { registrableDomain } from './sender-spoof';

/** The BIMI selector every receiver checks first. */
export const BIMI_SELECTOR = 'default';
/**
 * Logo size ceiling. The BIMI spec says a logo SHOULD stay under 32 KB, but
 * real ones do not always (Cloudflare's is 44 KB) and Gmail shows them; 64 KB
 * keeps the cache bounded without refusing brands that are merely verbose.
 */
export const BIMI_LOGO_MAX_BYTES = 64 * 1024;
/** A VMC chain is a few KB of PEM; generous, but bounded. */
export const BIMI_EVIDENCE_MAX_BYTES = 64 * 1024;
/** id-kp-BrandIndicatorforMessageIdentification (RFC 9495 / VMC requirements). */
export const BIMI_EKU_OID = '1.3.6.1.5.5.7.3.31';
/** id-pe-logotype (RFC 3709 / RFC 6170). */
export const LOGOTYPE_EXTENSION_OID = '1.3.6.1.5.5.7.1.12';
const SHA256_OID = '2.16.840.1.101.3.4.2.1';
/** Some MVAs (Apple's VMC among them) still bind the logo with SHA-1 in the logotype extension. */
const SHA1_OID = '1.3.14.3.2.26';

// ---------------------------------------------------------------- DNS records

export interface BimiRecord {
  /** `l=` — https URL of the SVG logo; null when the tag is absent. */
  logoUrl: string | null;
  /** `a=` — https URL of the evidence (PEM chain); null when absent. */
  evidenceUrl: string | null;
  /** `l=` present but empty: the domain explicitly declines to show a logo. */
  declined: boolean;
}

/** Split a `k=v; k=v` record into lower-cased keys. Values keep their case. */
function tagValues(txt: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of txt.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key) out.set(key, part.slice(eq + 1).trim());
  }
  return out;
}

function httpsUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Parse one TXT record as BIMI. Null when it is not a BIMI1 record at all. */
export function parseBimiRecord(txt: string): BimiRecord | null {
  const tags = tagValues(txt);
  if ((tags.get('v') || '').toUpperCase() !== 'BIMI1') return null;
  const l = tags.get('l');
  const declined = tags.has('l') && (l || '') === '';
  return {
    logoUrl: declined ? null : httpsUrlOrNull(l),
    evidenceUrl: httpsUrlOrNull(tags.get('a')),
    declined,
  };
}

export type DmarcPolicyValue = 'none' | 'quarantine' | 'reject';

export interface DmarcRecord {
  policy: DmarcPolicyValue | null;
  subdomainPolicy: DmarcPolicyValue | null;
  /** `pct=`, defaulting to 100 as the spec does. */
  pct: number;
}

function policyValue(v: string | undefined): DmarcPolicyValue | null {
  const p = (v || '').toLowerCase();
  return p === 'none' || p === 'quarantine' || p === 'reject' ? p : null;
}

/** Parse one TXT record as DMARC. Null when it is not a DMARC1 record. */
export function parseDmarcRecord(txt: string): DmarcRecord | null {
  const tags = tagValues(txt);
  if ((tags.get('v') || '').toUpperCase() !== 'DMARC1') return null;
  const pct = Number.parseInt(tags.get('pct') ?? '100', 10);
  return {
    policy: policyValue(tags.get('p')),
    subdomainPolicy: policyValue(tags.get('sp')),
    pct: Number.isFinite(pct) ? pct : 100,
  };
}

/**
 * Does this DMARC policy let a receiver display BIMI? The spec requires an
 * enforcing policy — quarantine or reject — applied to ALL mail (pct=100). For
 * a subdomain the `sp=` policy governs when it is present.
 */
export function dmarcEnforcesBimi(record: DmarcRecord | null, forSubdomain: boolean): boolean {
  if (!record) return false;
  const effective = forSubdomain && record.subdomainPolicy ? record.subdomainPolicy : record.policy;
  return (effective === 'quarantine' || effective === 'reject') && record.pct >= 100;
}

// ------------------------------------------------------------------- the logo

export interface SvgCheck {
  ok: boolean;
  /** Why it was rejected; null when ok. */
  reason: string | null;
  /** Declares `baseProfile="tiny-ps"`, the profile BIMI requires. */
  tinyPs: boolean;
}

const FORBIDDEN_SVG_TAGS = new Set(['script', 'foreignobject', 'iframe', 'embed', 'object', 'audio', 'video', 'animate', 'set', 'animatemotion', 'animatetransform']);

/**
 * Is this SVG safe to hand to an <img>? The logo is rendered as an image (a
 * `data:` URI), where a browser runs no script and loads no external
 * resource — so this is defence in depth, not the only line. It still rejects
 * anything a logo has no business containing: script and animation elements,
 * embedded documents, event handlers, and any reference that leaves the file.
 * Parsed as XML rather than pattern-matched, so a tag split across an entity
 * or an attribute quoted oddly cannot slip past.
 */
export function checkBimiSvg(bytes: Buffer): SvgCheck {
  if (bytes.length === 0) return { ok: false, reason: 'empty file', tinyPs: false };
  if (bytes.length > BIMI_LOGO_MAX_BYTES) return { ok: false, reason: `larger than ${BIMI_LOGO_MAX_BYTES / 1024} KB`, tinyPs: false };
  const text = bytes.toString('utf8');
  let root: string | null = null;
  let tinyPs = false;
  let reason: string | null = null;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (reason) return;
        const tag = name.toLowerCase();
        if (root === null) {
          root = tag;
          if (tag !== 'svg') { reason = 'not an SVG document'; return; }
          if ((attribs.baseProfile || attribs.baseprofile || '').toLowerCase() === 'tiny-ps') tinyPs = true;
        }
        if (FORBIDDEN_SVG_TAGS.has(tag)) { reason = `contains <${tag}>`; return; }
        for (const [attr, value] of Object.entries(attribs)) {
          const a = attr.toLowerCase();
          const v = (value || '').trim();
          if (a.startsWith('on')) { reason = `event handler attribute ${attr}`; return; }
          if ((a === 'href' || a === 'xlink:href' || a === 'src') && v && !v.startsWith('#')) {
            reason = `external reference in ${attr}`; return;
          }
          if (a === 'style' && /url\s*\(|@import|expression\s*\(/i.test(v)) { reason = 'external reference in style'; return; }
        }
      },
      ontext(data) {
        if (!reason && /url\s*\(\s*['"]?\s*(https?:|\/\/)|@import/i.test(data)) reason = 'external reference in stylesheet';
      },
      onerror() {
        if (!reason) reason = 'malformed XML';
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(text);
  parser.end();
  if (!reason && root === null) reason = 'not an SVG document';
  return { ok: reason === null, reason, tinyPs };
}

// ------------------------------------------------------ the certificate (VMC)

export type VmcStatus =
  | 'verified'
  | 'unparseable'
  | 'not-vmc'
  | 'expired'
  | 'not-yet-valid'
  | 'broken-chain'
  | 'untrusted-root'
  | 'domain-mismatch'
  | 'logo-mismatch';

export interface VmcResult {
  status: VmcStatus;
  /** Subject O — the brand owner the MVA verified. */
  organization: string | null;
  /** Issuer CN — which MVA CA signed it. */
  issuer: string | null;
  /** Issuer O. */
  issuerOrganization: string | null;
  /** Unix seconds. */
  notAfter: number | null;
  detail: string;
}

/** `AB:CD:…` upper-case, the form openssl prints and MVA_ROOTS records. */
export function fingerprintHex(der: ArrayBuffer | Uint8Array): string {
  return Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der))
    .toString('hex')
    .toUpperCase()
    .match(/.{2}/g)!
    .join(':');
}

export interface LogotypeEvidence {
  /** SHA-256 digests found in the extension, lower-case hex. */
  sha256: string[];
  /** SHA-1 digests, lower-case hex — RFC 3709's original algorithm, still issued. */
  sha1: string[];
  /** `data:` URIs found in the extension (the embedded logo, usually gzipped). */
  dataUris: string[];
}

/**
 * Pull the pieces that bind a logo out of an RFC 3709 logotype extension
 * value, walking the ASN.1 generically: every `SEQUENCE { AlgorithmIdentifier
 * (sha256), OCTET STRING }` is a hash, every IA5String starting `data:` is an
 * embedded logo. Generic on purpose — the exact nesting differs between
 * `direct` and `indirect` LogotypeInfo and between MVAs, and a schema that
 * matches one issuer's certificates would silently fail another's.
 */
export function extractLogotypeEvidence(extensionValue: ArrayBuffer | Uint8Array): LogotypeEvidence {
  const out: LogotypeEvidence = { sha256: [], sha1: [], dataUris: [] };
  const buf = extensionValue instanceof Uint8Array ? extensionValue : new Uint8Array(extensionValue);
  const parsed = asn1js.fromBER(buf);
  if (parsed.offset === -1) return out;

  // Only a CONSTRUCTED block's children are blocks. An ObjectIdentifier also
  // keeps a `value` array — its arcs — of plain sid records with no valueBlock
  // of their own, and descending into those is the crash the first real VMC
  // (Apple's) produced. Anything that is not a block is not walked.
  const isBlock = (x: unknown): x is asn1js.BaseBlock =>
    !!x && typeof x === 'object' && 'valueBlock' in (x as object) && 'idBlock' in (x as object);
  const children = (node: asn1js.BaseBlock): asn1js.BaseBlock[] => {
    if (node instanceof asn1js.ObjectIdentifier) return [];
    const value = (node.valueBlock as unknown as { value?: unknown })?.value;
    return Array.isArray(value) ? value.filter(isBlock) : [];
  };
  const oidOf = (node: asn1js.BaseBlock): string | null =>
    node instanceof asn1js.ObjectIdentifier ? node.valueBlock.toString() : null;

  const walk = (node: asn1js.BaseBlock): void => {
    if (!isBlock(node)) return;
    if (node instanceof asn1js.IA5String || node instanceof asn1js.Utf8String || node instanceof asn1js.PrintableString) {
      const s = (node.valueBlock as unknown as { value: string }).value;
      if (typeof s === 'string' && /^data:/i.test(s)) out.dataUris.push(s);
      return;
    }
    const kids = children(node);
    // HashAlgAndValue ::= SEQUENCE { hashAlg AlgorithmIdentifier, hashValue OCTET STRING }
    if (node instanceof asn1js.Sequence && kids.length === 2 && kids[0] instanceof asn1js.Sequence && kids[1] instanceof asn1js.OctetString) {
      const alg = children(kids[0])[0];
      const oid = alg ? oidOf(alg) : null;
      if (oid === SHA256_OID || oid === SHA1_OID) {
        (oid === SHA256_OID ? out.sha256 : out.sha1).push(Buffer.from(kids[1].valueBlock.valueHexView).toString('hex'));
        return;
      }
    }
    for (const kid of kids) walk(kid);
  };
  walk(parsed.result);
  return out;
}

/** The bytes a `data:` URI carries, gunzipped when it is gzip (VMCs embed the logo compressed). */
export function decodeLogoDataUri(uri: string): Buffer | null {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const meta = uri.slice(5, comma).toLowerCase();
  const payload = uri.slice(comma + 1);
  let bytes: Buffer;
  try {
    bytes = meta.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch {
    return null;
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return gunzipSync(bytes, { maxOutputLength: BIMI_LOGO_MAX_BYTES * 4 });
    } catch {
      return null;
    }
  }
  return bytes;
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha1Hex = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

function firstField(cert: X509Certificate, which: 'subject' | 'issuer', field: string): string | null {
  const name = which === 'subject' ? cert.subjectName : cert.issuerName;
  return name.getField(field)[0] ?? null;
}

/** The SAN dNSNames a VMC lists, lower-cased. */
export function vmcDomains(cert: X509Certificate): string[] {
  const san = cert.getExtension(SubjectAlternativeNameExtension);
  if (!san) return [];
  return san.names.items.filter((n) => n.type === 'dns').map((n) => n.value.toLowerCase());
}

export interface ValidateVmcOptions {
  /** Trust anchors; defaults to the pinned MVA roots. Tests pass their own. */
  roots?: readonly MarkVerifyingAuthorityRoot[];
  /** "Now" for the validity checks; defaults to the wall clock. */
  now?: Date;
}

/**
 * Validate a VMC chain for a domain and a logo. Every failure names its cause,
 * because the shield shows "logo published, certificate not verified: <why>"
 * rather than silently dropping to a plain logo.
 */
export async function validateVmc(
  pem: string,
  domain: string,
  logo: Buffer,
  opts: ValidateVmcOptions = {},
): Promise<VmcResult> {
  const now = opts.now ?? new Date();
  const roots = opts.roots ?? MVA_ROOTS;
  const fail = (status: VmcStatus, detail: string, leaf?: X509Certificate): VmcResult => ({
    status,
    organization: leaf ? firstField(leaf, 'subject', 'O') : null,
    issuer: leaf ? firstField(leaf, 'issuer', 'CN') : null,
    issuerOrganization: leaf ? firstField(leaf, 'issuer', 'O') : null,
    notAfter: leaf ? Math.floor(leaf.notAfter.getTime() / 1000) : null,
    detail,
  });

  let certs: X509Certificate[];
  try {
    certs = PemConverter.decode(pem).map((der) => new X509Certificate(der));
  } catch (e) {
    return fail('unparseable', `The certificate file could not be parsed: ${(e as Error).message}`);
  }
  if (certs.length === 0) return fail('unparseable', 'The certificate file contains no certificate');

  // The leaf is the one nobody else in the file was signed by.
  const issuers = new Set(certs.map((c) => c.issuer));
  const leaf = certs.find((c) => !issuers.has(c.subject)) ?? certs[0];

  const eku = leaf.getExtension(ExtendedKeyUsageExtension);
  if (!eku || !eku.usages.includes(BIMI_EKU_OID)) {
    return fail('not-vmc', 'The certificate is not a Verified Mark Certificate (no BIMI key usage)', leaf);
  }
  if (now < leaf.notBefore) return fail('not-yet-valid', `The certificate is not valid until ${leaf.notBefore.toISOString().slice(0, 10)}`, leaf);
  if (now > leaf.notAfter) return fail('expired', `The certificate expired on ${leaf.notAfter.toISOString().slice(0, 10)}`, leaf);

  // Chain to a PINNED root. The builder verifies every signature on the way;
  // what it cannot know is which self-signed certificate deserves trust.
  let rootCerts: X509Certificate[];
  try {
    rootCerts = roots.map((r) => new X509Certificate(r.pem));
  } catch (e) {
    return fail('untrusted-root', `Pinned root could not be loaded: ${(e as Error).message}`, leaf);
  }
  const builder = new X509ChainBuilder({ certificates: [...certs.filter((c) => c !== leaf), ...rootCerts] });
  let chain: X509Certificate[];
  try {
    chain = [...(await builder.build(leaf))];
  } catch (e) {
    return fail('broken-chain', `The certificate chain could not be built: ${(e as Error).message}`, leaf);
  }
  const top = chain[chain.length - 1];
  if (!(await top.isSelfSigned())) {
    return fail('broken-chain', `The chain stops at "${firstField(top, 'subject', 'CN') ?? top.subject}" without reaching a root`, leaf);
  }
  const topPrint = fingerprintHex(await top.getThumbprint('SHA-256'));
  const pinned = roots.find((r) => r.sha256.replace(/:/g, '').toUpperCase() === topPrint.replace(/:/g, ''));
  if (!pinned) {
    return fail('untrusted-root', `The chain ends at "${firstField(top, 'subject', 'CN') ?? top.subject}", which is not a recognised Mark Verifying Authority`, leaf);
  }
  for (const c of chain.slice(1)) {
    if (now < c.notBefore || now > c.notAfter) {
      return fail('expired', `An issuing certificate ("${firstField(c, 'subject', 'CN') ?? c.subject}") is outside its validity period`, leaf);
    }
  }

  // The domain. A VMC names the domains it covers; the From domain — or its
  // organisational domain, since BIMI records fall back to it — must be one.
  const wanted = domain.toLowerCase();
  const org = registrableDomain(wanted) ?? wanted;
  const names = vmcDomains(leaf);
  const domainOk = names.some((n) => n === wanted || n === org || wanted.endsWith('.' + n));
  if (!domainOk) {
    return fail('domain-mismatch', names.length
      ? `The certificate covers ${names.join(', ')}, not ${wanted}`
      : 'The certificate names no domain', leaf);
  }

  // The logo. The certificate binds a specific SVG by hash (and embeds it);
  // the file the domain serves has to be that one, or the tick would vouch
  // for a picture the MVA never saw.
  const logotype = leaf.getExtension(LOGOTYPE_EXTENSION_OID);
  if (!logotype) return fail('not-vmc', 'The certificate carries no logotype extension', leaf);
  const evidence = extractLogotypeEvidence(logotype.value);
  const bound = evidence.sha256.includes(sha256Hex(logo))
    || evidence.sha1.includes(sha1Hex(logo))
    || evidence.dataUris.some((u) => decodeLogoDataUri(u)?.equals(logo) === true);
  if (!bound) return fail('logo-mismatch', 'The logo the domain serves is not the one the certificate was issued for', leaf);

  return {
    status: 'verified',
    organization: firstField(leaf, 'subject', 'O'),
    issuer: firstField(leaf, 'issuer', 'CN'),
    issuerOrganization: firstField(leaf, 'issuer', 'O') ?? pinned.organization,
    notAfter: Math.floor(leaf.notAfter.getTime() / 1000),
    detail: `${firstField(leaf, 'subject', 'O') ?? 'The brand'} proved ownership of ${wanted} to ${pinned.organization}`,
  };
}

// --------------------------------------------------------------- the lookup

/** The subset of WHATWG `Response` the lookups read — `net.fetch` satisfies it. */
export interface FetchLike {
  (url: string): Promise<{
    ok: boolean;
    status: number;
    url?: string;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

export interface BimiDeps {
  /** `dns.promises.resolveTxt` shape: chunks per record. Missing-name errors are handled here. */
  resolveTxt: (name: string) => Promise<string[][]>;
  fetch: FetchLike;
  now?: () => Date;
  roots?: readonly MarkVerifyingAuthorityRoot[];
}

export type BimiStatus = 'verified' | 'logo' | 'declined' | 'none' | 'invalid' | 'error';

export interface BimiLookup {
  status: BimiStatus;
  /** The logo as a `data:image/svg+xml;base64,…` URI, for 'verified' and 'logo'. */
  logo: string | null;
  organization: string | null;
  issuer: string | null;
  /** Unix seconds; the VMC's notAfter. */
  certificateExpires: number | null;
  dmarcPolicy: DmarcPolicyValue | null;
  /** Which domain's record was used — the From domain or its organisational domain. */
  recordDomain: string | null;
  /** Why, in one sentence. Always set. */
  detail: string;
}

const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ESERVFAIL_NX']);

/** TXT records for a name, each record's chunks joined; [] when the name does not exist. */
export async function txtRecords(resolveTxt: BimiDeps['resolveTxt'], name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code && NO_RECORD_CODES.has(code)) return [];
    throw e;
  }
}

async function fetchBounded(fetch: FetchLike, url: string, maxBytes: number): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > maxBytes) return null;
  return { bytes, contentType: (res.headers.get('content-type') || '').toLowerCase() };
}

/**
 * Resolve a From domain's BIMI standing. DNS misses are answers ('none');
 * network failures are 'error', so the caller can retry soon instead of
 * caching a blank for a week.
 */
export async function lookupBimi(fromDomain: string, deps: BimiDeps): Promise<BimiLookup> {
  const domain = fromDomain.trim().toLowerCase();
  const org = registrableDomain(domain) ?? domain;
  const base = (over: Partial<BimiLookup>): BimiLookup => ({
    status: 'none', logo: null, organization: null, issuer: null, certificateExpires: null,
    dmarcPolicy: null, recordDomain: null, detail: '', ...over,
  });
  if (!domain) return base({ detail: 'No sender domain' });

  try {
    // A resolver failure (SERVFAIL, timeout) on a SUBDOMAIN's names is common
    // — `_dmarc.mailer.example.com` often does not exist as a zone at all —
    // and must not end the lookup: the organisational domain still has the
    // answer. A failure at the organisational domain is a real error.
    const txtLenient = async (name: string, lenient: boolean): Promise<string[]> => {
      try {
        return await txtRecords(deps.resolveTxt, name);
      } catch (e) {
        if (lenient) return [];
        throw e;
      }
    };

    // DMARC first: BIMI is only ever shown under an enforcing policy.
    let dmarc: DmarcRecord | null = null;
    let dmarcForSubdomain = false;
    for (const txt of await txtLenient(`_dmarc.${domain}`, org !== domain)) {
      dmarc = parseDmarcRecord(txt);
      if (dmarc) break;
    }
    if (!dmarc && org !== domain) {
      dmarcForSubdomain = true;
      for (const txt of await txtLenient(`_dmarc.${org}`, false)) {
        dmarc = parseDmarcRecord(txt);
        if (dmarc) break;
      }
    }
    const dmarcPolicy = dmarc ? (dmarcForSubdomain && dmarc.subdomainPolicy ? dmarc.subdomainPolicy : dmarc.policy) : null;

    // The BIMI record, at the From domain and then the organisational domain.
    let record: BimiRecord | null = null;
    let recordDomain: string | null = null;
    for (const candidate of org !== domain ? [domain, org] : [domain]) {
      for (const txt of await txtLenient(`${BIMI_SELECTOR}._bimi.${candidate}`, candidate !== org)) {
        record = parseBimiRecord(txt);
        if (record) { recordDomain = candidate; break; }
      }
      if (record) break;
    }
    if (!record) return base({ status: 'none', dmarcPolicy, detail: 'The domain publishes no BIMI record' });
    if (record.declined) return base({ status: 'declined', dmarcPolicy, recordDomain, detail: 'The domain declines to show a logo' });
    if (!record.logoUrl) return base({ status: 'invalid', dmarcPolicy, recordDomain, detail: 'The BIMI record has no https logo URL' });
    if (!dmarcEnforcesBimi(dmarc, dmarcForSubdomain)) {
      return base({
        status: 'invalid', dmarcPolicy, recordDomain,
        detail: `BIMI requires an enforcing DMARC policy; ${dmarcPolicy ? `the domain's is p=${dmarcPolicy}` : 'the domain publishes none'}`,
      });
    }

    const logoRes = await fetchBounded(deps.fetch, record.logoUrl, BIMI_LOGO_MAX_BYTES);
    if (!logoRes) return base({ status: 'invalid', dmarcPolicy, recordDomain, detail: `The logo could not be downloaded, or is larger than ${BIMI_LOGO_MAX_BYTES / 1024} KB` });
    const svg = checkBimiSvg(logoRes.bytes);
    if (!svg.ok) return base({ status: 'invalid', dmarcPolicy, recordDomain, detail: `The logo was rejected: ${svg.reason}` });
    const logo = `data:image/svg+xml;base64,${logoRes.bytes.toString('base64')}`;

    if (!record.evidenceUrl) {
      return base({ status: 'logo', logo, dmarcPolicy, recordDomain, detail: 'The domain publishes a logo but no Verified Mark Certificate' });
    }
    const pemRes = await fetchBounded(deps.fetch, record.evidenceUrl, BIMI_EVIDENCE_MAX_BYTES);
    if (!pemRes) {
      return base({ status: 'logo', logo, dmarcPolicy, recordDomain, detail: 'The certificate could not be downloaded' });
    }
    const vmc = await validateVmc(pemRes.bytes.toString('utf8'), domain, logoRes.bytes, { roots: deps.roots, now: deps.now?.() });
    if (vmc.status !== 'verified') {
      return base({
        status: 'logo', logo, dmarcPolicy, recordDomain,
        organization: vmc.organization, issuer: vmc.issuer, certificateExpires: vmc.notAfter,
        detail: `Certificate not verified: ${vmc.detail}`,
      });
    }
    return base({
      status: 'verified', logo, dmarcPolicy, recordDomain,
      organization: vmc.organization, issuer: vmc.issuer, certificateExpires: vmc.notAfter,
      detail: vmc.detail,
    });
  } catch (e) {
    return base({ status: 'error', detail: `Lookup failed: ${(e as Error)?.message ?? String(e)}` });
  }
}
