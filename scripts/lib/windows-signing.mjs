/*
 * Windows Authenticode signing for the release build: configuration, the
 * signing call itself, and the checks that prove it happened.
 *
 * Why this exists. The Windows builds used to ship unsigned. Signing is done
 * with jsign against an HSM key in Google Cloud KMS (docs/WINDOWS_SIGNING.md),
 * from inside electron-builder (apps/desktop/build/windowsSign.js), because
 * latest.yml's checksum, the signed update manifest and SHA256SUMS are all
 * computed over the bytes electron-builder leaves behind -- a signature added
 * afterwards would invalidate every one of them.
 *
 * Two properties carry the whole design, and most of this module is there to
 * enforce them:
 *
 *  1. DORMANT until the certificate chain is committed. Signing is ENABLED if
 *     and only if apps/desktop/build/windows-signing-chain.pem exists. Before
 *     that, every build is exactly what it was: unsigned, and with NO
 *     publisherName in app-update.yml.
 *
 *  2. FAIL-CLOSED from then on. Once the chain exists, a misconfiguration
 *     (no identity provider, a chain that does not parse or does not match the
 *     KMS key, an expired certificate, a CN that is not the pinned publisher, a
 *     missing token or jsign jar) throws and stops the release. The asymmetry is
 *     deliberate: the first signed release writes publisherName into every
 *     installed copy's app-update.yml, and electron-updater then refuses any
 *     update that is not signed by one of those names. One unsigned (or
 *     wrongly signed) Windows release after that point strands every user on
 *     the version they have.
 *
 * The publisher names are PINNED in windows-signing.json (publisherNames), not
 * only derived: the certificate's CN must equal publisherNames[0] exactly, so a
 * reissued certificate under a different spelling fails the build instead of
 * silently re-pinning every install. The list is also a ONE-WAY LATCH: once it
 * is non-empty, a missing chain is an error rather than "signing is off", so
 * signing can only be switched off by deliberately emptying the list -- never
 * by a chain file lost in a merge.
 *
 * The same reasoning is why publisherName is never written into package.json:
 * an UNSIGNED build carrying it would make every install refuse every later
 * unsigned update. release.yml passes it on the command line only when signing
 * is enabled, and verify-win-signatures checks both directions.
 *
 * Everything that can be pure is pure and takes its I/O as parameters, so the
 * tests can drive every branch without Windows, Java or a certificate.
 */

import { execFile } from 'node:child_process';
import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parseDn } from 'builder-util-runtime';
import { parse as parseYaml } from 'yaml';

import { readFileHeader, readTreeOnDisk } from './native-addons.mjs';
import {
  certificateTableProblem,
  isPeBinary,
  readPeCertificateTable,
  WIN_CERTIFICATE_HEADER_BYTES,
} from './pe-machine.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The committed signing configuration. The chain file sits next to it. */
export const DEFAULT_CONFIG_PATH = path.join(
  LIB_DIR,
  '..',
  '..',
  'apps',
  'desktop',
  'build',
  'windows-signing.json'
);

/**
 * The environment variable that carries the short-lived Google access token.
 * jsign reads it itself (`--storepass env:…`), so the token is never on a
 * command line, in electron-builder's log, or in an error message.
 */
export const SIGNING_TOKEN_ENV = 'SARV_WINDOWS_SIGNING_TOKEN';

/** Path of the checksum-verified jsign jar, set by the release workflow. */
export const JSIGN_JAR_ENV = 'JSIGN_JAR';

/** The extended-key-usage OID a certificate needs to sign code. */
export const CODE_SIGNING_EKU = '1.3.6.1.5.5.7.3.3';

/** The only digest the KMS key (RSA_SIGN_PKCS1_3072_SHA256) can sign. */
export const SIGNING_HASH = 'sha256';

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

const CONFIG_KEYS = [
  'kms',
  'publicKeySha256',
  'certificateChain',
  'publisherNames',
  'workloadIdentityProvider',
  'serviceAccount',
  'timestampUrls',
  'programName',
  'programUrl',
  'jsign',
];
const KMS_KEYS = ['keyRing', 'keyVersion'];
const JSIGN_KEYS = ['version', 'url', 'sha256'];

// Anchored, single-pass patterns over short resource names: no nested
// quantifiers, so no backtracking blow-up on hostile input. They check the
// SHAPE Google documents for each name, nothing cleverer.
const KEY_RING_PATTERN =
  /^projects\/[a-z][a-z0-9-]*\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+$/;
const KEY_VERSION_PATTERN = /^[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9][0-9]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_PATTERN =
  /^projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const SERVICE_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*\.iam\.gserviceaccount\.com$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
/**
 * The characters a publisher CN may use. Windows renders a certificate subject
 * as "CN=…, O=…" with its own quoting, Node as one "KEY=value" per line with
 * backslash escapes, and electron-updater compares the two byte for byte. A CN
 * with a comma, quote, plus, equals or backslash is spelled differently by the
 * two, so it is refused here rather than allowed to brick auto-update.
 */
const SAFE_PUBLISHER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .&'()-]*$/;

/** @param {unknown} value */
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Why a publisher name could never be matched by electron-updater, or null.
 * One rule for the names typed into windows-signing.json and the CN read from
 * the certificate, so the two cannot disagree on what is pinnable.
 *
 * @param {unknown} name
 * @returns {string | null}
 */
function publisherNameProblem(name) {
  if (typeof name !== 'string') return 'is not a string';
  if (!SAFE_PUBLISHER_PATTERN.test(name)) {
    return 'uses characters Windows and Node spell differently; electron-updater could never match it';
  }
  // The pattern admits spaces, so a trailing one gets through it. Windows
  // quotes such a CN and Node escapes it: never the same string twice.
  if (name !== name.trim()) return 'ends in whitespace; electron-updater could never match it';
  return null;
}

/**
 * Element-wise equality of two name lists, order included. Strict: the number
 * 12345 is not the CN "12345" (electron-builder's CLI parses a numeric -c
 * value as a number, and electron-updater compares with ===).
 *
 * @param {unknown[]} a
 * @param {unknown[]} b
 */
const sameNames = (a, b) => a.length === b.length && a.every((name, index) => name === b[index]);

/**
 * A publisherName value as electron-builder and electron-updater both read it:
 * absent/null is "no names", a string is one name, an array is the list.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
const asNameList = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

/**
 * @param {string} value
 * @param {string[]} protocols
 */
function urlProblem(value, protocols) {
  if (typeof value !== 'string' || value === '') return 'must be a URL';
  let url;
  try {
    url = new URL(value);
  } catch {
    return `"${value}" is not a URL`;
  }
  return protocols.includes(url.protocol) ? null : `"${value}" must use ${protocols.join(' or ')}`;
}

/**
 * @param {Record<string, unknown>} object
 * @param {string[]} allowed
 * @param {string} where
 * @param {string[]} problems
 */
function rejectUnknownKeys(object, allowed, where, problems) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key))
      problems.push(`${where}${key}: unknown key (a typo here would be silently ignored)`);
  }
}

/**
 * The shape rule for a publisherNames list: an array of pinnable names, none
 * twice. Shared by the committed config and a published release's config.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function publisherNamesProblems(value) {
  if (!Array.isArray(value)) {
    return ['publisherNames: must be a list of publisher names ([] while signing is off)'];
  }
  /** @type {string[]} */
  const problems = [];
  value.forEach((/** @type {unknown} */ name, /** @type {number} */ index) => {
    const problem = publisherNameProblem(name);
    if (problem) problems.push(`publisherNames[${index}]: ${JSON.stringify(name)} ${problem}`);
  });
  if (new Set(value).size !== value.length) problems.push('publisherNames: lists a name twice');
  return problems;
}

/**
 * Check the committed configuration's SHAPE. This runs whether signing is
 * enabled or not, so a typo is caught by the test suite today rather than on
 * the release that first turns signing on.
 *
 * @param {unknown} raw Parsed windows-signing.json.
 * @returns {string[]} One line per problem; empty when the shape is right.
 */
export function configShapeProblems(raw) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(raw)) return ['the configuration must be a JSON object'];
  const config = /** @type {Record<string, any>} */ (raw);
  rejectUnknownKeys(config, CONFIG_KEYS, '', problems);

  if (!isPlainObject(config.kms)) {
    problems.push('kms: must be an object with keyRing and keyVersion');
  } else {
    rejectUnknownKeys(config.kms, KMS_KEYS, 'kms.', problems);
    if (typeof config.kms.keyRing !== 'string' || !KEY_RING_PATTERN.test(config.kms.keyRing)) {
      problems.push('kms.keyRing: must be projects/<project>/locations/<location>/keyRings/<ring>');
    }
    if (
      typeof config.kms.keyVersion !== 'string' ||
      !KEY_VERSION_PATTERN.test(config.kms.keyVersion)
    ) {
      // jsign makes no metadata calls only when the version is pinned; without
      // it, it lists versions (more IAM) and signs with the newest one.
      problems.push('kms.keyVersion: must pin a version, as <key>/cryptoKeyVersions/<n>');
    }
  }

  if (typeof config.publicKeySha256 !== 'string' || !SHA256_PATTERN.test(config.publicKeySha256)) {
    problems.push(
      'publicKeySha256: must be 64 lowercase hex characters (sha256 of the key DER/SPKI)'
    );
  }

  if (
    typeof config.certificateChain !== 'string' ||
    config.certificateChain !== path.basename(config.certificateChain) ||
    !config.certificateChain.endsWith('.pem')
  ) {
    problems.push(
      'certificateChain: must be a bare .pem file name, resolved next to windows-signing.json'
    );
  }

  problems.push(...publisherNamesProblems(config.publisherNames));

  if (typeof config.workloadIdentityProvider !== 'string') {
    problems.push('workloadIdentityProvider: must be a string ("" until the provider exists)');
  } else if (
    config.workloadIdentityProvider !== '' &&
    !PROVIDER_PATTERN.test(config.workloadIdentityProvider)
  ) {
    problems.push(
      'workloadIdentityProvider: must be projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>'
    );
  }

  if (typeof config.serviceAccount !== 'string') {
    problems.push('serviceAccount: must be a string');
  } else if (config.serviceAccount !== '' && !SERVICE_ACCOUNT_PATTERN.test(config.serviceAccount)) {
    problems.push('serviceAccount: must be <name>@<project>.iam.gserviceaccount.com');
  }

  if (!Array.isArray(config.timestampUrls) || config.timestampUrls.length === 0) {
    problems.push('timestampUrls: must list at least one RFC 3161 timestamp server');
  } else {
    for (const url of config.timestampUrls) {
      const problem = urlProblem(url, ['http:', 'https:']);
      if (problem) problems.push(`timestampUrls: ${problem}`);
    }
  }

  if (typeof config.programName !== 'string' || config.programName.trim() === '') {
    problems.push('programName: must be a non-empty string');
  }
  const programUrlProblem = urlProblem(config.programUrl, ['https:']);
  if (programUrlProblem) problems.push(`programUrl: ${programUrlProblem}`);

  if (!isPlainObject(config.jsign)) {
    problems.push('jsign: must be an object with version, url and sha256');
  } else {
    rejectUnknownKeys(config.jsign, JSIGN_KEYS, 'jsign.', problems);
    if (typeof config.jsign.version !== 'string' || config.jsign.version === '') {
      problems.push('jsign.version: must be a non-empty string');
    }
    const jsignUrlProblem = urlProblem(config.jsign.url, ['https:']);
    if (jsignUrlProblem) {
      problems.push(`jsign.url: ${jsignUrlProblem}`);
    } else if (!config.jsign.url.endsWith(`/jsign-${config.jsign.version}.jar`)) {
      // A version bump that forgets the URL (or the reverse) would pin one
      // version's digest against another version's download.
      problems.push(
        `jsign.url: must end in /jsign-${config.jsign.version}.jar to match jsign.version`
      );
    }
    if (typeof config.jsign.sha256 !== 'string' || !SHA256_PATTERN.test(config.jsign.sha256)) {
      problems.push('jsign.sha256: must be 64 lowercase hex characters');
    }
  }

  return problems;
}

/**
 * The checks that only apply once signing is on: everything the CI needs to
 * reach the key must be filled in.
 *
 * @param {Record<string, any>} config A config that already passed {@link configShapeProblems}.
 * @returns {string[]}
 */
export function enabledConfigProblems(config) {
  /** @type {string[]} */
  const problems = [];
  if (config.workloadIdentityProvider === '') {
    problems.push(
      'workloadIdentityProvider is empty: GitHub cannot obtain a Google token to sign with (see "Switching it on" in docs/WINDOWS_SIGNING.md)'
    );
  }
  if (config.serviceAccount === '') {
    problems.push('serviceAccount is empty: GitHub has no identity to impersonate for signing');
  }
  if (config.publisherNames.length === 0) {
    problems.push(
      'publisherNames is empty: set it to ["<the certificate CN>"] in the same change that commits the chain ' +
        '(see "Switching it on" in docs/WINDOWS_SIGNING.md)'
    );
  }
  return problems;
}

/**
 * Split a PEM bundle into its certificates.
 *
 * Why hand-rolled: node:crypto's X509Certificate parses exactly one
 * certificate, and nothing in the stack splits a bundle (pkijs/asn1js would
 * parse DER, not the armour around it). The PEM armour is a fixed pair of
 * lines, so this is a line scanner -- no regex -- and anything that is not a
 * well-formed CERTIFICATE block (an unterminated block, a nested BEGIN) is an
 * error, never silently skipped. Text outside the blocks (OpenSSL's
 * "subject=" comments) is ignored, as every PEM reader does.
 *
 * @param {string} text
 * @returns {string[]} One PEM string per certificate, in file order.
 */
export function splitPemCertificates(text) {
  /** @type {string[]} */
  const blocks = [];
  /** @type {string[] | null} */
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '-----BEGIN CERTIFICATE-----') {
      if (current)
        throw new Error('certificate chain: a BEGIN CERTIFICATE line inside another certificate');
      current = [line];
    } else if (line === '-----END CERTIFICATE-----') {
      if (!current) throw new Error('certificate chain: an END CERTIFICATE line with no BEGIN');
      current.push(line);
      blocks.push(`${current.join('\n')}\n`);
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) throw new Error('certificate chain: the last certificate is not terminated');
  return blocks;
}

/**
 * The extended key usages of a certificate. Node calls them `keyUsage` (the
 * name predates extKeyUsage); both spellings are read so a Node that renames
 * it does not quietly make every certificate look EKU-less.
 *
 * @param {X509Certificate} certificate
 * @returns {string[]}
 */
function extendedKeyUsages(certificate) {
  const anyCert = /** @type {any} */ (certificate);
  return anyCert.extKeyUsage ?? anyCert.keyUsage ?? [];
}

/**
 * Pick the certificate that signs: a non-CA certificate carrying the
 * code-signing EKU. It must be the FIRST certificate in the chain file,
 * because jsign takes the first certificate of --certfile as the signer.
 *
 * @param {X509Certificate[]} certificates In file order.
 * @returns {X509Certificate}
 */
export function selectSigningCertificate(certificates) {
  const candidates = certificates.filter(
    (certificate) => !certificate.ca && extendedKeyUsages(certificate).includes(CODE_SIGNING_EKU)
  );
  if (candidates.length === 0) {
    throw new Error(
      'certificate chain: no code-signing leaf (a non-CA certificate with the codeSigning EKU)'
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `certificate chain: ${candidates.length} code-signing leaves; it must contain exactly one`
    );
  }
  if (certificates[0] !== candidates[0]) {
    throw new Error(
      'certificate chain: the code-signing leaf must be the first certificate in the file'
    );
  }
  return candidates[0];
}

/**
 * sha256 of a certificate's public key as DER SubjectPublicKeyInfo -- the
 * same digest `gcloud kms keys versions get-public-key … | openssl pkey
 * -pubin -outform DER | sha256sum` prints for the KMS key.
 *
 * @param {X509Certificate} certificate
 * @returns {string}
 */
export function publicKeySha256(certificate) {
  const der = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * The leaf's subject CN: what Windows reports as the signer and what
 * electron-updater compares against app-update.yml's publisherName. The
 * loader requires it to equal publisherNames[0] in windows-signing.json.
 *
 * @param {X509Certificate} certificate
 * @returns {string}
 */
export function publisherFromCertificate(certificate) {
  const names = certificate.subject
    .split('\n')
    .filter((line) => line.startsWith('CN='))
    .map((line) => line.slice('CN='.length));
  if (names.length !== 1) {
    throw new Error(`certificate subject must carry exactly one CN, found ${names.length}`);
  }
  const [name] = names;
  const problem = publisherNameProblem(name);
  if (problem) throw new Error(`certificate CN "${name}" ${problem}`);
  return name;
}

/**
 * @typedef {object} DisabledSigning
 * @property {false} enabled
 * @property {Record<string, any>} config
 * @property {string} configPath
 * @property {string} chainPath
 *
 * @typedef {object} EnabledSigning
 * @property {true} enabled
 * @property {Record<string, any>} config
 * @property {string} configPath
 * @property {string} chainPath
 * @property {string} publisher The leaf certificate's CN (= publisherNames[0]).
 * @property {string[]} publisherNames Every name app-update.yml pins, the CN first.
 * @property {{ subject: string, fingerprint256: string, validTo: string }} leaf
 */

/**
 * Load and validate windows-signing.json, and decide whether signing is on.
 *
 * ENABLED ⇔ the chain file exists. Enabled but misconfigured THROWS: that is
 * the fail-closed half of the design (see the header). So does a non-empty
 * publisherNames with NO chain: once signing has been switched on, a missing
 * chain is a lost file, not a decision to ship unsigned.
 *
 * @param {string} [configPath]
 * @param {{ now?: Date, readFile?: (file: string) => string, exists?: (file: string) => boolean }} [io]
 * @returns {DisabledSigning | EnabledSigning}
 */
export function loadWindowsSigningConfig(configPath = DEFAULT_CONFIG_PATH, io = {}) {
  const {
    now = new Date(),
    readFile = (file) => fs.readFileSync(file, 'utf8'),
    exists = fs.existsSync,
  } = io;

  let raw;
  try {
    raw = JSON.parse(readFile(configPath));
  } catch (error) {
    throw new Error(
      `windows signing: cannot read ${configPath}: ${/** @type {Error} */ (error).message}`
    );
  }
  const shape = configShapeProblems(raw);
  if (shape.length > 0) {
    throw new Error(`windows signing: ${configPath} is invalid:\n  - ${shape.join('\n  - ')}`);
  }

  const config = /** @type {Record<string, any>} */ (raw);
  const chainPath = path.join(path.dirname(configPath), config.certificateChain);
  /** @type {string[]} */
  const publisherNames = config.publisherNames;
  if (!exists(chainPath)) {
    if (publisherNames.length > 0) {
      // The in-tree half of the one-way latch: a chain file lost on its own
      // (a bad merge, a stray delete) must never read as "signing is off".
      // A change that drops the chain AND empties publisherNames together (a
      // revert of the switch-on) passes here; previousReleaseProblems catches
      // it against the last published release.
      throw new Error(
        `windows signing: signing was switched on; the certificate chain is missing. publisherNames is ` +
          `${JSON.stringify(publisherNames)} but ${chainPath} does not exist. Restore the chain. Once a ` +
          'signed release has been published, an unsigned one would strand every install, and the release ' +
          'workflow refuses it (docs/WINDOWS_SIGNING.md).'
      );
    }
    return { enabled: false, config, configPath, chainPath };
  }

  const fail = (/** @type {string} */ message) => {
    throw new Error(`windows signing is ENABLED (${chainPath} exists) but ${message}`);
  };

  const enabled = enabledConfigProblems(config);
  if (enabled.length > 0) fail(`misconfigured:\n  - ${enabled.join('\n  - ')}`);

  /** @type {X509Certificate[]} */
  let certificates = [];
  try {
    certificates = splitPemCertificates(readFile(chainPath)).map((pem) => new X509Certificate(pem));
  } catch (error) {
    fail(`the chain does not parse: ${/** @type {Error} */ (error).message}`);
  }
  if (certificates.length === 0) fail('the chain file holds no PEM certificate');

  let leaf = /** @type {X509Certificate} */ (/** @type {unknown} */ (undefined));
  try {
    leaf = selectSigningCertificate(certificates);
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }

  const keyDigest = publicKeySha256(leaf);
  if (keyDigest !== config.publicKeySha256) {
    fail(
      `the certificate's public key (sha256 ${keyDigest}) is not the KMS key (publicKeySha256 ${config.publicKeySha256}). ` +
        'jsign would sign with the KMS key under a certificate for a different key, which Windows rejects.'
    );
  }

  const validFrom = new Date(leaf.validFrom);
  const validTo = new Date(leaf.validTo);
  if (now < validFrom) fail(`the certificate is not valid until ${leaf.validFrom}`);
  if (now > validTo) fail(`the certificate expired on ${leaf.validTo}; install the renewed chain`);

  let publisher = '';
  try {
    publisher = publisherFromCertificate(leaf);
  } catch (error) {
    fail(/** @type {Error} */ (error).message);
  }
  // Exact and case-sensitive, because electron-updater's comparison is: a CA
  // that reissues "Sarv Webs Private Limited" for "SARV WEBS PRIVATE LIMITED"
  // must stop the build here, not re-pin (or strand) every install. The
  // message must never suggest fixing a NEW CN with one edit of the list:
  // that strands every install that pins only the old name.
  if (publisher !== publisherNames[0]) {
    fail(
      `the certificate CN "${publisher}" is not publisherNames[0] (${JSON.stringify(publisherNames[0])}); ` +
        'they must be identical, case included. At switch-on, publisherNames is exactly the issued CN. ' +
        'If the CN has CHANGED, do not edit publisherNames to match it: a new CN takes two releases, ' +
        'and installs that never received the first one can no longer auto-update. Follow "Changing the ' +
        'publisher name" in docs/WINDOWS_SIGNING.md.'
    );
  }

  return {
    enabled: true,
    config,
    configPath,
    chainPath,
    publisher,
    publisherNames: [...publisherNames],
    leaf: { subject: leaf.subject, fingerprint256: leaf.fingerprint256, validTo: leaf.validTo },
  };
}

/* ------------------------------------------------------------------------ */
/* The cross-release latch                                                   */
/* ------------------------------------------------------------------------ */

/*
 * The in-tree latch above cannot see history: a `git revert` of the switch-on
 * removes the chain AND empties publisherNames in one change, and a tag cut
 * from a branch older than the switch-on never had either. Both trees say
 * "disabled", and an unsigned release would go out as Latest and strand every
 * install that pins the publisher. What installed copies actually pin is the
 * publisherNames of the last PUBLISHED release (the one marked Latest, which
 * is what auto-update serves), so that is what this checks against.
 */

/** Where windows-signing.json lives in the repository, for the contents API. */
export const CONFIG_PATH_IN_REPO = 'apps/desktop/build/windows-signing.json';

const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** How `gh api` reports a 404 on stderr: "gh: Not Found (HTTP 404)". */
const GH_HTTP_404 = /\(HTTP 404\)/;

/**
 * Check a PUBLISHED release's windows-signing.json. Deliberately narrower than
 * configShapeProblems: only publisherNames is read, so a later change that
 * adds or renames a key does not turn every older release's file "invalid"
 * and block all releases. A file without a usable publisherNames still fails:
 * no released version of this file ever lacked it.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function previousConfigProblems(raw) {
  if (!isPlainObject(raw)) return ['the configuration must be a JSON object'];
  return publisherNamesProblems(/** @type {Record<string, unknown>} */ (raw).publisherNames);
}

/**
 * @typedef {{ kind: 'none' }
 *   | { kind: 'predates-signing', tag: string }
 *   | { kind: 'config', tag: string, publisherNames: string[] }} PreviousRelease
 */

/**
 * Ask GitHub what the release marked Latest pins, through `gh api` (the
 * job's GH_TOKEN). Exactly two outcomes mean "nothing is pinned": no release
 * is published at all (releases/latest is a 404), or the Latest release has
 * no windows-signing.json (it predates signing; the contents API is a 404).
 * Anything else that goes wrong -- gh missing, a network error, a 5xx, a tag
 * that is not one, a file that is not JSON or has no valid publisherNames --
 * THROWS: an unknown answer must never read as "nothing is pinned".
 *
 * The repository is read first, so a 404 on releases/latest cannot be a
 * misspelt or invisible repository passing for "no releases yet".
 *
 * @param {{ repository: string, run?: (file: string, args: string[], options: object) => Promise<{ stdout: unknown }> }} options
 * @returns {Promise<PreviousRelease>}
 */
export async function lookupPreviousRelease({
  repository,
  run = /** @type {any} */ (execFileAsync),
}) {
  if (typeof repository !== 'string' || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`not an owner/repository name: ${JSON.stringify(repository)}`);
  }
  /**
   * @param {string[]} args
   * @returns {Promise<string | null>} stdout, or null for a 404.
   */
  const gh = async (args) => {
    try {
      const { stdout } = await run('gh', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return String(stdout);
    } catch (caught) {
      const error = /** @type {{ message?: string, stderr?: unknown }} */ (caught);
      const stderr = String(error.stderr ?? '');
      if (GH_HTTP_404.test(stderr)) return null;
      throw new Error(
        `gh ${args.join(' ')} failed: ${(stderr.trim() || error.message) ?? 'unknown error'}`
      );
    }
  };

  const name = await gh(['api', `repos/${repository}`, '--jq', '.full_name']);
  if (name === null || name.trim().toLowerCase() !== repository.toLowerCase()) {
    throw new Error(
      `repository ${repository} is not visible to this token (got ${JSON.stringify(name)})`
    );
  }

  const latest = await gh(['api', `repos/${repository}/releases/latest`, '--jq', '.tag_name']);
  if (latest === null) return { kind: 'none' };
  const tag = latest.trim();
  if (tag === '' || /\s/.test(tag)) {
    throw new Error(`releases/latest returned no usable tag name: ${JSON.stringify(latest)}`);
  }

  const file = await gh([
    'api',
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repository}/contents/${CONFIG_PATH_IN_REPO}?ref=${encodeURIComponent(tag)}`,
  ]);
  if (file === null) return { kind: 'predates-signing', tag };

  let raw;
  try {
    raw = JSON.parse(file);
  } catch (error) {
    throw new Error(
      `${CONFIG_PATH_IN_REPO} at ${tag} is not JSON: ${/** @type {Error} */ (error).message}`
    );
  }
  const problems = previousConfigProblems(raw);
  if (problems.length > 0) {
    throw new Error(`${CONFIG_PATH_IN_REPO} at ${tag} is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return { kind: 'config', tag, publisherNames: [.../** @type {string[]} */ (raw.publisherNames)] };
}

/**
 * One line for the release log saying what the last published release pins.
 *
 * @param {PreviousRelease} previous
 * @returns {string}
 */
export function describePreviousRelease(previous) {
  if (previous.kind === 'none') {
    return 'Last published release: none (releases/latest is 404), so no installed copy pins a publisher.';
  }
  if (previous.kind === 'predates-signing') {
    return `Last published release ${previous.tag}: no ${CONFIG_PATH_IN_REPO} at that tag (it predates Windows signing), so no installed copy pins a publisher.`;
  }
  return previous.publisherNames.length === 0
    ? `Last published release ${previous.tag}: publisherNames is [], so no installed copy pins a publisher.`
    : `Last published release ${previous.tag}: installed copies pin ${JSON.stringify(previous.publisherNames)}.`;
}

/**
 * What the last published release demands of this build. If it pinned any
 * publisher, every install it updated refuses an update that is unsigned, or
 * signed under a CN outside that list. So this build must be signed, and its
 * certificate's CN must be one of the PREVIOUS names -- which is also what
 * makes a CN change take two releases: the new name has to ship in a
 * publisherNames list before a certificate carrying it may sign.
 *
 * @param {PreviousRelease} previous
 * @param {DisabledSigning | EnabledSigning} current
 * @returns {string[]}
 */
export function previousReleaseProblems(previous, current) {
  if (previous.kind !== 'config' || previous.publisherNames.length === 0) return [];
  const pinned = JSON.stringify(previous.publisherNames);
  if (!current.enabled) {
    return [
      `the last published release (${previous.tag}) is signed, and every install it updated pins ${pinned}; ` +
        'this build is UNSIGNED, so every one of those installs would refuse it. Restore the certificate chain ' +
        'and publisherNames: a revert of the switch-on, or a tag from a branch older than it, can never be released.',
    ];
  }
  if (!previous.publisherNames.includes(current.publisher)) {
    return [
      `this build is signed as "${current.publisher}", but the last published release (${previous.tag}) pins ${pinned}: ` +
        'every install it updated would refuse this one. A new CN must first ship in publisherNames in a release ' +
        'still signed with the old certificate ("Changing the publisher name" in docs/WINDOWS_SIGNING.md).',
    ];
  }
  return [];
}

/* ------------------------------------------------------------------------ */
/* Signers and the jsign command line                                        */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} Signer What jsign signs WITH. Built by one of the two
 *   factories below; the core signing function never chooses.
 * @property {'GOOGLECLOUD' | 'PKCS12'} storetype
 * @property {string} keystore
 * @property {string} [alias]
 * @property {string} [certfile]
 * @property {string} storepassEnv Name of the env var jsign reads the store password/token from.
 * @property {string} [keypassEnv]
 *
 * @typedef {object} SigningSettings
 * @property {string[]} timestampUrls
 * @property {string} programName
 * @property {string} programUrl
 */

/**
 * The production signer: the pinned KMS key version, the committed chain, the
 * token from {@link SIGNING_TOKEN_ENV}. There is deliberately no way to point
 * the electron-builder hook at any other key -- no environment override.
 *
 * @param {EnabledSigning} loaded
 * @returns {Signer}
 */
export function googleCloudSigner(loaded) {
  return {
    storetype: 'GOOGLECLOUD',
    keystore: loaded.config.kms.keyRing,
    alias: loaded.config.kms.keyVersion,
    certfile: loaded.chainPath,
    storepassEnv: SIGNING_TOKEN_ENV,
  };
}

/**
 * A PKCS#12 signer, for the CI self-test's throwaway certificate only.
 *
 * @param {{ keystore: string, passwordEnv: string, alias?: string }} options
 * @returns {Signer}
 */
export function pkcs12Signer({ keystore, passwordEnv, alias }) {
  if (!ENV_NAME_PATTERN.test(passwordEnv))
    throw new Error(`not an environment variable name: ${passwordEnv}`);
  return {
    storetype: 'PKCS12',
    keystore,
    ...(alias ? { alias } : {}),
    storepassEnv: passwordEnv,
    // jsign reads the key with an EMPTY password unless told otherwise.
    keypassEnv: passwordEnv,
  };
}

/**
 * @param {Record<string, any>} config
 * @returns {SigningSettings}
 */
export function signingSettings(config) {
  return {
    timestampUrls: [...config.timestampUrls],
    programName: config.programName,
    programUrl: config.programUrl,
  };
}

/** How many timestamp attempts jsign makes in total, cycling through the URLs. */
export const TIMESTAMP_ATTEMPTS = 4;
/** Seconds jsign waits between timestamp attempts (Sectigo asks for 15 s between requests; DigiCert goes first). */
export const TIMESTAMP_RETRY_WAIT_SECONDS = 10;

/**
 * The argument vector for `java -jar jsign.jar …`. Secrets are NEVER on it:
 * the token and passwords are named as `env:VAR`, and jsign reads them from
 * its own environment.
 *
 * @param {{ jar: string, signer: Signer, file: string, settings: SigningSettings }} options
 * @returns {string[]}
 */
export function jsignArgs({ jar, signer, file, settings }) {
  for (const name of [signer.storepassEnv, signer.keypassEnv].filter(Boolean)) {
    if (!ENV_NAME_PATTERN.test(/** @type {string} */ (name)))
      throw new Error(`not an environment variable name: ${name}`);
  }
  // electron-builder always passes absolute paths; anything else could be read
  // by jsign's option parser as a flag.
  if (!path.isAbsolute(file)) throw new Error(`refusing to sign a relative path: ${file}`);
  return [
    '-jar',
    jar,
    '--storetype',
    signer.storetype,
    '--keystore',
    signer.keystore,
    '--storepass',
    `env:${signer.storepassEnv}`,
    ...(signer.keypassEnv ? ['--keypass', `env:${signer.keypassEnv}`] : []),
    ...(signer.alias ? ['--alias', signer.alias] : []),
    ...(signer.certfile ? ['--certfile', signer.certfile] : []),
    '--alg',
    'SHA-256',
    // jsign does not timestamp at all unless asked, and its default mode is the
    // legacy Authenticode one; RFC 3161 is what keeps a signature valid after
    // the certificate expires.
    '--tsmode',
    'RFC3161',
    '--tsaurl',
    settings.timestampUrls.join(','),
    '--tsretries',
    String(TIMESTAMP_ATTEMPTS),
    '--tsretrywait',
    String(TIMESTAMP_RETRY_WAIT_SECONDS),
    '--name',
    settings.programName,
    '--url',
    settings.programUrl,
    // Without it jsign NESTS a second signature onto a signed file. The hook
    // skips signed files anyway; this keeps a retry idempotent regardless.
    '--replace',
    file,
  ];
}

/* ------------------------------------------------------------------------ */
/* Failure classification                                                    */
/* ------------------------------------------------------------------------ */

/*
 * The history of this codebase says most real bugs are a transient condition
 * treated as permanent, or a retry that double-applied. Here a retry cannot
 * double-apply (signed files are skipped, and --replace), so the risk is the
 * other one: retrying an auth failure four times hides the real message behind
 * a minute of backoff, and retrying an UNKNOWN failure retries things that
 * will never work. So: permanent markers win, transient markers retry,
 * everything else is permanent.
 *
 * jsign prints "jsign: <message>" and the cause's stack trace; Cloud KMS
 * errors come through as "<http code> - <STATUS>: <message>", timestamp
 * servers through HttpURLConnection's "Server returned HTTP response code".
 */
const PERMANENT_MARKERS = [
  'permission_denied',
  'unauthenticated',
  'invalid_argument',
  'failed_precondition',
  'not_found',
  '400 - ',
  '401 - ',
  '403 - ',
  '404 - ',
  'response code: 401',
  'response code: 403',
];
const TRANSIENT_MARKERS = [
  'unable to complete the timestamping',
  'unavailable',
  'resource_exhausted',
  'deadline_exceeded',
  '429 - ',
  '500 - ',
  '502 - ',
  '503 - ',
  '504 - ',
  'response code: 429',
  'response code: 500',
  'response code: 502',
  'response code: 503',
  'response code: 504',
  'sockettimeoutexception',
  'connect timed out',
  'read timed out',
  'connection reset',
  'connectexception',
  'unknownhostexception',
  'noroutetohostexception',
  'remote host terminated the handshake',
  'being used by another process',
];

/**
 * Decide whether a failed jsign run is worth retrying.
 *
 * @param {string} output Everything the run printed, plus the error message.
 * @param {{ code?: unknown, killed?: boolean }} [error] The execFile error.
 * @returns {'transient' | 'permanent'}
 */
export function classifyJsignFailure(output, error = {}) {
  // java itself is missing: no amount of waiting installs it.
  if (error.code === 'ENOENT') return 'permanent';
  // Killed by our own timeout: a hung TSA or KMS call.
  if (error.killed) return 'transient';
  const text = output.toLowerCase();
  if (PERMANENT_MARKERS.some((marker) => text.includes(marker))) return 'permanent';
  if (TRANSIENT_MARKERS.some((marker) => text.includes(marker))) return 'transient';
  return 'permanent';
}

/* ------------------------------------------------------------------------ */
/* Signing one file                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Read enough of a file to cover its PE headers: the first 4 KB, or more when
 * a large DOS stub puts the PE signature further in (the headers end a few
 * hundred bytes after it). Never the whole file -- the installer is hundreds
 * of MB.
 *
 * @param {string} file
 * @returns {Buffer}
 */
function readPeHeaders(file) {
  const header = readFileHeader(file, 4096);
  if (header.length < 0x40 || header.toString('binary', 0, 2) !== 'MZ') return header;
  const needed = Math.min(fs.statSync(file).size, header.readUInt32LE(0x3c) + 1024);
  return needed <= header.length ? header : readFileHeader(file, needed);
}

/**
 * Read a PE file's certificate table from disk without loading the whole file
 * (the installer is hundreds of MB).
 *
 * @param {string} file
 * @returns {{ pe: false } | { pe: true, format: string, hasTable: boolean, signed: boolean, problem: string | null }}
 */
export function readFileCertificateTable(file) {
  const size = fs.statSync(file).size;
  const header = readPeHeaders(file);
  if (!isPeBinary(header)) return { pe: false };

  const table = readPeCertificateTable(header);
  /** @type {Buffer | undefined} */
  let entry;
  if (table.size > 0 && table.offset > 0 && table.offset + WIN_CERTIFICATE_HEADER_BYTES <= size) {
    entry = Buffer.alloc(WIN_CERTIFICATE_HEADER_BYTES);
    const handle = fs.openSync(file, 'r');
    try {
      fs.readSync(handle, entry, 0, WIN_CERTIFICATE_HEADER_BYTES, table.offset);
    } finally {
      fs.closeSync(handle);
    }
  }
  const problem = certificateTableProblem(table, size, entry);
  return {
    pe: true,
    format: table.format,
    hasTable: table.size > 0,
    signed: problem === null,
    problem,
  };
}

/**
 * jsign 7.5 cannot open a read-only file (fixed in 7.6), and files unpacked
 * from the Electron zip can be read-only on Windows.
 *
 * @param {string} file
 */
function ensureWritable(file) {
  const { mode } = fs.statSync(file);
  if ((mode & 0o200) === 0) fs.chmodSync(file, mode | 0o200);
}

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const execFileAsync = promisify(execFile);

/** Keep error messages readable: jsign's stack traces run to hundreds of lines. */
const tail = (/** @type {string} */ text, max = 4000) =>
  text.length > max ? `…${text.slice(-max)}` : text;

/**
 * @typedef {object} SignResult
 * @property {'signed' | 'skipped'} status
 * @property {number} attempts jsign runs it took (0 when skipped).
 */

/**
 * THE signing function: used by the electron-builder hook (Cloud KMS) and the
 * CI self-test (a throwaway PKCS#12), so the self-test exercises exactly the
 * code the release runs.
 *
 *  - Only sha256: the KMS key cannot sign anything else, and a sha1 pass would
 *    be a second, nested signature.
 *  - A file that already carries a signature is LEFT ALONE. Microsoft-signed
 *    DLLs that ship inside Electron (d3dcompiler_47.dll) keep Microsoft's
 *    signature, and a retry of a file signed a moment ago is a no-op.
 *  - Only transient failures are retried, with backoff.
 *  - Success is not taken on jsign's word: the file is re-read and must now
 *    carry a well-formed certificate table.
 *
 * @param {object} options
 * @param {string} options.file Absolute path of the PE file, signed in place.
 * @param {string} [options.hash]
 * @param {Signer} options.signer
 * @param {SigningSettings} options.settings
 * @param {string} options.jar Path of the checksum-verified jsign jar.
 * @param {string} [options.java]
 * @param {NodeJS.ProcessEnv} [options.env] The environment jsign runs with (it reads the token from it).
 * @param {(file: string, args: string[], options: object) => Promise<unknown>} [options.run]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(message: string) => void} [options.log]
 * @param {number[]} [options.retryDelaysMs] One entry per retry.
 * @param {number} [options.timeoutMs] Per jsign run.
 * @returns {Promise<SignResult>}
 */
export async function signPeFile({
  file,
  hash = SIGNING_HASH,
  signer,
  settings,
  jar,
  java = 'java',
  env = process.env,
  run = execFileAsync,
  sleep = delay,
  log = console.log,
  retryDelaysMs = [10_000, 20_000, 40_000],
  timeoutMs = 300_000,
}) {
  if (hash !== SIGNING_HASH) {
    throw new Error(
      `windows signing: refusing to sign ${file} with ${hash}: the key signs sha256 only (set win.signtoolOptions.signingHashAlgorithms to ["sha256"])`
    );
  }

  const before = readFileCertificateTable(file);
  if (!before.pe)
    throw new Error(`windows signing: ${file} is not a PE file; jsign cannot sign it`);
  if (before.hasTable) {
    if (!before.signed) {
      // A malformed table in a file we were handed is not ours to paper over.
      throw new Error(
        `windows signing: ${file} carries a malformed certificate table: ${before.problem}`
      );
    }
    log(
      `  • windows signing: ${path.basename(file)} is already signed, leaving its signature in place`
    );
    return { status: 'skipped', attempts: 0 };
  }

  const args = jsignArgs({ jar, signer, file, settings });
  ensureWritable(file);

  const maxAttempts = retryDelaysMs.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await run(java, args, {
        env,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (caught) {
      const error =
        /** @type {{ message?: string, stdout?: string, stderr?: string, code?: unknown, killed?: boolean }} */ (
          caught
        );
      const output = [error.message, error.stdout, error.stderr].filter(Boolean).join('\n');
      const kind = classifyJsignFailure(output, error);
      if (kind === 'transient' && attempt < maxAttempts) {
        const wait = retryDelaysMs[attempt - 1];
        log(
          `  • windows signing: transient failure on ${path.basename(file)} (attempt ${attempt}/${maxAttempts}), retrying in ${wait / 1000}s`
        );
        await sleep(wait);
        continue;
      }
      throw new Error(
        `windows signing: jsign failed (${kind}) on ${file} after ${attempt} attempt(s):\n${tail(output)}`
      );
    }

    const after = readFileCertificateTable(file);
    if (!after.pe || !after.signed) {
      throw new Error(
        `windows signing: jsign exited 0 but ${file} carries no valid certificate table (${after.pe ? after.problem : 'no longer a PE file'})`
      );
    }
    log(
      `  • windows signing: signed ${path.basename(file)}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`
    );
    return { status: 'signed', attempts: attempt };
  }
}

/**
 * @param {string} file
 * @returns {string}
 */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/* ------------------------------------------------------------------------ */
/* The electron-builder hook                                                  */
/* ------------------------------------------------------------------------ */

/**
 * What the hook demands of electron-builder's own configuration when signing
 * is on. A signed build that forgot publisherName would still install, but
 * would write NO publisherName into app-update.yml, and electron-updater then
 * skips the signature check on every update -- signing for show. So the hook
 * refuses to sign unless release.yml passed the WHOLE pinned list, in order:
 * electron-builder writes exactly that list into app-update.yml, and during a
 * CN change it must carry both names, or the installs this release updates
 * would refuse whichever certificate signs the next one.
 *
 * @param {{ hash?: string, isNest?: boolean, options?: Record<string, any> }} configuration
 *   What electron-builder hands a custom `sign` hook.
 * @param {string[]} publisherNames publisherNames from windows-signing.json.
 * @returns {string[]}
 */
export function builderOptionsProblems(configuration, publisherNames) {
  /** @type {string[]} */
  const problems = [];
  if (configuration.hash !== SIGNING_HASH) {
    problems.push(
      `asked to sign with ${configuration.hash}; win.signtoolOptions.signingHashAlgorithms must be ["sha256"]`
    );
  }
  if (configuration.isNest)
    problems.push('asked for a nested (second) signature; only one sha256 signature is made');

  const options = configuration.options ?? {};
  // `-c.win.forceCodeSigning=true` arrives as the string "true" and is coerced
  // by electron-builder's schema validation; accept either spelling.
  if (options.forceCodeSigning !== true && options.forceCodeSigning !== 'true') {
    problems.push(
      'win.forceCodeSigning is not true (release.yml passes -c.win.forceCodeSigning=true when signing is enabled)'
    );
  }
  if (options.verifyUpdateCodeSignature === false) {
    problems.push(
      'win.verifyUpdateCodeSignature is false, which drops the update signature check for every install'
    );
  }
  // A single -c flag arrives as a string, repeated ones as an array (yargs);
  // electron-builder applies asArray, so both spellings mean the same list.
  const names = asNameList(options.signtoolOptions?.publisherName);
  if (!sameNames(names, publisherNames)) {
    problems.push(
      `win.signtoolOptions.publisherName is ${JSON.stringify(names)}, expected ${JSON.stringify(publisherNames)} ` +
        '(publisherNames in windows-signing.json, the certificate CN first); app-update.yml pins exactly this list: ' +
        'a name left out strands installs, and no publisherName at all switches the update signature check off'
    );
  }
  return problems;
}

/**
 * The body of apps/desktop/build/windowsSign.js. `state` lives in the hook
 * module, so the config is loaded, the jar hashed and the "disabled" notice
 * logged once per build rather than once per file.
 *
 * @param {{ path: string, hash?: string, isNest?: boolean, options?: Record<string, any> }} configuration
 * @param {object} [deps]
 * @param {string} [deps.configPath]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {(message: string) => void} [deps.log]
 * @param {{ loaded?: DisabledSigning | EnabledSigning, disabledLogged?: boolean, verifiedJar?: string }} [deps.state]
 * @param {Date} [deps.now]
 * @param {(file: string, args: string[], options: object) => Promise<unknown>} [deps.run]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number[]} [deps.retryDelaysMs]
 * @returns {Promise<SignResult | { status: 'disabled' }>}
 */
export async function electronBuilderSign(configuration, deps = {}) {
  const {
    configPath = DEFAULT_CONFIG_PATH,
    env = process.env,
    log = console.log,
    state = {},
    now,
    ...signDeps
  } = deps;

  state.loaded ??= loadWindowsSigningConfig(configPath, now ? { now } : {});
  const loaded = state.loaded;

  if (!loaded.enabled) {
    if (!state.disabledLogged) {
      log(
        `  • windows signing: DISABLED (${path.basename(loaded.chainPath)} is not committed) -- Windows binaries are NOT code-signed`
      );
      state.disabledLogged = true;
    }
    return { status: 'disabled' };
  }

  const problems = builderOptionsProblems(configuration, loaded.publisherNames);
  if (!env[SIGNING_TOKEN_ENV])
    problems.push(`${SIGNING_TOKEN_ENV} is not set: no Google access token to sign with`);
  const jar = env[JSIGN_JAR_ENV];
  if (!jar) problems.push(`${JSIGN_JAR_ENV} is not set: no jsign jar to sign with`);
  if (problems.length > 0) {
    throw new Error(
      `windows signing is ENABLED but cannot sign ${configuration.path}:\n  - ${problems.join('\n  - ')}`
    );
  }

  if (state.verifiedJar !== jar) {
    const digest = sha256File(/** @type {string} */ (jar));
    if (digest !== loaded.config.jsign.sha256) {
      throw new Error(
        `windows signing: ${jar} has sha256 ${digest}, not the pinned ${loaded.config.jsign.sha256}`
      );
    }
    state.verifiedJar = jar;
  }

  return signPeFile({
    file: configuration.path,
    hash: configuration.hash,
    signer: googleCloudSigner(loaded),
    settings: signingSettings(loaded.config),
    jar: /** @type {string} */ (jar),
    env,
    log,
    ...signDeps,
  });
}

/* ------------------------------------------------------------------------ */
/* Verifying the packaged build                                               */
/* ------------------------------------------------------------------------ */

/** The two app directories one Windows build produces (x64, arm64). */
export const DEFAULT_UNPACKED_DIRS = ['win-unpacked', 'win-arm64-unpacked'];

/**
 * Which signer a PE file may carry.
 *
 *  - 'own': the files that are OURS and nobody else's -- the app executable at
 *    the root of each app directory, the installer at the root of the release
 *    directory, and every .node addon (built from source by this build). These
 *    must be signed by the publisher, whatever else is true.
 *  - 'other': every other .exe or .dll (Electron's DLLs, electron-builder's
 *    elevate.exe, any helper). The hook signs these too, but leaves a file that
 *    already carries a signature alone, so one that arrived Valid-signed by
 *    someone else (Microsoft's d3dcompiler_47.dll) keeps it. The hook never
 *    signs with any other key, so a foreign signer here can only have been
 *    there before the build. Unsigned is still a failure.
 *  - 'unexpected': a PE file with another extension, which electron-builder
 *    never offers to the hook (signExts covers .exe/.dll/.node). A failure.
 *
 * @param {string} file
 * @param {{ appDirs?: string[], releaseDir?: string }} [where] The app
 *   directories (win-unpacked, …) and the release directory, to recognise the
 *   app executables and the installer by location.
 * @returns {'own' | 'other' | 'unexpected'}
 */
export function peFileKind(file, { appDirs = [], releaseDir } = {}) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.node') return 'own';
  if (extension === '.exe') {
    // Resolved on both sides, so "release/" and "release" are the same place.
    const dir = path.resolve(path.dirname(file));
    const isIn = (/** @type {string | undefined} */ root) =>
      root !== undefined && path.resolve(root) === dir;
    return appDirs.some(isIn) || isIn(releaseDir) ? 'own' : 'other';
  }
  if (extension === '.dll') return 'other';
  return 'unexpected';
}

/**
 * @typedef {object} AuthenticodeResult What the PowerShell query reports per file.
 * @property {string} path
 * @property {string} status SignatureStatus as a string ("Valid", "NotSigned", …).
 * @property {string | null} statusMessage
 * @property {string | null} signerSubject
 * @property {string | null} timeStamperSubject
 * @property {string | null} [signerThumbprint] SignerCertificate.Thumbprint (SHA-1, as Windows shows it).
 * @property {string | null} [signerSha256] SHA-256 of the signer certificate's DER, uppercase hex.
 */

/**
 * A certificate digest in one spelling: uppercase hex, no separators. Node
 * prints "AB:CD:…", PowerShell "ABCD…".
 *
 * @param {unknown} value
 * @returns {string}
 */
const certificateDigest = (value) =>
  String(value ?? '')
    .replaceAll(':', '')
    .toUpperCase();

/**
 * Parse the query's JSON. Windows PowerShell 5.1 can prefix a BOM, and
 * ConvertTo-Json emits a bare object for a single-element array.
 *
 * @param {string} stdout
 * @returns {AuthenticodeResult[]}
 */
export function parseAuthenticodeJson(stdout) {
  const text = (stdout.startsWith('\uFEFF') ? stdout.slice(1) : stdout).trim();
  if (text === '') throw new Error('Get-AuthenticodeSignature printed nothing');
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    if (!isPlainObject(item) || typeof item.path !== 'string' || typeof item.status !== 'string') {
      throw new Error(`unexpected Get-AuthenticodeSignature record: ${JSON.stringify(item)}`);
    }
  }
  return list;
}

/**
 * The CN of a Windows certificate subject, parsed exactly as electron-updater
 * parses it (builder-util-runtime's parseDn), so CI applies the very rule an
 * installed copy will apply to the next update.
 *
 * @param {string | null} subject
 * @returns {string | null}
 */
export function subjectCommonName(subject) {
  if (!subject) return null;
  return parseDn(subject).get('CN') ?? null;
}

/**
 * Judge every signature. Pure: the PowerShell output and the file kinds go in,
 * problems come out. Signed by a publisher means the signer's CN is one of
 * publisherNames (the list app-update.yml pins). Our OWN files must moreover
 * be signed by THE committed certificate (leafSha256), not merely by one
 * carrying our name: the hook skips a file that is already signed, so a file
 * that arrived signed under our CN by some other certificate would otherwise
 * ship as ours.
 *
 * @param {Array<{ path: string, kind: 'own' | 'other' | 'unexpected', result: AuthenticodeResult | undefined }>} entries
 * @param {string[]} publisherNames
 * @param {{ leafSha256?: string }} [leaf] SHA-256 fingerprint of the committed leaf certificate.
 * @returns {{ problems: string[], upstream: string[], ok: number }}
 */
export function evaluateSignatures(entries, publisherNames, { leafSha256 } = {}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const upstream = [];
  let ok = 0;
  for (const { path: file, kind, result } of entries) {
    if (kind === 'unexpected') {
      problems.push(
        `${file}: a PE file electron-builder never offers for signing (signExts covers .exe/.dll/.node)`
      );
      continue;
    }
    if (!result) {
      problems.push(`${file}: Get-AuthenticodeSignature returned nothing for it`);
      continue;
    }
    if (result.status !== 'Valid') {
      problems.push(
        `${file}: signature status ${result.status}${result.statusMessage ? ` (${result.statusMessage})` : ''}`
      );
      continue;
    }
    if (!result.timeStamperSubject) {
      problems.push(
        `${file}: signed but NOT timestamped; it stops verifying the day the certificate expires`
      );
      continue;
    }
    const signer = subjectCommonName(result.signerSubject);
    if (signer !== null && publisherNames.includes(signer)) {
      if (
        kind === 'own' &&
        (!leafSha256 || certificateDigest(result.signerSha256) !== certificateDigest(leafSha256))
      ) {
        problems.push(
          `${file}: signed as "${signer}" but by certificate sha256 ${certificateDigest(result.signerSha256) || '(none reported)'} ` +
            `(thumbprint ${result.signerThumbprint ?? 'unknown'}), not the committed one (sha256 ${certificateDigest(leafSha256) || 'unknown'})`
        );
        continue;
      }
      ok++;
    } else if (kind === 'other') {
      upstream.push(
        `${file}: kept its upstream signature from ${result.signerSubject} (it arrived signed; the hook leaves signed files alone)`
      );
      ok++;
    } else {
      problems.push(
        `${file}: signed by "${signer}" (${result.signerSubject}), expected the publisher: one of ${JSON.stringify(publisherNames)}`
      );
    }
  }
  return { problems, upstream, ok };
}

/**
 * The auto-update brick guard, both ways round.
 *
 * Unsigned: app-update.yml must carry NO publisherName -- the key absent, or
 * an explicit null. electron-updater skips the signature check only when the
 * value is `== null`; anything else, even [], is a list every update is
 * checked against, so an empty list or a stray string refuses every later
 * unsigned update on every install.
 *
 * Signed: it must pin exactly publisherNames, in order. Absent, the update
 * signature check is off; short a name, installs refuse correctly signed
 * updates.
 *
 * @param {unknown} document Parsed app-update.yml.
 * @param {{ enabled: boolean, publisherNames?: string[] }} status
 * @param {string} where For the message.
 * @returns {string | null}
 */
export function appUpdatePublisherProblem(document, status, where) {
  const configured = isPlainObject(document)
    ? /** @type {Record<string, unknown>} */ (document).publisherName
    : undefined;
  if (!status.enabled) {
    return configured == null
      ? null
      : `${where} carries publisherName ${JSON.stringify(configured)} in an UNSIGNED build: every install would refuse all later unsigned updates (only no publisherName, or null, is safe)`;
  }
  const expected = status.publisherNames ?? [];
  const names = asNameList(configured);
  if (!sameNames(names, expected)) {
    const consequence =
      configured == null
        ? 'never check update signatures'
        : expected.some((name) => !names.includes(name))
          ? 'reject correctly signed updates'
          : names.some((name) => !expected.includes(name))
            ? 'also accept updates signed by a name windows-signing.json does not list'
            : 'pin the right names in a different order, so this is not the build windows-signing.json describes';
    return `${where} pins publisherName ${JSON.stringify(names)}, expected ${JSON.stringify(expected)}: installs would ${consequence}`;
  }
  return null;
}

/**
 * Every PE file in a Windows release directory, found by CONTENT (MZ + PE
 * signature), so a binary with an unexpected extension is not overlooked.
 * Nothing here knows Electron's DLL list: it changes between versions.
 *
 * @param {string} releaseDir
 * @param {string[]} [unpackedDirs]
 * @returns {{ files: Array<{ path: string, kind: 'own' | 'other' | 'unexpected' }>, problems: string[] }}
 */
export function collectReleasePeFiles(releaseDir, unpackedDirs = DEFAULT_UNPACKED_DIRS) {
  /** @type {Array<{ path: string, kind: 'own' | 'other' | 'unexpected' }>} */
  const files = [];
  /** @type {string[]} */
  const problems = [];
  const where = { appDirs: unpackedDirs.map((name) => path.join(releaseDir, name)), releaseDir };

  const add = (/** @type {string} */ file) => {
    let isPe;
    try {
      isPe = isPeBinary(readPeHeaders(file));
    } catch (error) {
      // Unreadable is not "not a binary": it would let anything hide here.
      problems.push(`${file}: cannot be read (${/** @type {Error} */ (error).message})`);
      return;
    }
    const kind = peFileKind(file, where);
    if (isPe) files.push({ path: file, kind });
    else if (kind !== 'unexpected')
      problems.push(`${file}: has a binary's extension but is not a PE file`);
  };

  for (const name of unpackedDirs) {
    const root = path.join(releaseDir, name);
    if (!fs.existsSync(root)) {
      problems.push(`${root} does not exist: electron-builder did not produce this build`);
      continue;
    }
    const before = files.length;
    for (const entry of readTreeOnDisk(root)) {
      if (entry.isFile()) add(path.join(entry.parentPath ?? entry.path, entry.name));
    }
    const mine = files.slice(before);
    if (
      !mine.some(
        (file) => path.dirname(file.path) === root && file.path.toLowerCase().endsWith('.exe')
      )
    ) {
      problems.push(`${root}: no application .exe found`);
    }
    if (!mine.some((file) => file.path === path.join(root, 'resources', 'elevate.exe'))) {
      problems.push(`${root}: resources/elevate.exe is missing`);
    }
    if (!mine.some((file) => file.path.endsWith('.node'))) {
      problems.push(`${root}: no native .node addon found`);
    }
  }

  const installers = fs.existsSync(releaseDir)
    ? fs
        .readdirSync(releaseDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
        .map((entry) => path.join(releaseDir, entry.name))
    : [];
  if (installers.length === 0) problems.push(`${releaseDir}: no installer (.exe) found`);
  for (const installer of installers) add(installer);

  return { files, problems };
}

/**
 * Ask Windows. Get-AuthenticodeSignature is the very call electron-updater
 * makes on each downloaded update, so "Valid" here means "an installed copy
 * would accept this". The script goes in as -EncodedCommand (no quoting
 * through cmd.exe), the paths through a file named by an environment variable
 * (no injection), and every field leaves as a STRING, so the status is never
 * an enum number whose mapping we would have to guess.
 *
 * @param {string[]} files
 * @param {{ run?: (file: string, args: string[], options: object) => Promise<{ stdout: string }>, tmpDir?: string }} [deps]
 * @returns {Promise<AuthenticodeResult[]>}
 */
export async function queryAuthenticode(files, deps = {}) {
  const { run = /** @type {any} */ (execFileAsync), tmpDir = os.tmpdir() } = deps;
  const listFile = path.join(fs.mkdtempSync(path.join(tmpDir, 'authenticode-')), 'files.txt');
  fs.writeFileSync(listFile, `${files.join('\n')}\n`, 'utf8');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$paths = [IO.File]::ReadAllLines($env:SARV_AUTHENTICODE_LIST, [Text.Encoding]::UTF8) | Where-Object { $_ -ne "" }',
    '$out = foreach ($p in $paths) {',
    '  $s = Get-AuthenticodeSignature -LiteralPath $p',
    '  [pscustomobject]@{',
    '    path = $p',
    '    status = [string]$s.Status',
    '    statusMessage = [string]$s.StatusMessage',
    '    signerSubject = $(if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { $null })',
    '    timeStamperSubject = $(if ($s.TimeStamperCertificate) { [string]$s.TimeStamperCertificate.Subject } else { $null })',
    '    signerThumbprint = $(if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint } else { $null })',
    '    signerSha256 = $(if ($s.SignerCertificate) { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s.SignerCertificate.RawData)).Replace("-", "") } else { $null })',
    '  }',
    '}',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    'ConvertTo-Json -InputObject @($out) -Depth 3 -Compress',
  ].join('\n');
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env: { ...process.env, SARV_AUTHENTICODE_LIST: listFile },
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    return parseAuthenticodeJson(String(stdout));
  } finally {
    fs.rmSync(path.dirname(listFile), { recursive: true, force: true });
  }
}

/**
 * Verify a packaged Windows release. Signed: every PE file Valid and
 * timestamped; our own (app executables, installer, .node addons) by one of
 * publisherNames; anything else by a publisher or by whoever signed it before
 * the build (logged); app-update.yml pinning exactly publisherNames.
 * Unsigned: app-update.yml carries no publisherName (the brick guard), and a
 * warning.
 *
 * @param {object} options
 * @param {string} options.releaseDir
 * @param {{ enabled: boolean, publisherNames?: string[], leafSha256?: string }} options.status
 *   leafSha256: the committed leaf certificate's SHA-256 fingerprint, which
 *   our own files must be signed with.
 * @param {string[]} [options.unpackedDirs]
 * @param {(files: string[]) => Promise<AuthenticodeResult[]>} [options.query]
 * @returns {Promise<{ problems: string[], warnings: string[], notes: string[], checked: number }>}
 */
export async function verifyWindowsRelease({
  releaseDir,
  status,
  unpackedDirs = DEFAULT_UNPACKED_DIRS,
  query = queryAuthenticode,
}) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];

  for (const name of unpackedDirs) {
    const file = path.join(releaseDir, name, 'resources', 'app-update.yml');
    if (!fs.existsSync(file)) {
      problems.push(`${file} is missing: auto-update has no feed configuration`);
      continue;
    }
    const problem = appUpdatePublisherProblem(
      parseYaml(fs.readFileSync(file, 'utf8')),
      status,
      file
    );
    if (problem) problems.push(problem);
  }

  if (!status.enabled) {
    warnings.push(
      'Windows code signing is disabled (no certificate chain committed): this Windows build is NOT code-signed.'
    );
    return { problems, warnings, notes: [], checked: 0 };
  }

  const collected = collectReleasePeFiles(releaseDir, unpackedDirs);
  problems.push(...collected.problems);
  const results =
    collected.files.length > 0 ? await query(collected.files.map((file) => file.path)) : [];
  const byPath = new Map(results.map((result) => [result.path, result]));
  const verdict = evaluateSignatures(
    collected.files.map((file) => ({ ...file, result: byPath.get(file.path) })),
    status.publisherNames ?? [],
    { leafSha256: status.leafSha256 }
  );
  problems.push(...verdict.problems);
  return { problems, warnings, notes: verdict.upstream, checked: verdict.ok };
}

/* ------------------------------------------------------------------------ */
/* Command-line entry points                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Format `key=value` lines for $GITHUB_OUTPUT. A newline in a value would let
 * it write a second, forged output, so it is refused.
 *
 * @param {Record<string, string>} outputs
 * @returns {string}
 */
export function formatGithubOutput(outputs) {
  return Object.entries(outputs)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`output ${key} contains a line break`);
      return `${key}=${value}\n`;
    })
    .join('');
}

/**
 * The status outputs release.yml branches on. `publisher_names` is the whole
 * pinned list as one JSON line (an output cannot hold a line break); the
 * Package step turns it into one -c.win.signtoolOptions.publisherName flag
 * per name. Disabled, it is always "[]": the loader refuses a non-empty list
 * without a chain.
 *
 * @param {DisabledSigning | EnabledSigning} loaded
 * @returns {Record<string, string>}
 */
export function statusOutputs(loaded) {
  return {
    enabled: String(loaded.enabled),
    publisher: loaded.enabled ? loaded.publisher : '',
    publisher_names: JSON.stringify(loaded.enabled ? loaded.publisherNames : []),
    provider: loaded.config.workloadIdentityProvider,
    service_account: loaded.config.serviceAccount,
  };
}

/**
 * Download the pinned jsign jar and refuse it unless its sha256 matches.
 * Nothing is written to `destDir` until the digest has been checked.
 *
 * @param {{ jsign: { version: string, url: string, sha256: string }, destDir: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string>} Path of the verified jar.
 */
export async function fetchJsign({ jsign, destDir, fetchImpl = fetch }) {
  const response = await fetchImpl(jsign.url, { redirect: 'follow' });
  if (!response.ok)
    throw new Error(`jsign download failed: HTTP ${response.status} from ${jsign.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== jsign.sha256) {
    throw new Error(
      `jsign ${jsign.version} from ${jsign.url} has sha256 ${digest}, not the pinned ${jsign.sha256}; refusing it`
    );
  }
  const jar = path.join(destDir, `jsign-${jsign.version}.jar`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(jar, bytes);
  return jar;
}

/**
 * @typedef {object} CliIo
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(message: string) => void} [log]
 * @property {(message: string) => void} [error]
 * @property {string} [configPath]
 * @property {Date} [now]
 * @property {typeof fetch} [fetchImpl]
 * @property {(files: string[]) => Promise<AuthenticodeResult[]>} [query]
 * @property {(file: string, args: string[], options: object) => Promise<{ stdout: unknown }>} [run] Runs `gh`.
 */

/**
 * @param {string | undefined} target
 * @param {Record<string, string>} outputs
 */
function writeGithubOutput(target, outputs) {
  if (!target) throw new Error('--github-output given but GITHUB_OUTPUT is not set');
  fs.appendFileSync(target, formatGithubOutput(outputs));
}

const USAGE =
  'usage: node scripts/windows-signing.mjs status [--previous-release <owner/repo>] [--github-output] | ' +
  'fetch-jsign --dest <dir> [--github-output]';

/**
 * `node scripts/windows-signing.mjs status [--previous-release <owner/repo>] [--github-output]`
 * `node scripts/windows-signing.mjs fetch-jsign --dest <dir> [--github-output]`
 *
 * With --previous-release, `status` first asks GitHub what the release marked
 * Latest pins, and exits 1 if this build would be refused by the installs it
 * updated (previousReleaseProblems). The release workflow always passes it.
 *
 * @param {string[]} argv
 * @param {CliIo} [io]
 * @returns {Promise<number>} Exit code.
 */
export async function windowsSigningCli(argv, io = {}) {
  const {
    env = process.env,
    log = console.log,
    error = console.error,
    configPath = DEFAULT_CONFIG_PATH,
    now,
    fetchImpl,
    run,
  } = io;
  const [command, ...rest] = argv;
  const githubOutput = rest.includes('--github-output');
  try {
    if (command === 'status') {
      const previousAt = rest.indexOf('--previous-release');
      const repository = previousAt === -1 ? undefined : rest[previousAt + 1];
      if (previousAt !== -1 && (!repository || repository.startsWith('--'))) {
        error(USAGE);
        return 2;
      }
      // What installed copies pin comes first: it decides what this build may be.
      const previous =
        repository === undefined
          ? undefined
          : await lookupPreviousRelease({ repository, ...(run ? { run } : {}) });
      if (previous) log(describePreviousRelease(previous));

      const loaded = loadWindowsSigningConfig(configPath, now ? { now } : {});
      const refused = previous ? previousReleaseProblems(previous, loaded) : [];
      if (refused.length > 0) throw new Error(`windows signing: ${refused.join('\n')}`);

      if (loaded.enabled) {
        log(
          `Windows code signing: ENABLED, publisher "${loaded.publisher}", certificate valid until ${loaded.leaf.validTo}; ` +
            `app-update.yml will pin ${JSON.stringify(loaded.publisherNames)}`
        );
      } else {
        log(
          `::warning::Windows code signing is disabled (${path.basename(loaded.chainPath)} is not committed): the Windows build is NOT code-signed.`
        );
      }
      if (!previous) log('Not checked against the last published release (no --previous-release).');
      if (githubOutput) writeGithubOutput(env.GITHUB_OUTPUT, statusOutputs(loaded));
      return 0;
    }
    if (command === 'fetch-jsign') {
      const loaded = loadWindowsSigningConfig(configPath, now ? { now } : {});
      const destIndex = rest.indexOf('--dest');
      const destDir = destIndex === -1 ? undefined : rest[destIndex + 1];
      if (!destDir) throw new Error('fetch-jsign needs --dest <dir>');
      const jar = await fetchJsign({ jsign: loaded.config.jsign, destDir, fetchImpl });
      log(
        `jsign ${loaded.config.jsign.version} verified (sha256 ${loaded.config.jsign.sha256}) at ${jar}`
      );
      if (githubOutput) writeGithubOutput(env.GITHUB_OUTPUT, { path: jar });
      return 0;
    }
    error(USAGE);
    return 2;
  } catch (caught) {
    error(`::error::${/** @type {Error} */ (caught).message}`);
    return 1;
  }
}

/**
 * `node scripts/verify-win-signatures.mjs <release-dir>`
 *
 * @param {string[]} argv
 * @param {CliIo} [io]
 * @returns {Promise<number>}
 */
export async function verifyWinSignaturesCli(argv, io = {}) {
  const {
    log = console.log,
    error = console.error,
    configPath = DEFAULT_CONFIG_PATH,
    now,
    query,
  } = io;
  if (argv.length !== 1) {
    error('usage: node scripts/verify-win-signatures.mjs <release-dir>');
    return 2;
  }
  try {
    const loaded = loadWindowsSigningConfig(configPath, now ? { now } : {});
    const status = loaded.enabled
      ? {
          enabled: true,
          publisherNames: loaded.publisherNames,
          leafSha256: loaded.leaf.fingerprint256,
        }
      : { enabled: false };
    const result = await verifyWindowsRelease({
      releaseDir: argv[0],
      status,
      ...(query ? { query } : {}),
    });
    for (const note of result.notes) log(`NOTE: ${note}`);
    for (const warning of result.warnings) log(`::warning::${warning}`);
    if (result.problems.length > 0) {
      for (const problem of result.problems) error(`::error::${problem}`);
      error('Do not publish this build: see docs/WINDOWS_SIGNING.md.');
      return 1;
    }
    log(
      status.enabled
        ? `OK: ${result.checked} PE files carry valid, timestamped signatures; app-update.yml pins ${JSON.stringify(status.publisherNames)}`
        : 'OK: app-update.yml carries no publisherName, so installs keep accepting unsigned updates'
    );
    return 0;
  } catch (caught) {
    error(`::error::${/** @type {Error} */ (caught).message}`);
    return 1;
  }
}

/**
 * `node scripts/verify-pe-signed.mjs <file>...` -- the OS-independent check
 * in the publish job: each installer must carry a certificate table when
 * signing is enabled. It cannot judge validity (that needs Windows, and was
 * done in the build job); it catches an unsigned file reaching the release.
 *
 * @param {string[]} argv
 * @param {CliIo} [io]
 * @returns {Promise<number>}
 */
export async function verifyPeSignedCli(argv, io = {}) {
  const { log = console.log, error = console.error, configPath = DEFAULT_CONFIG_PATH, now } = io;
  if (argv.length === 0) {
    error('usage: node scripts/verify-pe-signed.mjs <file>...');
    return 2;
  }
  try {
    const loaded = loadWindowsSigningConfig(configPath, now ? { now } : {});
    if (!loaded.enabled) {
      log('::warning::Windows code signing is disabled: the Windows installer is NOT code-signed.');
      return 0;
    }
    /** @type {string[]} */
    const problems = [];
    for (const file of argv) {
      if (!fs.existsSync(file)) {
        problems.push(`${file} does not exist`);
        continue;
      }
      const table = readFileCertificateTable(file);
      if (!table.pe) problems.push(`${file} is not a PE file`);
      else if (!table.signed) problems.push(`${file}: ${table.problem}`);
      else log(`OK:   ${file} carries an Authenticode certificate table (${table.format})`);
    }
    if (problems.length > 0) {
      for (const problem of problems) error(`::error::${problem}`);
      return 1;
    }
    return 0;
  } catch (caught) {
    error(`::error::${/** @type {Error} */ (caught).message}`);
    return 1;
  }
}
