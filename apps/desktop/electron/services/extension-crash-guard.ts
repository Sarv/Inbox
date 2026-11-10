/**
 * Keeps a crash loop from locking someone out of their own mail.
 *
 * Extensions start before the window opens, so anything in one that takes the main
 * process down does it on every launch, before the reader can reach the switch that would
 * turn it off. The limits in the sandbox are there to stop that. This is the backstop for
 * whatever still gets through: if the app died while starting extensions, or within a
 * minute of it, on consecutive launches, the next launch starts without extension code,
 * says so, and offers to turn them back on.
 *
 * It holds code back and touches nothing else. Approvals, settings and stored data are not
 * this file's to change, and every extension stays enabled.
 *
 * The danger in something like this is a false alarm that turns extensions off for a
 * healthy user, so:
 *   - a clean end of any kind clears the mark first: a quit, an update's restart, a
 *     relaunch, an OS shutdown (see `watchForCleanExit`);
 *   - one bad launch is not enough. It takes two in a row, each dying inside the first
 *     minute, which a stray `kill -9` or power cut does not usually do;
 *   - a new app version starts over, since the fault may be fixed;
 *   - a mark that cannot be read counts as no mark, and one that cannot be written means no
 *     protection, never that extensions are held back;
 *   - only a release build uses it: a dev run restarts by signal all day.
 *
 * Plain Node apart from what is passed in, so the false alarms can be tested one by one.
 */
import { mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

import { createLogger, writePrivateFileAtomicSync } from '@sarvinbox/core';

const logger = createLogger('extension-crash-guard');

/** Unclean ends in a row, each within `STABLE_AFTER_MS`, before extensions are held back. */
export const CONSECUTIVE_CRASHES_TO_HOLD = 2;

/** How long after starting extensions the app has to stay up to be considered fine. */
export const STABLE_AFTER_MS = 60_000;

/** What is kept on disk between launches. */
interface GuardState {
  /** Extensions were started, and nothing has said the app has got past that safely. */
  starting: boolean;
  /** Launches in a row that ended with `starting` still set. */
  crashes: number;
  /** Held back until the reader says otherwise, or the app is updated. */
  held: boolean;
  appVersion: string;
}

export interface ExtensionCrashGuardOptions {
  /** Where the mark is kept. Beside the extension data, in the user-data folder. */
  file: string;
  appVersion: string;
}

export interface ExtensionCrashGuard {
  /** Whether to hold back extension code this launch. Marks the launch as starting if not. */
  decide(idsWithCode: readonly string[]): boolean;
  /** The app has been up long enough, or is ending cleanly. Clears the mark. */
  markSafe(): void;
  /** The reader turned extensions back on: run them, and watch again as on any launch. */
  release(): void;
  /** Whether this launch is holding extension code back. */
  isHolding(): boolean;
}

/** Absent or unreadable alike: nothing here may ever hold extensions back on a bad read. */
function readState(file: string): GuardState | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<GuardState>;
    if (
      typeof parsed.starting !== 'boolean' ||
      typeof parsed.crashes !== 'number' ||
      !Number.isFinite(parsed.crashes) ||
      typeof parsed.held !== 'boolean' ||
      typeof parsed.appVersion !== 'string'
    ) {
      logger.warn('Ignoring a crash guard mark in an unknown shape');
      return null;
    }
    return parsed as GuardState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('Ignoring a crash guard mark that could not be read:', error);
    }
    return null;
  }
}

/** Written whole or not at all, because the crash this exists for can come at any moment. */
function writeState(file: string, state: GuardState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writePrivateFileAtomicSync(file, JSON.stringify(state));
  } catch (error) {
    // No mark means no protection this launch, which is the safe way round to fail.
    logger.warn('Could not write the crash guard mark:', error);
  }
}

export function createExtensionCrashGuard(options: ExtensionCrashGuardOptions): ExtensionCrashGuard {
  const { file, appVersion } = options;
  let holding = false;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  };

  const markSafe = (): void => {
    clearTimer();
    // Only a launch that was starting has anything to clear. One that is holding wrote
    // `starting: false`, so a hold stays until the reader decides.
    const state = readState(file);
    if (state?.starting) writeState(file, { ...state, starting: false, crashes: 0 });
  };

  const armStableTimer = (): void => {
    clearTimer();
    stableTimer = setTimeout(markSafe, STABLE_AFTER_MS);
    // Never what keeps the app from quitting.
    stableTimer.unref?.();
  };

  return {
    decide(idsWithCode) {
      const previous = readState(file);

      // Nothing to start, so nothing that could be the cause, and nothing to hold back.
      if (idsWithCode.length === 0) {
        if (previous) writeState(file, { starting: false, crashes: 0, held: false, appVersion });
        return false;
      }

      // An update starts over: it may be the fix, and the reader should not need to go
      // and undo a hold that was about the previous version.
      const sameVersion = previous?.appVersion === appVersion;
      const crashes = sameVersion ? previous.crashes + (previous.starting ? 1 : 0) : 0;
      holding = (sameVersion && previous.held) || crashes >= CONSECUTIVE_CRASHES_TO_HOLD;

      if (holding) {
        logger.warn(`Holding back extension code after ${crashes} unclean launches in a row`);
        writeState(file, { starting: false, crashes, held: true, appVersion });
        return true;
      }

      writeState(file, { starting: true, crashes, held: false, appVersion });
      armStableTimer();
      return false;
    },
    markSafe,
    release() {
      holding = false;
      writeState(file, { starting: true, crashes: 0, held: false, appVersion });
      armStableTimer();
    },
    isHolding: () => holding,
  };
}

/** What `watchForCleanExit` listens to, so each way of ending can be tested. */
export interface CleanExitSources {
  app: { on(event: string, listener: (...args: never[]) => void): unknown };
  powerMonitor: { on(event: string, listener: () => void): unknown };
  process: { on(event: 'exit', listener: (code: number) => void): unknown };
}

/**
 * Every way the app ends on purpose, each of which must clear the mark. Miss one and a
 * healthy user who does it twice in a minute loses their extensions.
 *
 *   before-quit            every quit, including a signal, which main routes to app.quit
 *   before-quit-for-update the macOS updater; the Windows and Linux ones go by before-quit
 *   session-end            Windows logging off or shutting down
 *   shutdown               macOS and Linux shutting down
 *   exit, code 0           `app.exit` and `process.exit`, as a relaunch ends. Not a nonzero
 *                          code, and a native crash never gets here at all
 */
export function watchForCleanExit(guard: ExtensionCrashGuard, sources: CleanExitSources): void {
  const safe = (): void => guard.markSafe();
  sources.app.on('before-quit', safe);
  sources.app.on('before-quit-for-update', safe);
  sources.app.on('session-end', safe);
  sources.powerMonitor.on('shutdown', safe);
  sources.process.on('exit', (code) => {
    if (code === 0) safe();
  });
}

/** What the reader is told, naming what was held back. Short enough for a card. */
export function heldBackNotice(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((name) => (name.length > 24 ? `${name.slice(0, 24)}…` : name));
  const rest = names.length > shown.length ? ` and ${names.length - shown.length} more` : '';
  return (
    `Sarv Inbox closed unexpectedly while starting extensions, so these did not start: ` +
    `${shown.join(', ')}${rest}. Turn them back on in Settings, Extensions.`
  );
}

let current: ExtensionCrashGuard | null = null;

/** The guard of this launch, for the handler behind the "turn back on" button. */
export function setExtensionCrashGuard(guard: ExtensionCrashGuard | null): void {
  current = guard;
}

export function getExtensionCrashGuard(): ExtensionCrashGuard | null {
  return current;
}
