import { describe, expect, it } from 'vitest';

import {
  BIMI_EKU_OID,
  BIMI_EVIDENCE_MAX_BYTES,
  BIMI_LOGO_MAX_BYTES,
  BIMI_SELECTOR,
  LOGOTYPE_EXTENSION_OID,
  MVA_ROOTS,
  checkBimiSvg,
  decodeLogoDataUri,
  dmarcEnforcesBimi,
  extractLogotypeEvidence,
  fetchBounded,
  fingerprintHex,
  defaultFetch,
  lookupBimi,
  parseBimiRecord,
  parseDmarcRecord,
  validateVmc,
  vmcDomains,
} from '../../../src/utils/bimi';

/**
 * BIMI and the Verified Mark Certificate behind the blue tick — as Inbox sees
 * it, now that the record grammar, the chain verification, the pinned roots
 * and the SVG Tiny PS rules are `@sarv-in/email-spam-scan/brand`.
 *
 * The behaviour coverage moved with the code: the library's own
 * `brand-bimi`, `brand-vmc`, `brand-records` and `brand-svg` suites (about
 * 1,050 lines) build real certificate chains and pin every single defect —
 * an unpinned root, a certificate for another domain, a logo the certificate
 * never saw, a policy that lets spoofers through. Re-running that here would
 * be the same assertions against the same code.
 *
 * What is pinned HERE is what Inbox owns and could lose without noticing:
 *
 *   1. the seam itself — a mistyped re-export is not a type error in a
 *      renderer that imports the barrel, it is a crash at first use;
 *   2. the trust anchors — a library upgrade that adds, drops or rotates a
 *      Mark Verifying Authority changes who can mint a blue tick in Inbox,
 *      and that is a decision, not an upgrade note; and
 *   3. the contract domain-identity-store.ts caches against: what a lookup
 *      answers for a plain domain, an enforcing policy, a weak policy, and a
 *      resolver that failed.
 */
describe('the brand seam', () => {
  it('re-exports every symbol the main process and the store import', () => {
    for (const fn of [
      parseBimiRecord, parseDmarcRecord, dmarcEnforcesBimi, checkBimiSvg, fingerprintHex,
      extractLogotypeEvidence, decodeLogoDataUri, vmcDomains, validateVmc, lookupBimi,
      fetchBounded, defaultFetch,
    ]) expect(typeof fn).toBe('function');
    expect(BIMI_SELECTOR).toBe('default');
    expect(BIMI_EKU_OID).toBe('1.3.6.1.5.5.7.3.31');
    expect(LOGOTYPE_EXTENSION_OID).toBe('1.3.6.1.5.5.7.1.12');
    expect(BIMI_LOGO_MAX_BYTES).toBe(64 * 1024);
    expect(BIMI_EVIDENCE_MAX_BYTES).toBe(64 * 1024);
  });

  // WHO CAN MINT A TICK. These three authorities, by fingerprint, are the whole
  // trust decision; anything the library adds later must be reviewed here first.
  it('trusts exactly the three Mark Verifying Authorities Inbox reviewed', () => {
    expect(MVA_ROOTS.map((root) => `${root.name} ${root.sha256}`)).toEqual([
      'DigiCert Verified Mark Root CA 50:43:86:C9:EE:89:32:FE:CC:95:FA:DE:42:7F:69:C3:E2:53:4B:73:10:48:9E:30:0F:EE:44:8E:33:C4:6B:42',
      'Entrust Verified Mark Root Certification Authority - VMCR1 78:31:D9:5A:47:D4:25:08:CD:5C:9E:62:64:F9:09:6B:AC:19:F0:4E:B9:B7:C8:BD:D3:5F:FF:C7:1C:18:96:17',
      'GlobalSign Verified Mark Root R42 CD:12:2C:B8:77:C6:92:8B:90:17:B0:F0:B8:0D:BD:50:81:96:30:0B:BD:03:CD:73:56:C3:BE:EF:52:4E:7E:0B',
    ]);
    for (const root of MVA_ROOTS) {
      expect(root.pem.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
      expect(root.source.startsWith('https://')).toBe(true);
    }
  });
});

describe('lookupBimi through the seam', () => {
  const SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 10 10"><title>Example</title><circle cx="5" cy="5" r="4" fill="#0a0"/></svg>';
  const LOGO = 'https://brand.example/logo.svg';

  /** The library's resolver contract: a name that does not exist is no records, not an error. */
  const query = (records: Record<string, string[]>) => async (name: string): Promise<string[]> => {
    if (name === 'boom.example' || name.endsWith('.boom.example')) throw new Error('ESERVFAIL');
    return records[name] ?? [];
  };
  const fetchSvg = async (url: string) => {
    if (url !== LOGO) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(SVG);
    return {
      ok: true, status: 200, url,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/svg+xml' : String(body.byteLength)) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  };
  const look = (domain: string, records: Record<string, string[]> = {}) =>
    lookupBimi(domain, { query: query(records), fetch: fetchSvg as never });

  // Four answers the cache stores differently: "none" is cacheable for a long
  // time, "logo" is the picture, "invalid" must never show one, and "error"
  // must be retried rather than remembered as "this brand has no logo".
  it('answers none, logo, invalid and error — and never confuses the last two', async () => {
    expect((await look('plain.example')).status).toBe('none');

    const enforcing = await look('brand.example', {
      '_dmarc.brand.example': ['v=DMARC1; p=quarantine'],
      'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`],
    });
    expect(enforcing.status).toBe('logo');
    expect(enforcing.logo).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`);
    expect(enforcing.dmarcPolicy).toBe('quarantine');
    expect(enforcing.recordDomain).toBe('brand.example');

    // THE premise: no enforcing DMARC, no logo, whatever the record says.
    const weak = await look('brand.example', {
      '_dmarc.brand.example': ['v=DMARC1; p=none'],
      'default._bimi.brand.example': [`v=BIMI1; l=${LOGO}`],
    });
    expect(weak.status).toBe('invalid');
    expect(weak.logo).toBeNull();

    const broken = await look('boom.example');
    expect(broken.status).toBe('error');
    expect(broken.detail).toContain('ESERVFAIL');
  });
});
