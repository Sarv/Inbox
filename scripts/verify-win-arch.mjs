#!/usr/bin/env node
/*
 * Fail the Windows release build if any packaged native addon was compiled for
 * the wrong CPU.
 *
 * Run by .github/workflows/release.yml after electron-builder packs the app.
 * See scripts/lib/pe-machine.mjs for why this check is worth a build step: a
 * cross-compile that quietly falls back to the host architecture produces a
 * green build and an arm64 app that boots with no mail in it.
 *
 * Usage:
 *   node scripts/verify-win-arch.mjs <unpacked-dir>=<expected-arch> ...
 *
 * Example:
 *   node scripts/verify-win-arch.mjs \
 *     apps/desktop/release/win-unpacked=x64 \
 *     apps/desktop/release/win-arm64-unpacked=arm64
 *
 * A directory that does not exist is an error, not a pass -- silently
 * verifying nothing is how this class of bug ships.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readPeMachine } from './lib/pe-machine.mjs';

/** Enough bytes to cover the DOS stub and the COFF header of any PE file. */
const HEADER_BYTES = 1024;

/**
 * Collect every `.node` addon under a directory tree.
 *
 * @param {string} root
 * @returns {string[]} Absolute paths, sorted for stable output.
 */
function findNativeAddons(root) {
  /** @type {string[]} */
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.node')) {
      found.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return found.sort();
}

/**
 * Read only the header of a file, rather than pulling a multi-megabyte addon
 * into memory just to look at 64 bytes of it.
 *
 * @param {string} file
 * @returns {Buffer}
 */
function readHeader(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fs.readSync(handle, buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * @param {string[]} args `<dir>=<arch>` pairs.
 * @returns {number} Process exit code.
 */
function main(args) {
  if (args.length === 0) {
    console.error('usage: node scripts/verify-win-arch.mjs <unpacked-dir>=<expected-arch> ...');
    return 2;
  }

  /** @type {string[]} */
  const problems = [];

  for (const arg of args) {
    const separator = arg.lastIndexOf('=');
    if (separator === -1) {
      problems.push(`FAIL: "${arg}" is not in <dir>=<arch> form`);
      continue;
    }

    const directory = arg.slice(0, separator);
    const expected = arg.slice(separator + 1);

    if (!fs.existsSync(directory)) {
      problems.push(`FAIL: ${directory} does not exist -- electron-builder did not produce a ${expected} build`);
      continue;
    }

    const addons = findNativeAddons(directory);
    if (addons.length === 0) {
      problems.push(`FAIL: no .node addon found under ${directory} -- asarUnpack may have stopped unpacking them`);
      continue;
    }

    for (const addon of addons) {
      const relative = path.relative(directory, addon);
      let actual;
      try {
        actual = readPeMachine(readHeader(addon));
      } catch (error) {
        problems.push(`FAIL: ${directory} -> ${relative}: ${error.message}`);
        continue;
      }

      if (actual === expected) {
        console.log(`OK:   ${directory} -> ${relative} is ${actual}`);
      } else {
        problems.push(`FAIL: ${directory} -> ${relative} is ${actual}, expected ${expected}`);
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error('');
    console.error('A native addon built for the wrong CPU does not crash the app -- every');
    console.error('database read is wrapped in a try/catch, so it looks like an account with');
    console.error('no mail. Do not publish this build.');
    return 1;
  }

  console.log('OK: every packaged native addon matches its target architecture');
  return 0;
}

process.exit(main(process.argv.slice(2)));
