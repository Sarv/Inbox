/**
 * Boot offer (macOS only): move the app into /Applications, because an app that
 * lives anywhere else cannot update itself.
 *
 * macOS App Translocation is the mechanism. A quarantined bundle launched from
 * the mounted DMG — or from a copy still sitting in ~/Downloads — is run from a
 * randomized READ-ONLY mount under /private/var/folders. Squirrel.Mac updates by
 * swapping the .app bundle in place, so from there electron-updater refuses
 * before it makes a single network call: "Cannot update while running on a
 * read-only volume".
 *
 * Reported from the field on 1.2.1. The user saw it as a failed update CHECK —
 * nothing had been downloaded, and the dialog's generic tail told them it
 * usually means no connection — so the one action that would have fixed it was
 * never suggested. Nobody in that position ever gets another version, either:
 * the app is frozen at whatever release they first copied.
 *
 * Asking at startup is the only moment that works. It has to happen before
 * storage, keychain and IMAP open, because a successful move quits and relaunches
 * the app out from under whatever was already running.
 *
 * The decision and the copy are pure so both are asserted without a dialog, a
 * bundle or an /Applications folder — the text IS the feature, same as the
 * native-module guard beside it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLogger } from '@sarvinbox/core';
import { app, dialog } from 'electron';

const logger = createLogger('mac-install-location');

/** Where the "don't ask again" answer is remembered, under userData. */
export const INSTALL_LOCATION_FILE_NAME = 'install-location.json';

/** Title bar of the prompt. */
export const MOVE_PROMPT_TITLE = 'Move Sarv Inbox to Applications?';

/** The question itself, shown in bold above the detail. */
export const MOVE_PROMPT_MESSAGE = 'Move Sarv Inbox to your Applications folder?';

/** Button labels, in the order they are offered. Index 0 is the default. */
export const MOVE_BUTTON = 'Move to Applications';
export const LATER_BUTTON = 'Not now';
export const DONT_ASK_AGAIN_LABEL = "Don't ask again";

/**
 * Why moving matters, in the user's terms.
 *
 * Says what the app can't do rather than naming App Translocation, and says
 * outright that mail and settings are not inside the bundle: "move the
 * application" reads as "and lose everything in it" to most people, which is
 * exactly the fear that makes someone pick "Not now" forever.
 */
export function moveInvitation(): string {
  return [
    'Sarv Inbox is running from outside your Applications folder, so macOS is',
    'running it from a temporary read-only copy. It cannot install its own',
    'updates from there — update checks fail with a "read-only volume" error, and',
    'this copy would stay on its current version for good.',
    '',
    'Moving it takes a moment and Sarv Inbox reopens by itself. Your accounts,',
    'mail and settings are stored separately and are not affected.',
  ].join('\n');
}

/** Everything the decision depends on, so the decision itself needs no Electron. */
export interface InstallLocation {
  platform: NodeJS.Platform;
  /** False in dev, where the "bundle" is a checkout and moving it is nonsense. */
  isPackaged: boolean;
  isInApplicationsFolder: boolean;
  /** The running version. */
  version: string;
  /** Version the user last chose to stop being asked about; null when never. */
  dismissedForVersion: string | null;
}

/**
 * Whether to put the question. Every "no" here is a launch that must proceed
 * untouched — this runs before the window exists, so a wrong "yes" is a modal
 * in front of an app that hasn't started.
 *
 * The dismissal is keyed to the version, not permanent: a user stuck on a copy
 * that cannot update never sees a new version, so per-version is "never again"
 * for them in practice, while someone who later installs a fresh build into
 * Downloads by hand is asked once about THAT one.
 */
export function shouldOfferMove(location: InstallLocation): boolean {
  if (location.platform !== 'darwin') return false;
  if (!location.isPackaged) return false;
  if (location.isInApplicationsFolder) return false;
  return location.dismissedForVersion !== location.version;
}

/** The user's answer to the prompt. */
export interface MoveAnswer {
  move: boolean;
  dontAskAgain: boolean;
}

export type MoveOfferOutcome =
  /** Not applicable — wrong platform, dev, already in place, or dismissed. */
  | 'not-offered'
  /** The move succeeded; the app is quitting and relaunching. Stop startup. */
  | 'moving'
  /** The user said no, or cancelled the move. Carry on starting up. */
  | 'declined'
  /** The move was attempted and failed. Carry on starting up. */
  | 'failed';

export interface MoveOfferDeps {
  location?: InstallLocation;
  ask?: (invitation: string) => Promise<MoveAnswer>;
  /** `app.moveToApplicationsFolder()` — returns false when the user cancels. */
  move?: () => boolean;
  remember?: (version: string) => void;
  log?: (message: string) => void;
}

/**
 * Put the question and act on the answer. Returns 'moving' when the caller must
 * stop initializing, because Electron has already begun quitting and relaunching
 * the app from its new home.
 *
 * Nothing here is allowed to prevent a launch: a dialog that cannot be shown, a
 * move that fails and a refusal all end the same way — the app starts where it
 * is, still unable to update, which is strictly better than not starting.
 */
export async function offerMoveToApplications(deps: MoveOfferDeps = {}): Promise<MoveOfferOutcome> {
  const {
    location = currentInstallLocation(),
    ask = askViaDialog,
    move = () => app.moveToApplicationsFolder(),
    remember = (version: string) => writeDismissedVersion(app.getPath('userData'), version),
    log = (message: string) => logger.info(message),
  } = deps;

  if (!shouldOfferMove(location)) return 'not-offered';

  let answer: MoveAnswer;
  try {
    answer = await ask(moveInvitation());
  } catch (err) {
    log(`[Main] could not ask about moving to Applications: ${(err as Error)?.message}`);
    return 'failed';
  }

  if (answer.dontAskAgain) remember(location.version);

  if (!answer.move) {
    log('[Main] Running outside /Applications; the user declined the move. Updates stay unavailable.');
    return 'declined';
  }

  try {
    // False is the user cancelling macOS's own replace-the-existing-copy prompt,
    // which is a refusal and not an error.
    if (!move()) {
      log('[Main] Move to /Applications cancelled.');
      return 'declined';
    }
  } catch (err) {
    log(`[Main] Move to /Applications failed: ${(err as Error)?.message}`);
    return 'failed';
  }

  log('[Main] Moved to /Applications; relaunching from there.');
  return 'moving';
}

/** Read the live facts off Electron. The only place this module touches `app`. */
function currentInstallLocation(): InstallLocation {
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    // macOS-only API; never reached on another platform because `platform` is
    // checked first, but guarded so a future caller cannot crash on it.
    isInApplicationsFolder: process.platform === 'darwin' ? app.isInApplicationsFolder() : true,
    version: app.getVersion(),
    dismissedForVersion: readDismissedVersion(app.getPath('userData')),
  };
}

/** Ask with a real dialog. Async because only the async form reports the checkbox. */
async function askViaDialog(invitation: string): Promise<MoveAnswer> {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    title: MOVE_PROMPT_TITLE,
    message: MOVE_PROMPT_MESSAGE,
    detail: invitation,
    buttons: [MOVE_BUTTON, LATER_BUTTON],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: DONT_ASK_AGAIN_LABEL,
  });
  return { move: response === 0, dontAskAgain: checkboxChecked };
}

/**
 * The stored answer, or null. Anything unexpected in the file reads as null:
 * "ask again" is the safe reading of a file we cannot understand, and the cost
 * of being wrong is one dialog.
 */
export function parseDismissedVersion(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as { dismissedForVersion?: unknown }).dismissedForVersion;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Path of the answer file inside a userData directory. */
export function installLocationFilePath(userDataDir: string): string {
  return join(userDataDir, INSTALL_LOCATION_FILE_NAME);
}

export function readDismissedVersion(userDataDir: string): string | null {
  try {
    return parseDismissedVersion(JSON.parse(readFileSync(installLocationFilePath(userDataDir), 'utf8')));
  } catch {
    // Missing on first run, unreadable and corrupt are the same answer here.
    return null;
  }
}

/**
 * Remember the answer. Not written atomically on purpose: a torn write parses
 * as null, which asks once more — the failure mode is a repeated question, not
 * a lost setting, so the temp-file dance would buy nothing.
 */
export function writeDismissedVersion(userDataDir: string, version: string): void {
  try {
    writeFileSync(
      installLocationFilePath(userDataDir),
      `${JSON.stringify({ dismissedForVersion: version }, null, 2)}\n`,
      { mode: 0o600 }
    );
  } catch (err) {
    logger.warn('[Main] could not remember the Applications-folder answer:', err);
  }
}
