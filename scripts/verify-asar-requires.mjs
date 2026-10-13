#!/usr/bin/env node
/*
 * Fail the release build if a packed app requires a module it does not carry.
 *
 * Run by .github/workflows/release.yml after electron-builder packs the app,
 * on every platform. package.json `build.files` ships only the node_modules
 * the production bundles still load (see scripts/lib/asar-requires.mjs); this
 * is what makes that allowlist safe to keep short.
 *
 * Usage:
 *   node scripts/verify-asar-requires.mjs <release-dir> ...
 *
 * Example:
 *   node scripts/verify-asar-requires.mjs apps/desktop/release
 *
 * A release directory with no packed app in it is an error, not a pass.
 */

import fs from 'node:fs';
import path from 'node:path';

import { extractFile, listPackage } from '@electron/asar';

import { analyseRequires } from './lib/asar-requires.mjs';
import { findPackagedApps } from './lib/native-addons.mjs';

/**
 * Every file in an archive as a `/`-separated path with no leading slash.
 * listPackage also lists directories; those never end in a script extension
 * or sit under a package, so they fall out of every later filter.
 * @param {string} archive
 * @returns {string[]}
 */
const listArchive = (archive) =>
  listPackage(archive, { isPack: false }).map((entry) => entry.split(/[\\/]/).filter(Boolean).join('/'));

/**
 * @param {string[]} args Release directories to check.
 * @returns {number} Process exit code.
 */
function main(args) {
  if (args.length === 0) {
    console.error('usage: node scripts/verify-asar-requires.mjs <release-dir> ...');
    return 2;
  }

  /** @type {string[]} */
  const problems = [];

  for (const releaseDir of args) {
    if (!fs.existsSync(releaseDir)) {
      problems.push(`FAIL: ${releaseDir} does not exist -- electron-builder produced no output`);
      continue;
    }

    const apps = findPackagedApps(releaseDir);
    if (apps.length === 0) {
      problems.push(`FAIL: no packed app (no app.asar) found under ${releaseDir}`);
      continue;
    }

    for (const resources of apps) {
      const archive = path.join(resources, 'app.asar');
      const shown = path.relative(releaseDir, resources) || '.';
      const files = listArchive(archive);
      const read = (file) => extractFile(archive, file.split('/').join(path.sep)).toString('utf8');
      const { missing, reached, packed } = analyseRequires(files, read);

      for (const { name, requiredBy } of missing) {
        problems.push(`FAIL: ${releaseDir} -> ${shown}: ${requiredBy} requires "${name}", which is not packed`);
      }
      const unused = packed.filter((name) => !reached.includes(name));
      if (unused.length > 0) {
        // Not a failure: dead weight costs download size, not correctness.
        console.warn(`WARN: ${shown} packs node_modules nothing requires: ${unused.join(', ')}`);
      }
      if (missing.length === 0) {
        console.log(`OK:   ${releaseDir} -> ${shown} loads only what it carries (${reached.join(', ') || 'no packages'})`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('');
    console.error('A module made external in vite.config.ts must also be listed in');
    console.error('apps/desktop/package.json build.files, or the app throws when it is first');
    console.error('required -- possibly only when a user reaches that feature. Do not publish this build.');
    return 1;
  }

  console.log('OK: every packed app carries every module it requires');
  return 0;
}

process.exit(main(process.argv.slice(2)));
