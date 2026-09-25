#!/usr/bin/env node
/*
 * Fail the release build when a packaged Linux app demands a newer glibc than
 * the oldest distribution we support.
 *
 * Run by .github/workflows/release.yml after electron-builder packs the Linux
 * app. See scripts/lib/elf-glibc.mjs for the failure this exists to catch: the
 * v1.2.2 tag produced Linux artifacts that were green, uploaded and
 * installable, and died on launch for every user on Ubuntu 22.04 LTS because
 * the runner image had floated forward to Ubuntu 24.04.
 *
 * The build machine can never notice this by running the app -- its own glibc
 * is always new enough. Only the binaries can tell you, so they are read.
 *
 * Usage:
 *   node scripts/verify-glibc-floor.mjs <unpacked-dir> [--max=2.35]
 *
 * Example:
 *   node scripts/verify-glibc-floor.mjs apps/desktop/release/linux-unpacked
 *
 * A directory with no ELF files in it is an error, not a pass -- verifying
 * nothing is how an empty artifact shipped at v1.2.0.
 */

import {
  compareVersions,
  findElfFiles,
  formatVersion,
  parseVersion,
  readGlibcRequirement,
} from './lib/elf-glibc.mjs';

/** Ubuntu 22.04 LTS / Linux Mint 21. Debian 12 (2.36) and newer accept it too. */
const DEFAULT_MAX = '2.35';

/**
 * @param {string[]} args
 * @returns {{ roots: string[], max: string }}
 */
function parseArgs(args) {
  /** @type {string[]} */
  const roots = [];
  let max = DEFAULT_MAX;
  for (const arg of args) {
    const flag = /^--max=(.+)$/.exec(arg);
    if (flag) max = flag[1];
    else roots.push(arg);
  }
  return { roots, max };
}

/**
 * @param {string[]} args
 * @returns {number} Process exit code.
 */
function main(args) {
  const { roots, max } = parseArgs(args);
  if (roots.length === 0) {
    console.error('usage: node scripts/verify-glibc-floor.mjs <unpacked-dir> [--max=2.35]');
    return 2;
  }

  const ceiling = parseVersion(max);
  /** @type {string[]} */
  const problems = [];
  let checked = 0;
  /** @type {number[] | null} */
  let highest = null;

  for (const root of roots) {
    const files = findElfFiles(root);
    if (files.length === 0) {
      console.error(`FAIL: no ELF binaries found under ${root} — nothing was verified.`);
      return 1;
    }
    for (const file of files) {
      checked += 1;
      const required = readGlibcRequirement(file);
      if (required === null) continue;
      if (highest === null || compareVersions(required, highest) > 0) highest = required;
      if (compareVersions(required, ceiling) > 0) {
        problems.push(`  ${file} needs GLIBC_${formatVersion(required)}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} of ${checked} binaries need a newer glibc than ${max}:`);
    console.error(problems.join('\n'));
    console.error('');
    console.error('These install fine and then fail to launch on any distribution shipping an');
    console.error(`older glibc. Build Linux on a runner whose glibc is ${max} or older`);
    console.error('(.github/workflows/release.yml pins ubuntu-22.04 for exactly this reason).');
    return 1;
  }

  console.log(
    `OK: ${checked} binaries checked, highest requirement GLIBC_${highest === null ? 'none' : formatVersion(highest)} (floor ${max})`
  );
  return 0;
}

process.exit(main(process.argv.slice(2)));
