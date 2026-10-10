#!/usr/bin/env node
/*
 * Fail the release build if a packaged binary does not carry the required
 * Electron fuses (scripts/lib/electron-fuses.mjs explains which and why).
 *
 * Run by .github/workflows/release.yml after electron-builder packs the app,
 * on every platform and arch — including Windows arm64, which the smoke launch
 * cannot execute on an x64 runner. Every fuse wire in the file is checked: a
 * universal macOS build has one per CPU slice.
 *
 * Usage:
 *   node scripts/verify-fuses.mjs <app-or-executable> ...
 *
 * Example:
 *   node scripts/verify-fuses.mjs "apps/desktop/release/mac-universal/Sarv Inbox.app"
 *
 * No targets, a missing file, or a file with no fuse wire is an error, not a pass.
 */

import fs from 'node:fs';

import { FuseV1Options } from '@electron/fuses';

import { fuseFilePath, fuseProblems, readFuseWires } from './lib/electron-fuses.mjs';

/** Numeric ids by fuse name, from the installed library (the enum maps both ways). */
const ids = Object.fromEntries(Object.entries(FuseV1Options).filter(([name]) => Number.isNaN(Number(name))));

/** Fuse wire format version this check understands (FuseVersion.V1). */
const WIRE_VERSION = 1;

/**
 * @param {string[]} targets
 * @returns {number} Process exit code.
 */
function main(targets) {
  if (targets.length === 0) {
    console.error('usage: node scripts/verify-fuses.mjs <app-or-executable> ...');
    return 2;
  }
  let failed = false;
  for (const target of targets) {
    const file = fuseFilePath(target);
    let binary;
    try {
      binary = fs.readFileSync(file);
    } catch (error) {
      console.error(`✗ ${target}: cannot read ${file} (${error.code ?? error.message})`);
      failed = true;
      continue;
    }
    const wires = readFuseWires(binary);
    if (wires.length === 0) {
      console.error(`✗ ${target}: no fuse wire found — not an Electron binary?`);
      failed = true;
      continue;
    }
    wires.forEach((wire, slice) => {
      const label = wires.length > 1 ? `${target} (slice ${slice + 1} of ${wires.length})` : target;
      const problems = wire.version === WIRE_VERSION
        ? fuseProblems(wire.states, ids)
        : [`fuse wire version ${wire.version}, this check understands ${WIRE_VERSION}`];
      if (problems.length === 0) {
        console.log(`✓ ${label}: all fuses as required`);
        return;
      }
      failed = true;
      console.error(`✗ ${label}:`);
      for (const problem of problems) console.error(`    ${problem}`);
    });
  }
  return failed ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
