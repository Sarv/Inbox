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
 * All of that — the record grammar, the chain verification, the pinned roots,
 * the SVG Tiny PS rules — is `@sarv-in/mailguard/brand` now; this module
 * is the seam. Everything network-shaped (DNS, HTTPS) is still injected, so
 * the whole policy stays unit-testable with a fake resolver and fetch, and the
 * main process hands in Chromium's `net.fetch`. Nothing here caches; the
 * caller does (see domain-identity-store.ts).
 *
 * The certificate half runs on the library's OPTIONAL peer dependencies —
 * `@peculiar/x509` (with `reflect-metadata` loaded first, which the library
 * does itself) and `asn1js` — so they are dependencies of this package. When
 * one is missing nothing throws: every certificate lands as "logo, certificate
 * not verified" and no sender ever gets the tick. {@link vmcVerifierUnavailable}
 * is how a caller finds that out instead.
 */
import { extractLogotypeEvidence, validateVmc } from '@sarv-in/mailguard/brand';

export {
  BIMI_SELECTOR,
  BIMI_EVIDENCE_MAX_BYTES,
  BIMI_LOGO_MAX_BYTES,
  BIMI_EKU_OID,
  LOGOTYPE_EXTENSION_OID,
  MVA_ROOTS,
  parseBimiRecord,
  parseDmarcRecord,
  dmarcEnforcesBimi,
  checkBimiSvg,
  fingerprintHex,
  extractLogotypeEvidence,
  decodeLogoDataUri,
  vmcDomains,
  validateVmc,
  lookupBimi,
  fetchBounded,
  defaultFetch,
} from '@sarv-in/mailguard/brand';

export type {
  MarkVerifyingAuthorityRoot,
  BimiRecord,
  BimiStatus,
  BimiLookup,
  BimiOptions,
  DmarcRecord,
  DmarcPolicyValue,
  SvgCheck,
  LogotypeEvidence,
  VmcStatus,
  VmcResult,
  ValidateVmcOptions,
  FetchLike,
  FetchResponse,
  FetchedBytes,
  FetchBoundedOptions,
} from '@sarv-in/mailguard/brand';

/**
 * Why this build cannot verify a Verified Mark Certificate, or null when it can.
 *
 * Each library call loads its optional peer before it looks at its input, and
 * throws only when that peer cannot be loaded: `validateVmc` needs
 * `@peculiar/x509`, `extractLogotypeEvidence` needs `asn1js`. Given nothing to
 * check, both otherwise answer at once without touching the network.
 */
export async function vmcVerifierUnavailable(): Promise<string | null> {
  try {
    await validateVmc('', '', new Uint8Array(0));
    await extractLogotypeEvidence(new Uint8Array(0));
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
