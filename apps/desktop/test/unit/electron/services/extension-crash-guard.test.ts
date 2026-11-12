import { EventEmitter } from 'events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONSECUTIVE_CRASHES_TO_HOLD,
  createExtensionCrashGuard,
  heldBackNotice,
  STABLE_AFTER_MS,
  watchForCleanExit,
  type ExtensionCrashGuard,
} from '../../../../electron/services/extension-crash-guard';

/**
 * The backstop for a crash loop. Extensions start before the window, so anything that takes
 * the app down there does it on every launch, and the reader cannot reach the switch. But a
 * false alarm is worse than it looks: it turns extensions off for a healthy user. So most of
 * what is pinned here is what must NOT count.
 */

let dir: string;
let file: string;

/** One launch of the app. Each call reads the mark from disk, as a new process would. */
const launch = (appVersion = '1.0.0'): ExtensionCrashGuard => createExtensionCrashGuard({ file, appVersion });
const IDS = ['otp-code', 'vip-scoring'];

/** A launch that dies with the mark set: nothing gets to run, as in a real crash. */
const crashedLaunch = (appVersion?: string): boolean => launch(appVersion).decide(IDS);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  dir = mkdtempSync(join(tmpdir(), 'sarv-guard-'));
  file = join(dir, 'nested', 'extension-crash-guard.json');
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('what it takes to hold extensions back', () => {
  // The whole point: dying while starting extensions, launch after launch, must end with
  // a launch the reader can actually use.
  it('holds back after two crashes in a row', () => {
    expect(CONSECUTIVE_CRASHES_TO_HOLD).toBe(2);
    expect(crashedLaunch()).toBe(false);
    expect(crashedLaunch()).toBe(false);
    expect(crashedLaunch()).toBe(true);
  });

  // Once held, it stays held until the reader says so. Otherwise a launch that happens not
  // to crash would put them back in the loop, with no sign of what is going on.
  it('stays held across launches until the reader turns them back on', () => {
    crashedLaunch();
    crashedLaunch();
    const held = launch();
    expect(held.decide(IDS)).toBe(true);
    expect(held.isHolding()).toBe(true);
    held.markSafe();

    expect(launch().decide(IDS)).toBe(true);
  });

  // The way back, and it watches again: if they still bring the app down, they are held again.
  it('runs them again once released, and watches again', () => {
    crashedLaunch();
    crashedLaunch();
    const held = launch();
    held.decide(IDS);

    held.release();
    expect(held.isHolding()).toBe(false);

    expect(crashedLaunch()).toBe(false); // the released launch crashed: one
    expect(crashedLaunch()).toBe(true); // this one crashed too: two, so the next holds
  });
});

describe('what must not count', () => {
  const survive = (guard: ExtensionCrashGuard) => guard.markSafe();

  // A normal quit, however quickly after launching.
  it('a clean end clears it: quitting many times in the first minute holds nothing', () => {
    for (let i = 0; i < 10; i += 1) {
      const guard = launch();
      expect(guard.decide(IDS)).toBe(false);
      survive(guard);
    }
  });

  // One crash and then a clean run is not a loop, and must not be carried forward.
  it('a clean run between crashes starts the count over', () => {
    crashedLaunch();
    survive((() => { const g = launch(); g.decide(IDS); return g; })());
    expect(crashedLaunch()).toBe(false);
    expect(crashedLaunch()).toBe(false);
    expect(crashedLaunch()).toBe(true);
  });

  // Up for a minute means extensions got through starting. A crash later is not this.
  it('staying up past the stable point clears it', () => {
    const first = launch();
    first.decide(IDS);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ starting: false, crashes: 0 });

    // This process now dies unexpectedly, much later, and again in the next: not counted.
    const second = launch();
    expect(second.decide(IDS)).toBe(false);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(launch().decide(IDS)).toBe(false);
  });

  // Not a minute before.
  it('does not clear it before the stable point', () => {
    launch().decide(IDS);
    vi.advanceTimersByTime(STABLE_AFTER_MS - 1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ starting: true });
  });

  // No code to start means nothing to blame. An app crashing for some other reason must not
  // hold back an extension the reader installs afterwards.
  it('ignores launches with no extension code', () => {
    const a = launch();
    expect(a.decide([])).toBe(false);
    const b = launch();
    expect(b.decide([])).toBe(false);
    expect(crashedLaunch()).toBe(false);
    expect(crashedLaunch()).toBe(false);
    expect(crashedLaunch()).toBe(true);
  });

  // An update may well be the fix, and the reader should not have to go and undo a hold
  // that was about the previous version.
  it('starts over when the app version changes', () => {
    crashedLaunch('1.0.0');
    crashedLaunch('1.0.0');
    expect(crashedLaunch('1.0.0')).toBe(true);

    expect(crashedLaunch('1.0.1')).toBe(false);
    expect(crashedLaunch('1.0.1')).toBe(false);
    expect(crashedLaunch('1.0.1')).toBe(true);
  });

  // An unreadable store and an empty store are the same value and opposite facts (CLAUDE.md):
  // here both must mean "run them", because holding extensions back on a read that failed
  // would be exactly the false alarm this file is afraid of.
  it.each([
    ['garbage', 'not json'],
    ['the wrong shape', '{"starting":"yes"}'],
    ['a null', 'null'],
    ['a NaN count', '{"starting":true,"crashes":"x","held":true,"appVersion":"1.0.0"}'],
  ])('treats a mark holding %s as no mark', (_name, content) => {
    launch().decide(IDS);
    writeFileSync(file, content);
    expect(launch().decide(IDS)).toBe(false);
  });

  // A disk that cannot take the mark means no protection this launch, not extensions off.
  it('runs them when the mark cannot be written', () => {
    const blocked = join(dir, 'a-file');
    writeFileSync(blocked, 'x');
    const guard = createExtensionCrashGuard({ file: join(blocked, 'mark.json'), appVersion: '1.0.0' });

    expect(guard.decide(IDS)).toBe(false);
    expect(() => guard.markSafe()).not.toThrow();
    expect(() => guard.release()).not.toThrow();
  });
});

describe('what it does not touch', () => {
  // It holds code back. A launch that is holding clears nothing, and being safe does not
  // quietly release a hold the reader has not been asked about.
  it('leaves a hold in place through a clean end', () => {
    crashedLaunch();
    crashedLaunch();
    const held = launch();
    held.decide(IDS);
    held.markSafe();
    vi.advanceTimersByTime(STABLE_AFTER_MS * 2);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ held: true });
  });

  // Only its own file, with its own name: no temporary file from the atomic write is
  // left beside it.
  it('keeps nothing but the mark', () => {
    launch().decide(IDS);
    expect(readdirSync(dirname(file))).toEqual(['extension-crash-guard.json']);
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual(['appVersion', 'crashes', 'held', 'starting']);
  });
});

describe('every clean way of ending', () => {
  function sources() {
    return { app: new EventEmitter(), powerMonitor: new EventEmitter(), process: new EventEmitter() };
  }

  // Miss one of these and a healthy user who does it twice in a minute loses their extensions.
  it.each([
    ['a quit, including a signal, which main routes to app.quit', 'app', 'before-quit'],
    ['the macOS updater', 'app', 'before-quit-for-update'],
    ['Windows logging off or shutting down', 'app', 'session-end'],
    ['macOS or Linux shutting down', 'powerMonitor', 'shutdown'],
  ] as const)('%s clears the mark', (_name, source, event) => {
    const all = sources();
    const guard = launch();
    guard.decide(IDS);
    watchForCleanExit(guard, all as never);

    all[source].emit(event);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ starting: false, crashes: 0 });
  });

  // `app.exit` and `process.exit`, as a relaunch ends, including an update on Windows.
  it('an exit with code 0 clears the mark', () => {
    const all = sources();
    const guard = launch();
    guard.decide(IDS);
    watchForCleanExit(guard, all as never);

    all.process.emit('exit', 0);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ starting: false });
  });

  // Failing to start is not a clean end. A native crash never gets this far at all.
  it('an exit with an error code does not', () => {
    const all = sources();
    const guard = launch();
    guard.decide(IDS);
    watchForCleanExit(guard, all as never);

    all.process.emit('exit', 1);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ starting: true });
  });
});

describe('what the reader is told', () => {
  // They have to know which, and where to go. Body text is capped at 240 on a card.
  it('names what was held back and where to turn it on', () => {
    const notice = heldBackNotice(['Verification codes', 'VIP Scoring']);
    expect(notice).toContain('Verification codes, VIP Scoring');
    expect(notice).toContain('Settings, Extensions');
    expect(notice.length).toBeLessThanOrEqual(240);
  });

  // Extension names are their authors' text, and there can be many.
  it('stays short with many long names', () => {
    const names = Array.from({ length: 9 }, (_v, i) => `A very long extension name indeed number ${i}`);
    const notice = heldBackNotice(names);
    expect(notice).toContain('and 6 more');
    expect(notice.length).toBeLessThanOrEqual(240);
  });
});
