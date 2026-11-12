// Regenerates the Verified Mark Certificate fixture in this directory. Run it
// from the repository root:
//
//   node packages/core/test/unit/utils/fixtures/bimi/generate.mjs
//
// It mints a throwaway three-level PKI shaped like a real Mark Verifying
// Authority's: a self-signed root, an issuing intermediate, and a VMC leaf for
// brand.example that carries the BIMI extended key usage and an RFC 3709
// logotype extension binding logo.svg (by SHA-256 and by an embedded gzipped
// copy, as MVAs issue them). The private keys exist only in memory and are
// thrown away when the script exits. See README.md for what each file is.
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
require('reflect-metadata'); // must precede @peculiar/x509 (tsyringe needs the polyfill)
const x509 = require('@peculiar/x509');
const asn1js = require('asn1js');

x509.cryptoProvider.set(webcrypto);

const here = (name) => new URL(`./${name}`, import.meta.url);
const BIMI_EKU_OID = '1.3.6.1.5.5.7.3.31';
const LOGOTYPE_EXTENSION_OID = '1.3.6.1.5.5.7.1.12';
const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const NOT_BEFORE = new Date('2026-01-01T00:00:00Z');
const CA_NOT_AFTER = new Date('2046-01-01T00:00:00Z');
const LEAF_NOT_AFTER = new Date('2036-01-01T00:00:00Z');

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/** LogotypeExtn { subjectLogo [2] direct [0] LogotypeData { image { LogotypeDetails } } }. */
function logotype(svg) {
  const hash = new asn1js.Sequence({ value: [
    new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: SHA256_OID })] }),
    new asn1js.OctetString({ valueHex: toArrayBuffer(createHash('sha256').update(svg).digest()) }),
  ] });
  const details = new asn1js.Sequence({ value: [
    new asn1js.IA5String({ value: 'image/svg+xml' }),
    new asn1js.Sequence({ value: [hash] }),
    new asn1js.Sequence({ value: [
      new asn1js.IA5String({ value: `data:image/svg+xml;base64,${gzipSync(svg).toString('base64')}` }),
    ] }),
  ] });
  const logotypeData = new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [details] })] })] });
  const direct = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 0 }, value: [logotypeData] });
  const subjectLogo = new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 2 }, value: [direct] });
  return new asn1js.Sequence({ value: [subjectLogo] }).toBER();
}

async function keys() {
  return webcrypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
}

const svg = readFileSync(here('logo.svg'));

const rootKeys = await keys();
const root = await x509.X509CertificateGenerator.createSelfSigned({
  serialNumber: '01',
  name: 'CN=Inbox Test Verified Mark Root, O=Inbox Test MVA, C=US',
  notBefore: NOT_BEFORE,
  notAfter: CA_NOT_AFTER,
  signingAlgorithm: SIGN_ALG,
  keys: rootKeys,
  extensions: [
    new x509.BasicConstraintsExtension(true, 1, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    await x509.SubjectKeyIdentifierExtension.create(rootKeys.publicKey),
  ],
});

const intermediateKeys = await keys();
const intermediate = await x509.X509CertificateGenerator.create({
  serialNumber: '02',
  subject: 'CN=Inbox Test Verified Mark Issuing CA, O=Inbox Test MVA, C=US',
  issuer: root.subject,
  notBefore: NOT_BEFORE,
  notAfter: CA_NOT_AFTER,
  signingAlgorithm: SIGN_ALG,
  publicKey: intermediateKeys.publicKey,
  signingKey: rootKeys.privateKey,
  extensions: [
    new x509.BasicConstraintsExtension(true, 0, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    await x509.SubjectKeyIdentifierExtension.create(intermediateKeys.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(rootKeys.publicKey),
  ],
});

const leafKeys = await keys();
const leaf = await x509.X509CertificateGenerator.create({
  serialNumber: '03',
  subject: 'CN=Example Brand, O=Example Brand Inc, C=US',
  issuer: intermediate.subject,
  notBefore: NOT_BEFORE,
  notAfter: LEAF_NOT_AFTER,
  signingAlgorithm: SIGN_ALG,
  publicKey: leafKeys.publicKey,
  signingKey: intermediateKeys.privateKey,
  extensions: [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
    new x509.ExtendedKeyUsageExtension([BIMI_EKU_OID]),
    new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'brand.example' }]),
    await x509.AuthorityKeyIdentifierExtension.create(intermediateKeys.publicKey),
    new x509.Extension(LOGOTYPE_EXTENSION_OID, false, logotype(svg)),
  ],
});

// What a domain serves at its BIMI a= URL: the leaf first, then its issuer.
writeFileSync(here('vmc-chain.pem'), `${leaf.toString('pem')}\n${intermediate.toString('pem')}\n`);
writeFileSync(here('mva-root.pem'), `${root.toString('pem')}\n`);

const thumbprint = Buffer.from(await root.getThumbprint('SHA-256')).toString('hex').toUpperCase().match(/../g).join(':');
// eslint-disable-next-line no-console -- a one-off generator run by hand; the fingerprint goes into the tests
console.log(`mva-root.pem SHA-256: ${thumbprint}`);
