#!/usr/bin/env node

/*
 * Switch better-sqlite3 between the Node and Electron ABIs.
 *
 * The compiled addon is valid for one ABI at a time (see scripts/lib/native-abi.mjs).
 * You should not need to run this yourself: it is the first step of every
 * `test` script in a package that opens a database (→ node) and of `dev` /
 * `electron:dev` / `sh scripts/dev.sh` (→ electron), so `pnpm test` and
 * `pnpm dev:desktop` can be alternated in any order.
 *
 * Running it BY HAND for `node` and then starting the app is the failure this
 * automation exists to prevent: the app cannot open any database, and because
 * core-DB reads answer an unreadable database with an empty result, it boots
 * looking like a fresh install rather than like an error.
 *
 * Prints the ABI the binary currently reports first, so a mismatch is visible
 * before you spend a minute compiling.
 *
 * Skips the compile when the addon already reports the target ABI; pass
 * --force to rebuild regardless. A rebuild already running elsewhere (parallel
 * `pnpm test` tasks) is waited for rather than treated as a failure.
 *
 * The runtime has no default, and a command line the script cannot read (an
 * unknown flag, no runtime, two of them) is refused with the usage text before
 * the addon is so much as probed. It used to default to node and skip flags it
 * did not know, so `--help` REBUILT the addon for Node; see
 * scripts/lib/native-abi-args.mjs.
 *
 * Run: node scripts/native-abi.mjs <node|electron> [--force]
 *      node scripts/native-abi.mjs --help
 */

import { parseNativeAbiArgs, USAGE } from './lib/native-abi-args.mjs';
import {
  isAbiCurrent,
  readBuiltAbi,
  readElectronVersion,
  rebuildBetterSqlite3,
} from './lib/native-abi.mjs';

/**
 * How long to wait for a rebuild already in progress before giving up.
 *
 * A cold node-gyp compile of sqlite3 is around a minute; this is generous
 * enough for a slow machine and short enough that a genuinely wedged build
 * still reports itself rather than hanging the command forever.
 */
const LOCK_WAIT_MS = 10 * 60_000;

const log = (msg) => console.log(`[native-abi] ${msg}`);
const warn = (msg) => console.warn(`[native-abi] ${msg}`);

// Before anything else, even the probe below: a command line this script
// cannot read is one it must not act on.
const cli = parseNativeAbiArgs(process.argv.slice(2));
if (cli.kind === 'help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (cli.kind === 'error') {
  console.error(`[native-abi] ${cli.message}\n\n${USAGE}`);
  process.exit(1);
}
const { runtime, force } = cli;

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
const ok = rebuildBetterSqlite3({ runtime, target: electronVersion, log, warn, force, waitMs: LOCK_WAIT_MS });
if (!ok) process.exit(1);

log(`done — ${currentAbi()}`);
