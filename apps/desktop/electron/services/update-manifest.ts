/**
 * Verify an update before a single byte of it is downloaded (CASA M-3).
 *
 * electron-updater trusts the sha512 in a release's latest*.yml — a file that
 * sits in the SAME GitHub release as the binaries it vouches for, and Windows
 * and Linux builds are not OS-signed. So whoever could alter a release could
 * ship every installed copy a binary of their choosing within the hour.
 *
 * Each release now carries update-manifest.json (every artifact's sha512) and
 * an Ed25519 signature over it, made in CI with a key that exists only in a
 * GitHub secret (scripts/sign-release.mjs). This app carries the public key
 * (build/update-signing-keys.json) and, for every update electron-updater
 * finds, checks that each file it is about to download is one the signed
 * manifest vouches for, hash for hash. electron-updater then verifies the
 * download against those same hashes. Anything unsigned, unverifiable or
 * mismatched is refused: there is no fallback to the unsigned path.
 */
import { createPublicKey, verify } from 'node:crypto';

import trustedKeys from '../../build/update-signing-keys.json';

import { chromiumFetch } from './net-fetch';

/** The repo whose releases feed updates — pinned equal to package.json `build.publish` by test. */
export const UPDATE_RELEASE_REPO = { owner: 'Sarv', repo: 'Inbox' } as const;
export const MANIFEST_NAME = 'update-manifest.json';
export const SIGNATURE_NAME = 'update-manifest.json.sig';
const MANIFEST_FORMAT = 1;
/** Far above any real manifest; a bound so a hostile response can't exhaust memory. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export interface UpdateManifest {
  format: number;
  version: string;
  files: Record<string, { sha512: string; size: number }>;
}

/** The parts of electron-updater's UpdateInfo this check reads. */
export interface UpdateInfoLike {
  version: string;
  files?: Array<{ url: string; sha512: string }>;
}

export type UpdateVerification = { ok: true } | { ok: false; reason: string };

/**
 * The manifest, if `signature` is a valid Ed25519 signature over exactly
 * `manifestBytes` by one of `publicKeys`; otherwise throws.
 */
export function verifyManifestSignature(
  manifestBytes: Buffer,
  signature: string,
  publicKeys: readonly string[] = trustedKeys.ed25519,
): UpdateManifest {
  const sig = Buffer.from(signature.trim(), 'base64');
  const signedByTrustedKey = publicKeys.some((pem) => {
    try {
      return verify(null, manifestBytes, createPublicKey(pem), sig);
    } catch {
      return false;
    }
  });
  if (!signedByTrustedKey) throw new Error('the update manifest is not signed by a trusted Sarv key');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as UpdateManifest;
  if (manifest?.format !== MANIFEST_FORMAT || typeof manifest.version !== 'string' || typeof manifest.files !== 'object' || !manifest.files) {
    throw new Error(`the update manifest has an unsupported format (${String(manifest?.format)})`);
  }
  return manifest;
}

/**
 * Every way the update electron-updater found disagrees with the signed
 * manifest. Pure. Empty = every file to be downloaded is vouched for.
 */
export function updateInfoProblems(info: UpdateInfoLike, manifest: UpdateManifest): string[] {
  const problems: string[] = [];
  if (info.version !== manifest.version) problems.push(`version ${info.version} is not the signed ${manifest.version}`);
  const files = info.files ?? [];
  if (files.length === 0) problems.push('the update lists no files');
  for (const file of files) {
    const name = String(file.url ?? '').split('/').pop() ?? '';
    const signed = Object.prototype.hasOwnProperty.call(manifest.files, name) ? manifest.files[name] : undefined;
    if (!signed) problems.push(`${name || '(no name)'} is not in the signed manifest`);
    else if (signed.sha512 !== file.sha512) problems.push(`${name} does not match its signed hash`);
  }
  return problems;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchBounded(fetchImpl: Fetch, url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('response too large');
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/** Where a release's signed manifest lives. */
export function releaseAssetUrl(version: string, name: string): string {
  const { owner, repo } = UPDATE_RELEASE_REPO;
  return `https://github.com/${owner}/${repo}/releases/download/v${encodeURIComponent(version)}/${name}`;
}

/**
 * Fetch the release's signed manifest and check the found update against it.
 * Never throws: every failure — missing manifest, bad signature, mismatch,
 * network — is a refusal with a reason, because the only safe answer to "can't
 * verify" is "don't install".
 */
export async function verifyUpdate(info: UpdateInfoLike, fetchImpl: Fetch = chromiumFetch): Promise<UpdateVerification> {
  try {
    const [manifestBytes, signature] = await Promise.all([
      fetchBounded(fetchImpl, releaseAssetUrl(info.version, MANIFEST_NAME)),
      fetchBounded(fetchImpl, releaseAssetUrl(info.version, SIGNATURE_NAME)),
    ]);
    const manifest = verifyManifestSignature(manifestBytes, signature.toString('utf8'));
    const problems = updateInfoProblems(info, manifest);
    if (problems.length) return { ok: false, reason: problems.join('; ') };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}
