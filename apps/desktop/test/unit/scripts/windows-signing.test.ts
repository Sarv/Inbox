import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDn } from 'builder-util-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CODE_SIGNING_EKU,
  DEFAULT_CONFIG_PATH,
  JSIGN_JAR_ENV,
  SIGNING_TOKEN_ENV,
  appUpdatePublisherProblem,
  builderOptionsProblems,
  classifyJsignFailure,
  collectReleasePeFiles,
  configShapeProblems,
  describePreviousRelease,
  electronBuilderSign,
  enabledConfigProblems,
  evaluateSignatures,
  fetchJsign,
  formatGithubOutput,
  googleCloudSigner,
  jsignArgs,
  loadWindowsSigningConfig,
  lookupPreviousRelease,
  parseAuthenticodeJson,
  peFileKind,
  pkcs12Signer,
  previousConfigProblems,
  previousReleaseProblems,
  publicKeySha256,
  publisherFromCertificate,
  queryAuthenticode,
  readFileCertificateTable,
  selectSigningCertificate,
  signPeFile,
  signingSettings,
  splitPemCertificates,
  statusOutputs,
  subjectCommonName,
  verifyPeSignedCli,
  verifyWinSignaturesCli,
  verifyWindowsRelease,
  windowsSigningCli,
  type AuthenticodeResult,
  type EnabledSigning,
  type GhRun,
  type HookState,
  type PreviousRelease,
  type Run,
} from '../../../../../scripts/lib/windows-signing.mjs';

import { appendSignature, fullPe, winCertificate } from './helpers/synthetic-pe';

/**
 * Guards the Windows Authenticode signing pipeline (scripts/lib/windows-signing.mjs,
 * apps/desktop/build/windowsSign.js, the release workflow's checks).
 *
 * The stakes are asymmetric. The first signed release writes a publisherName
 * into every installed copy's app-update.yml; from then on electron-updater
 * refuses any update not signed by that publisher. So the two regressions this
 * file exists for are:
 *
 *  - signing that silently does not happen (or happens with the wrong key,
 *    without a timestamp, or without pinning the publisher) once it is on --
 *    the next release then strands every Windows user on the version they have;
 *  - signing that switches on, or pins a publisher, BEFORE the certificate is
 *    committed -- an unsigned build carrying publisherName bricks updates the
 *    same way.
 *
 * Everything runs on synthetic PE buffers, throwaway openssl test certificates
 * (fixtures/windows-signing, no private keys) and fake process runners, so it
 * needs neither Windows, Java nor the real certificate. The real jsign and
 * Get-AuthenticodeSignature are exercised by CI's Windows signing self-test.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/windows-signing/', import.meta.url));
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const cert = (name: string) => new X509Certificate(fixture(name));

const LEAF = 'test-leaf-signed-by-ca.pem';
const CA = 'test-ca.pem';
// openssl x509 -in <leaf> -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum
// -- independent of the code under test, so a change in what gets hashed fails.
const LEAF_KEY_SHA256 = 'f5d2799a16577560f723ab81fa70711ef2125adcd6488aa18acd08acbb32e6b1';
// The test leaf CERTIFICATE's SHA-256 fingerprint, as Node prints it
// ("AB:CD:…") and as the PowerShell query prints it (no separators): our own
// files must be signed with exactly this certificate.
const LEAF_CERT_SHA256 = new X509Certificate(
  readFileSync(
    new URL('./fixtures/windows-signing/test-leaf-signed-by-ca.pem', import.meta.url),
    'utf8'
  )
).fingerprint256;
const LEAF_CERT_SHA256_PS = LEAF_CERT_SHA256.split(':').join('');
const NOW = new Date('2026-10-16T00:00:00Z');
const PUBLISHER = 'Sarv Inbox Test Publisher';

// The shape of the real certificate (throwaway keys, "TEST ONLY" issuers):
// leaf "C=IN, ST=Rajasthan, O=…, CN=SARV WEBS PRIVATE LIMITED", RSA-3072,
// SHA-384, valid 2026-11-01 to 2027-12-05, issued by an R36-style code-signing
// CA under an R46-style root that is itself cross-signed (so the root in the
// file is NOT self-signed), delivered leaf first.
const SECTIGO_SHAPED_CHAIN = 'test-sectigo-shaped-chain.pem';
const REAL_CN = 'SARV WEBS PRIVATE LIMITED';
// openssl x509 -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum, on the leaf.
const SECTIGO_SHAPED_KEY_SHA256 =
  '562ec9a7fdda0b1ae43d43073da4a394c424eefc429830b650af7e575ab91901';
const PROVIDER =
  'projects/123456789/locations/global/workloadIdentityPools/github-release/providers/sarv-inbox-tags';

const committedConfig = () =>
  JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf8')) as Record<string, any>;

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'winsign-test-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A config directory in the scratch area; `chain` undefined = no chain file
 * (disabled). publisherNames is set for both states rather than inherited from
 * the committed file, which carries the real name once signing is switched on:
 * [] without a chain, the test leaf's CN with one; overrides win.
 */
const writeConfig = (overrides: Record<string, unknown> = {}, chain?: string): string => {
  const dir = mkdtempSync(join(scratch, 'config-'));
  const config: Record<string, unknown> = {
    ...committedConfig(),
    publicKeySha256: LEAF_KEY_SHA256,
    workloadIdentityProvider: PROVIDER,
    publisherNames: chain === undefined ? [] : [PUBLISHER],
    ...overrides,
  };
  writeFileSync(join(dir, 'windows-signing.json'), JSON.stringify(config));
  if (chain !== undefined) writeFileSync(join(dir, config.certificateChain as string), chain);
  return join(dir, 'windows-signing.json');
};
const leafChain = () => fixture(LEAF) + fixture(CA);
const loadEnabled = (path = writeConfig({}, leafChain())) =>
  loadWindowsSigningConfig(path, { now: NOW }) as EnabledSigning;

const writeFile = (name: string, bytes: Buffer): string => {
  const file = join(scratch, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
};

describe('the committed windows-signing.json', () => {
  // A typo in the committed config must fail `pnpm test` today, not the
  // release that first switches signing on.
  it('has a valid shape', () => {
    expect(configShapeProblems(committedConfig())).toEqual([]);
  });

  // The dormancy rule, tied to the file system rather than a flag: signing is
  // on exactly when the chain is committed. Loading must never throw while it
  // is off, or every Windows build breaks before the certificate even exists.
  it('is enabled exactly when the certificate chain is committed', () => {
    const loaded = loadWindowsSigningConfig();
    expect(loaded.enabled).toBe(
      existsSync(join(dirname(DEFAULT_CONFIG_PATH), 'windows-signing-chain.pem'))
    );
  });

  // The pins the release depends on. Changing the KMS key or jsign build must
  // be a visible edit to this test, not a quiet config change.
  it('pins the KMS key version, the sha256-only key digest and the jsign build', () => {
    const config = committedConfig();
    expect(config.kms.keyVersion).toBe('sarv-inbox-authenticode/cryptoKeyVersions/1');
    expect(config.publicKeySha256).toBe(
      '9b55c5a8db46d2b30c0ee69af9099442342b0cf913de775edbb84dfa78b600a8'
    );
    expect(config.jsign).toEqual({
      version: '7.5',
      url: 'https://github.com/ebourg/jsign/releases/download/7.5/jsign-7.5.jar',
      sha256: '602a51c3545a6dc4fb99bd2ea7152b26d1345916d0c93ddfbd5936cb735af91c',
    });
    // DigiCert first: Sectigo asks for 15 s between requests, and a release
    // makes ~20 back to back.
    expect(config.timestampUrls[0]).toBe('http://timestamp.digicert.com');
  });

  // The publisher pin is filled in by the switch-on change, together with the
  // chain. Committed non-empty without the chain, every release would fail on
  // the one-way latch; committed with a guessed name, the first signed release
  // could pin the wrong one.
  it('keeps publisherNames empty while no chain is committed', () => {
    if (!existsSync(join(dirname(DEFAULT_CONFIG_PATH), 'windows-signing-chain.pem'))) {
      expect(committedConfig().publisherNames).toEqual([]);
    } else {
      expect(committedConfig().publisherNames.length).toBeGreaterThan(0);
    }
  });
});

describe('configShapeProblems', () => {
  // Each malformed field is named, so the release log says what to fix.
  it.each([
    ['kms', 'nope', /kms: must be an object/],
    ['kms', { keyRing: 'codesign', keyVersion: 'k/cryptoKeyVersions/1' }, /kms.keyRing/],
    [
      'kms',
      { keyRing: 'projects/p-1/locations/l/keyRings/r', keyVersion: 'sarv-inbox-authenticode' },
      /must pin a version/,
    ],
    [
      'kms',
      {
        keyRing: 'projects/p-1/locations/l/keyRings/r',
        keyVersion: 'k/cryptoKeyVersions/1',
        extra: 1,
      },
      /kms.extra: unknown key/,
    ],
    ['publicKeySha256', 'ABC', /publicKeySha256/],
    ['certificateChain', '../chain.pem', /certificateChain/],
    ['certificateChain', 'chain.crt', /certificateChain/],
    ['workloadIdentityProvider', 7, /workloadIdentityProvider: must be a string/],
    [
      'workloadIdentityProvider',
      'projects/abc/providers/x',
      /workloadIdentityProvider: must be projects/,
    ],
    ['serviceAccount', 1, /serviceAccount: must be a string/],
    ['serviceAccount', 'gha@gmail.com', /serviceAccount: must be/],
    ['timestampUrls', [], /timestampUrls: must list/],
    ['timestampUrls', ['ftp://ts.example'], /must use http: or https:/],
    ['timestampUrls', ['not a url'], /is not a URL/],
    ['programName', ' ', /programName/],
    ['programUrl', 'http://inbox.sarv.com', /programUrl: .* must use https:/],
    ['programUrl', 5, /programUrl: must be a URL/],
    ['jsign', null, /jsign: must be an object/],
    [
      'jsign',
      { version: '', url: 'https://x/jsign-.jar', sha256: 'a'.repeat(64) },
      /jsign.version/,
    ],
    [
      'jsign',
      { version: '7.6', url: 'https://x/jsign-7.5.jar', sha256: 'a'.repeat(64) },
      /must end in \/jsign-7.6.jar/,
    ],
    [
      'jsign',
      { version: '7.5', url: 'http://x/jsign-7.5.jar', sha256: 'a'.repeat(64) },
      /jsign.url/,
    ],
    ['jsign', { version: '7.5', url: 'https://x/jsign-7.5.jar', sha256: 'nope' }, /jsign.sha256/],
    [
      'jsign',
      { version: '7.5', url: 'https://x/jsign-7.5.jar', sha256: 'a'.repeat(64), mirror: 'x' },
      /jsign.mirror: unknown key/,
    ],
    // A pinned name electron-updater could never match is refused while
    // signing is still off, not on the release that switches it on.
    ['publisherNames', REAL_CN, /publisherNames: must be a list/],
    ['publisherNames', [7], /publisherNames\[0\]: 7 is not a string/],
    [
      'publisherNames',
      [REAL_CN, 'Sarv, Inc.'],
      /publisherNames\[1\]: "Sarv, Inc\." uses characters Windows and Node spell differently/,
    ],
    ['publisherNames', [`${REAL_CN} `], /publisherNames\[0\]: .* ends in whitespace/],
    ['publisherNames', [REAL_CN, REAL_CN], /publisherNames: lists a name twice/],
  ])('rejects a bad %s', (key, value, message) => {
    const problems = configShapeProblems({ ...committedConfig(), [key]: value });
    expect(problems.join('\n')).toMatch(message);
  });

  // A misspelt key ("publicKeySHA256") would otherwise be ignored and the real
  // one reported missing -- or worse, a setting silently not applied.
  it('rejects unknown top-level keys and non-objects', () => {
    expect(configShapeProblems({ ...committedConfig(), publisherName: 'X' })).toContain(
      'publisherName: unknown key (a typo here would be silently ignored)'
    );
    expect(configShapeProblems([])).toEqual(['the configuration must be a JSON object']);
    expect(configShapeProblems(null)).toEqual(['the configuration must be a JSON object']);
  });

  // publisherNames is REQUIRED: a config that lost the key must not read as
  // "no names pinned", which is what switches the one-way latch off.
  it('requires publisherNames, and accepts the empty list and a transition list', () => {
    const { publisherNames: _dropped, ...withoutNames } = committedConfig();
    expect(configShapeProblems(withoutNames).join('\n')).toMatch(/publisherNames: must be a list/);
    expect(configShapeProblems({ ...committedConfig(), publisherNames: [] })).toEqual([]);
    expect(
      configShapeProblems({
        ...committedConfig(),
        publisherNames: [REAL_CN, 'Sarv Webs Old Name Ltd.'],
      })
    ).toEqual([]);
  });
});

describe('enabledConfigProblems', () => {
  // The provider is "" until the owner creates it. That is fine while dormant
  // and fatal once enabled: the auth step would fail with a less clear error.
  // Changed deliberately: enabledConfigProblems now also reads publisherNames,
  // so both calls pass it (the assertions on the provider and service account
  // are unchanged). An enabled config with no pinned name would let the first
  // signed release pin whatever CN the chain happens to carry.
  it('requires the identity provider, the service account and a pinned publisher once enabled', () => {
    const complete = {
      workloadIdentityProvider: PROVIDER,
      serviceAccount: 'a@b.iam.gserviceaccount.com',
      publisherNames: [PUBLISHER],
    };
    expect(enabledConfigProblems(complete)).toEqual([]);
    const problems = enabledConfigProblems({
      workloadIdentityProvider: '',
      serviceAccount: '',
      publisherNames: [],
    });
    expect(problems.join('\n')).toMatch(/workloadIdentityProvider is empty/);
    expect(problems.join('\n')).toMatch(/serviceAccount is empty/);
    expect(problems.join('\n')).toMatch(/publisherNames is empty/);
  });
});

describe('splitPemCertificates', () => {
  // A CA's chain download is leaf + intermediates in one file, often with
  // "subject=" comment lines between blocks. Every certificate must come out.
  it('splits a bundle and ignores text between blocks', () => {
    const bundle = `subject=CN=leaf\n${fixture(LEAF)}\nsubject=CN=ca\r\n${fixture(CA).replace(/\n/g, '\r\n')}`;
    const blocks = splitPemCertificates(bundle);
    expect(blocks).toHaveLength(2);
    expect(new X509Certificate(blocks[0]).subject).toContain(`CN=${PUBLISHER}`);
    expect(new X509Certificate(blocks[1]).ca).toBe(true);
    expect(splitPemCertificates('no certificates here')).toEqual([]);
  });

  // A damaged chain must be an error, not "fewer certificates".
  it('rejects malformed armour', () => {
    const body = fixture(LEAF);
    expect(() => splitPemCertificates(body.replace('-----END CERTIFICATE-----', ''))).toThrow(
      /not terminated/
    );
    expect(() => splitPemCertificates(`-----END CERTIFICATE-----\n${body}`)).toThrow(
      /END CERTIFICATE line with no BEGIN/
    );
    expect(() => splitPemCertificates(`-----BEGIN CERTIFICATE-----\n${body}`)).toThrow(
      /inside another certificate/
    );
  });
});

describe('selectSigningCertificate', () => {
  // The leaf is the non-CA certificate with the code-signing EKU.
  it('picks the code-signing leaf of a leaf + CA chain', () => {
    const leaf = cert(LEAF);
    expect(selectSigningCertificate([leaf, cert(CA)])).toBe(leaf);
    expect(selectSigningCertificate([cert('test-selfsigned-codesign.pem')]).subject).toContain(
      'Self-Signed'
    );
  });

  // The test CA carries the code-signing EKU too: being a CA must disqualify
  // it, or a chain file holding only the intermediate would "work" and sign
  // with a certificate that is not ours.
  it('never picks a CA, and needs the code-signing EKU', () => {
    expect(cert(CA).keyUsage).toContain(CODE_SIGNING_EKU);
    expect(() => selectSigningCertificate([cert(CA)])).toThrow(/no code-signing leaf/);
    expect(() => selectSigningCertificate([cert('test-tls-server.pem')])).toThrow(
      /no code-signing leaf/
    );
  });

  // Node calls the EKU list `keyUsage` today; a Node that renames it to
  // extKeyUsage (or drops it) must not make every certificate look EKU-less
  // -- or, worse, read the wrong list.
  it('reads the EKU list under either property name', () => {
    const renamed = { ca: false, extKeyUsage: [CODE_SIGNING_EKU] } as unknown as X509Certificate;
    expect(selectSigningCertificate([renamed])).toBe(renamed);
    const none = { ca: false } as unknown as X509Certificate;
    expect(() => selectSigningCertificate([none])).toThrow(/no code-signing leaf/);
  });

  // jsign signs with the FIRST certificate of --certfile; two leaves, or the
  // leaf after the CA, would sign under the wrong certificate.
  it('requires exactly one leaf, first in the file', () => {
    expect(() =>
      selectSigningCertificate([cert(LEAF), cert('test-selfsigned-codesign.pem')])
    ).toThrow(/2 code-signing leaves/);
    expect(() => selectSigningCertificate([cert(CA), cert(LEAF)])).toThrow(
      /must be the first certificate/
    );
  });
});

describe('publicKeySha256 / publisherFromCertificate', () => {
  // Must equal the digest of the KMS public key as `gcloud … get-public-key |
  // openssl pkey -outform DER | sha256sum` prints it, or the guard compares
  // two different things.
  it('hashes the DER SubjectPublicKeyInfo', () => {
    expect(publicKeySha256(cert(LEAF))).toBe(LEAF_KEY_SHA256);
  });

  // The publisher is DERIVED from the CN, so it cannot drift from what Windows
  // reports for the signature.
  it('derives the publisher from the subject CN', () => {
    expect(publisherFromCertificate(cert(LEAF))).toBe(PUBLISHER);
  });

  // A CN that Windows and Node spell differently (a comma) could never match
  // in electron-updater; no CN at all has nothing to pin.
  it('refuses a CN it cannot pin safely, or none', () => {
    expect(() => publisherFromCertificate(cert('test-comma-cn-codesign.pem'))).toThrow(
      /spell differently/
    );
    expect(() => publisherFromCertificate(cert('test-no-cn-codesign.pem'))).toThrow(
      /exactly one CN, found 0/
    );
  });

  // A subject with two CNs: Windows reports one, Node lists both, and
  // electron-updater's parseDn keeps whichever it sees last -- there is no
  // single name to pin, so it must not pick one.
  it('refuses a subject with two CNs', () => {
    expect(cert('test-two-cn-codesign.pem').subject).toBe(
      'CN=Sarv Inbox Test\nCN=Second Test Name\nO=TEST ONLY'
    );
    expect(() => publisherFromCertificate(cert('test-two-cn-codesign.pem'))).toThrow(
      /exactly one CN, found 2/
    );
  });

  // A CN ending in a space. Today's Node escapes it (a backslash before the
  // space), which the
  // character rule already refuses; a Node that printed it raw would slip past
  // that rule, and only the whitespace check stands between it and a pin that
  // Windows (which quotes it) never reproduces.
  it('refuses a CN with trailing whitespace, escaped or raw', () => {
    expect(cert('test-trailing-space-cn-codesign.pem').subject).toBe(
      'CN=Sarv Inbox Test\\ \nO=TEST ONLY'
    );
    expect(() => publisherFromCertificate(cert('test-trailing-space-cn-codesign.pem'))).toThrow(
      /spell differently/
    );
    const rawTrailingSpace = {
      subject: 'CN=Sarv Inbox Test \nO=TEST ONLY',
    } as unknown as X509Certificate;
    expect(() => publisherFromCertificate(rawTrailingSpace)).toThrow(
      /certificate CN "Sarv Inbox Test " ends in whitespace/
    );
  });

  // The real certificate's shape: a multi-RDN subject (C, ST, O, CN) yields
  // exactly the CN, upper case and all, which is what publisherNames[0] must
  // then equal.
  it('derives the CN of a Sectigo-shaped leaf', () => {
    const [leaf] = splitPemCertificates(fixture(SECTIGO_SHAPED_CHAIN)).map(
      (pem) => new X509Certificate(pem)
    );
    expect(leaf.subject).toBe(`C=IN\nST=Rajasthan\nO=${REAL_CN}\nCN=${REAL_CN}`);
    expect(publisherFromCertificate(leaf)).toBe(REAL_CN);
    expect(publicKeySha256(leaf)).toBe(SECTIGO_SHAPED_KEY_SHA256);
  });
});

describe('loadWindowsSigningConfig', () => {
  // DORMANT: no chain file, no signing, and no demand that the provider exists.
  it('is disabled while the chain file is absent, even with an empty provider', () => {
    const path = writeConfig({ workloadIdentityProvider: '' });
    const loaded = loadWindowsSigningConfig(path, { now: NOW });
    expect(loaded.enabled).toBe(false);
    expect(loaded.chainPath).toBe(join(dirname(path), 'windows-signing-chain.pem'));
  });

  // ENABLED: the chain is committed and everything lines up.
  it('enables signing and derives the publisher once the chain is committed', () => {
    const loaded = loadEnabled();
    expect(loaded.enabled).toBe(true);
    expect(loaded.publisher).toBe(PUBLISHER);
    expect(loaded.publisherNames).toEqual([PUBLISHER]);
    expect(loaded.leaf.validTo).toMatch(/2125/);
  });

  // THE ONE-WAY LATCH. Once publisherNames is set, signing has been switched
  // on, and a chain file lost in a merge or a revert must stop the release --
  // never quietly produce the unsigned build that strands every install.
  it('throws when publisherNames is set but the chain is missing', () => {
    const path = writeConfig({ publisherNames: [REAL_CN] });
    expect(() => loadWindowsSigningConfig(path, { now: NOW })).toThrow(
      /signing was switched on; the certificate chain is missing\. publisherNames is \["SARV WEBS PRIVATE LIMITED"\]/
    );
  });

  // The pin. The CN must equal publisherNames[0] EXACTLY: a reissue under
  // another spelling (case included -- electron-updater compares with ===),
  // a name list that puts the old CN first, or no list at all must stop the
  // build rather than pin, or fail to match, every install.
  it.each([
    ['no pinned name', [], /publisherNames is empty/],
    [
      'a different name',
      ['Some Other Publisher'],
      /certificate CN "Sarv Inbox Test Publisher" is not publisherNames\[0\] \("Some Other Publisher"\)/,
    ],
    ['the same name in another case', [PUBLISHER.toUpperCase()], /is not publisherNames\[0\]/],
    [
      'the CN listed second',
      ['Old Name Ltd', PUBLISHER],
      /is not publisherNames\[0\] \("Old Name Ltd"\)/,
    ],
  ])('throws when enabled with %s', (_label, publisherNames, message) => {
    const path = writeConfig({ publisherNames }, leafChain());
    expect(() => loadWindowsSigningConfig(path, { now: NOW })).toThrow(
      /windows signing is ENABLED/
    );
    expect(() => loadWindowsSigningConfig(path, { now: NOW })).toThrow(message);
  });

  // A CN change lists the new name first and keeps the old one after it; the
  // whole list is carried through to electron-builder.
  it('accepts a transition list with the CN first', () => {
    const loaded = loadEnabled(
      writeConfig({ publisherNames: [PUBLISHER, 'Old Name Ltd'] }, leafChain())
    );
    expect(loaded.publisher).toBe(PUBLISHER);
    expect(loaded.publisherNames).toEqual([PUBLISHER, 'Old Name Ltd']);
  });

  // The certificate as it will actually arrive: leaf + intermediate + a
  // cross-signed root, valid from 2026-11-01 to 2027-12-05. It must enable
  // signing inside that window and fail closed on either side of it.
  it('loads a Sectigo-shaped chain inside its validity window only', () => {
    const path = writeConfig(
      { publicKeySha256: SECTIGO_SHAPED_KEY_SHA256, publisherNames: [REAL_CN] },
      fixture(SECTIGO_SHAPED_CHAIN)
    );
    const loaded = loadWindowsSigningConfig(path, {
      now: new Date('2026-11-15T00:00:00Z'),
    }) as EnabledSigning;
    expect(loaded).toMatchObject({ enabled: true, publisher: REAL_CN, publisherNames: [REAL_CN] });
    expect(loaded.leaf.validTo).toBe('Dec  5 23:59:59 2027 GMT');
    expect(() => loadWindowsSigningConfig(path, { now: new Date('2026-10-31T23:59:59Z') })).toThrow(
      /not valid until Nov {2}1 00:00:00 2026 GMT/
    );
    expect(() => loadWindowsSigningConfig(path, { now: new Date('2027-12-06T00:00:00Z') })).toThrow(
      /expired on Dec {2}5 23:59:59 2027 GMT/
    );
    const lowerCase = writeConfig(
      { publicKeySha256: SECTIGO_SHAPED_KEY_SHA256, publisherNames: ['Sarv Webs Private Limited'] },
      fixture(SECTIGO_SHAPED_CHAIN)
    );
    expect(() =>
      loadWindowsSigningConfig(lowerCase, { now: new Date('2026-11-15T00:00:00Z') })
    ).toThrow(/is not publisherNames\[0\]/);
  });

  // FAIL-CLOSED, one branch each: enabled but unusable must stop the release,
  // never fall back to an unsigned build.
  it.each([
    [
      'an empty identity provider',
      { workloadIdentityProvider: '' },
      () => leafChain(),
      /workloadIdentityProvider is empty/,
    ],
    [
      'an empty service account',
      { serviceAccount: '' },
      () => leafChain(),
      /serviceAccount is empty/,
    ],
    [
      'an unparsable chain',
      {},
      () => '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      /the chain does not parse/,
    ],
    ['a chain with no certificate', {}, () => 'nothing here\n', /holds no PEM certificate/],
    [
      'a chain with no code-signing leaf',
      {},
      () => fixture('test-tls-server.pem'),
      /no code-signing leaf/,
    ],
    [
      'a certificate for another key',
      { publicKeySha256: 'a'.repeat(64) },
      () => leafChain(),
      /is not the KMS key/,
    ],
    [
      'an expired certificate',
      {},
      () => fixture('test-expired-codesign.pem'),
      /expired on .*2021|is not the KMS key/,
    ],
    [
      'a CN that cannot be pinned',
      {},
      () => fixture('test-comma-cn-codesign.pem'),
      /spell differently|is not the KMS key/,
    ],
  ])('throws when enabled with %s', (_label, overrides, chain, message) => {
    const path = writeConfig(overrides, chain());
    expect(() => loadWindowsSigningConfig(path, { now: NOW })).toThrow(
      /windows signing is ENABLED/
    );
    expect(() => loadWindowsSigningConfig(path, { now: NOW })).toThrow(message);
  });

  // The expiry and CN checks above would be masked by the key check, so they
  // are also run with the key digest of the certificate under test.
  it('throws on an expired or not-yet-valid certificate whose key matches', () => {
    const expired = fixture('test-expired-codesign.pem');
    const expiredPath = writeConfig(
      { publicKeySha256: publicKeySha256(new X509Certificate(expired)) },
      expired
    );
    expect(() => loadWindowsSigningConfig(expiredPath, { now: NOW })).toThrow(
      /expired on Jan {2}1 00:00:00 2021 GMT/
    );
    expect(() =>
      loadWindowsSigningConfig(writeConfig({}, leafChain()), { now: new Date('2024-06-01') })
    ).toThrow(/not valid until/);
    const comma = fixture('test-comma-cn-codesign.pem');
    const commaPath = writeConfig(
      { publicKeySha256: publicKeySha256(new X509Certificate(comma)) },
      comma
    );
    expect(() => loadWindowsSigningConfig(commaPath, { now: NOW })).toThrow(/spell differently/);
  });

  // A broken config file fails loudly with its path, never as "disabled".
  it('throws on unreadable JSON and on a bad shape, naming the file', () => {
    const dir = mkdtempSync(join(scratch, 'bad-'));
    writeFileSync(join(dir, 'windows-signing.json'), '{ not json');
    expect(() => loadWindowsSigningConfig(join(dir, 'windows-signing.json'))).toThrow(
      /cannot read .*windows-signing.json/
    );
    expect(() => loadWindowsSigningConfig(writeConfig({ programUrl: 'http://x' }))).toThrow(
      /is invalid:\n {2}- programUrl/
    );
  });
});

/**
 * A fake `gh` that answers by the API path it is asked for, the way the real
 * one behaves (checked against gh 2.96): stdout on success; on an HTTP error a
 * non-zero exit with "gh: <reason> (HTTP <code>)" on stderr.
 */
const GH_REPO = 'Sarv/Inbox';
const CONFIG_AT = (tag: string) =>
  `repos/${GH_REPO}/contents/apps/desktop/build/windows-signing.json?ref=${tag}`;
type GhAnswer = string | { http: number } | Error;
const fakeGh = (answers: Record<string, GhAnswer>) => {
  const calls: string[][] = [];
  const run: GhRun = async (file, args) => {
    calls.push([file, ...args]);
    const apiPath = args.find((arg) => arg.startsWith('repos/')) ?? '';
    const answer = answers[apiPath];
    if (answer === undefined) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'object') {
      const reason = answer.http === 404 ? 'Not Found' : 'Bad Gateway';
      throw Object.assign(new Error(`Command failed: gh ${args.join(' ')}`), {
        code: 1,
        stdout: `{"message":"${reason}","status":"${answer.http}"}`,
        stderr: `gh: ${reason} (HTTP ${answer.http})\n`,
      });
    }
    return { stdout: answer, stderr: '' };
  };
  return { run, calls };
};
/** gh answers for a repository whose Latest release is `tag` with `config` as its windows-signing.json. */
const latestRelease = (tag: string, config: GhAnswer): Record<string, GhAnswer> => ({
  [`repos/${GH_REPO}`]: `${GH_REPO}\n`,
  [`repos/${GH_REPO}/releases/latest`]: `${tag}\n`,
  [CONFIG_AT(tag)]: config,
});
const releasedConfig = (publisherNames: unknown) =>
  JSON.stringify({ ...committedConfig(), publisherNames });

describe('the cross-release latch: what the last published release pins', () => {
  // The lookup is exactly the two calls release.yml documents (plus a check
  // that the repository is visible at all), with the raw file at the Latest
  // TAG -- reading the default branch instead would compare against a config
  // no install has.
  it('reads the publisher names of the release marked Latest', async () => {
    const { run, calls } = fakeGh(latestRelease('v1.5.0', releasedConfig([REAL_CN])));
    expect(await lookupPreviousRelease({ repository: GH_REPO, run })).toEqual({
      kind: 'config',
      tag: 'v1.5.0',
      publisherNames: [REAL_CN],
    });
    expect(calls).toEqual([
      ['gh', 'api', 'repos/Sarv/Inbox', '--jq', '.full_name'],
      ['gh', 'api', 'repos/Sarv/Inbox/releases/latest', '--jq', '.tag_name'],
      ['gh', 'api', '-H', 'Accept: application/vnd.github.raw', CONFIG_AT('v1.5.0')],
    ]);
  });

  // The two 404s that genuinely mean "no install pins anything": no release
  // published yet, or a Latest release from before signing existed. Each is
  // named in the log, so a release that passes unchecked says why.
  it('treats no published release, and a Latest that predates signing, as no constraint', async () => {
    const none = await lookupPreviousRelease({
      repository: GH_REPO,
      run: fakeGh({
        [`repos/${GH_REPO}`]: GH_REPO,
        [`repos/${GH_REPO}/releases/latest`]: { http: 404 },
      }).run,
    });
    expect(none).toEqual({ kind: 'none' });
    expect(describePreviousRelease(none)).toMatch(
      /^Last published release: none \(releases\/latest is 404\)/
    );

    const predates = await lookupPreviousRelease({
      repository: GH_REPO,
      run: fakeGh(latestRelease('v1.4.10', { http: 404 })).run,
    });
    expect(predates).toEqual({ kind: 'predates-signing', tag: 'v1.4.10' });
    expect(describePreviousRelease(predates)).toMatch(
      /v1\.4\.10: no .* at that tag \(it predates Windows signing\)/
    );
  });

  // Everything else FAILS CLOSED: an answer we could not read must never
  // pass for "nothing is pinned", or a network blip would let an unsigned
  // build through as Latest.
  it.each([
    [
      'a 5xx on releases/latest',
      { [`repos/${GH_REPO}`]: GH_REPO, [`repos/${GH_REPO}/releases/latest`]: { http: 502 } },
      /HTTP 502/,
    ],
    ['a 5xx on the file', latestRelease('v1.5.0', { http: 502 }), /HTTP 502/],
    [
      'gh missing',
      { [`repos/${GH_REPO}`]: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) },
      /ENOENT/,
    ],
    [
      'an invisible repository (its 404 is not "no releases")',
      { [`repos/${GH_REPO}`]: { http: 404 } },
      /is not visible to this token/,
    ],
    [
      'a different repository answering',
      { [`repos/${GH_REPO}`]: 'Someone/Else\n' },
      /is not visible to this token/,
    ],
    ['an empty tag', latestRelease('', releasedConfig([])), /no usable tag name/],
    ['a file that is not JSON', latestRelease('v1.5.0', '<html>'), /at v1\.5\.0 is not JSON/],
    [
      'a file without publisherNames',
      latestRelease('v1.5.0', '{"kms":{}}'),
      /at v1\.5\.0 is invalid:\n {2}- publisherNames: must be a list/,
    ],
    [
      'a file with an unpinnable name',
      latestRelease('v1.5.0', releasedConfig(['Sarv, Inc.'])),
      /is invalid:[\s\S]*spell differently/,
    ],
  ])('fails closed on %s', async (_label, answers, message) => {
    await expect(
      lookupPreviousRelease({ repository: GH_REPO, run: fakeGh(answers).run })
    ).rejects.toThrow(message);
  });

  // The repository argument is interpolated into an API path: anything but
  // owner/name is refused before gh runs.
  it('refuses a repository that is not owner/name', async () => {
    const { run, calls } = fakeGh({});
    await expect(lookupPreviousRelease({ repository: 'Sarv/Inbox/../x', run })).rejects.toThrow(
      /not an owner\/repository/
    );
    expect(calls).toEqual([]);
  });

  // Only publisherNames is read from a released file: a later change that
  // adds a key must not make every older release "invalid" and block them all.
  it('reads only publisherNames from a released file', () => {
    expect(previousConfigProblems({ publisherNames: [], someKeyAddedLater: true })).toEqual([]);
    expect(previousConfigProblems('nope')).toEqual(['the configuration must be a JSON object']);
  });
});

describe('the cross-release latch: what this build may be', () => {
  const pinned = (publisherNames: string[]): PreviousRelease => ({
    kind: 'config',
    tag: 'v1.5.0',
    publisherNames,
  });
  const disabled = () =>
    loadWindowsSigningConfig(writeConfig({ workloadIdentityProvider: '' }), { now: NOW });

  // THE revert scenario. `git revert` of the switch-on removes the chain and
  // empties publisherNames together, so the tree says "disabled"; so does a
  // tag cut from a branch older than the switch-on. Every install the signed
  // Latest release updated would refuse this build: it must not ship.
  it('refuses an unsigned build once the last published release is signed', () => {
    expect(previousReleaseProblems(pinned([REAL_CN]), disabled())).toEqual([
      expect.stringMatching(
        /the last published release \(v1\.5\.0\) is signed, .*this build is UNSIGNED/
      ),
    ]);
  });

  // A certificate whose CN no install trusts yet: a one-step CN change.
  // Every install the Latest release updated would refuse it.
  it('refuses a build signed under a CN the last release does not pin', () => {
    expect(previousReleaseProblems(pinned(['Old Name Ltd']), loadEnabled())).toEqual([
      expect.stringMatching(
        /signed as "Sarv Inbox Test Publisher", but the last published release \(v1\.5\.0\) pins \["Old Name Ltd"\]/
      ),
    ]);
  });

  // Step 2 of a CN change: the new CN was shipped SECOND in the previous
  // list (step 1), and now signs. Refusing it would make a CN change
  // impossible.
  it('allows a CN that the last release pins in a non-first position', () => {
    expect(previousReleaseProblems(pinned(['Old Name Ltd', PUBLISHER]), loadEnabled())).toEqual([]);
    expect(previousReleaseProblems(pinned([PUBLISHER]), loadEnabled())).toEqual([]);
  });

  // Nothing pinned yet -- no release, a release from before signing, or one
  // with publisherNames [] -- constrains nothing: the first signed release,
  // or any unsigned one before it, goes through.
  it.each([
    ['no published release', { kind: 'none' } as PreviousRelease],
    [
      'a Latest from before signing',
      { kind: 'predates-signing', tag: 'v1.4.10' } as PreviousRelease,
    ],
    [
      'a Latest with publisherNames []',
      { kind: 'config', tag: 'v1.4.11', publisherNames: [] } as PreviousRelease,
    ],
  ])('allows anything after %s', (_label, previous) => {
    expect(previousReleaseProblems(previous, disabled())).toEqual([]);
    expect(previousReleaseProblems(previous, loadEnabled())).toEqual([]);
  });
});

describe('signers and jsignArgs', () => {
  const settings = signingSettings(committedConfig());

  // The production signer is fully determined by the committed config: the
  // pinned key VERSION (no metadata calls, signer role suffices), the
  // committed chain, and the token named -- never inlined.
  it('builds the GOOGLECLOUD signer from the committed key and chain', () => {
    const loaded = loadEnabled();
    expect(googleCloudSigner(loaded)).toEqual({
      storetype: 'GOOGLECLOUD',
      keystore: committedConfig().kms.keyRing,
      alias: 'sarv-inbox-authenticode/cryptoKeyVersions/1',
      certfile: loaded.chainPath,
      storepassEnv: SIGNING_TOKEN_ENV,
    });
  });

  // The token must never be on argv: argv is visible to every process on the
  // runner and lands in electron-builder's error output.
  it('names secrets only as env: references and never puts a value on argv', () => {
    const secret = 'ya29.SECRET-TOKEN-VALUE';
    process.env[SIGNING_TOKEN_ENV] = secret;
    try {
      const args = jsignArgs({
        jar: '/j/jsign.jar',
        signer: googleCloudSigner(loadEnabled()),
        file: '/a/b.exe',
        settings,
      });
      expect(args.join(' ')).not.toContain(secret);
      expect(args[args.indexOf('--storepass') + 1]).toBe(`env:${SIGNING_TOKEN_ENV}`);
    } finally {
      delete process.env[SIGNING_TOKEN_ENV];
    }
  });

  // What makes a signature durable and attributable: SHA-256, an RFC 3161
  // timestamp from the configured servers in order, --replace so a retry never
  // nests, and the file last.
  it('asks for sha256, RFC 3161 timestamps, --replace, and puts the file last', () => {
    const args = jsignArgs({
      jar: '/j/jsign.jar',
      signer: googleCloudSigner(loadEnabled()),
      file: '/a/b.exe',
      settings,
    });
    expect(args.slice(0, 2)).toEqual(['-jar', '/j/jsign.jar']);
    expect(args[args.indexOf('--alg') + 1]).toBe('SHA-256');
    expect(args[args.indexOf('--tsmode') + 1]).toBe('RFC3161');
    expect(args[args.indexOf('--tsaurl') + 1]).toBe(
      'http://timestamp.digicert.com,http://timestamp.sectigo.com'
    );
    expect(args[args.indexOf('--name') + 1]).toBe('Sarv Inbox');
    expect(args[args.indexOf('--url') + 1]).toBe('https://inbox.sarv.com');
    expect(args).toContain('--replace');
    expect(args.at(-1)).toBe('/a/b.exe');
    expect(args).not.toContain('--keypass');
  });

  // jsign reads a PKCS#12 key with an EMPTY password unless --keypass is given.
  it('passes the PKCS12 password for both store and key, and omits a missing alias', () => {
    const args = jsignArgs({
      jar: '/j.jar',
      signer: pkcs12Signer({ keystore: '/k.p12', passwordEnv: 'P_W' }),
      file: '/f.exe',
      settings,
    });
    expect(args[args.indexOf('--keypass') + 1]).toBe('env:P_W');
    expect(args).not.toContain('--alias');
    expect(args).not.toContain('--certfile');
    const withAlias = pkcs12Signer({ keystore: '/k.p12', passwordEnv: 'P_W', alias: 'test' });
    expect(withAlias.alias).toBe('test');
  });

  // A relative path could be read as an option; a non-variable name in env:
  // would make jsign read the wrong thing.
  it('refuses relative paths and bad variable names', () => {
    expect(() =>
      jsignArgs({
        jar: '/j.jar',
        signer: googleCloudSigner(loadEnabled()),
        file: 'b.exe',
        settings,
      })
    ).toThrow(/relative path/);
    expect(() => pkcs12Signer({ keystore: '/k', passwordEnv: 'not-a-name' })).toThrow(
      /environment variable name/
    );
    const bad = { ...googleCloudSigner(loadEnabled()), storepassEnv: 'x y' };
    expect(() => jsignArgs({ jar: '/j.jar', signer: bad, file: '/b.exe', settings })).toThrow(
      /environment variable name/
    );
  });

  // Breaks if the refusal quotes what it refused. The likely mistake is passing
  // the password or token ITSELF where its variable name belongs, and the
  // message lands in a CI log (the self-test prints any error it dies of).
  it('never echoes a rejected variable name, which may be the secret itself', () => {
    const secret = 'hunter2-Sup3r-secret';
    const thrown = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a throw');
    };
    const fromSigner = thrown(() => pkcs12Signer({ keystore: '/k', passwordEnv: secret }));
    expect(fromSigner).toMatch(/passwordEnv is not an environment variable name/);
    expect(fromSigner).not.toContain(secret);
    for (const field of ['storepassEnv', 'keypassEnv'] as const) {
      const signer = { ...pkcs12Signer({ keystore: '/k', passwordEnv: 'P_W' }), [field]: secret };
      const fromArgs = thrown(() => jsignArgs({ jar: '/j.jar', signer, file: '/b.exe', settings }));
      expect(fromArgs).toMatch(new RegExp(`signer\\.${field} is not an environment variable name`));
      expect(fromArgs).not.toContain(secret);
    }
  });
});

describe('classifyJsignFailure', () => {
  // Retrying auth failures hides the real message behind minutes of backoff;
  // not retrying a TSA blip fails a release for nothing.
  it.each([
    [
      "jsign: Couldn't sign\njava.io.IOException: 403 - PERMISSION_DENIED: Permission denied",
      'permanent',
    ],
    [
      'java.io.IOException: 401 - UNAUTHENTICATED: Request had invalid authentication credentials',
      'permanent',
    ],
    ['java.io.IOException: 400 - FAILED_PRECONDITION: key version is DISABLED', 'permanent'],
    ['java.io.IOException: 404 - NOT_FOUND: KeyRing not found', 'permanent'],
    ['TimestampingException: Unable to complete the timestamping after 4 attempts', 'transient'],
    ['java.io.IOException: 503 - UNAVAILABLE: The service is currently unavailable', 'transient'],
    ['java.io.IOException: 429 - RESOURCE_EXHAUSTED: Quota exceeded', 'transient'],
    [
      'java.io.IOException: Server returned HTTP response code: 502 for URL: http://timestamp.digicert.com',
      'transient',
    ],
    ['java.net.SocketTimeoutException: Read timed out', 'transient'],
    ['java.net.UnknownHostException: cloudkms.googleapis.com', 'transient'],
    ['The process cannot access the file because it is being used by another process', 'transient'],
    ["jsign: The file C:\\x.exe couldn't be found", 'permanent'],
    ['something nobody has seen before', 'permanent'],
    // Both kinds of marker: permanent wins (a 403 page served slowly is still a 403).
    ['403 - PERMISSION_DENIED after Read timed out', 'permanent'],
  ])('%s -> %s', (output, expected) => {
    expect(classifyJsignFailure(output)).toBe(expected);
  });

  // No java on PATH will not fix itself; our own timeout killing a hung TSA
  // call is worth one more try.
  it('treats a missing java as permanent and our timeout kill as transient', () => {
    expect(classifyJsignFailure('spawn java ENOENT', { code: 'ENOENT' })).toBe('permanent');
    expect(classifyJsignFailure('', { killed: true })).toBe('transient');
  });
});

/** A fake `java -jar jsign.jar …` that signs the way jsign does: in place, by appending a table. */
const fakeJsign = (behaviour: Array<'sign' | 'noop' | Error> = ['sign']) => {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const run: Run = async (file, args, options) => {
    calls.push({ file, args, options: options as Record<string, unknown> });
    const step = behaviour[Math.min(calls.length - 1, behaviour.length - 1)];
    if (step instanceof Error) throw step;
    if (step === 'sign') {
      const target = args.at(-1) as string;
      writeFileSync(target, appendSignature(readFileSync(target)));
    }
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
};
const jsignError = (stderr: string) =>
  Object.assign(new Error('Command failed: java -jar jsign.jar'), { stderr, stdout: '' });

describe('signPeFile', () => {
  const settings = signingSettings(committedConfig());
  const signer = pkcs12Signer({ keystore: '/k.p12', passwordEnv: 'SELFTEST_PW' });
  const base = { signer, settings, jar: '/j/jsign.jar', log: () => {} };

  // The core of the hook: an unsigned PE gets exactly one jsign run, with no
  // shell, and the result is re-read from disk before it counts as signed.
  it('signs an unsigned file and verifies the signature landed', async () => {
    const file = writeFile('app.exe', fullPe());
    const { run, calls } = fakeJsign();
    const result = await signPeFile({ ...base, file, run, env: { SELFTEST_PW: 'x' } });
    expect(result).toEqual({ status: 'signed', attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('java');
    expect(calls[0].args.at(-1)).toBe(file);
    expect(calls[0].options).toMatchObject({ env: { SELFTEST_PW: 'x' }, windowsHide: true });
    expect(calls[0].options.shell).toBeUndefined();
    expect(readFileCertificateTable(file)).toMatchObject({ pe: true, signed: true });
  });

  // Microsoft-signed DLLs keep Microsoft's signature, and electron-builder's
  // own retry of a file we just signed must not re-sign or nest.
  it('leaves an already-signed file untouched (idempotent re-run)', async () => {
    const file = writeFile('d3dcompiler_47.dll', fullPe({ certificate: winCertificate() }));
    const before = readFileSync(file);
    const { run, calls } = fakeJsign();
    expect(await signPeFile({ ...base, file, run })).toEqual({ status: 'skipped', attempts: 0 });
    expect(calls).toHaveLength(0);
    expect(readFileSync(file).equals(before)).toBe(true);

    const fresh = writeFile('fresh.exe', fullPe());
    await signPeFile({ ...base, file: fresh, run });
    const once = readFileSync(fresh);
    expect(await signPeFile({ ...base, file: fresh, run })).toMatchObject({ status: 'skipped' });
    expect(readFileSync(fresh).equals(once)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // The KMS key signs sha256 only; a sha1 pass would be a second, nested
  // signature (electron-builder's default is sha1 THEN sha256).
  it('refuses any hash but sha256 before running anything', async () => {
    const file = writeFile('app.exe', fullPe());
    const { run, calls } = fakeJsign();
    await expect(signPeFile({ ...base, file, run, hash: 'sha1' })).rejects.toThrow(/sha256 only/);
    expect(calls).toHaveLength(0);
  });

  // Non-PE files and malformed tables are errors, never "skip" -- skipping
  // would ship them unsigned.
  it('throws on a non-PE file and on a malformed certificate table', async () => {
    const { run } = fakeJsign();
    await expect(
      signPeFile({ ...base, file: writeFile('x.dll', Buffer.from('not a binary')), run })
    ).rejects.toThrow(/not a PE file/);
    const broken = fullPe({ certificate: winCertificate(64, { type: 1 }) });
    await expect(signPeFile({ ...base, file: writeFile('y.dll', broken), run })).rejects.toThrow(
      /malformed certificate table/
    );
  });

  // A transient TSA/KMS failure is retried with backoff and then succeeds.
  it('retries a transient failure with backoff', async () => {
    const file = writeFile('app.exe', fullPe());
    const sleep = vi.fn(async () => {});
    const { run, calls } = fakeJsign([
      jsignError('Unable to complete the timestamping after 4 attempts'),
      'sign',
    ]);
    const log = vi.fn();
    expect(await signPeFile({ ...base, file, run, sleep, log })).toEqual({
      status: 'signed',
      attempts: 2,
    });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(log.mock.calls.join('\n')).toMatch(/transient failure .* retrying in 10s/);
    expect(log.mock.calls.join('\n')).toMatch(/after 2 attempts/);
  });

  // Bounded: a TSA that stays down fails the build after the last retry rather
  // than hanging it.
  it('gives up after the last retry of a transient failure', async () => {
    const file = writeFile('app.exe', fullPe());
    const { run, calls } = fakeJsign([jsignError('503 - UNAVAILABLE')]);
    // The real (default) sleep, with millisecond delays.
    const started = Date.now();
    await expect(signPeFile({ ...base, file, run, retryDelaysMs: [5, 10] })).rejects.toThrow(
      /jsign failed \(transient\) .* after 3 attempt\(s\)/s
    );
    expect(calls).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(14);
  });

  // Auth and permission failures are never retried.
  it('does not retry a permanent failure', async () => {
    const file = writeFile('app.exe', fullPe());
    const sleep = vi.fn(async () => {});
    const { run, calls } = fakeJsign([jsignError('403 - PERMISSION_DENIED: no useToSign')]);
    await expect(signPeFile({ ...base, file, run, sleep })).rejects.toThrow(
      /jsign failed \(permanent\).*PERMISSION_DENIED/s
    );
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  // jsign's word is not enough: exit 0 with no signature on disk must fail.
  it('throws when jsign exits 0 but the file carries no signature', async () => {
    const file = writeFile('app.exe', fullPe());
    const { run } = fakeJsign(['noop']);
    await expect(signPeFile({ ...base, file, run })).rejects.toThrow(
      /exited 0 but .* carries no valid certificate table/
    );
  });

  // A run that leaves something other than a PE file behind is not "signed".
  it('throws when the file is no longer a PE file after jsign', async () => {
    const file = writeFile('app.exe', fullPe());
    const run: Run = async () => {
      writeFileSync(file, 'truncated');
      return {};
    };
    await expect(signPeFile({ ...base, file, run })).rejects.toThrow(/no longer a PE file/);
  });

  // jsign 7.5 cannot open a read-only file; the hook makes it writable first.
  it('makes a read-only file writable before signing', async () => {
    const file = writeFile('ro.dll', fullPe());
    chmodSync(file, 0o444);
    const { run } = fakeJsign();
    await signPeFile({ ...base, file, run });
    expect(statSync(file).mode & 0o200).toBe(0o200);
  });

  // A long stderr (Java stack traces) is trimmed in the error, keeping the end.
  it('keeps the tail of very long jsign output', async () => {
    const file = writeFile('app.exe', fullPe());
    const { run } = fakeJsign([jsignError(`${'x'.repeat(10_000)}END-OF-TRACE`)]);
    await expect(signPeFile({ ...base, file, run })).rejects.toThrow(/…x+END-OF-TRACE$/);
  });
});

describe('readFileCertificateTable', () => {
  // A large DOS stub pushes the headers past the first 4 KB read; the reader
  // must re-read rather than report a signed file as unreadable.
  it('reads headers beyond the first 4 KB and reports non-PE files', () => {
    const file = writeFile('far.exe', fullPe({ peOffset: 0x1800, certificate: winCertificate() }));
    expect(readFileCertificateTable(file)).toMatchObject({
      pe: true,
      signed: true,
      format: 'PE32+',
    });
    expect(readFileCertificateTable(writeFile('t.txt', Buffer.from('hello')))).toEqual({
      pe: false,
    });
  });

  // A table whose offset runs past the file is reported, not read.
  it('reports a table pointing outside the file', () => {
    const file = writeFile('bad.exe', fullPe({ table: { offset: 100_000, size: 64 } }));
    expect(readFileCertificateTable(file)).toMatchObject({
      pe: true,
      hasTable: true,
      signed: false,
    });
  });

  // Breaks if the reader goes back to the PATH between its reads (a stat for
  // the size, a second open for the table entry): a file replaced meanwhile is
  // then judged by the headers of one file and the table of another. Windows
  // cannot replace a file that is open, so the swap is POSIX-only.
  it.skipIf(process.platform === 'win32')(
    'judges the file it opened even if the path is replaced mid-read',
    () => {
      const file = writeFile('swap.exe', fullPe({ certificate: winCertificate() }));
      const replacement = writeFile('replacement.bin', Buffer.from('not a PE file'));
      const realReadSync = fs.readSync;
      let swapped = false;
      const spy = vi.spyOn(fs, 'readSync').mockImplementation(((...args: unknown[]) => {
        const read = (realReadSync as (...a: unknown[]) => number)(...args);
        if (!swapped) {
          swapped = true;
          fs.renameSync(replacement, file);
        }
        return read;
      }) as typeof fs.readSync);
      try {
        expect(readFileCertificateTable(file)).toMatchObject({ pe: true, signed: true });
        expect(swapped).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
  );
});

describe('builderOptionsProblems', () => {
  const good = {
    hash: 'sha256',
    isNest: false,
    options: { forceCodeSigning: true, signtoolOptions: { publisherName: PUBLISHER } },
  };

  // What release.yml passes when signing is on. The string form of
  // forceCodeSigning is how -c.win.forceCodeSigning=true arrives; one
  // publisherName flag arrives as a string, several as an array.
  // Changed deliberately: the second argument is now the pinned list
  // (publisherNames), not one derived publisher.
  it('accepts the configuration release.yml produces', () => {
    expect(builderOptionsProblems(good, [PUBLISHER])).toEqual([]);
    expect(
      builderOptionsProblems({ ...good, options: { ...good.options, forceCodeSigning: 'true' } }, [
        PUBLISHER,
      ])
    ).toEqual([]);
    const asArray = {
      ...good,
      options: { ...good.options, signtoolOptions: { publisherName: [PUBLISHER] } },
    };
    expect(builderOptionsProblems(asArray, [PUBLISHER])).toEqual([]);
  });

  // A CN change: the hook must see the WHOLE list, in order, or the installs
  // this release updates would refuse whichever certificate signs the next.
  it('demands the whole pinned list, in order', () => {
    const names = [PUBLISHER, 'Old Name Ltd'];
    const withNames = (publisherName: unknown) => ({
      ...good,
      options: { forceCodeSigning: true, signtoolOptions: { publisherName } },
    });
    expect(builderOptionsProblems(withNames(names), names)).toEqual([]);
    expect(builderOptionsProblems(withNames(PUBLISHER), names).join('\n')).toMatch(
      /publisherName is \["Sarv Inbox Test Publisher"\], expected \["Sarv Inbox Test Publisher","Old Name Ltd"\]/
    );
    expect(builderOptionsProblems(withNames([...names].reverse()), names)).toHaveLength(1);
  });

  // electron-builder's CLI parses a numeric -c value as a NUMBER, and
  // electron-updater compares with ===: 12345 would never match the CN
  // "12345". Strict comparison catches it at build time.
  it('does not accept a number for a name', () => {
    const numeric = {
      ...good,
      options: { forceCodeSigning: true, signtoolOptions: { publisherName: 12345 } },
    };
    expect(builderOptionsProblems(numeric, ['12345'])).toHaveLength(1);
  });

  // Each of these produces a build that installs but either is never
  // signature-checked on update, or is dual-signed with a hash the key refuses.
  it.each([
    ['sha1 hash', { ...good, hash: 'sha1' }, /signingHashAlgorithms must be \["sha256"\]/],
    ['nested signature', { ...good, isNest: true }, /nested/],
    [
      'no forceCodeSigning',
      { ...good, options: { ...good.options, forceCodeSigning: undefined } },
      /forceCodeSigning is not true/,
    ],
    [
      'verifyUpdateCodeSignature false',
      { ...good, options: { ...good.options, verifyUpdateCodeSignature: false } },
      /verifyUpdateCodeSignature is false/,
    ],
    ['no publisherName', { ...good, options: { forceCodeSigning: true } }, /publisherName is \[\]/],
    [
      'wrong publisherName',
      { ...good, options: { forceCodeSigning: true, signtoolOptions: { publisherName: 'Other' } } },
      /expected \["Sarv Inbox Test Publisher"\]/,
    ],
    [
      'two publisherNames',
      {
        ...good,
        options: {
          forceCodeSigning: true,
          signtoolOptions: { publisherName: [PUBLISHER, 'Other'] },
        },
      },
      /publisherName is/,
    ],
    ['no options at all', { hash: 'sha256' }, /forceCodeSigning/],
  ])('flags %s', (_label, configuration, message) => {
    expect(builderOptionsProblems(configuration, [PUBLISHER]).join('\n')).toMatch(message);
  });
});

describe('electronBuilderSign (the hook body)', () => {
  const builderConfig = (file: string) => ({
    path: file,
    hash: 'sha256',
    isNest: false,
    options: { forceCodeSigning: true, signtoolOptions: { publisherName: PUBLISHER } },
  });
  const jarWithDigest = () => {
    const jar = writeFile('jsign.jar', Buffer.from('fake jar'));
    return { jar, sha256: createHash('sha256').update('fake jar').digest('hex') };
  };

  // DORMANT: every call is a no-op that leaves the file alone, and the notice
  // is printed once per build, not once per file.
  it('is a no-op that logs once while disabled', async () => {
    const configPath = writeConfig({ workloadIdentityProvider: '' });
    const file = writeFile('app.exe', fullPe());
    const before = readFileSync(file);
    const log = vi.fn();
    const state: HookState = {};
    const { run, calls } = fakeJsign();
    expect(
      await electronBuilderSign(builderConfig(file), { configPath, log, state, run, env: {} })
    ).toEqual({ status: 'disabled' });
    expect(
      await electronBuilderSign(
        { ...builderConfig(file), options: {} },
        { configPath, log, state, run, env: {} }
      )
    ).toEqual({
      status: 'disabled',
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/DISABLED .* NOT code-signed/);
    expect(calls).toHaveLength(0);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  // ENABLED: signs with the KMS key, the committed chain and the token from
  // the environment; the jar is hashed once per build.
  it('signs with the GOOGLECLOUD signer when enabled', async () => {
    const { jar, sha256 } = jarWithDigest();
    const configPath = writeConfig({ jsign: { ...committedConfig().jsign, sha256 } }, leafChain());
    const state: HookState = {};
    const { run, calls } = fakeJsign();
    const env = { [SIGNING_TOKEN_ENV]: 'token', [JSIGN_JAR_ENV]: jar };
    for (const name of ['a.exe', 'b.node']) {
      const result = await electronBuilderSign(builderConfig(writeFile(name, fullPe())), {
        configPath,
        state,
        run,
        env,
        now: NOW,
        log: () => {},
      });
      expect(result).toEqual({ status: 'signed', attempts: 1 });
    }
    const args = calls[0].args;
    expect(args[args.indexOf('--storetype') + 1]).toBe('GOOGLECLOUD');
    expect(args[args.indexOf('--alias') + 1]).toBe('sarv-inbox-authenticode/cryptoKeyVersions/1');
    expect(args[args.indexOf('--certfile') + 1]).toBe(
      join(dirname(configPath), 'windows-signing-chain.pem')
    );
    expect(calls[0].options.env).toBe(env);
    expect(state.verifiedJar).toBe(jar);
  });

  // FAIL-CLOSED: enabled with any missing piece throws, naming every problem.
  it('throws when enabled without the token, the jar, or the release.yml overrides', async () => {
    const configPath = writeConfig({}, leafChain());
    const file = writeFile('app.exe', fullPe());
    const deps = { configPath, now: NOW, log: () => {}, run: fakeJsign().run };
    await expect(
      electronBuilderSign(builderConfig(file), { ...deps, env: {}, state: {} })
    ).rejects.toThrow(
      new RegExp(`${SIGNING_TOKEN_ENV} is not set[\\s\\S]*${JSIGN_JAR_ENV} is not set`)
    );
    await expect(
      electronBuilderSign(
        { ...builderConfig(file), options: {} },
        { ...deps, env: { [SIGNING_TOKEN_ENV]: 't', [JSIGN_JAR_ENV]: '/j' }, state: {} }
      )
    ).rejects.toThrow(/forceCodeSigning is not true[\s\S]*publisherName is \[\]/);
  });

  // The jar sees the token: a jar that is not the pinned build is refused.
  it('refuses a jsign jar whose digest is not the pinned one', async () => {
    const configPath = writeConfig({}, leafChain());
    const jar = writeFile('evil.jar', Buffer.from('not jsign'));
    await expect(
      electronBuilderSign(builderConfig(writeFile('app.exe', fullPe())), {
        configPath,
        now: NOW,
        state: {},
        env: { [SIGNING_TOKEN_ENV]: 't', [JSIGN_JAR_ENV]: jar },
      })
    ).rejects.toThrow(/evil.jar has sha256 [0-9a-f]{64}, not the pinned/);
  });

  // The latch reaches the hook: publisherNames set but no chain fails the
  // very first file instead of letting the build run unsigned.
  it('throws on the first file when publisherNames is set but the chain is missing', async () => {
    const configPath = writeConfig({ publisherNames: [PUBLISHER] });
    const { run, calls } = fakeJsign();
    await expect(
      electronBuilderSign(builderConfig(writeFile('app.exe', fullPe())), {
        configPath,
        now: NOW,
        state: {},
        run,
        env: {},
      })
    ).rejects.toThrow(/certificate chain is missing/);
    expect(calls).toHaveLength(0);
  });

  // Enabled but misconfigured fails at load, on the first file.
  it('throws on the first file when the enabled config is incomplete', async () => {
    const configPath = writeConfig({ workloadIdentityProvider: '' }, leafChain());
    await expect(
      electronBuilderSign(builderConfig(writeFile('app.exe', fullPe())), {
        configPath,
        now: NOW,
        state: {},
      })
    ).rejects.toThrow(/workloadIdentityProvider is empty/);
  });

  // The real hook module, loaded the way electron-builder loads it: through
  // app-builder-lib's own resolveFunction (relative to apps/desktop, checked
  // against the workspace root, CommonJS default export), in a separate Node
  // process. With no chain committed it must be a no-op that leaves the file
  // alone; once signing is on it must refuse to run without its token.
  it('is wired through the committed CommonJS hook, as electron-builder resolves it', () => {
    const desktop = fileURLToPath(new URL('../../../', import.meta.url));
    const file = writeFile('hook.exe', fullPe());
    const script = `
      const { resolveFunction } = require('app-builder-lib/out/util/resolve.js');
      (async () => {
        const sign = await resolveFunction(undefined, './build/windowsSign.js', 'sign', ${JSON.stringify(join(desktop, '..', '..'))});
        const configuration = { path: ${JSON.stringify(file)}, hash: 'sha256', isNest: false, options: {} };
        try { await sign(configuration); await sign(configuration); console.log('RESULT ok'); }
        catch (error) { console.log('RESULT threw ' + error.message.split('\\n')[0]); }
      })();`;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: desktop,
      encoding: 'utf8',
      env: { ...process.env, [SIGNING_TOKEN_ENV]: '' },
    });
    const loaded = loadWindowsSigningConfig();
    if (!loaded.enabled) {
      expect(output).toContain('RESULT ok');
      // Logged once for two files.
      expect(output.match(/windows signing: DISABLED/g)).toHaveLength(1);
      expect(readFileCertificateTable(file)).toMatchObject({ signed: false });
    } else {
      expect(output).toMatch(/RESULT threw windows signing is ENABLED/);
    }
  });
});

describe('Authenticode verification', () => {
  // Changed deliberately: a Valid result now also reports the signer
  // certificate (as the extended PowerShell query does), and every verdict is
  // judged against the committed leaf, because our own files must carry THAT
  // certificate, not just our name. The default is the committed leaf, so
  // every pre-existing expectation below is unchanged.
  const valid = (
    path: string,
    cn = PUBLISHER,
    signerSha256 = LEAF_CERT_SHA256_PS
  ): AuthenticodeResult => ({
    path,
    status: 'Valid',
    statusMessage: 'Signature verified.',
    signerSubject: `CN=${cn}, O=TEST ONLY, C=IN`,
    timeStamperSubject:
      'CN=DigiCert SHA256 RSA4096 Timestamp Responder 2025 1, O="DigiCert, Inc.", C=US',
    signerThumbprint: 'A1B2C3',
    signerSha256,
  });
  const judge = (entries: Parameters<typeof evaluateSignatures>[0], names = [PUBLISHER]) =>
    evaluateSignatures(entries, names, { leafSha256: LEAF_CERT_SHA256 });

  // Changed deliberately: "ours" is now decided by WHAT the file is, not its
  // extension alone. The app executables, the installer and every .node addon
  // must be ours; any other .exe/.dll (elevate.exe, Electron's DLLs) may keep
  // a signature it arrived with; a PE file the hook is never offered is a
  // failure. Getting this wrong either lets a foreign-signed app executable
  // ship, or fails a release over Microsoft's signature on a DLL.
  it('classifies files by location and extension, case-insensitively', () => {
    const release = join(scratch, 'release');
    const where = {
      appDirs: [join(release, 'win-unpacked'), join(release, 'win-arm64-unpacked')],
      releaseDir: release,
    };
    expect(peFileKind(join(release, 'win-unpacked', 'Sarv Inbox.EXE'), where)).toBe('own');
    expect(peFileKind(join(release, 'win-arm64-unpacked', 'Sarv Inbox.exe'), where)).toBe('own');
    expect(peFileKind(join(release, 'Sarv-Inbox-Setup-1.0.0.exe'), where)).toBe('own');
    expect(
      peFileKind(join(release, 'win-unpacked', 'resources', 'x', 'better_sqlite3.node'), where)
    ).toBe('own');
    expect(peFileKind(join(release, 'win-unpacked', 'resources', 'elevate.exe'), where)).toBe(
      'other'
    );
    expect(peFileKind(join(release, 'win-unpacked', 'ffmpeg.DLL'), where)).toBe('other');
    expect(peFileKind(join(release, 'win-unpacked', 'thing.bin'), where)).toBe('unexpected');
    // "release/" and "release" are the same directory.
    expect(peFileKind(join(release, 'Setup.exe'), { releaseDir: `${release}/` })).toBe('own');
    // With no location given, an .exe is not assumed to be ours.
    expect(peFileKind('/r/Sarv Inbox.exe')).toBe('other');
  });

  // Windows PowerShell 5.1 can prefix a BOM, and ConvertTo-Json flattens a
  // one-element array to an object.
  it('parses the PowerShell JSON in every shape it comes in', () => {
    const one = valid('a.exe');
    expect(parseAuthenticodeJson(`\uFEFF${JSON.stringify(one)}`)).toEqual([one]);
    expect(parseAuthenticodeJson(JSON.stringify([one, one]))).toHaveLength(2);
    expect(() => parseAuthenticodeJson('  ')).toThrow(/printed nothing/);
    expect(() => parseAuthenticodeJson('[{"path":"a"}]')).toThrow(
      /unexpected Get-AuthenticodeSignature record/
    );
  });

  // The CN is parsed exactly as electron-updater parses it, quotes included.
  it('reads the CN the way electron-updater does', () => {
    expect(subjectCommonName('CN="Sarv, Inc.", O=X')).toBe('Sarv, Inc.');
    expect(subjectCommonName('O=No CN')).toBeNull();
    expect(subjectCommonName(null)).toBeNull();
  });

  // The pinned publisher is a PLAIN name, which electron-updater compares to
  // the CN only. If parseDn ever read it as a DN (an "=" in it), electron-updater
  // would compare DN components instead and the CN-derived pin would not match.
  it('derives a publisher electron-updater treats as a plain CN', () => {
    const publisher = publisherFromCertificate(cert(LEAF));
    expect(parseDn(publisher).size).toBe(0);
    expect(subjectCommonName(`CN=${publisher}, O=TEST ONLY, C=IN`)).toBe(publisher);
  });

  // The verdicts the release depends on, one per branch.
  it('passes valid, timestamped signatures by the publisher', () => {
    const verdict = judge(
      [
        { path: 'a.exe', kind: 'own', result: valid('a.exe') },
        { path: 'b.dll', kind: 'other', result: valid('b.dll') },
      ],
      [PUBLISHER]
    );
    expect(verdict).toEqual({ problems: [], upstream: [], ok: 2 });
  });

  // During a CN change our files may be signed by any pinned name: the old
  // certificate before the switch, the new one after.
  it('accepts our files signed by any name in publisherNames', () => {
    const verdict = judge(
      [{ path: 'a.exe', kind: 'own', result: valid('a.exe', 'Old Name Ltd') }],
      [PUBLISHER, 'Old Name Ltd']
    );
    expect(verdict).toEqual({ problems: [], upstream: [], ok: 1 });
  });

  // d3dcompiler_47.dll keeps Microsoft's signature: allowed, and logged.
  it('allows a DLL that kept its upstream signature, and reports it', () => {
    const verdict = judge(
      [{ path: 'd3d.dll', kind: 'other', result: valid('d3d.dll', 'Microsoft Corporation') }],
      [PUBLISHER]
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.upstream[0]).toMatch(
      /d3d.dll: kept its upstream signature from CN=Microsoft Corporation/
    );
  });

  // elevate.exe is electron-builder's helper, not one of OUR files: if it
  // arrives already signed (and timestamped) by its maker, the hook leaves
  // that signature alone and the release must accept it -- and say so.
  it('accepts elevate.exe that arrived signed by someone else, and reports it', () => {
    const verdict = judge(
      [
        {
          path: 'resources/elevate.exe',
          kind: 'other',
          result: valid('resources/elevate.exe', 'Upstream Helper Signer'),
        },
      ],
      [PUBLISHER]
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(1);
    expect(verdict.upstream).toEqual([
      expect.stringMatching(
        /resources\/elevate.exe: kept its upstream signature from CN=Upstream Helper Signer/
      ),
    ]);
  });

  // ...but an UNSIGNED elevate.exe, or one signed by someone else without a
  // timestamp, still fails: "may keep a foreign signature" never means "may
  // be unsigned".
  it('fails elevate.exe that is unsigned, or foreign-signed without a timestamp', () => {
    const unsigned = {
      ...valid('resources/elevate.exe'),
      status: 'NotSigned',
      statusMessage: 'The file is not digitally signed.',
      signerSubject: null,
    };
    const untimestamped = {
      ...valid('resources/elevate.exe', 'Upstream Helper Signer'),
      timeStamperSubject: null,
    };
    for (const result of [unsigned, untimestamped]) {
      const verdict = judge(
        [{ path: 'resources/elevate.exe', kind: 'other', result }],
        [PUBLISHER]
      );
      expect(verdict.ok).toBe(0);
      expect(verdict.upstream).toEqual([]);
      expect(verdict.problems[0]).toMatch(
        /resources\/elevate.exe: (signature status NotSigned|signed but NOT timestamped)/
      );
    }
  });

  // OUR files may never carry someone else's signature, however valid: the
  // app executables, the installer and the addons are what we vouch for.
  it.each([
    ['the app executable', 'win-unpacked/Sarv Inbox.exe'],
    ['the installer', 'Sarv-Inbox-Setup-1.0.0.exe'],
    ['a native addon', 'win-unpacked/resources/app.asar.unpacked/better_sqlite3.node'],
  ])('fails %s signed by someone else', (_label, file) => {
    const verdict = judge(
      [{ path: file, kind: 'own', result: valid(file, 'Upstream Helper Signer') }],
      [PUBLISHER]
    );
    expect(verdict.ok).toBe(0);
    expect(verdict.upstream).toEqual([]);
    expect(verdict.problems[0]).toMatch(
      /signed by "Upstream Helper Signer" .* expected the publisher: one of \["Sarv Inbox Test Publisher"\]/
    );
  });

  // OUR files must carry the committed certificate itself. The hook skips a
  // file that is already signed, so an app executable, installer or addon
  // that arrived signed under OUR name by some other certificate (a lookalike,
  // or an old one) would otherwise ship as ours.
  it.each([
    ['the app executable', 'win-unpacked/Sarv Inbox.exe'],
    ['the installer', 'Sarv-Inbox-Setup-1.0.0.exe'],
    ['a native addon', 'win-unpacked/resources/app.asar.unpacked/better_sqlite3.node'],
  ])('fails %s signed with our CN by a different certificate', (_label, file) => {
    const verdict = judge([
      { path: file, kind: 'own', result: valid(file, PUBLISHER, 'AB'.repeat(32)) },
    ]);
    expect(verdict.ok).toBe(0);
    expect(verdict.problems).toEqual([
      expect.stringMatching(
        new RegExp(
          `signed as "Sarv Inbox Test Publisher" but by certificate sha256 ${'AB'.repeat(32)} .*not the committed one \\(sha256 ${LEAF_CERT_SHA256_PS}\\)`
        )
      ),
    ]);
  });

  // No certificate reported, or no committed leaf to compare with: refused,
  // never waved through as "can't tell".
  it('fails our own file when either fingerprint is missing', () => {
    const noDigest = { ...valid('a.exe'), signerSha256: null };
    expect(judge([{ path: 'a.exe', kind: 'own', result: noDigest }]).problems[0]).toMatch(
      /certificate sha256 \(none reported\)/
    );
    const noLeaf = evaluateSignatures(
      [{ path: 'a.exe', kind: 'own', result: valid('a.exe') }],
      [PUBLISHER]
    );
    expect(noLeaf.ok).toBe(0);
    expect(noLeaf.problems[0]).toMatch(/not the committed one \(sha256 unknown\)/);
  });

  // The two spellings of one fingerprint -- Node's "AB:CD:…" and the query's
  // "ABCD…", in either case -- are the same certificate.
  it('matches the committed certificate whatever the digest spelling', () => {
    const lower = valid('a.exe', PUBLISHER, LEAF_CERT_SHA256_PS.toLowerCase());
    expect(judge([{ path: 'a.exe', kind: 'own', result: lower }])).toEqual({
      problems: [],
      upstream: [],
      ok: 1,
    });
  });

  // Unchanged for files that are not ours: a DLL or helper carrying our name
  // under another certificate is judged as before (the pin is for OUR files).
  it('leaves non-own files to the name check', () => {
    const verdict = judge([
      { path: 'x.dll', kind: 'other', result: valid('x.dll', PUBLISHER, 'CD'.repeat(32)) },
    ]);
    expect(verdict).toEqual({ problems: [], upstream: [], ok: 1 });
  });

  // Every failure an installed copy (or Windows) would act on.
  it.each([
    [
      'unsigned',
      {
        ...valid('a.exe'),
        status: 'NotSigned',
        statusMessage: 'The file is not digitally signed.',
        signerSubject: null,
      },
      /status NotSigned \(The file is not digitally signed.\)/,
    ],
    ['tampered', { ...valid('a.exe'), status: 'HashMismatch' }, /status HashMismatch/],
    [
      'untrusted',
      { ...valid('a.exe'), status: 'NotTrusted', statusMessage: '' },
      /status NotTrusted$/,
    ],
    ['not timestamped', { ...valid('a.exe'), timeStamperSubject: null }, /NOT timestamped/],
    [
      'our exe signed by someone else',
      valid('a.exe', 'Someone Else'),
      /signed by "Someone Else" .* expected the publisher/,
    ],
  ])('fails a file that is %s', (_label, result, message) => {
    const verdict = judge(
      [{ path: 'a.exe', kind: 'own', result: result as AuthenticodeResult }],
      [PUBLISHER]
    );
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toMatch(message);
    expect(verdict.ok).toBe(0);
  });

  // A PE file signExts never covers, or one PowerShell skipped, is a failure.
  it('fails unexpected PE files and missing results', () => {
    const verdict = judge(
      [
        { path: 'x.bin', kind: 'unexpected', result: valid('x.bin') },
        { path: 'y.exe', kind: 'own', result: undefined },
      ],
      [PUBLISHER]
    );
    expect(verdict.problems.join('\n')).toMatch(/x.bin: a PE file electron-builder never offers/);
    expect(verdict.problems.join('\n')).toMatch(
      /y.exe: Get-AuthenticodeSignature returned nothing/
    );
  });

  // The brick guard, both directions. Changed deliberately: the signed side
  // now takes the pinned list (publisherNames) instead of one publisher; every
  // assertion it had still holds.
  it('checks app-update.yml pins the publisher exactly when signing is on', () => {
    const on = { enabled: true, publisherNames: [PUBLISHER] };
    const off = { enabled: false };
    expect(appUpdatePublisherProblem({ provider: 'github' }, off, 'y')).toBeNull();
    expect(appUpdatePublisherProblem(null, off, 'y')).toBeNull();
    expect(appUpdatePublisherProblem({ publisherName: ['X'] }, off, 'y')).toMatch(
      /UNSIGNED build: every install would refuse/
    );
    expect(appUpdatePublisherProblem({ publisherName: [PUBLISHER] }, on, 'y')).toBeNull();
    expect(appUpdatePublisherProblem({ publisherName: PUBLISHER }, on, 'y')).toBeNull();
    expect(appUpdatePublisherProblem({ provider: 'github' }, on, 'y')).toMatch(
      /never check update signatures/
    );
    expect(appUpdatePublisherProblem({ publisherName: ['Other'] }, on, 'y')).toMatch(
      /reject correctly signed updates/
    );
    expect(appUpdatePublisherProblem({ publisherName: [PUBLISHER, 'Other'] }, on, 'y')).toMatch(
      /expected \["Sarv Inbox Test Publisher"\]/
    );
  });

  // THE brick guard, unsigned side. electron-updater skips the check only for
  // a publisherName that is `== null`; ANY other value -- an empty list, an
  // empty string, a name -- is a list every update is checked against, so the
  // first unsigned update after it is refused by every install.
  it.each([
    ['an empty list', { publisherName: [] }],
    ['an empty string', { publisherName: '' }],
    ['a plain string', { publisherName: PUBLISHER }],
    ['a list of names', { publisherName: [PUBLISHER] }],
  ])('fails an unsigned build whose app-update.yml carries %s', (_label, document) => {
    expect(appUpdatePublisherProblem(document, { enabled: false }, 'app-update.yml')).toMatch(
      /^app-update.yml carries publisherName .* in an UNSIGNED build: every install would refuse all later unsigned updates/
    );
  });

  // Absent, or an explicit null, is what electron-updater reads as "no check".
  it('passes an unsigned build whose app-update.yml has no publisherName, or null', () => {
    expect(appUpdatePublisherProblem({ provider: 'github' }, { enabled: false }, 'y')).toBeNull();
    expect(
      appUpdatePublisherProblem(
        { provider: 'github', publisherName: null },
        { enabled: false },
        'y'
      )
    ).toBeNull();
  });

  // Signed side, with a transition list: exactly the list, in order. A name
  // missing strands installs; an extra one widens who may ship updates.
  it('requires a signed build to pin exactly publisherNames, in order', () => {
    const on = { enabled: true, publisherNames: [REAL_CN, 'Old Name Ltd'] };
    expect(
      appUpdatePublisherProblem({ publisherName: [REAL_CN, 'Old Name Ltd'] }, on, 'y')
    ).toBeNull();
    expect(appUpdatePublisherProblem({ publisherName: [REAL_CN] }, on, 'y')).toMatch(
      /reject correctly signed updates/
    );
    expect(
      appUpdatePublisherProblem({ publisherName: [REAL_CN, 'Old Name Ltd', 'Third'] }, on, 'y')
    ).toMatch(/also accept updates signed by a name/);
    expect(
      appUpdatePublisherProblem({ publisherName: ['Old Name Ltd', REAL_CN] }, on, 'y')
    ).toMatch(/different order/);
    expect(appUpdatePublisherProblem({ publisherName: [] }, on, 'y')).toMatch(
      /expected \["SARV WEBS PRIVATE LIMITED","Old Name Ltd"\]: installs would reject/
    );
  });
});

/** A release directory shaped like electron-builder's Windows output. */
const makeRelease = (publisherLine = `publisherName:\n  - ${PUBLISHER}\n`) => {
  const release = join(scratch, 'release');
  for (const name of ['win-unpacked', 'win-arm64-unpacked']) {
    const dir = join(release, name);
    writeFile(join('release', name, 'Sarv Inbox.exe'), fullPe());
    writeFile(join('release', name, 'resources', 'elevate.exe'), fullPe({ format: 'PE32' }));
    writeFile(
      join(
        'release',
        name,
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'better_sqlite3.node'
      ),
      fullPe()
    );
    writeFile(join('release', name, 'ffmpeg.dll'), fullPe());
    writeFile(join('release', name, 'locales', 'en-US.pak'), Buffer.from('not a binary'));
    writeFileSync(
      join(dir, 'resources', 'app-update.yml'),
      `owner: Sarv\nrepo: Inbox\nprovider: github\n${publisherLine}`
    );
  }
  writeFile(join('release', 'Sarv-Inbox-Setup-1.0.0.exe'), fullPe({ format: 'PE32' }));
  writeFile(join('release', 'latest.yml'), Buffer.from('version: 1.0.0\n'));
  return release;
};

describe('collectReleasePeFiles', () => {
  // Every PE file in both apps plus the installer is found by content, with
  // no Electron DLL list to go stale.
  it('finds every PE file of both apps and the installer', () => {
    const release = makeRelease();
    const { files, problems } = collectReleasePeFiles(release);
    expect(problems).toEqual([]);
    expect(files).toHaveLength(9);
    expect(files.filter((file) => file.kind === 'other')).toHaveLength(4);
    expect(files.some((file) => file.path.endsWith('Sarv-Inbox-Setup-1.0.0.exe'))).toBe(true);
    expect(files.some((file) => file.path.endsWith('.pak'))).toBe(false);
  });

  // Which files must be OURS is decided here, by where electron-builder puts
  // them: both app executables, the installer and the addons are 'own';
  // elevate.exe and the DLLs are 'other'. A slip would either accept a
  // foreign signature on the app, or reject Microsoft's on a DLL.
  it('marks the app executables, the installer and the addons as ours', () => {
    const release = makeRelease();
    const kinds = Object.fromEntries(
      collectReleasePeFiles(release).files.map((file) => [
        file.path.slice(release.length + 1),
        file.kind,
      ])
    );
    expect(kinds).toEqual({
      [join('win-unpacked', 'Sarv Inbox.exe')]: 'own',
      [join('win-arm64-unpacked', 'Sarv Inbox.exe')]: 'own',
      'Sarv-Inbox-Setup-1.0.0.exe': 'own',
      [join(
        'win-unpacked',
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'better_sqlite3.node'
      )]: 'own',
      [join(
        'win-arm64-unpacked',
        'resources',
        'app.asar.unpacked',
        'node_modules',
        'better-sqlite3',
        'better_sqlite3.node'
      )]: 'own',
      [join('win-unpacked', 'resources', 'elevate.exe')]: 'other',
      [join('win-arm64-unpacked', 'resources', 'elevate.exe')]: 'other',
      [join('win-unpacked', 'ffmpeg.dll')]: 'other',
      [join('win-arm64-unpacked', 'ffmpeg.dll')]: 'other',
    });
  });

  // The walk must not pass by finding nothing: each app must hold its exe,
  // elevate.exe and an addon, and the release an installer.
  it('reports a missing app, exe, elevate.exe, addon or installer', () => {
    const empty = join(scratch, 'empty');
    mkdirSync(join(empty, 'win-unpacked', 'resources'), { recursive: true });
    const { problems } = collectReleasePeFiles(empty);
    const text = problems.join('\n');
    expect(text).toMatch(/win-unpacked: no application .exe found/);
    expect(text).toMatch(/resources\/elevate.exe is missing/);
    expect(text).toMatch(/no native .node addon found/);
    expect(text).toMatch(/win-arm64-unpacked does not exist/);
    expect(text).toMatch(/no installer \(.exe\) found/);
    expect(collectReleasePeFiles(join(scratch, 'nowhere')).problems.join('\n')).toMatch(
      /no installer/
    );
  });

  // A file the walk cannot read is a failure, not "not a binary" -- otherwise
  // an unreadable unsigned DLL would pass unexamined.
  // Skipped on Windows (chmod 000 does not make a file unreadable there) and
  // as root (root reads it anyway): neither can produce the unreadable file.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a file it cannot read',
    () => {
      const release = makeRelease();
      const locked = writeFile(join('release', 'win-unpacked', 'locked.dll'), fullPe());
      chmodSync(locked, 0o000);
      try {
        expect(collectReleasePeFiles(release).problems.join('\n')).toMatch(
          /locked.dll: cannot be read/
        );
      } finally {
        chmodSync(locked, 0o644);
      }
    }
  );

  // A binary hiding behind an unexpected extension is still found; a
  // ".dll" that is not a PE is reported rather than skipped.
  it('flags PE files with other extensions and fake binaries', () => {
    const release = makeRelease();
    writeFile(join('release', 'win-unpacked', 'helper.bin'), fullPe());
    writeFile(join('release', 'win-unpacked', 'fake.dll'), Buffer.from('text'));
    const { files, problems } = collectReleasePeFiles(release);
    expect(files.find((file) => file.path.endsWith('helper.bin'))?.kind).toBe('unexpected');
    expect(problems.join('\n')).toMatch(/fake.dll: has a binary's extension but is not a PE file/);
  });
});

describe('queryAuthenticode', () => {
  // The script goes in encoded (no cmd.exe quoting), the paths through a file
  // named in the environment (no injection), and the temp file is removed.
  it('runs Get-AuthenticodeSignature through powershell.exe with an encoded script', async () => {
    let seenList = '';
    let listPath = '';
    const run = vi.fn(async (_file: string, _args: string[], options: object) => {
      listPath = (options as { env: Record<string, string> }).env.SARV_AUTHENTICODE_LIST;
      seenList = readFileSync(listPath, 'utf8');
      return {
        stdout: JSON.stringify([
          {
            path: 'C:\\a b\\x.exe',
            status: 'Valid',
            statusMessage: '',
            signerSubject: null,
            timeStamperSubject: null,
          },
        ]),
      };
    });
    const results = await queryAuthenticode(['C:\\a b\\x.exe', 'C:\\y.dll'], {
      run,
      tmpDir: scratch,
    });
    expect(results[0].status).toBe('Valid');
    const [file, args] = run.mock.calls[0];
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    const script = Buffer.from(args[5], 'base64').toString('utf16le');
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $p');
    expect(script).toContain('[string]$s.Status');
    // The signer certificate itself, so OUR files can be pinned to the
    // committed one: Windows' thumbprint, and the SHA-256 of its DER.
    expect(script).toContain(
      'signerThumbprint = $(if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint }'
    );
    expect(script).toContain(
      'signerSha256 = $(if ($s.SignerCertificate) { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s.SignerCertificate.RawData)).Replace("-", "") }'
    );
    expect(seenList).toBe('C:\\a b\\x.exe\nC:\\y.dll\n');
    expect(existsSync(listPath)).toBe(false);
  });

  // A PowerShell failure must surface, and still clean up.
  it('propagates a failed query and removes its temp files', async () => {
    const run = vi.fn(async () => {
      throw new Error('powershell.exe not found');
    });
    await expect(queryAuthenticode(['a.exe'], { run, tmpDir: scratch })).rejects.toThrow(
      /not found/
    );
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe('verifyWindowsRelease', () => {
  // Changed deliberately: results carry the signer certificate's digest, and
  // `signed` the committed leaf's, since our own files are now pinned to it.
  const allValid = async (files: string[]): Promise<AuthenticodeResult[]> =>
    files.map((path) => ({
      path,
      status: 'Valid',
      statusMessage: null,
      signerSubject: `CN=${PUBLISHER}`,
      timeStamperSubject: 'CN=TSA',
      signerSha256: LEAF_CERT_SHA256_PS,
    }));
  const signed = { enabled: true, publisherNames: [PUBLISHER], leafSha256: LEAF_CERT_SHA256 };
  /** Every file valid and ours, except those whose path ends in `suffix`, which get `override`. */
  const allValidExcept =
    (suffix: string, override: Partial<AuthenticodeResult>) => async (files: string[]) =>
      (await allValid(files)).map((result) =>
        result.path.endsWith(suffix) ? { ...result, ...override } : result
      );

  // Disabled: the step warns, checks nothing else, and passes a clean build.
  it('only warns about a correctly unsigned build', async () => {
    const query = vi.fn(allValid);
    const result = await verifyWindowsRelease({
      releaseDir: makeRelease(''),
      status: { enabled: false },
      query,
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings[0]).toMatch(/NOT code-signed/);
    expect(query).not.toHaveBeenCalled();
  });

  // The brick guard: an unsigned build that pins a publisher must FAIL.
  it('fails an unsigned build whose app-update.yml pins a publisher', async () => {
    const result = await verifyWindowsRelease({
      releaseDir: makeRelease(),
      status: { enabled: false },
    });
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/UNSIGNED build/);
  });

  // The brick guard on the file electron-builder actually writes: an empty
  // list is a pin too. Only a missing key, or null, passes.
  it('fails an unsigned build whose app-update.yml says publisherName: [] and passes null', async () => {
    const empty = await verifyWindowsRelease({
      releaseDir: makeRelease('publisherName: []\n'),
      status: { enabled: false },
    });
    expect(empty.problems).toHaveLength(2);
    expect(empty.problems[0]).toMatch(/carries publisherName \[\] in an UNSIGNED build/);
    rmSync(join(scratch, 'release'), { recursive: true });
    const explicitNull = await verifyWindowsRelease({
      releaseDir: makeRelease('publisherName: null\n'),
      status: { enabled: false },
    });
    expect(explicitNull.problems).toEqual([]);
  });

  // Enabled: every file is queried and judged, app-update.yml checked.
  it('passes a correctly signed build and checks every PE file', async () => {
    const query = vi.fn(allValid);
    const result = await verifyWindowsRelease({ releaseDir: makeRelease(), status: signed, query });
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(9);
    expect(query.mock.calls[0][0]).toHaveLength(9);
  });

  // elevate.exe arriving signed by its maker passes (in both apps), and is
  // reported, so the release log shows whose signature shipped.
  it('accepts a pre-signed elevate.exe and reports it', async () => {
    const query = allValidExcept('elevate.exe', { signerSubject: 'CN=Upstream Helper Signer' });
    const result = await verifyWindowsRelease({ releaseDir: makeRelease(), status: signed, query });
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(9);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toMatch(
      /elevate.exe: kept its upstream signature from CN=Upstream Helper Signer/
    );
  });

  // An unsigned elevate.exe fails the release: it is the helper that installs
  // updates with elevation, and Smart App Control blocks unsigned code.
  it('fails an unsigned elevate.exe', async () => {
    const query = allValidExcept('elevate.exe', {
      status: 'NotSigned',
      statusMessage: 'The file is not digitally signed.',
      signerSubject: null,
    });
    const result = await verifyWindowsRelease({ releaseDir: makeRelease(), status: signed, query });
    expect(result.problems).toHaveLength(2);
    expect(
      result.problems.every((problem) => /elevate.exe: signature status NotSigned/.test(problem))
    ).toBe(true);
  });

  // An app executable that arrived pre-signed under OUR name by another
  // certificate is refused in the real release walk too (both arches).
  it('fails a pre-signed app executable carrying our CN but another certificate', async () => {
    const query = allValidExcept('Sarv Inbox.exe', { signerSha256: 'EF'.repeat(32) });
    const result = await verifyWindowsRelease({ releaseDir: makeRelease(), status: signed, query });
    expect(result.problems).toHaveLength(2);
    expect(
      result.problems.every((problem) =>
        /Sarv Inbox.exe: signed as .* not the committed one/.test(problem)
      )
    ).toBe(true);
  });

  // Our own files signed by anyone but a pinned publisher fail, however valid.
  it.each([['Sarv Inbox.exe'], ['Setup-1.0.0.exe'], ['better_sqlite3.node']])(
    'fails %s signed by someone else',
    async (suffix) => {
      const query = allValidExcept(suffix, { signerSubject: 'CN=Upstream Helper Signer' });
      const result = await verifyWindowsRelease({
        releaseDir: makeRelease(),
        status: signed,
        query,
      });
      expect(result.problems.length).toBeGreaterThan(0);
      expect(
        result.problems.every(
          (problem) => problem.includes(suffix) && problem.includes('expected the publisher')
        )
      ).toBe(true);
      expect(result.notes).toEqual([]);
    }
  );

  // Enabled with a missing app-update.yml, or a file PowerShell did not report.
  it('fails on a missing app-update.yml or an unreported file', async () => {
    const release = makeRelease();
    rmSync(join(release, 'win-unpacked', 'resources', 'app-update.yml'));
    const query = vi.fn(async (files: string[]) => (await allValid(files)).slice(1));
    const result = await verifyWindowsRelease({ releaseDir: release, status: signed, query });
    expect(result.problems.join('\n')).toMatch(/app-update.yml is missing/);
    expect(result.problems.join('\n')).toMatch(/returned nothing for it/);
  });

  // An empty release dir still fails rather than "verifying nothing".
  it('does not query when nothing was found, and fails', async () => {
    const query = vi.fn(allValid);
    const result = await verifyWindowsRelease({
      releaseDir: join(scratch, 'none'),
      status: signed,
      query,
    });
    expect(query).not.toHaveBeenCalled();
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

describe('workflow outputs and the jsign download', () => {
  // A line break in an output value would let it forge a second output.
  it('formats GitHub outputs and refuses line breaks', () => {
    expect(formatGithubOutput({ enabled: 'true', publisher: 'A B' })).toBe(
      'enabled=true\npublisher=A B\n'
    );
    expect(() => formatGithubOutput({ publisher: 'A\nenabled=true' })).toThrow(/line break/);
  });

  // What release.yml branches on, in both states. publisher_names is the
  // whole pinned list as one JSON line, which the Package step expands into
  // one -c flag per name.
  it('reports status outputs for both states', () => {
    expect(
      statusOutputs(
        loadWindowsSigningConfig(writeConfig({ workloadIdentityProvider: '' }), { now: NOW })
      )
    ).toEqual({
      enabled: 'false',
      publisher: '',
      publisher_names: '[]',
      provider: '',
      service_account: 'gha-authenticode@sarv-inbox-signing.iam.gserviceaccount.com',
    });
    expect(statusOutputs(loadEnabled())).toMatchObject({
      enabled: 'true',
      publisher: PUBLISHER,
      publisher_names: '["Sarv Inbox Test Publisher"]',
      provider: PROVIDER,
    });
    const transition = loadEnabled(
      writeConfig({ publisherNames: [PUBLISHER, 'Old Name Ltd'] }, leafChain())
    );
    expect(JSON.parse(statusOutputs(transition).publisher_names)).toEqual([
      PUBLISHER,
      'Old Name Ltd',
    ]);
    expect(() => formatGithubOutput(statusOutputs(transition))).not.toThrow();
  });

  const fakeFetch = (body: string, status = 200) =>
    vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

  // The jar is only written once its digest matches the pin.
  it('downloads jsign and keeps it only if the digest matches', async () => {
    const sha256 = createHash('sha256').update('jar bytes').digest('hex');
    const jsign = { version: '7.5', url: 'https://example.test/jsign-7.5.jar', sha256 };
    const dest = join(scratch, 'jsign');
    const jar = await fetchJsign({ jsign, destDir: dest, fetchImpl: fakeFetch('jar bytes') });
    expect(jar).toBe(join(dest, 'jsign-7.5.jar'));
    expect(readFileSync(jar, 'utf8')).toBe('jar bytes');

    const other = join(scratch, 'other');
    await expect(
      fetchJsign({ jsign, destDir: other, fetchImpl: fakeFetch('tampered') })
    ).rejects.toThrow(/refusing it/);
    expect(existsSync(other)).toBe(false);
    await expect(
      fetchJsign({ jsign, destDir: other, fetchImpl: fakeFetch('', 404) })
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('command-line entry points', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, log: (m: string) => out.push(m), error: (m: string) => err.push(m) };
  };

  // The status step's outputs, written to $GITHUB_OUTPUT, plus the warning
  // that the build is unsigned.
  it('status: writes outputs and warns while disabled', async () => {
    const output = join(scratch, 'out.txt');
    const sink = io();
    const configPath = writeConfig({ workloadIdentityProvider: '' });
    expect(
      await windowsSigningCli(['status', '--github-output'], {
        ...sink,
        configPath,
        env: { GITHUB_OUTPUT: output },
      })
    ).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('enabled=false\n');
    expect(sink.out[0]).toMatch(/^::warning::.*NOT code-signed/);
  });

  // Enabled: names the publisher and the pinned list; misconfigured: exit 1
  // so the build stops.
  it('status: reports the publisher when enabled and fails when misconfigured', async () => {
    const sink = io();
    const output = join(scratch, 'enabled-out.txt');
    expect(
      await windowsSigningCli(['status', '--github-output'], {
        ...sink,
        configPath: writeConfig({}, leafChain()),
        now: NOW,
        env: { GITHUB_OUTPUT: output },
      })
    ).toBe(0);
    expect(sink.out[0]).toMatch(
      /ENABLED, publisher "Sarv Inbox Test Publisher".*app-update.yml will pin \["Sarv Inbox Test Publisher"\]/
    );
    expect(readFileSync(output, 'utf8')).toContain(
      'publisher_names=["Sarv Inbox Test Publisher"]\n'
    );
    const bad = io();
    expect(
      await windowsSigningCli(['status'], {
        ...bad,
        configPath: writeConfig({ workloadIdentityProvider: '' }, leafChain()),
        now: NOW,
      })
    ).toBe(1);
    expect(bad.err[0]).toMatch(/^::error::windows signing is ENABLED/);
  });

  // The latch at the status step: the release stops before anything is built,
  // with outputs never written.
  it('status: fails when publisherNames is set but the chain is missing', async () => {
    const sink = io();
    const output = join(scratch, 'latch-out.txt');
    const configPath = writeConfig({ publisherNames: [PUBLISHER] });
    expect(
      await windowsSigningCli(['status', '--github-output'], {
        ...sink,
        configPath,
        env: { GITHUB_OUTPUT: output },
      })
    ).toBe(1);
    expect(sink.err[0]).toMatch(
      /^::error::windows signing: signing was switched on; the certificate chain is missing/
    );
    expect(existsSync(output)).toBe(false);
  });

  // The release's status step: what Latest pins is looked up FIRST and named
  // in the log, and a build those installs would refuse exits 1 before any
  // output is written -- so no signing (or unsigned) step runs after it.
  it('status --previous-release: refuses a revert of the switch-on, with no outputs', async () => {
    const sink = io();
    const output = join(scratch, 'revert-out.txt');
    const { run } = fakeGh(latestRelease('v1.5.0', releasedConfig([REAL_CN])));
    const configPath = writeConfig({ workloadIdentityProvider: '' });
    expect(
      await windowsSigningCli(['status', '--previous-release', GH_REPO, '--github-output'], {
        ...sink,
        configPath,
        run,
        env: { GITHUB_OUTPUT: output },
      })
    ).toBe(1);
    expect(sink.out[0]).toBe(
      'Last published release v1.5.0: installed copies pin ["SARV WEBS PRIVATE LIMITED"].'
    );
    expect(sink.err[0]).toMatch(
      /^::error::windows signing: the last published release \(v1\.5\.0\) is signed/
    );
    expect(existsSync(output)).toBe(false);
  });

  // Each "nothing pinned" case passes and says which it was; a signed build
  // whose CN the Latest release pins passes too.
  it('status --previous-release: passes, and logs why, when nothing forbids this build', async () => {
    const cases: Array<[Record<string, GhAnswer>, string, RegExp]> = [
      [
        { [`repos/${GH_REPO}`]: GH_REPO, [`repos/${GH_REPO}/releases/latest`]: { http: 404 } },
        writeConfig({ workloadIdentityProvider: '' }),
        /none \(releases\/latest is 404\)/,
      ],
      [
        latestRelease('v1.4.10', { http: 404 }),
        writeConfig({ workloadIdentityProvider: '' }),
        /predates Windows signing/,
      ],
      [
        latestRelease('v1.5.0', releasedConfig([PUBLISHER])),
        writeConfig({}, leafChain()),
        /installed copies pin \["Sarv Inbox Test Publisher"\]/,
      ],
    ];
    for (const [answers, configPath, logged] of cases) {
      const sink = io();
      expect(
        await windowsSigningCli(['status', '--previous-release', GH_REPO], {
          ...sink,
          configPath,
          now: NOW,
          run: fakeGh(answers).run,
        })
      ).toBe(0);
      expect(sink.out[0]).toMatch(logged);
      expect(sink.out.join('\n')).not.toMatch(/Not checked/);
    }
  });

  // A lookup that fails for any other reason stops the release.
  it('status --previous-release: fails closed when GitHub cannot be read', async () => {
    const sink = io();
    const output = join(scratch, 'blip-out.txt');
    const answers = {
      [`repos/${GH_REPO}`]: GH_REPO,
      [`repos/${GH_REPO}/releases/latest`]: { http: 502 },
    };
    expect(
      await windowsSigningCli(['status', '--previous-release', GH_REPO, '--github-output'], {
        ...sink,
        configPath: writeConfig({ workloadIdentityProvider: '' }),
        run: fakeGh(answers).run,
        env: { GITHUB_OUTPUT: output },
      })
    ).toBe(1);
    expect(sink.err[0]).toMatch(
      /^::error::gh api repos\/Sarv\/Inbox\/releases\/latest .* failed: gh: Bad Gateway \(HTTP 502\)/
    );
    expect(existsSync(output)).toBe(false);
  });

  // A flag without its repository is a usage error, not "no check"; and a
  // local run without the flag says it did not check.
  it('status: a bare --previous-release is a usage error; no flag says so', async () => {
    const bare = io();
    expect(
      await windowsSigningCli(['status', '--previous-release'], {
        ...bare,
        configPath: writeConfig({ workloadIdentityProvider: '' }),
      })
    ).toBe(2);
    expect(
      await windowsSigningCli(['status', '--previous-release', '--github-output'], {
        ...io(),
        configPath: writeConfig({ workloadIdentityProvider: '' }),
      })
    ).toBe(2);
    const local = io();
    expect(
      await windowsSigningCli(['status'], {
        ...local,
        configPath: writeConfig({ workloadIdentityProvider: '' }),
      })
    ).toBe(0);
    expect(local.out.at(-1)).toMatch(/^Not checked against the last published release/);
  });

  // Usage errors and a missing GITHUB_OUTPUT are loud, not silent no-ops.
  it('rejects unknown commands, a missing --dest and a missing GITHUB_OUTPUT', async () => {
    const configPath = writeConfig({ workloadIdentityProvider: '' });
    expect(await windowsSigningCli(['frobnicate'], { ...io(), configPath })).toBe(2);
    const noDest = io();
    expect(await windowsSigningCli(['fetch-jsign'], { ...noDest, configPath })).toBe(1);
    expect(noDest.err[0]).toMatch(/needs --dest/);
    const noOutput = io();
    expect(
      await windowsSigningCli(['status', '--github-output'], { ...noOutput, configPath, env: {} })
    ).toBe(1);
    expect(noOutput.err[0]).toMatch(/GITHUB_OUTPUT is not set/);
  });

  // fetch-jsign hands the verified jar's path to the workflow.
  it('fetch-jsign: writes the verified jar path to GITHUB_OUTPUT', async () => {
    const sha256 = createHash('sha256').update('jar').digest('hex');
    const configPath = writeConfig({ jsign: { ...committedConfig().jsign, sha256 } });
    const output = join(scratch, 'out.txt');
    const fetchImpl = vi.fn(async () => new Response('jar')) as unknown as typeof fetch;
    const dest = join(scratch, 'dest');
    const sink = io();
    expect(
      await windowsSigningCli(['fetch-jsign', '--dest', dest, '--github-output'], {
        ...sink,
        configPath,
        fetchImpl,
        env: { GITHUB_OUTPUT: output },
      })
    ).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(`path=${join(dest, 'jsign-7.5.jar')}\n`);
    // Without --github-output it only reports.
    const plain = io();
    expect(
      await windowsSigningCli(['fetch-jsign', '--dest', join(scratch, 'plain')], {
        ...plain,
        configPath,
        fetchImpl,
      })
    ).toBe(0);
    expect(plain.out[0]).toMatch(/jsign 7.5 verified/);
  });

  // verify-win-signatures: usage, the disabled warning, a failure, and a pass.
  it('verify-win-signatures: exits by verdict', async () => {
    expect(await verifyWinSignaturesCli([], io())).toBe(2);
    const disabled = io();
    const disabledConfig = writeConfig({ workloadIdentityProvider: '' });
    expect(
      await verifyWinSignaturesCli([makeRelease('')], { ...disabled, configPath: disabledConfig })
    ).toBe(0);
    expect(disabled.out.join('\n')).toMatch(/::warning::.*NOT code-signed/);
    rmSync(join(scratch, 'release'), { recursive: true });

    const bricked = io();
    expect(
      await verifyWinSignaturesCli([makeRelease()], { ...bricked, configPath: disabledConfig })
    ).toBe(1);
    expect(bricked.err.join('\n')).toMatch(/UNSIGNED build[\s\S]*Do not publish/);

    const enabled = io();
    const query = async (files: string[]) =>
      files.map((path) => ({
        path,
        status: 'Valid',
        statusMessage: null,
        signerSubject: path.endsWith('ffmpeg.dll') ? 'CN=Microsoft Corporation' : `CN=${PUBLISHER}`,
        timeStamperSubject: 'CN=TSA',
        // Changed deliberately: our files report the committed certificate,
        // which the CLI now pins them to (loaded.leaf.fingerprint256).
        signerSha256: path.endsWith('ffmpeg.dll') ? 'AA'.repeat(32) : LEAF_CERT_SHA256_PS,
      }));
    expect(
      await verifyWinSignaturesCli([join(scratch, 'release')], {
        ...enabled,
        configPath: writeConfig({}, leafChain()),
        now: NOW,
        query,
      })
    ).toBe(0);
    expect(enabled.out.join('\n')).toMatch(/NOTE: .*ffmpeg.dll: kept its upstream signature/);
    expect(enabled.out.at(-1)).toMatch(/OK: 9 PE files/);

    const broken = io();
    expect(
      await verifyWinSignaturesCli([join(scratch, 'release')], {
        ...broken,
        configPath: writeConfig({ workloadIdentityProvider: '' }, leafChain()),
        now: NOW,
      })
    ).toBe(1);

    // The latch: a pinned list with no chain fails the verify step too.
    const latched = io();
    expect(
      await verifyWinSignaturesCli([join(scratch, 'release')], {
        ...latched,
        configPath: writeConfig({ publisherNames: [PUBLISHER] }),
      })
    ).toBe(1);
    expect(latched.err[0]).toMatch(/certificate chain is missing/);
  });

  // verify-pe-signed: the publish job's presence check, in every state.
  it('verify-pe-signed: warns when disabled, and checks each file when enabled', async () => {
    expect(await verifyPeSignedCli([], io())).toBe(2);
    const disabled = io();
    expect(
      await verifyPeSignedCli(['whatever.exe'], {
        ...disabled,
        configPath: writeConfig({ workloadIdentityProvider: '' }),
      })
    ).toBe(0);
    expect(disabled.out[0]).toMatch(/::warning::/);

    const configPath = writeConfig({}, leafChain());
    const signed = writeFile(
      'Setup.exe',
      fullPe({ format: 'PE32', certificate: winCertificate() })
    );
    const ok = io();
    expect(await verifyPeSignedCli([signed], { ...ok, configPath, now: NOW })).toBe(0);
    expect(ok.out[0]).toMatch(/carries an Authenticode certificate table \(PE32\)/);

    const bad = io();
    const unsigned = writeFile('Unsigned.exe', fullPe({ format: 'PE32' }));
    const text = writeFile('notes.exe', Buffer.from('text'));
    expect(
      await verifyPeSignedCli([unsigned, text, join(scratch, 'artifacts/*.exe')], {
        ...bad,
        configPath,
        now: NOW,
      })
    ).toBe(1);
    expect(bad.err.join('\n')).toMatch(
      /Unsigned.exe: no certificate table[\s\S]*notes.exe is not a PE file[\s\S]*\*\.exe does not exist/
    );

    const broken = io();
    expect(
      await verifyPeSignedCli([signed], {
        ...broken,
        configPath: writeConfig({ workloadIdentityProvider: '' }, leafChain()),
        now: NOW,
      })
    ).toBe(1);

    // The latch reaches the publish job's check as well.
    const latched = io();
    expect(
      await verifyPeSignedCli([signed], {
        ...latched,
        configPath: writeConfig({ publisherNames: [PUBLISHER] }),
      })
    ).toBe(1);
    expect(latched.err[0]).toMatch(/certificate chain is missing/);
  });
});
