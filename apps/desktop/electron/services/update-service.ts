/**
 * Auto-update service — the I/O edge around electron-updater.
 *
 * Responsibilities, in order of importance:
 *   1. Check GitHub Releases for a newer version, hourly and on demand.
 *   2. Download it — in the background, or only when asked, per the user's
 *      "Install updates automatically" preference.
 *   3. Push one {@link UpdateState} to the renderer whenever anything changes.
 *
 * Every *decision* (should we prompt, should we download unasked, is this build
 * updatable, what does "later" mean) lives in `update-policy.ts` as a pure
 * function. This file holds the timers, the event wiring and the one JSON file,
 * and nothing else — so the rules can be tested without downloading anything.
 *
 * The feed is the GitHub Releases of the repo named in the `publish` block of
 * apps/desktop/package.json. electron-updater only ever sees PUBLISHED releases,
 * so the draft that `.github/workflows/release.yml` creates reaches nobody until
 * a maintainer clicks publish. That is the intended safety gate, not an
 * oversight — see docs/RELEASING.md.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

import { createLogger, isTimeoutError, withTimeout } from '@sarvinbox/core';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { getMainWindow } from '../shared';

import {
  CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_PREFS,
  FIRST_CHECK_DELAY_MS,
  INITIAL_UPDATE_STATE,
  UPDATE_CHECK_TIMEOUT_MS,
  getUpdateSupport,
  parseUpdatePrefs,
  remindLater,
  setAutoUpdate,
  shouldAutoDownload,
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
/** When the in-flight check started, so every outcome can be logged with its cost. */
let checkStartedAt = 0;
/**
 * The user pressed "Download and install" during this cycle.
 *
 * Two jobs. It re-opens the dialog when the download finishes, so a user who
 * hid the progress bar still gets told the update is ready; and it keeps a
 * background cycle's dialog alive through the download that user started, which
 * `shouldShowDialog` would otherwise close as soon as automatic updates were
 * off and the phase left 'available'.
 */
let downloadRequested = false;
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

/** The running version, for copy like "1.2.1 is the newest version". */
const runningVersion = (): string | null => {
  try {
    return app.getVersion?.() ?? null;
  } catch {
    return null;
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
    downloadRequested,
  });
  merged.trigger = currentTrigger;
  merged.autoUpdate = prefs.autoUpdate;
  merged.currentVersion = merged.currentVersion ?? runningVersion();
  state = merged;
  broadcast();
};

export const getUpdateState = (): UpdateState => state;

/** How long the check that just finished took. Zero when none was running. */
const checkDurationMs = (): number => (checkStartedAt === 0 ? 0 : Date.now() - checkStartedAt);

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
    // Logged with its cost: a check that takes 15 seconds and a check that
    // hangs are indistinguishable in a log that only records the outcome, and
    // that is precisely the gap that made "Checking for updates..." impossible
    // to diagnose from app.log.
    logger.info(
      `[Update] Update available: ${info.version} (check took ${checkDurationMs()}ms,`,
      prefs.autoUpdate ? 'downloading now)' : 'waiting for the user to ask)',
    );
    // With automatic updates on, electron-updater is already fetching it — say
    // so. With them off nothing is moving until the user presses the button,
    // and 'available' is the phase that asks.
    setState(
      shouldAutoDownload(prefs)
        ? { phase: 'downloading', version: info.version, percent: 0, error: null }
        : { phase: 'available', version: info.version, percent: 0, error: null },
    );
  });

  autoUpdater.on('update-not-available', () => {
    logger.info(`[Update] No update available (check took ${checkDurationMs()}ms)`);
    setState({ phase: 'up-to-date', version: null, checkedAt: Date.now(), error: null });
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // Re-evaluated per version, not once at startup: a user who skipped 1.2.0
    // must still receive 1.2.1 automatically.
    autoUpdater.autoInstallOnAppQuit = shouldAutoInstallOnQuit(prefs, info.version);
    logger.info(
      '[Update] Update downloaded and staged:',
      info.version,
      autoUpdater.autoInstallOnAppQuit ? '(installs on next quit)' : '(skipped by the user)',
    );
    // A download the user asked for has earned an answer, even if they closed
    // the progress dialog while it ran. Without this the "ready to install"
    // prompt was swallowed by the dismissal of the dialog it replaces.
    if (downloadRequested) dialogDismissed = false;
    setState({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      checkedAt: Date.now(),
      error: null,
    });
  });

  autoUpdater.on('error', (error) => {
    // Routinely non-fatal: offline, GitHub rate limit, a release with no asset
    // for this platform. Never surfaced for a quiet background cycle — `prompt`
    // stays false unless the user asked or is waiting on a download they
    // started — so it cannot become a recurring popup.
    logger.warn(`[Update] Update check failed after ${checkDurationMs()}ms:`, error);
    setState({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    });
  });
};

/**
 * The file electron-updater opens on every check.
 *
 * electron-builder writes `app-update.yml` into the packaged app's resources
 * directory; electron-updater reads it from `process.resourcesPath` to learn
 * where the feed is. Nothing else tells us as honestly whether this build can
 * update itself, so the check asks the filesystem rather than trusting a flag.
 */
const hasUpdateConfig = (): boolean => {
  try {
    return existsSync(join(process.resourcesPath, 'app-update.yml'));
  } catch {
    // An unreadable resources directory is not an updatable build either.
    return false;
  }
};

/** Everything the pure support rules need, read from this process. */
const currentUpdateSupport = () =>
  getUpdateSupport({
    platform: process.platform,
    // NOT app.isPackaged: Electron derives that from the executable's file
    // name, and scripts/postinstall.mjs renames the dev binary, so it reports
    // true under `pnpm dev:desktop`. process.defaultApp survives the rename.
    isDefaultApp: Boolean(process.defaultApp),
    hasUpdateConfig: hasUpdateConfig(),
    isAppImage: Boolean(process.env['APPIMAGE']),
  });

/**
 * Run one check. Safe to call at any time: it no-ops on an unsupported build
 * and coalesces with a check that is already running.
 */
export const checkForUpdates = async (trigger: UpdateTrigger): Promise<UpdateState> => {
  const support = currentUpdateSupport();

  currentTrigger = trigger;
  // A new check is a new question, so an earlier "Close" no longer applies.
  dialogDismissed = false;

  if (!support.supported) {
    setState({ phase: 'unsupported', error: support.message, version: null });
    return state;
  }

  // A manual press while a check is mid-flight — or while a download is
  // running — re-shows the dialog against the run already in progress rather
  // than starting a second one. Re-checking during a download is the worse of
  // the two: electron-updater would start fetching the same file again.
  if (checkInFlight || state.phase === 'downloading') {
    setState({});
    return state;
  }

  wireEvents();
  checkInFlight = true;
  checkStartedAt = Date.now();
  downloadRequested = false;
  try {
    // Bounded, because nothing below us is. builder-util-runtime's transport
    // defaults to a 60s socket timeout and retries server errors three times,
    // so an unbounded await can leave the dialog on "Checking for updates..."
    // for minutes. An honest failure at 20s is a better answer than a spinner.
    await withTimeout(
      autoUpdater.checkForUpdates(),
      UPDATE_CHECK_TIMEOUT_MS,
      `The update server did not respond within ${Math.round(UPDATE_CHECK_TIMEOUT_MS / 1000)} seconds.`,
    );
  } catch (error) {
    // Two different failures land here. A rejection from electron-updater has
    // already fired the 'error' event, so the state is set and there is nothing
    // to add. A TIMEOUT has fired nothing — the request is still out there —
    // so it has to report itself.
    if (isTimeoutError(error)) {
      logger.warn(`[Update] Check timed out after ${checkDurationMs()}ms`);
      setState({
        phase: 'error',
        error: error.message,
        checkedAt: Date.now(),
      });
    } else {
      logger.warn('[Update] Check rejected:', error);
    }
  } finally {
    // THE latch must be released on every path, including the timeout. It used
    // to be cleared only by a terminal event, so a check that never produced
    // one left it stuck true for the life of the process — and every later
    // press of "Check for Updates" then short-circuited into the coalescing
    // branch above, showing "Checking for updates..." forever without ever
    // sending a request.
    checkInFlight = false;
  }
  return state;
};

/**
 * Start downloading the update this check found.
 *
 * Only reachable with automatic updates off, where 'available' is a real
 * waiting state rather than a moment in passing. Returns false when there is
 * nothing to download, so the renderer can say so instead of spinning.
 */
export const downloadUpdate = (): boolean => {
  if (state.phase !== 'available' || !state.version) {
    logger.warn('[Update] Download requested with nothing available (phase:', state.phase, ')');
    return false;
  }

  logger.info('[Update] User asked to download', state.version);
  downloadRequested = true;
  dialogDismissed = false;
  setState({ phase: 'downloading', percent: 0, error: null });
  // The rejection path is the 'error' event, which is already wired; this
  // catch only stops an unhandled rejection from reaching the process.
  void autoUpdater.downloadUpdate().catch((error) => {
    logger.warn('[Update] Download rejected:', error);
  });
  return true;
};

/**
 * Turn background downloading on or off.
 *
 * Turning it ON while an update is sitting in 'available' starts that download
 * immediately: the user has just said "fetch these for me", and making them
 * press a second button to fetch the one already on screen would be a toggle
 * that does nothing visible.
 */
export const setAutoUpdateEnabled = (enabled: boolean): UpdateState => {
  savePrefs(setAutoUpdate(prefs, enabled));
  autoUpdater.autoDownload = shouldAutoDownload(prefs);
  logger.info('[Update] Automatic updates', enabled ? 'enabled' : 'disabled');

  if (enabled && state.phase === 'available' && state.version) {
    downloadUpdate();
    return state;
  }

  setState({});
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
  // stale snooze would silence the NEXT release for up to six hours. The
  // automatic-update toggle is NOT one of those answers — it is a standing
  // preference about bandwidth, so it is carried across rather than reset.
  savePrefs({ ...DEFAULT_UPDATE_PREFS, autoUpdate: prefs.autoUpdate });

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

  const support = currentUpdateSupport();

  if (!support.supported) {
    logger.info('[Update] Background checks disabled:', support.message);
    // Recorded in state (without a prompt) so a manual check can explain why.
    state = {
      ...INITIAL_UPDATE_STATE,
      phase: 'unsupported',
      error: support.message,
      currentVersion: runningVersion(),
      autoUpdate: prefs.autoUpdate,
    };
    return;
  }

  autoUpdater.autoDownload = shouldAutoDownload(prefs);
  // Updates are automatic by default: downloaded in the background, then
  // applied during the next ordinary quit, so a user who never touches the
  // dialog still ends up on the new version without doing anything. The
  // dialog's "Restart now" only makes that happen sooner.
  // `skipCurrentVersion()` is the one thing that turns this off, and only for
  // the version that was skipped.
  autoUpdater.autoInstallOnAppQuit = shouldAutoInstallOnQuit(prefs, null);
  autoUpdater.logger = null;
  state = { ...state, currentVersion: runningVersion(), autoUpdate: prefs.autoUpdate };

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

  logger.info(
    '[Update] Background update checks started (hourly,',
    prefs.autoUpdate ? 'downloading automatically)' : 'asking before downloading)',
  );
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
  checkStartedAt = 0;
  downloadRequested = false;
  dialogDismissed = false;
  wired = false;
};
