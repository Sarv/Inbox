/*
 * The signed update manifest — the release-side half (the app-side verifier is
 * apps/desktop/electron/services/update-manifest.ts; update-manifest.test.ts
 * round-trips one through the other so the two can't drift).
 *
 * Why it exists (CASA M-3): electron-updater trusts the sha512 in a release's
 * latest*.yml, and that file sits in the SAME GitHub release as the binaries it
 * vouches for. Windows and Linux builds aren't OS-signed, so anyone able to
 * alter a release could ship every installed copy a binary of their choosing.
 * Each release now also carries update-manifest.json — every artifact's sha512
 * — with an Ed25519 signature from a key that exists only in the
 * UPDATE_SIGNING_KEY secret. The app carries the public key and refuses any
 * update the manifest doesn't vouch for.
 */

import crypto from 'node:crypto';

/** Bumped only with a verifier that understands the new shape. */
export const MANIFEST_FORMAT = 1;
export const MANIFEST_NAME = 'update-manifest.json';
export const SIGNATURE_NAME = 'update-manifest.json.sig';

/** sha512 as electron-builder writes it in latest*.yml (base64). */
export function sha512Base64(bytes) {
  return crypto.createHash('sha512').update(bytes).digest('base64');
}

/**
 * The manifest for a set of artifacts, as the exact bytes to sign. Keys are
 * sorted so the same artifacts always produce the same bytes.
 *
 * @param {string} version
 * @param {Record<string, Buffer>} artifacts file name → contents
 * @returns {Buffer}
 */
export function buildManifest(version, artifacts) {
  const files = {};
  for (const name of Object.keys(artifacts).sort()) {
    files[name] = { sha512: sha512Base64(artifacts[name]), size: artifacts[name].length };
  }
  return Buffer.from(`${JSON.stringify({ format: MANIFEST_FORMAT, version, files }, null, 2)}\n`, 'utf8');
}

/** Detached Ed25519 signature over the manifest bytes, base64. */
export function signManifest(manifestBytes, privateKeyPem) {
  return crypto.sign(null, manifestBytes, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

/** The SPKI PEM public key for a private key — to check it against the app's. */
export function publicKeyPemFor(privateKeyPem) {
  return crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString().trim();
}

/**
 * Every way a latest*.yml disagrees with the signed hashes. The updater
 * downloads what the yml names and checks the yml's sha512; if the two
 * disagreed, every installed app would refuse the update — so this fails the
 * release instead.
 *
 * @param {string} ymlName
 * @param {{ version?: string, files?: Array<{ url?: string, sha512?: string }> }} yml parsed
 * @param {string} version
 * @param {Record<string, { sha512: string }>} signed manifest.files
 * @returns {string[]}
 */
export function ymlProblems(ymlName, yml, version, signed) {
  const problems = [];
  if (yml?.version !== version) problems.push(`${ymlName}: version ${yml?.version} ≠ ${version}`);
  const files = Array.isArray(yml?.files) ? yml.files : [];
  if (files.length === 0) problems.push(`${ymlName}: lists no files`);
  for (const file of files) {
    const name = String(file?.url ?? '').split('/').pop();
    const entry = signed[name];
    if (!entry) problems.push(`${ymlName}: ${name || '(no url)'} is not among the signed artifacts`);
    else if (entry.sha512 !== file.sha512) problems.push(`${ymlName}: ${name} sha512 differs from the artifact`);
  }
  return problems;
}
