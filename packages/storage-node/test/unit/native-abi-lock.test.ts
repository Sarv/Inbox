/*
 * Guards scripts/lib/native-abi.mjs — the rebuild that keeps better-sqlite3's
 * compiled addon on the right ABI. It lives with storage-node because that is
 * the package whose every SQLite test dies (ERR_DLOPEN_FAILED) when the flip
 * goes wrong.
 *
 * The build lock is the part worth testing: get it wrong in one direction and
 * two node-gyp runs delete each other's build tree (the ENOENT on
 * `.deps/…/sqlite3.o.d.raw` this fix chases); get it wrong in the other and a
 * lock left behind by an interrupted run blocks every rebuild forever.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  acquireBuildLock,
  isRunning,
  readBuiltAbi,
  releaseBuildLock,
} from '../../../../scripts/lib/native-abi.mjs';

let workDir;
let lockDir;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'native-abi-'));
  lockDir = join(workDir, 'lock');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: a child we ran to completion. */
const deadPid = () => {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return child.pid;
};

const seedLock = (pid) => {
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'pid'), String(pid));
};

describe('isRunning', () => {
  // Breaks: our own pid read as dead makes the lock self-defeating — a rebuild
  // would keep taking over the lock it just took.
  it('reports a live process as running', () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  // Breaks: a pid left by an interrupted rebuild is treated as live and every
  // later rebuild refuses to run — the "stops failing" fix would itself wedge.
  it('reports an exited process as not running', () => {
    expect(isRunning(deadPid())).toBe(false);
  });

  // Breaks: `Number('')` is 0 and `Number('garbage')` is NaN. On some platforms
  // signalling pid 0 hits the whole process group, so it must never be probed.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN from a garbage pid file', Number.NaN],
    ['a fractional pid', 1.5],
    ['null from an unreadable pid file', null],
  ])('rejects %s without signalling anything', (_case, pid) => {
    expect(isRunning(pid)).toBe(false);
  });
});

describe('acquireBuildLock', () => {
  // Breaks: the lock never forms, both rebuilds proceed, and node-gyp's
  // `rm -rf build` in one deletes the directories the other is compiling into.
  it('takes a free lock and records the owning pid', () => {
    expect(acquireBuildLock({ lockDir })).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  // Breaks: THE concurrency bug. A second rebuild starting on top of a live one
  // is exactly what produces the ENOENT on a path node-gyp had just created.
  it('refuses the lock while its owner is alive, and says who holds it', () => {
    const warnings = [];
    seedLock(process.pid);

    expect(acquireBuildLock({ lockDir, warn: (msg) => warnings.push(msg) })).toBe(false);
    expect(warnings.join('\n')).toContain(String(process.pid));
    // The live owner's record must survive — stealing it would defeat the lock.
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  // Breaks: an interrupted flip (Ctrl-C, a killed shell) leaves the lock behind
  // and no rebuild can ever run again until someone deletes it by hand.
  it('takes over a lock whose owner has died', () => {
    seedLock(deadPid());

    expect(acquireBuildLock({ lockDir })).toBe(true);
    expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  // Breaks: a run killed between the mkdir and the pid write leaves an ownerless
  // lock; reading it must not throw, and must not block the next rebuild.
  it.each([
    ['an empty pid file', ''],
    ['a garbage pid file', 'not-a-pid'],
  ])('takes over a lock with %s', (_case, contents) => {
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), contents);

    expect(acquireBuildLock({ lockDir })).toBe(true);
  });

  // Breaks: same half-written lock, with no pid file at all.
  it('takes over a lock directory that has no pid file', () => {
    mkdirSync(lockDir);

    expect(acquireBuildLock({ lockDir })).toBe(true);
  });

  // Breaks: the lock outlives the rebuild that held it, so the next flip — the
  // `pnpm test:node-abi` → `electron` round trip — is refused.
  it('releases the lock so the next rebuild can take it', () => {
    acquireBuildLock({ lockDir });
    releaseBuildLock({ lockDir });

    expect(existsSync(lockDir)).toBe(false);
    expect(acquireBuildLock({ lockDir })).toBe(true);
  });

  // Breaks: releasing a lock nobody holds (a failed acquire, a double release)
  // throws and takes the rebuild down with it.
  it('tolerates releasing a lock that is not there', () => {
    expect(() => releaseBuildLock({ lockDir })).not.toThrow();
  });
});

describe('readBuiltAbi', () => {
  // Breaks: a missing addon reported as an ABI, so the rebuild "verifies" a
  // binary that does not exist.
  it('returns null when the addon is missing', () => {
    expect(readBuiltAbi({ addon: join(workDir, 'absent.node') })).toBeNull();
  });

  // Breaks: an unloadable binary (a truncated or half-written build) passing
  // verification and being shipped to the app.
  it('returns null when the addon cannot be loaded', () => {
    const broken = join(workDir, 'broken.node');
    writeFileSync(broken, 'this is not a native module');

    expect(readBuiltAbi({ addon: broken })).toBeNull();
  });

  // Breaks: the probe running in-process. Node caches a module by resolved
  // filename, so an in-process check after a rebuild reports the ABI of the
  // binary loaded BEFORE it — the script's "done — …" line lying about what it
  // just built. Loading in a child is what makes the answer current.
  it('reads the ABI in a child process, not this one', () => {
    // A .js path, not .node: the probe just require()s what it is given, and a
    // real dlopen needs a real binary. What is under test is WHERE it loads.
    const loadable = join(workDir, 'fake.js');
    writeFileSync(loadable, 'module.exports = {};');

    expect(readBuiltAbi({ addon: loadable })).toBe(process.versions.modules);
  });

  // Breaks: a hostile/broken addon that crashes the probe takes the rebuild
  // down instead of being reported as "not loadable".
  it('survives an addon that kills the probe', () => {
    const exploding = join(workDir, 'boom.js');
    writeFileSync(exploding, 'process.exit(3);');

    expect(readBuiltAbi({ addon: exploding })).toBeNull();
  });
});

describe('the CLI entry point', () => {
  // Breaks: a typo'd runtime silently rebuilding for the wrong ABI — the flip
  // appears to succeed and the app or the tests then fail to load the DB.
  it('rejects an unknown runtime instead of guessing one', () => {
    const script = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'native-abi.mjs');
    const run = spawnSync(process.execPath, [script, 'deno'], { encoding: 'utf8' });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unknown runtime');
    // Nothing may be compiled on the way out.
    expect(run.stdout).not.toContain('rebuilding');
  });
});
