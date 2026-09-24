/*
 * Shared native-module rebuild for better-sqlite3.
 *
 * better-sqlite3 is a compiled addon, so its binary is valid for exactly ONE
 * ABI at a time — and this repo needs two:
 *
 *   electron  the desktop app loads the DB inside Electron (its own ABI)
 *   node      vitest runs the storage-node suite in plain Node
 *
 * Whichever was built last wins, which is why a test run right after
 * `pnpm install` (postinstall builds for Electron) fails every SQLite test with
 * ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch. Both callers live here so
 * the two paths can't drift:
 *
 *   scripts/postinstall.mjs   → electron (dev default)
 *   scripts/native-abi.mjs    → either, on demand — run for you by the `dev`
 *                               and `test` scripts of every package that opens
 *                               a database, so nobody has to flip it by hand.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const BSQ_DIR = join(NODE_MODULES, 'better-sqlite3');
const BUILD_DIR = join(BSQ_DIR, 'build');
const ADDON = join(BUILD_DIR, 'Release', 'better_sqlite3.node');
export const LOCK_DIR = join(BSQ_DIR, '.native-abi.lock');

/** How node-gyp is resolved when it is not hoisted to the root node_modules. */
const defaultResolve = (specifier) => createRequire(import.meta.url).resolve(specifier);

/**
 * node-gyp's CLI, as an argv pair ready for execFile.
 *
 * Deliberately NOT `node_modules/.bin/node-gyp`. On Windows pnpm writes three
 * shims under that name -- `node-gyp` (a POSIX sh script), `node-gyp.cmd` and
 * `node-gyp.ps1` -- and an existsSync check finds the extensionless sh one,
 * which Windows cannot start: execFile fails instantly.
 *
 * That is not hypothetical. On the v1.2.0 Windows release job both rebuild
 * attempts "failed" 1.6ms apart, where a real compile takes about a minute, and
 * since each attempt clears build/ first the runner was left with no
 * better_sqlite3.node at all -- an installer with no database addon, which does
 * not crash, it just looks like an app with no mail in it.
 *
 * Running the .js entry with THIS node binary involves no shim and behaves the
 * same on all three platforms.
 *
 * @returns {{command: string, args: string[]} | null} null when node-gyp cannot
 *   be found at all.
 */
export function nodeGypCommand({ nodeModules = NODE_MODULES, resolve = defaultResolve } = {}) {
  const hoisted = join(nodeModules, 'node-gyp', 'bin', 'node-gyp.js');
  if (existsSync(hoisted)) return { command: process.execPath, args: [hoisted] };
  try {
    // pnpm need not have hoisted node-gyp to the root; resolve it the way an
    // import would rather than giving up on the rebuild.
    return { command: process.execPath, args: [resolve('node-gyp/bin/node-gyp.js')] };
  } catch {
    return null;
  }
}

/** Electron version this repo builds against, or null when not installed. */
export function readElectronVersion() {
  const pkg = join(NODE_MODULES, 'electron', 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The ABI the compiled addon reports, read in a CHILD process.
 *
 * Never require the addon in-process to check this: Node caches a module by
 * resolved filename, so a second look after a rebuild returns the binary that
 * was loaded BEFORE it and reports the old ABI as if nothing had changed. That
 * made the script's own "done — …" line lie about what it had just built.
 *
 * Returns the numeric ABI as a string, or null when the addon is missing or
 * unloadable for some other reason.
 */
export function readBuiltAbi({ addon = ADDON } = {}) {
  if (!existsSync(addon)) return null;
  const probe = `try { require(process.argv[1]); console.log(process.versions.modules); }
    catch (err) {
      const m = /NODE_MODULE_VERSION (\\d+)/.exec(err.message || '');
      console.log(m ? m[1] : '');
    }`;
  try {
    const out = execFileSync(process.execPath, ['-e', probe, addon], { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** The ABI a successful rebuild for `runtime` must produce, or null if unknown. */
function expectedAbi({ runtime, target }) {
  if (runtime !== 'electron') return process.versions.modules;
  try {
    // node-abi maps an Electron version to its NODE_MODULE_VERSION. It is a
    // transitive dep (pinned by a pnpm override), so treat it as best-effort:
    // without it we simply skip the verification rather than fail the build.
    const { createRequire } = process.getBuiltinModule('node:module');
    return String(createRequire(import.meta.url)('node-abi').getAbi(target, 'electron'));
  } catch {
    return null;
  }
}

/**
 * Is the compiled addon ALREADY valid for this runtime?
 *
 * `sh scripts/dev.sh` used to shell out to node-gyp unconditionally, paying a
 * ~1-minute compile on every app start even when the binary was already built
 * for Electron. Answering this first makes the common case a no-op.
 *
 * Conservative by design: an addon that will not load, or an Electron version
 * whose ABI cannot be resolved (node-abi absent), both report false, so the
 * caller rebuilds rather than trusting a binary it could not verify.
 */
export function isAbiCurrent({ runtime, target, arch = process.arch }) {
  // An addon compiled for another CPU cannot be dlopen'd by this process, so
  // there is nothing to probe — a cross-arch request always means "rebuild".
  if (arch !== process.arch) return false;
  const wanted = expectedAbi({ runtime, target });
  if (!wanted) return false;
  return readBuiltAbi() === wanted;
}

/** How long to sleep between polls while waiting for another rebuild. */
const LOCK_POLL_MS = 250;

/** Give up on a takeover war rather than spinning forever. */
const MAX_STALE_TAKEOVERS = 2;

/** Block this (synchronous) script for `ms` without burning a core. */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the build directory, optionally WAITING for whoever currently holds it.
 *
 * Two node-gyp runs in one directory destroy each other. `node-gyp rebuild`
 * begins by deleting `build/`, so the second run removes directories the first
 * has just created and both die on ENOENT for a path that should exist —
 * `build/Release/.deps/…/sqlite3.o.d.raw` or `build/node_gyp_bins`. Those two
 * errors look like a broken toolchain but mean "something else is building".
 *
 * mkdir is atomic, so it doubles as the lock. A lock whose owner is gone is
 * stale (an interrupted run, a killed shell) and gets taken over — otherwise it
 * would block every rebuild forever.
 *
 * `waitMs > 0` makes a live owner something to wait for rather than a failure.
 * That is the normal case now that the flip is automatic: `pnpm test` runs the
 * package suites in PARALLEL under turbo, so several of them ask for the Node
 * ABI at the same moment and exactly one can build. Refusing the others turned
 * a working command into a hard failure whose message ("kill it and re-run")
 * was advice for a situation that wasn't happening. The waiters re-probe once
 * they get in, so the winner's compile serves all of them.
 */
export function acquireBuildLock({
  warn = () => {},
  log = () => {},
  lockDir = LOCK_DIR,
  waitMs = 0,
  sleep = sleepSync,
  now = Date.now,
} = {}) {
  const deadline = now() + waitMs;
  let staleTakeovers = 0;
  let announced = false;

  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = readOwnerPid(lockDir);

      if (!isRunning(owner)) {
        // The owner died mid-build; its half-written tree is exactly what breaks
        // the next run, so clear the lock and let the clean rebuild below fix it.
        if (staleTakeovers >= MAX_STALE_TAKEOVERS) {
          warn(`could not take the better-sqlite3 build lock at ${lockDir} — it keeps being re-taken.`);
          return false;
        }
        staleTakeovers += 1;
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        warn(
          `another better-sqlite3 rebuild is already running (pid ${owner}) — refusing to build `
          + 'on top of it. Wait for it to finish, or kill it and re-run.',
        );
        return false;
      }
      if (!announced) {
        log(`another better-sqlite3 rebuild is running (pid ${owner}) — waiting for it…`);
        announced = true;
      }
      sleep(Math.min(LOCK_POLL_MS, remaining));
    }
  }
}

export function releaseBuildLock({ lockDir = LOCK_DIR } = {}) {
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * The pid recorded in a lock directory, or null when it can't be read.
 *
 * A lock whose pid file is missing, empty or garbage was written by a run that
 * died between the mkdir and the write. Treating that as "no owner" is what
 * lets the next rebuild take it over instead of being blocked forever.
 */
function readOwnerPid(lockDir) {
  try {
    const pid = Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim());
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still running.
    return err.code === 'EPERM';
  }
}

/** The manual command to run when the automated rebuild can't. */
export function manualRebuildCommand({ runtime, target, arch = process.arch }) {
  const electronFlags = runtime === 'electron'
    ? ` --runtime=electron --target=${target} --dist-url=https://electronjs.org/headers`
    : '';
  // --arch names the arch that was BEING built, not the host: a cross-compile
  // that failed is only reproducible with the same --arch.
  return `(cd node_modules/better-sqlite3 && node-gyp rebuild --release${electronFlags} --arch=${arch})`;
}

/**
 * Rebuild better-sqlite3 for the given runtime.
 *
 * `runtime: 'electron'` compiles against Electron's headers; `'node'` against
 * the running Node. Returns true on success, false when it could not run (the
 * caller decides whether that's fatal — postinstall must not block an install).
 *
 * We deliberately call node-gyp DIRECTLY rather than electron-rebuild: under
 * pnpm's nested node_modules, electron-rebuild's dependency walk silently
 * no-ops (it prints "Rebuild Complete" while producing nothing, leaving a
 * host-ABI binary that crashes the app).
 */
export function rebuildBetterSqlite3({
  runtime,
  target,
  arch = process.arch,
  log = () => {},
  warn = () => {},
  waitMs = 0,
  force = false,
}) {
  if (!existsSync(BSQ_DIR)) {
    warn('better-sqlite3 not found — skipping rebuild');
    return false;
  }
  const manual = manualRebuildCommand({ runtime, target, arch });
  const nodeGyp = nodeGypCommand();
  if (nodeGyp == null) {
    warn(`node-gyp not found — cannot rebuild better-sqlite3. Run manually:\n  ${manual}`);
    return false;
  }
  if (!acquireBuildLock({ warn, log, waitMs })) return false;

  try {
    // Re-probe now that we hold the lock. When we waited for someone else, they
    // were very likely building the same ABI we want (parallel `pnpm test`
    // tasks all ask for Node's), and compiling it a second time would cost
    // another minute to produce a byte-identical binary.
    if (!force && isAbiCurrent({ runtime, target, arch })) {
      log(`better-sqlite3 is already built for ${runtime} — nothing to do`);
      return true;
    }
    return rebuildUnderLock({ runtime, target, arch, nodeGyp, manual, log, warn });
  } finally {
    releaseBuildLock();
  }
}

function rebuildUnderLock({ runtime, target, arch, nodeGyp, manual, log, warn }) {
  // A binary for another CPU cannot be loaded here, so the ABI probe below is
  // unavailable and existence is all we can assert. The release workflow reads
  // the machine type straight out of the file instead — see
  // scripts/verify-win-arch.mjs, which is the check that caught this whole bug.
  const crossCompiling = arch !== process.arch;
  const wanted = crossCompiling ? null : expectedAbi({ runtime, target });
  const verify = (how) => {
    if (crossCompiling) {
      if (existsSync(ADDON)) return true;
      warn(`${how} produced no better-sqlite3 binary for ${arch}.`);
      return false;
    }
    const built = readBuiltAbi();
    if (!built) {
      warn(`${how} produced no loadable better-sqlite3 binary.`);
      return false;
    }
    if (wanted && built !== wanted) {
      // The classic cause is a stale build/config.gypi from the other runtime,
      // which node-gyp can reuse — the rebuild "succeeds" and the addon still
      // has the wrong ABI. Reporting success here is what put a Node-ABI binary
      // under the desktop app (and vice versa) with no visible error.
      warn(`${how} produced ABI ${built}, expected ${wanted} for ${runtime}.`);
      return false;
    }
    return true;
  };

  // Electron only: a matching prebuilt binary skips the ~1min compile. Recent
  // Electron majors usually don't ship one, so this normally falls through.
  const prebuildCli = join(NODE_MODULES, 'prebuild-install', 'bin.js');
  if (runtime === 'electron' && existsSync(prebuildCli)) {
    log(`Fetching better-sqlite3 prebuild for Electron ${target} (${process.platform}-${arch})`);
    try {
      execFileSync(process.execPath, [prebuildCli, '--runtime=electron', `--target=${target}`, `--arch=${arch}`], {
        cwd: BSQ_DIR,
        stdio: 'inherit',
      });
      if (verify('The prebuilt Electron binary')) {
        log('better-sqlite3: prebuilt Electron binary installed');
        return true;
      }
    } catch {
      warn('No prebuilt Electron binary — compiling from source with node-gyp');
    }
  }

  const args = ['rebuild', '--release', `--arch=${arch}`];
  if (runtime === 'electron') {
    args.push('--runtime=electron', `--target=${target}`, '--dist-url=https://electronjs.org/headers');
  }

  // Two attempts. Both start from an empty build/ — node-gyp's own clean step
  // leaves config.gypi behind and can reuse the other runtime's settings, and a
  // tree left half-written by an interrupted run makes make fail on directories
  // it should have created. scripts/dev.sh has always done this `rm -rf build`;
  // doing it here too is what stops the two paths drifting apart.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    rmSync(BUILD_DIR, { recursive: true, force: true });
    try {
      execFileSync(nodeGyp.command, [...nodeGyp.args, ...args], { cwd: BSQ_DIR, stdio: 'inherit' });
      if (verify('The rebuild')) {
        log(`better-sqlite3 compiled from source for ${runtime === 'electron' ? 'Electron' : 'Node'} (${arch})`);
        return true;
      }
    } catch (error) {
      // Naming the reason matters: a spawn that never started (the Windows .bin
      // shim) and a compile that failed look identical without it.
      warn(`better-sqlite3 rebuild attempt ${attempt} failed: ${error.message}`);
    }
    if (attempt === 1) log('retrying once from a clean build directory…');
  }

  warn(
    `Could not rebuild better-sqlite3 for ${runtime}. `
    + `${runtime === 'electron' ? 'The desktop app will fail to load the DB' : 'SQLite tests will fail'} until you run:\n  ${manual}`,
  );
  return false;
}
