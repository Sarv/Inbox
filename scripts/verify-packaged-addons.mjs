#!/usr/bin/env node
/*
 * Fail the release build if a packaged app is missing its native addons.
 *
 * Run by .github/workflows/release.yml after electron-builder packs the app, on
 * the platforms that have no stricter check of their own. Windows runs
 * verify-win-arch.mjs instead, which verifies the CPU of every addon and so
 * covers this as well.
 *
 * See scripts/lib/native-addons.mjs for the failure this exists to catch: the
 * v1.2.0 tag produced four green, uploaded, installable artifacts whose
 * app.asar contained no node_modules at all.
 *
 * Usage:
 *   node scripts/verify-packaged-addons.mjs <release-dir> ...
 *
 * Example:
 *   node scripts/verify-packaged-addons.mjs apps/desktop/release
 *
 * A release directory with no packed app in it is an error, not a pass --
 * verifying nothing is exactly how this shipped the first time.
 */

import fs from 'node:fs';
import path from 'node:path';

import { REQUIRED_ADDONS, findNativeAddons, findPackagedApps, missingRequiredAddons } from './lib/native-addons.mjs';

/**
 * @param {string[]} args Release directories to check.
 * @returns {number} Process exit code.
 */
function main(args) {
  if (args.length === 0) {
    console.error('usage: node scripts/verify-packaged-addons.mjs <release-dir> ...');
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
      const missing = missingRequiredAddons(findNativeAddons(resources));
      const shown = path.relative(releaseDir, resources) || '.';
      if (missing.length === 0) {
        console.log(`OK:   ${releaseDir} -> ${shown} carries ${REQUIRED_ADDONS.join(', ')}`);
      } else {
        problems.push(`FAIL: ${releaseDir} -> ${shown} is missing ${missing.join(', ')}`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('');
    console.error('An app packed without better_sqlite3.node does not crash -- every database');
    console.error('read is wrapped in a try/catch, so it looks like an account with no mail.');
    console.error('Check that build/beforeBuild.js still returns true. Do not publish this build.');
    return 1;
  }

  console.log('OK: every packed app carries its native addons');
  return 0;
}

process.exit(main(process.argv.slice(2)));
