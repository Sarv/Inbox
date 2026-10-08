#!/usr/bin/env node
/*
 * Sign a release's artifacts before they are published (.github/workflows/release.yml).
 *
 * Writes into <dir>:
 *   update-manifest.json      every artifact's sha512 + size, and the version
 *   update-manifest.json.sig  Ed25519 signature (UPDATE_SIGNING_KEY) — the app
 *                             refuses any update this doesn't vouch for
 *
 * Fails — so nothing is published — when the key is missing, when it isn't a
 * key the app trusts (apps/desktop/build/update-signing-keys.json: a wrong key
 * would make EVERY installed copy refuse the update), when there are no
 * artifacts, or when a latest*.yml points at a file or hash the manifest
 * doesn't sign.
 *
 * Usage:
 *   UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-release.mjs <dir> <version> [--trusted-keys <json>]
 *
 * --trusted-keys defaults to apps/desktop/build/update-signing-keys.json (what
 * the app ships); tests point it at a throwaway key.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  MANIFEST_NAME,
  SIGNATURE_NAME,
  buildManifest,
  publicKeyPemFor,
  signManifest,
  ymlProblems,
} from './lib/update-manifest.mjs';

const DEFAULT_TRUSTED_KEYS = path.join(path.dirname(new URL(import.meta.url).pathname), '../apps/desktop/build/update-signing-keys.json');

/** Files that are signatures/sums themselves, never signed artifacts. */
const NOT_ARTIFACTS = new Set([MANIFEST_NAME, SIGNATURE_NAME, 'SHA256SUMS', 'SHA256SUMS.asc']);

function main(args) {
  const flag = args.indexOf('--trusted-keys');
  const trustedKeysPath = flag >= 0 ? args[flag + 1] : DEFAULT_TRUSTED_KEYS;
  const [dir, version] = flag >= 0 ? args.filter((_, i) => i !== flag && i !== flag + 1) : args;
  if (!dir || !version || !trustedKeysPath) {
    console.error('usage: UPDATE_SIGNING_KEY=<pem> node scripts/sign-release.mjs <dir> <version>');
    return 2;
  }
  const privateKey = process.env.UPDATE_SIGNING_KEY;
  if (!privateKey?.trim()) {
    console.error('✗ UPDATE_SIGNING_KEY is not set — refusing to publish an unsigned release.');
    return 1;
  }
  let publicPem;
  try {
    publicPem = publicKeyPemFor(privateKey);
  } catch (error) {
    console.error(`✗ UPDATE_SIGNING_KEY is not a usable private key (${error.message}).`);
    return 1;
  }
  const trusted = JSON.parse(fs.readFileSync(trustedKeysPath, 'utf8')).ed25519.map((k) => k.trim());
  if (!trusted.includes(publicPem)) {
    console.error('✗ UPDATE_SIGNING_KEY is not one of the keys in apps/desktop/build/update-signing-keys.json —');
    console.error('  every installed app would refuse this update. Refusing to publish.');
    return 1;
  }

  const names = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile() && !NOT_ARTIFACTS.has(name));
  if (names.length === 0) {
    console.error(`✗ ${dir} has no artifacts to sign.`);
    return 1;
  }
  const artifacts = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(dir, name))]));
  const manifestBytes = buildManifest(version, artifacts);
  const { files } = JSON.parse(manifestBytes.toString('utf8'));

  const problems = names
    .filter((name) => /^latest.*\.yml$/.test(name))
    .flatMap((name) => ymlProblems(name, parseYaml(artifacts[name].toString('utf8')), version, files));
  if (!names.some((name) => /^latest.*\.yml$/.test(name))) problems.push('no latest*.yml — nothing would drive the update');
  if (problems.length) {
    console.error('✗ The update feed disagrees with the artifacts:');
    for (const problem of problems) console.error(`    ${problem}`);
    return 1;
  }

  fs.writeFileSync(path.join(dir, MANIFEST_NAME), manifestBytes);
  fs.writeFileSync(path.join(dir, SIGNATURE_NAME), `${signManifest(manifestBytes, privateKey)}\n`);
  console.log(`✓ Signed ${names.length} artifacts for ${version} (${MANIFEST_NAME} + ${SIGNATURE_NAME})`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
