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
 */
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
