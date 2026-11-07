# Verified Mark Certificate fixture

A **throwaway test PKI** shaped like a real Mark Verifying Authority's, made
only for `bimi.test.ts`. It protects nothing, no real software trusts it, and
its private keys were never written to disk.

- `mva-root.pem`: "Inbox Test Verified Mark Root", self-signed. Tests pin it
  by SHA-256 `82:F8:C2:3F:D6:B0:F0:14:50:24:1C:6A:CD:F5:B8:3F:BD:27:72:21:D4:C5:C7:6F:34:1D:66:D4:52:06:8C:88`,
  the way `MVA_ROOTS` pins the real three.
- `vmc-chain.pem`: what a brand serves at its BIMI `a=` URL. The VMC leaf for
  `brand.example` (organisation "Example Brand Inc", BIMI extended key usage,
  RFC 3709 logotype extension) comes first, then "Inbox Test Verified Mark
  Issuing CA", which the root signed.
- `logo.svg`: the SVG Tiny PS logo the leaf's logotype extension binds, both
  by SHA-256 and as an embedded gzipped `data:` URI.

Every certificate is valid from 2026-01-01; the leaf until 2036-01-01, the two
CAs until 2046-01-01. Tests pass their own `now`, so the fixture does not
expire under them.

Regenerate all three PEM outputs with `node generate.mjs` from the repository
root (it needs `@peculiar/x509`, `asn1js` and `reflect-metadata`, which are
dependencies of `@sarvinbox/core`), then update the pinned fingerprint above
and in `bimi.test.ts`. The files are marked `-text` in `.gitattributes`: the
logotype hash covers `logo.svg`'s exact bytes.
