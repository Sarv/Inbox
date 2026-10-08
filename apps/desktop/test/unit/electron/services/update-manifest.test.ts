import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildManifest,
  publicKeyPemFor,
  sha512Base64,
  signManifest,
  ymlProblems,
} from '../../../../../../scripts/lib/update-manifest.mjs';
import {
  MANIFEST_NAME,
  SIGNATURE_NAME,
  UPDATE_RELEASE_REPO,
  releaseAssetUrl,
  updateInfoProblems,
  verifyManifestSignature,
  verifyUpdate,
} from '../../../../electron/services/update-manifest';

/**
 * The signed update manifest (CASA M-3), both halves: what CI signs
 * (scripts/lib/update-manifest.mjs, scripts/sign-release.mjs) and what the app
 * verifies before downloading anything (electron/services/update-manifest.ts).
 * What breaks if this fails: an update swapped into a GitHub release is
 * installed on every copy; or a genuine release is refused by every copy
 * because the two halves drifted, or CI signed with a key the app doesn't trust.
 */

// Hoisted above the imports by vitest.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));

const require = createRequire(import.meta.url);
const signScript = fileURLToPath(new URL('../../../../../../scripts/sign-release.mjs', import.meta.url));

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
};
const ours = keyPair();
const theirs = keyPair();

const artifacts = { 'sarv-inbox-1.3.0-x64.exe': Buffer.from('installer bytes'), 'latest.yml': Buffer.from('yml') };
const manifest = buildManifest('1.3.0', artifacts);
const info = { version: '1.3.0', files: [{ url: 'sarv-inbox-1.3.0-x64.exe', sha512: sha512Base64(artifacts['sarv-inbox-1.3.0-x64.exe']) }] };

describe('signature', () => {
  it('accepts a manifest signed by a trusted key — the CI signer and app verifier agree', () => {
    const parsed = verifyManifestSignature(manifest, signManifest(manifest, ours.priv), [ours.pub]);
    expect(parsed.version).toBe('1.3.0');
    expect(updateInfoProblems(info, parsed)).toEqual([]);
  });

  // THE attack: a release edited by someone without the private key.
  it('rejects a manifest signed by any other key, or altered after signing', () => {
    expect(() => verifyManifestSignature(manifest, signManifest(manifest, theirs.priv), [ours.pub])).toThrow(/not signed by a trusted/);
    const tampered = Buffer.from(manifest.toString('utf8').replace('1.3.0', '1.3.9'));
    expect(() => verifyManifestSignature(tampered, signManifest(manifest, ours.priv), [ours.pub])).toThrow(/not signed by a trusted/);
    expect(() => verifyManifestSignature(manifest, 'not base64 at all!', [ours.pub])).toThrow();
    expect(() => verifyManifestSignature(manifest, signManifest(manifest, ours.priv), ['not a key'])).toThrow();
  });

  // Rotation: a release signed with either key in the list is accepted.
  it('accepts any key in the trusted list', () => {
    expect(() => verifyManifestSignature(manifest, signManifest(manifest, theirs.priv), [ours.pub, theirs.pub])).not.toThrow();
  });

  it('rejects a validly signed manifest in an unknown format', () => {
    const v2 = Buffer.from(JSON.stringify({ format: 2, version: '1.3.0', files: {} }));
    expect(() => verifyManifestSignature(v2, signManifest(v2, ours.priv), [ours.pub])).toThrow(/unsupported format/);
  });

  // Breaks: CI and the shipped app disagree about which key signs releases.
  it('ships exactly one well-formed trusted key', () => {
    const keys = require('../../../../build/update-signing-keys.json').ed25519 as string[];
    expect(keys.length).toBeGreaterThan(0);
    for (const pem of keys) expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----$/);
  });
});

describe('updateInfoProblems', () => {
  const parsed = verifyManifestSignature(manifest, signManifest(manifest, ours.priv), [ours.pub]);

  // Breaks: a swapped installer whose hash the manifest doesn't carry is accepted.
  it('names every file the manifest does not vouch for', () => {
    expect(updateInfoProblems({ ...info, files: [{ url: 'sarv-inbox-1.3.0-x64.exe', sha512: 'other' }] }, parsed))
      .toEqual(['sarv-inbox-1.3.0-x64.exe does not match its signed hash']);
    expect(updateInfoProblems({ ...info, files: [{ url: 'evil.exe', sha512: 'x' }] }, parsed))
      .toEqual(['evil.exe is not in the signed manifest']);
    expect(updateInfoProblems({ ...info, files: [{ url: '__proto__', sha512: 'x' }] }, parsed))
      .toEqual(['__proto__ is not in the signed manifest']);
  });

  // Breaks: an old, genuinely signed manifest licenses a different version.
  it('requires the same version, and at least one file', () => {
    expect(updateInfoProblems({ ...info, version: '1.3.1' }, parsed)).toContain('version 1.3.1 is not the signed 1.3.0');
    expect(updateInfoProblems({ version: '1.3.0', files: [] }, parsed)).toEqual(['the update lists no files']);
  });

  it('matches on the file name even when the url carries a path', () => {
    expect(updateInfoProblems({ ...info, files: [{ ...info.files[0], url: 'https://x/y/sarv-inbox-1.3.0-x64.exe' }] }, parsed)).toEqual([]);
  });
});

describe('verifyUpdate (fetches from the release)', () => {
  // Can't reach the real key in a test, so sign with the shipped key's
  // partner is impossible — instead prove the plumbing: every failure refuses.
  const response = (body: string, status = 200) => new Response(body, { status });

  it('fetches the manifest and signature from the update repo\'s release for that version', async () => {
    const fetch = vi.fn(async () => response('{}'));
    await verifyUpdate(info, fetch);
    expect(fetch.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      releaseAssetUrl('1.3.0', MANIFEST_NAME),
      releaseAssetUrl('1.3.0', SIGNATURE_NAME),
    ]);
    expect(releaseAssetUrl('1.3.0', MANIFEST_NAME)).toBe('https://github.com/Sarv/Inbox/releases/download/v1.3.0/update-manifest.json');
  });

  // The only safe answer to "can't verify" is "don't install".
  it.each([
    ['a release without a manifest (404)', async () => response('', 404)],
    ['a network failure', async () => { throw new TypeError('fetch failed'); }],
    ['an oversized response', async () => response('x'.repeat(300 * 1024))],
    ['a manifest signed by an untrusted key', async (url: string) => (url.endsWith('.sig') ? response(signManifest(manifest, theirs.priv)) : new Response(new Uint8Array(manifest)))],
  ])('refuses on %s', async (_label, impl) => {
    const verdict = await verifyUpdate(info, vi.fn(impl as never));
    expect(verdict.ok).toBe(false);
  });

  it('is pinned to the repo package.json publishes to', () => {
    const publish = (require('../../../../package.json').build.publish as Array<{ owner: string; repo: string }>)[0];
    expect(UPDATE_RELEASE_REPO).toEqual({ owner: publish.owner, repo: publish.repo });
  });
});

describe('scripts/sign-release.mjs (as the release workflow runs it)', () => {
  let dir: string;
  let keysDir: string;
  let trustedKeys: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sarvinbox-sign-'));
    // A throwaway trusted-keys file, so the real one is never touched.
    keysDir = mkdtempSync(join(tmpdir(), 'sarvinbox-keys-'));
    trustedKeys = join(keysDir, 'keys.json');
    writeFileSync(trustedKeys, JSON.stringify({ ed25519: [ours.pub] }));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(keysDir, { recursive: true, force: true });
  });
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [signScript, ...args, ...(args.length ? ['--trusted-keys', trustedKeys] : [])], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  const writeRelease = (ymlSha = sha512Base64(Buffer.from('installer'))) => {
    writeFileSync(join(dir, 'sarv-inbox-1.3.0-x64.exe'), 'installer');
    writeFileSync(join(dir, 'latest.yml'), `version: 1.3.0\nfiles:\n  - url: sarv-inbox-1.3.0-x64.exe\n    sha512: ${ymlSha}\n    size: 9\n`);
  };

  it('signs a release so the app\'s verifier accepts it', () => {
    writeRelease();
    const result = run({ UPDATE_SIGNING_KEY: ours.priv }, dir, '1.3.0');
    expect(result.status).toBe(0);
    const parsed = verifyManifestSignature(readFileSync(join(dir, MANIFEST_NAME)), readFileSync(join(dir, SIGNATURE_NAME), 'utf8'), [ours.pub]);
    expect(Object.keys(parsed.files).sort()).toEqual(['latest.yml', 'sarv-inbox-1.3.0-x64.exe']);
    expect(updateInfoProblems({ version: '1.3.0', files: [{ url: 'sarv-inbox-1.3.0-x64.exe', sha512: sha512Base64(Buffer.from('installer')) }] }, parsed)).toEqual([]);
  });

  // Fail closed: nothing unsigned, or signed by the wrong key, is published.
  it('refuses without a key, with a key the app does not trust, or with a broken key', () => {
    writeRelease();
    expect(run({ UPDATE_SIGNING_KEY: '' }, dir, '1.3.0')).toMatchObject({ status: 1, stderr: expect.stringContaining('not set') });
    expect(run({ UPDATE_SIGNING_KEY: theirs.priv }, dir, '1.3.0')).toMatchObject({ status: 1, stderr: expect.stringContaining('every installed app would refuse') });
    expect(run({ UPDATE_SIGNING_KEY: 'garbage' }, dir, '1.3.0')).toMatchObject({ status: 1, stderr: expect.stringContaining('not a usable private key') });
  });

  // Breaks: the feed points the updater at bytes the manifest doesn't sign, so
  // every installed copy refuses the release.
  it('refuses when a latest*.yml disagrees with the artifacts, or there is none', () => {
    writeRelease('wrong-hash');
    expect(run({ UPDATE_SIGNING_KEY: ours.priv }, dir, '1.3.0')).toMatchObject({ status: 1, stderr: expect.stringContaining('sha512 differs') });
    rmSync(join(dir, 'latest.yml'));
    expect(run({ UPDATE_SIGNING_KEY: ours.priv }, dir, '1.3.0')).toMatchObject({ status: 1, stderr: expect.stringContaining('no latest*.yml') });
  });

  it('refuses an empty directory and missing arguments', () => {
    expect(run({ UPDATE_SIGNING_KEY: ours.priv }, dir, '1.3.0').status).toBe(1);
    expect(run({ UPDATE_SIGNING_KEY: ours.priv }).status).toBe(2);
  });
});

describe('ymlProblems', () => {
  it('flags a version mismatch and an unsigned file', () => {
    expect(ymlProblems('latest.yml', { version: '1.2.0', files: [{ url: 'x.exe', sha512: 'h' }] }, '1.3.0', {}))
      .toEqual(['latest.yml: version 1.2.0 ≠ 1.3.0', 'latest.yml: x.exe is not among the signed artifacts']);
    expect(ymlProblems('latest.yml', { version: '1.3.0' }, '1.3.0', {})).toEqual(['latest.yml: lists no files']);
  });

  it('derives the public key from a private one', () => {
    expect(publicKeyPemFor(ours.priv)).toBe(ours.pub);
  });
});
