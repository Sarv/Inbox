/**
 * Auto-update service — the I/O edge around electron-updater.
 *
 * Responsibilities, in order of importance:
 *   1. Check GitHub Releases for a newer version, hourly and on demand.
 *   2. Download it in the background so "Install and Relaunch" is instant.
 *   3. Push one {@link UpdateState} to the renderer whenever anything changes.
 *
 * Every *decision* (should we prompt, is this build updatable, what does "later"
 * mean) lives in `update-policy.ts` as a pure function. This file holds the
 * timers, the event wiring and the one JSON file, and nothing else — so the
 * rules can be tested without downloading anything.
 *
 * The feed is the GitHub Releases of the repo named in the `publish` block of
 * apps/desktop/package.json. electron-updater only ever sees PUBLISHED releases,
 * so the draft that `.github/workflows/release.yml` creates reaches nobody until
 * a maintainer clicks publish. That is the intended safety gate, not an
 * oversight — see docs/RELEASING.md.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { getMainWindow } from '../shared';

import {
  CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_PREFS,
  FIRST_CHECK_DELAY_MS,
  INITIAL_UPDATE_STATE,
  getUpdateSupport,
  parseUpdatePrefs,
  remindLater,
  shouldAutoInstallOnQuit,
  shouldShowDialog,
  skipVersion,
  type UpdatePrefs,
  type UpdateState,
  type UpdateTrigger,
} from './update-policy';

const logger = createLogger('update-service');

const PREFS_FILE_NAME = 'update-prefs.json';

/**
 * Deliberately a small JSON file rather than a row in the core DB. Update
 * preferences must be readable before storage initialises and must survive a
 * database that fails to open — an app that cannot read its DB is exactly the
 * app that most needs to be able to update itself. It holds no secrets.
 */
const prefsPath = (): string => join(app.getPath('userData'), PREFS_FILE_NAME);

let prefs: UpdatePrefs = { ...DEFAULT_UPDATE_PREFS };
let state: UpdateState = { ...INITIAL_UPDATE_STATE };
let currentTrigger: UpdateTrigger = 'scheduled';
let checkTimer: NodeJS.Timeout | null = null;
let firstCheckTimer: NodeJS.Timeout | null = null;
let wired = false;
/** Guards against overlapping checks (a manual press during an hourly check). */
let checkInFlight = false;
/**
 * The user closed the dialog for the CURRENT check cycle.
 *
 * `setState` recomputes `prompt` on every state change, so a patch of
 * `{ prompt: false }` was overwritten by the recomputation an instant later and
 * the dialog reopened itself — "Close" and "Remind me later" did nothing on a
 * manual check, which always wants to show something. The answer has to
 * survive the recomputation, so it is an input to it. Reset when a new check
 * begins: a dismissal answers this check, not every future one.
 */
let dialogDismissed = false;

const loadPrefs = (): UpdatePrefs => {
  try {
    return parseUpdatePrefs(JSON.parse(readFileSync(prefsPath(), 'utf8')));
  } catch {
    // Missing on first run, and unreadable/corrupt is treated identically:
    // "no preferences yet" is the safe default in both cases.
    return { ...DEFAULT_UPDATE_PREFS };
  }
};

/**
 * Write prefs atomically (temp file + rename), so a crash mid-write leaves the
 * previous file intact rather than a truncated one. A half-written prefs file
 * would parse as "no preferences" and silently resurrect a prompt the user
 * already dismissed.
 */
const savePrefs = (next: UpdatePrefs): void => {
  prefs = next;
  const target = prefsPath();
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    // Losing a preference is a nuisance (the prompt comes back); failing the
    // press is worse. Log and carry on.
    logger.warn('[Update] Could not persist update preferences:', error);
    try { unlinkSync(temp); } catch { /* best effort */ }
  }
};

/** Push the current state to the renderer. A closed window is not an error. */
const broadcast = (): void => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return;
  try {
    window.webContents.send('updater:state', state);
  } catch (error) {
    logger.warn('[Update] Could not push update state to the renderer:', error);
  }
};

const setState = (patch: Partial<UpdateState>): void => {
  const merged: UpdateState = { ...state, ...patch };
  merged.prompt = shouldShowDialog({
    phase: merged.phase,
    trigger: currentTrigger,
    version: merged.version,
    prefs,
    now: Date.now(),
    dismissed: dialogDismissed,
  });
  merged.trigger = currentTrigger;
  state = merged;
  broadcast();
};

export const getUpdateState = (): UpdateState => state;

/**
 * Wire electron-updater's events onto {@link setState}. Called once; the
 * listeners live for the process lifetime.
 */
const wireEvents = (): void => {
  if (wired) return;
  wired = true;

  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    logger.info('[Update] Update available:', info.version);
    // autoDownload is on, so electron-updater is already fetching it; the
    // dialog stays hidden for a scheduled check until the download completes.
    setState({ phase: 'downloading', version: info.version, percent: 0, error: null });
  });

  autoUpdater.on('update-not-available', () => {
    checkInFlight = false;
    setState({ phase: 'up-to-date', version: null, checkedAt: Date.now(), error: null });
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    checkInFlight = false;
    // Re-evaluated per version, not once at startup: a user who skipped 1.2.0
    // must still receive 1.2.1 automatically.
    autoUpdater.autoInstallOnAppQuit = shouldAutoInstallOnQuit(prefs, info.version);
    logger.info(
      '[Update] Update downloaded and staged:',
      info.version,
      autoUpdater.autoInstallOnAppQuit ? '(installs on next quit)' : '(skipped by the user)',
    );
    setState({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      checkedAt: Date.now(),
      error: null,
    });
  });

  autoUpdater.on('error', (error) => {
    checkInFlight = false;
    // Routinely non-fatal: offline, GitHub rate limit, a release with no asset
    // for this platform. Never surfaced for a scheduled check — `prompt` stays
    // false unless the user asked — so it cannot become a recurring popup.
    logger.warn('[Update] Update check failed:', error);
    setState({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    });
  });
};

/**
 * Run one check. Safe to call at any time: it no-ops on an unsupported build
 * and coalesces with a check that is already running.
 */
export const checkForUpdates = async (trigger: UpdateTrigger): Promise<UpdateState> => {
  const support = getUpdateSupport({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isAppImage: Boolean(process.env['APPIMAGE']),
  });

  currentTrigger = trigger;
  // A new check is a new question, so an earlier "Close" no longer applies.
  dialogDismissed = false;

  if (!support.supported) {
    setState({ phase: 'unsupported', error: support.message, version: null });
    return state;
  }

  // A manual press while the hourly check is mid-flight re-shows the dialog
  // against the run already in progress rather than starting a second one.
  if (checkInFlight) {
    setState({});
    return state;
  }

  wireEvents();
  checkInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // checkForUpdates rejects for the same reasons the 'error' event fires;
    // the handler above has already set the state, so this only needs to
    // release the in-flight latch.
    checkInFlight = false;
    logger.warn('[Update] Check rejected:', error);
  }
  return state;
};

/**
 * Quit and install the staged update, relaunching afterwards.
 *
 * Returns false when nothing is staged, so the renderer can keep the dialog
 * open rather than appearing to do nothing.
 */
export const installUpdateAndRestart = (): boolean => {
  if (state.phase !== 'downloaded') {
    logger.warn('[Update] Install requested with no staged update (phase:', state.phase, ')');
    return false;
  }

  // An installed update supersedes both answers: a skip recorded for this
  // version would otherwise suppress the post-install "up to date" state, and a
  // stale snooze would silence the NEXT release for up to six hours.
  savePrefs({ ...DEFAULT_UPDATE_PREFS });

  logger.info('[Update] Installing update and relaunching');
  // isSilent: false so Windows shows the installer's progress; isForceRunAfter
  // relaunches on every platform once the swap completes.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
};

/** Record "Skip this version" — no further prompts for this exact version. */
export const skipCurrentVersion = (): UpdateState => {
  if (state.version) {
    logger.info('[Update] User skipped version', state.version);
    savePrefs(skipVersion(prefs, state.version));
    // Without this the update would still be applied on the next quit, which
    // would make "Skip this version" a button that does nothing.
    autoUpdater.autoInstallOnAppQuit = false;
  }
  dialogDismissed = true;
  setState({});
  return state;
};

/** Record "Remind me later" — no prompts of any kind for six hours. */
export const remindAboutUpdateLater = (): UpdateState => {
  // Note this does NOT disarm the silent install: "later" is about the prompt,
  // not the update. If the user quits before the six hours are up they still
  // get the new version, which is the whole point of automatic updates.
  savePrefs(remindLater(prefs, Date.now()));
  logger.info('[Update] Reminder snoozed until', new Date(prefs.remindAfter ?? 0).toISOString());
  dialogDismissed = true;
  setState({});
  return state;
};

/** Dismiss the dialog without recording anything (Escape / backdrop click). */
export const dismissUpdateDialog = (): UpdateState => {
  dialogDismissed = true;
  setState({});
  return state;
};

/**
 * Start the background checker: once shortly after launch, then hourly.
 *
 * Idempotent, and a no-op on a build that cannot self-update — there is no
 * point spending a request an hour to discover something the user cannot act
 * on from inside the app.
 */
export const startUpdateService = (): void => {
  prefs = loadPrefs();

  const support = getUpdateSupport({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isAppImage: Boolean(process.env['APPIMAGE']),
  });

  if (!support.supported) {
    logger.info('[Update] Background checks disabled:', support.message);
    // Recorded in state (without a prompt) so a manual check can explain why.
    state = { ...INITIAL_UPDATE_STATE, phase: 'unsupported', error: support.message };
    return;
  }

  autoUpdater.autoDownload = true;
  // Updates are automatic by default: downloaded in the background, then
  // applied during the next ordinary quit, so a user who never touches the
  // dialog still ends up on the new version without doing anything. The
  // dialog's "Install and Relaunch" only makes that happen sooner.
  // `skipCurrentVersion()` is the one thing that turns this off, and only for
  // the version that was skipped.
  autoUpdater.autoInstallOnAppQuit = shouldAutoInstallOnQuit(prefs, null);
  autoUpdater.logger = null;

  wireEvents();

  if (firstCheckTimer) clearTimeout(firstCheckTimer);
  firstCheckTimer = setTimeout(() => {
    void checkForUpdates('scheduled');
  }, FIRST_CHECK_DELAY_MS);
  // Never hold the event loop open for an update check on an app that is quitting.
  firstCheckTimer.unref?.();

  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    void checkForUpdates('scheduled');
  }, CHECK_INTERVAL_MS);
  checkTimer.unref?.();

  logger.info('[Update] Background update checks started (hourly)');
};

/** Stop the timers. Part of the app's shutdown sweep. */
export const stopUpdateService = (): void => {
  if (firstCheckTimer) { clearTimeout(firstCheckTimer); firstCheckTimer = null; }
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
};

/** Test seam: reset module state between cases. */
export const __resetUpdateServiceForTests = (): void => {
  stopUpdateService();
  prefs = { ...DEFAULT_UPDATE_PREFS };
  state = { ...INITIAL_UPDATE_STATE };
  currentTrigger = 'scheduled';
  checkInFlight = false;
  wired = false;
};
