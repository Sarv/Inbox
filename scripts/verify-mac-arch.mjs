#!/usr/bin/env node
/*
 * Fail the macOS release build if a packaged app is not truly universal.
 *
 * Run by .github/workflows/release.yml after electron-builder packs the app.
 * The macOS build is one universal binary carrying both Intel and Apple
 * Silicon; see scripts/lib/macho-arch.mjs for why losing a slice is worth a
 * build step. In short: the dmg still builds, signs, notarizes and installs,
 * and then fails only for the half of users whose CPU went missing -- as an
 * app with no mail in it rather than as an error.
 *
 * Usage:
 *   node scripts/verify-mac-arch.mjs <app-or-dir>=<arch>[,<arch>] ...
 *
 * Example:
 *   node scripts/verify-mac-arch.mjs apps/desktop/release/mac-universal=x64,arm64
 *
 * Every .node under the directory must carry EVERY listed architecture. A
 * directory that does not exist is an error, not a pass.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readMachOArchs } from './lib/macho-arch.mjs';
import { findNativeAddons, readFileHeader } from './lib/native-addons.mjs';

/**
 * @param {string[]} args `<dir>=<arch>[,<arch>]` pairs.
 * @returns {number} Process exit code.
 */
function main(args) {
  if (args.length === 0) {
    console.error('usage: node scripts/verify-mac-arch.mjs <app-or-dir>=<arch>[,<arch>] ...');
    return 2;
  }

  /** @type {string[]} */
  const problems = [];

  for (const arg of args) {
    const separator = arg.lastIndexOf('=');
    if (separator === -1) {
      problems.push(`FAIL: "${arg}" is not in <dir>=<arch>[,<arch>] form`);
      continue;
    }

    const directory = arg.slice(0, separator);
    const expected = arg
      .slice(separator + 1)
      .split(',')
      .map((arch) => arch.trim())
      .filter(Boolean);

    if (expected.length === 0) {
      problems.push(`FAIL: "${arg}" names no architectures`);
      continue;
    }

    if (!fs.existsSync(directory)) {
      problems.push(`FAIL: ${directory} does not exist -- electron-builder did not produce a macOS build`);
      continue;
    }

    const addons = findNativeAddons(directory);
    if (addons.length === 0) {
      problems.push(`FAIL: no .node addon found under ${directory} -- node_modules may not have been packed`);
      continue;
    }

    for (const addon of addons) {
      const relative = path.relative(directory, addon);
      /** @type {string[]} */
      let actual;
      try {
        actual = readMachOArchs(readFileHeader(addon));
      } catch (error) {
        problems.push(`FAIL: ${directory} -> ${relative}: ${error.message}`);
        continue;
      }

      const missing = expected.filter((arch) => !actual.includes(arch));
      if (missing.length === 0) {
        console.log(`OK:   ${directory} -> ${relative} carries ${actual.join(', ')}`);
      } else {
        problems.push(`FAIL: ${directory} -> ${relative} carries ${actual.join(', ')}, missing ${missing.join(', ')}`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('');
    console.error('A universal app missing one slice does not crash on the CPU it lost -- every');
    console.error('database read is wrapped in a try/catch, so it looks like an account with no');
    console.error('mail. Check that @electron/universal still lipos the addon. Do not publish.');
    return 1;
  }

  console.log('OK: every packaged addon carries every expected architecture');
  return 0;
}

process.exit(main(process.argv.slice(2)));
