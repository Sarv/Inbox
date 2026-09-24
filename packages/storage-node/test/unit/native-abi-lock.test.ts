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
let lockPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'native-abi-'));
  lockPath = join(workDir, 'lock');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A pid that is guaranteed dead: a child we ran to completion. */
const deadPid = () => {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return child.pid;
};

/** A lock already held by `pid`, as acquireBuildLock would have written it. */
const seedLock = (pid) => writeFileSync(lockPath, String(pid));

/** Longer than OWNERLESS_GRACE_MS, for the tests that must outlive it. */
const PAST_THE_GRACE_PERIOD = 60_000;

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
    expect(acquireBuildLock({ lockPath })).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  // Breaks: THE concurrency bug. A second rebuild starting on top of a live one
  // is exactly what produces the ENOENT on a path node-gyp had just created.
  it('refuses the lock while its owner is alive, and says who holds it', () => {
    const warnings = [];
    seedLock(process.pid);

    expect(acquireBuildLock({ lockPath, warn: (msg) => warnings.push(msg) })).toBe(false);
    expect(warnings.join('\n')).toContain(String(process.pid));
    // The live owner's record must survive — stealing it would defeat the lock.
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  // Breaks: `pnpm test`, roughly one run in three, and this is the regression
  // the file-plus-grace-period lock was written for.
  //
  // The lock used to be a DIRECTORY with a `pid` file written into it as a
  // second step. Turbo starts the storage-node and desktop suites at the same
  // instant; both ask for the Node ABI; A created the directory, and B — losing
  // the mkdir by microseconds — read the pid file A had not written yet, saw no
  // owner, concluded the lock was abandoned, deleted it and took it. Two
  // node-gyp runs then shredded each other's build tree, and the symptom was a
  // rebuild that failed BOTH attempts yet succeeded when re-run by hand.
  //
  // A lock that exists but names no owner must therefore be left alone while it
  // could still be someone mid-claim.
  it('leaves an ownerless lock alone while it could still be mid-claim', () => {
    // Exactly the state A is in between creating the lock and writing its pid.
    writeFileSync(lockPath, '');

    expect(acquireBuildLock({ lockPath })).toBe(false);
    // Not stolen, not emptied — A's claim survives to be completed.
    expect(existsSync(lockPath)).toBe(true);
  });

  // Breaks: `pnpm test`. Turbo runs the package suites in PARALLEL and each one
  // now ensures the Node ABI first, so several ask for the lock at the same
  // moment. Refusing the losers made the ordinary command fail outright.
  it('waits for a live owner and takes the lock when it is released', () => {
    seedLock(process.pid);
    const logs: string[] = [];
    let clock = 0;
    let sleeps = 0;
    // Stand in for the other rebuild finishing: it releases on its third poll.
    const sleep = (ms: number) => {
      clock += ms;
      sleeps += 1;
      if (sleeps === 3) rmSync(lockPath, { recursive: true, force: true });
    };

    const took = acquireBuildLock({
      lockPath, waitMs: 60_000, sleep, now: () => clock, log: (msg: string) => logs.push(msg),
    });

    expect(took).toBe(true);
    expect(sleeps).toBe(3);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    // Said so once, not once per poll — a 60s wait must not print 240 lines.
    expect(logs.filter((msg) => msg.includes('waiting'))).toHaveLength(1);
  });

  // Breaks: the grace period turning a crash between the two syscalls into a
  // permanent block. An ownerless lock is waited on, not stolen — but only
  // until it is old enough that nobody can still be mid-claim.
  it('waits out an ownerless lock and then takes it', () => {
    writeFileSync(lockPath, '');
    let clock = 0;

    const took = acquireBuildLock({
      lockPath,
      waitMs: PAST_THE_GRACE_PERIOD,
      sleep: (ms: number) => { clock += ms; },
      now: () => clock,
    });

    expect(took).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  // Breaks: a genuinely wedged rebuild hangs the command forever instead of
  // reporting who is holding it.
  it('gives up once the wait budget is spent, naming the holder', () => {
    seedLock(process.pid);
    const warnings: string[] = [];
    let clock = 0;

    const took = acquireBuildLock({
      lockPath,
      waitMs: 1_000,
      sleep: (ms: number) => { clock += ms; },
      now: () => clock,
      warn: (msg: string) => warnings.push(msg),
    });

    expect(took).toBe(false);
    expect(warnings.join('\n')).toContain(String(process.pid));
    // The live owner's lock must survive being waited on and given up on.
    expect(existsSync(lockPath)).toBe(true);
  });

  // Breaks: postinstall (waitMs defaults to 0) blocking a `pnpm install` behind
  // someone else's compile instead of skipping its best-effort rebuild.
  it('does not wait at all by default', () => {
    seedLock(process.pid);
    let sleeps = 0;

    expect(acquireBuildLock({ lockPath, sleep: () => { sleeps += 1; } })).toBe(false);
    expect(sleeps).toBe(0);
  });

  // Breaks: an interrupted flip (Ctrl-C, a killed shell) leaves the lock behind
  // and no rebuild can ever run again until someone deletes it by hand. A named
  // owner that is gone is unambiguous, so this needs no grace period.
  it('takes over a lock whose owner has died', () => {
    seedLock(deadPid());

    expect(acquireBuildLock({ lockPath })).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  // Breaks: a lock whose contents are not a pid at all (a truncated write, a
  // stray file) blocking every rebuild forever. It is ownerless, so it is
  // cleared on the same terms as an empty one -- once it is too old to be a
  // claim in progress.
  it.each([
    ['a garbage pid file', 'not-a-pid'],
    ['a zero pid, which must never be signalled', '0'],
  ])('takes over %s once it is past the grace period', (_case, contents) => {
    writeFileSync(lockPath, contents);
    let clock = 0;

    const took = acquireBuildLock({
      lockPath,
      waitMs: PAST_THE_GRACE_PERIOD,
      sleep: (ms: number) => { clock += ms; },
      now: () => clock,
    });

    expect(took).toBe(true);
  });

  // Breaks: a checkout that ran the older code left the lock as a DIRECTORY, so
  // the first rebuild after the update cannot create the file and — if it could
  // not remove a directory — would never run again.
  it('clears a lock left behind as a directory by an older checkout', () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'pid'), String(deadPid()));
    let clock = 0;

    const took = acquireBuildLock({
      lockPath,
      waitMs: PAST_THE_GRACE_PERIOD,
      sleep: (ms: number) => { clock += ms; },
      now: () => clock,
    });

    expect(took).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  // Breaks: the lock outlives the rebuild that held it, so the next flip — the
  // `pnpm test:node-abi` → `electron` round trip — is refused.
  it('releases the lock so the next rebuild can take it', () => {
    acquireBuildLock({ lockPath });
    releaseBuildLock({ lockPath });

    expect(existsSync(lockPath)).toBe(false);
    expect(acquireBuildLock({ lockPath })).toBe(true);
  });

  // Breaks: releasing a lock nobody holds (a failed acquire, a double release)
  // throws and takes the rebuild down with it.
  it('tolerates releasing a lock that is not there', () => {
    expect(() => releaseBuildLock({ lockPath })).not.toThrow();
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
