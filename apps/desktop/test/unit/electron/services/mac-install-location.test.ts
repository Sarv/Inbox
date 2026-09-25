import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

/**
 * The macOS "move me to /Applications" offer.
 *
 * What breaks if this file fails: a user who copied the app to ~/Downloads (or
 * ran it straight off the DMG) is never asked to move it, so macOS keeps running
 * it from a read-only translocated mount and every update check dies with
 * "Cannot update while running on a read-only volume". That copy is then frozen
 * on its version for good — exactly what a 1.2.1 user hit. The other half is
 * just as important: a wrong "yes" here puts a modal in front of an app that has
 * not started yet, on Linux, on Windows, and on every dev run.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    isInApplicationsFolder: vi.fn(() => false),
    moveToApplicationsFolder: vi.fn(() => true),
    getVersion: vi.fn(() => '1.2.3'),
    getPath: vi.fn(() => '/tmp/userData'),
  },
  dialog: { showMessageBox: vi.fn() },
}));

import {
  INSTALL_LOCATION_FILE_NAME,
  installLocationFilePath,
  moveInvitation,
  offerMoveToApplications,
  parseDismissedVersion,
  readDismissedVersion,
  shouldOfferMove,
  writeDismissedVersion,
  type InstallLocation,
  type MoveAnswer,
} from '../../../../electron/services/mac-install-location';

/** A packaged mac app sitting outside /Applications — the case we exist for. */
const translocated = (overrides: Partial<InstallLocation> = {}): InstallLocation => ({
  platform: 'darwin',
  isPackaged: true,
  isInApplicationsFolder: false,
  version: '1.2.3',
  dismissedForVersion: null,
  ...overrides,
});

/** Run the offer against spies; nothing here may touch Electron or the disk. */
const harness = (answer: MoveAnswer | Error, options: Partial<InstallLocation> = {}, move = () => true) => {
  const remembered: string[] = [];
  const logs: string[] = [];
  const moveSpy = vi.fn(move);
  const ask = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const outcome = offerMoveToApplications({
    location: translocated(options),
    ask,
    move: moveSpy,
    remember: (version) => remembered.push(version),
    log: (message) => logs.push(message),
  });
  return { outcome, ask, moveSpy, remembered, logs };
};

describe('shouldOfferMove', () => {
  // Breaks: the whole feature. This is the only case that should ever ask.
  it('asks when a packaged mac app runs outside /Applications', () => {
    expect(shouldOfferMove(translocated())).toBe(true);
  });

  // Breaks: Linux and Windows users get a modal about a macOS-only folder.
  it('never asks off macOS', () => {
    expect(shouldOfferMove(translocated({ platform: 'linux' }))).toBe(false);
    expect(shouldOfferMove(translocated({ platform: 'win32' }))).toBe(false);
  });

  // Breaks: `pnpm dev:desktop` opens a dialog offering to move the checkout.
  it('never asks in development', () => {
    expect(shouldOfferMove(translocated({ isPackaged: false }))).toBe(false);
  });

  // Breaks: every launch of a correctly installed app asks a pointless question.
  it('does not ask when the app is already in /Applications', () => {
    expect(shouldOfferMove(translocated({ isInApplicationsFolder: true }))).toBe(false);
  });

  // Breaks: "Don't ask again" does nothing and the prompt returns every launch.
  it('honours a dismissal for the running version', () => {
    expect(shouldOfferMove(translocated({ dismissedForVersion: '1.2.3' }))).toBe(false);
  });

  // Breaks: someone who dismissed an old build is never told the new copy they
  // just dropped in Downloads cannot update either.
  it('asks again once the version changes', () => {
    expect(shouldOfferMove(translocated({ dismissedForVersion: '1.2.2' }))).toBe(true);
  });
});

describe('moveInvitation', () => {
  // Breaks: the user reads "move the application" as "lose everything in it"
  // and declines forever. Saying the data is elsewhere is the point of the copy.
  it('says updates are impossible here and that mail is not affected', () => {
    const text = moveInvitation();
    expect(text).toContain('read-only');
    expect(text).toContain('updates');
    expect(text.toLowerCase()).toContain('not affected');
  });
});

describe('offerMoveToApplications', () => {
  // Breaks: the caller keeps initializing storage and IMAP while Electron is
  // already quitting to relaunch from /Applications.
  it('reports "moving" after a successful move so startup stops', async () => {
    const { outcome, moveSpy } = harness({ move: true, dontAskAgain: false });
    await expect(outcome).resolves.toBe('moving');
    expect(moveSpy).toHaveBeenCalledTimes(1);
  });

  // Breaks: declining blocks the launch, or the app is moved anyway.
  it('starts normally when the user says no, and does not move anything', async () => {
    const { outcome, moveSpy } = harness({ move: false, dontAskAgain: false });
    await expect(outcome).resolves.toBe('declined');
    expect(moveSpy).not.toHaveBeenCalled();
  });

  // Breaks: the checkbox is ignored and the prompt comes back next launch.
  it('remembers the running version when "Don\'t ask again" is ticked', async () => {
    const { outcome, remembered } = harness({ move: false, dontAskAgain: true });
    await outcome;
    expect(remembered).toEqual(['1.2.3']);
  });

  // Breaks: a user who ticks the box AND moves is never asked again about a
  // future copy — the dismissal must be recorded on the version either way.
  it('records the dismissal even when the move goes ahead', async () => {
    const { outcome, remembered } = harness({ move: true, dontAskAgain: true });
    await expect(outcome).resolves.toBe('moving');
    expect(remembered).toEqual(['1.2.3']);
  });

  // Breaks: nothing is remembered when it shouldn't be, and the user's "no"
  // silently becomes permanent.
  it('remembers nothing when the box is left unticked', async () => {
    const { outcome, remembered } = harness({ move: false, dontAskAgain: false });
    await outcome;
    expect(remembered).toEqual([]);
  });

  // Breaks: macOS's own "a copy already exists" prompt is cancelled and the app
  // reports a move that never happened, so startup returns and nothing runs.
  it('treats a cancelled move as a decline, not a move', async () => {
    const { outcome } = harness({ move: true, dontAskAgain: false }, {}, () => false);
    await expect(outcome).resolves.toBe('declined');
  });

  // Breaks: a failed move takes the whole launch down. An app that cannot
  // update is better than an app that will not start.
  it('starts anyway when the move throws', async () => {
    const { outcome, logs } = harness({ move: true, dontAskAgain: false }, {}, () => {
      throw new Error('Operation not permitted');
    });
    await expect(outcome).resolves.toBe('failed');
    expect(logs.join('\n')).toContain('Operation not permitted');
  });

  // Breaks: a dialog that cannot be shown (no display, no window server)
  // rejects, and the app never starts.
  it('starts anyway when the dialog itself fails', async () => {
    const { outcome, moveSpy } = harness(new Error('no window server'));
    await expect(outcome).resolves.toBe('failed');
    expect(moveSpy).not.toHaveBeenCalled();
  });

  // Breaks: Linux and Windows launches wait on a dialog that never applies.
  it('asks nothing at all when the case does not apply', async () => {
    const { outcome, ask } = harness({ move: true, dontAskAgain: false }, { platform: 'linux' });
    await expect(outcome).resolves.toBe('not-offered');
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('the remembered answer', () => {
  const withDir = <T>(run: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'install-location-'));
    try {
      return run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // Breaks: the file is written where nothing reads it back.
  it('round-trips through userData', () => {
    withDir((dir) => {
      expect(readDismissedVersion(dir)).toBeNull();
      writeDismissedVersion(dir, '1.2.3');
      expect(readDismissedVersion(dir)).toBe('1.2.3');
      expect(installLocationFilePath(dir)).toBe(join(dir, INSTALL_LOCATION_FILE_NAME));
    });
  });

  // Breaks: a corrupt or half-written file throws out of startup instead of
  // costing one extra dialog.
  it('reads a damaged file as "never dismissed"', () => {
    withDir((dir) => {
      writeFileSync(installLocationFilePath(dir), '{ not json');
      expect(readDismissedVersion(dir)).toBeNull();
    });
  });

  // Breaks: an unwritable userData directory turns a checkbox into a crash.
  it('swallows a write it cannot make', () => {
    expect(() => writeDismissedVersion('/definitely/not/a/directory', '1.2.3')).not.toThrow();
  });

  // Breaks: junk in the file is trusted as a version and silences the prompt
  // for good.
  it('accepts only a non-empty string', () => {
    expect(parseDismissedVersion({ dismissedForVersion: '1.2.3' })).toBe('1.2.3');
    expect(parseDismissedVersion({ dismissedForVersion: '' })).toBeNull();
    expect(parseDismissedVersion({ dismissedForVersion: 7 })).toBeNull();
    expect(parseDismissedVersion({})).toBeNull();
    expect(parseDismissedVersion(null)).toBeNull();
    expect(parseDismissedVersion('1.2.3')).toBeNull();
  });
});
