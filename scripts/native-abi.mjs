#!/usr/bin/env node

/*
 * Switch better-sqlite3 between the Node and Electron ABIs.
 *
 * The compiled addon is valid for one ABI at a time (see scripts/lib/native-abi.mjs),
 * so you flip it depending on what you're about to do:
 *
 *   pnpm test:node-abi     → node      before running the SQLite test suites
 *   node scripts/native-abi.mjs electron  → back to the desktop app
 *   sh scripts/dev.sh                     → also rebuilds for Electron
 *
 * Prints the ABI the binary currently reports first, so a mismatch is visible
 * before you spend a minute compiling.
 *
 * Skips the compile when the addon already reports the target ABI; pass
 * --force to rebuild regardless.
 *
 * Run: node scripts/native-abi.mjs [node|electron] [--force]   (default: node)
 */

import {
  isAbiCurrent,
  readBuiltAbi,
  readElectronVersion,
  rebuildBetterSqlite3,
} from './lib/native-abi.mjs';

const log = (msg) => console.log(`[native-abi] ${msg}`);
const warn = (msg) => console.warn(`[native-abi] ${msg}`);

const args = process.argv.slice(2);
const force = args.includes('--force');
const runtime = (args.find((a) => !a.startsWith('--')) ?? 'node').toLowerCase();
if (!['node', 'electron'].includes(runtime)) {
  console.error(`[native-abi] unknown runtime "${runtime}" — use "node" or "electron"`);
  process.exit(1);
}

// Report what the addon is currently built for. readBuiltAbi probes it in a
// child process — requiring it here would cache the binary loaded BEFORE the
// rebuild, so the closing line would report the old ABI as if nothing changed.
const currentAbi = () => {
  const abi = readBuiltAbi();
  if (!abi) return 'not loadable';
  return abi === process.versions.modules
    ? `loads under this Node (ABI ${abi})`
    : `built for ABI ${abi}, this Node is ABI ${process.versions.modules}`;
};

log(`current better-sqlite3: ${currentAbi()}`);

const electronVersion = readElectronVersion();
if (runtime === 'electron' && !electronVersion) {
  warn('electron is not installed — nothing to rebuild against');
  process.exit(0);
}

// The addon is already what the caller asked for — skip the ~1min node-gyp run.
// `sh scripts/dev.sh` calls this on every app start, so this is the hot path.
if (!force && isAbiCurrent({ runtime, target: electronVersion })) {
  log(`already built for ${runtime} — nothing to do (use --force to rebuild anyway)`);
  process.exit(0);
}

log(`rebuilding better-sqlite3 for ${runtime}${runtime === 'electron' ? ` ${electronVersion}` : ''}…`);
const ok = rebuildBetterSqlite3({ runtime, target: electronVersion, log, warn });
if (!ok) process.exit(1);

log(`done — ${currentAbi()}`);
if (runtime === 'node') log('remember: run `sh scripts/dev.sh` (or this script with `electron`) before starting the app again');
