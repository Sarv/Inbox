/**
 * The throwaway Verified Mark Certificate fixture (see README.md), loaded, and
 * brand.example's DNS and HTTPS as a BIMI lookup sees them. Shared by core's
 * bimi tests and the desktop sender-identity tests, which run the real lookup
 * over it.
 */
import { readFileSync } from 'node:fs';

import type { MarkVerifyingAuthorityRoot } from '@sarv-in/mailguard/brand';

const file = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url));

export const VMC_DOMAIN = 'brand.example';
export const VMC_LOGO = file('logo.svg');
export const VMC_CHAIN = file('vmc-chain.pem').toString('utf8');
export const VMC_ROOT: MarkVerifyingAuthorityRoot = {
  name: 'Inbox Test Verified Mark Root',
  organization: 'Inbox Test MVA',
  source: 'packages/core/test/unit/utils/fixtures/bimi/mva-root.pem',
  sha256: '82:F8:C2:3F:D6:B0:F0:14:50:24:1C:6A:CD:F5:B8:3F:BD:27:72:21:D4:C5:C7:6F:34:1D:66:D4:52:06:8C:88',
  pem: file('mva-root.pem').toString('utf8'),
};
/** Inside every certificate's validity (2026-01-01 to 2036-01-01), forever. */
export const VMC_NOW = new Date('2026-06-01T00:00:00Z');

/** What the leaf says, as validateVmc reports a pass. */
export const VMC_VERIFIED = {
  status: 'verified',
  organization: 'Example Brand Inc',
  issuer: 'Inbox Test Verified Mark Issuing CA',
  issuerOrganization: 'Inbox Test MVA',
  notAfter: Date.parse('2036-01-01T00:00:00Z') / 1000,
  detail: 'Example Brand Inc proved ownership of brand.example to Inbox Test MVA',
} as const;

const LOGO_URL = `https://${VMC_DOMAIN}/bimi/logo.svg`;
const VMC_URL = `https://${VMC_DOMAIN}/bimi/vmc.pem`;

const RECORDS: Record<string, string[]> = {
  [`_dmarc.${VMC_DOMAIN}`]: ['v=DMARC1; p=reject'],
  [`default._bimi.${VMC_DOMAIN}`]: [`v=BIMI1; l=${LOGO_URL}; a=${VMC_URL}`],
};

const BODIES: Record<string, { type: string; body: Buffer }> = {
  [LOGO_URL]: { type: 'image/svg+xml', body: VMC_LOGO },
  [VMC_URL]: { type: 'application/x-pem-file', body: Buffer.from(VMC_CHAIN) },
};

/** brand.example's DNS: an enforcing DMARC policy and a BIMI record with both URLs. A name it lacks has no records. */
export async function vmcBrandDns(name: string): Promise<string[]> {
  return RECORDS[name] ?? [];
}

/** brand.example's web server: the logo and the certificate chain, 404 for anything else. */
export async function vmcBrandFetch(url: string) {
  const hit = BODIES[url];
  if (!hit) return { ok: false, status: 404, url, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? hit.type : String(hit.body.byteLength)) },
    arrayBuffer: async () => hit.body.buffer.slice(hit.body.byteOffset, hit.body.byteOffset + hit.body.byteLength) as ArrayBuffer,
  };
}

/** lookupBimi's options for brand.example, with the fixture's root pinned. */
export const vmcLookupOptions = () => ({
  query: vmcBrandDns,
  fetch: vmcBrandFetch as never,
  roots: [VMC_ROOT],
  now: () => VMC_NOW,
});
