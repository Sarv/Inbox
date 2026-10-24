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
import { app, Notification } from 'electron';
import { autoUpdater, type Logger as UpdaterLogger } from 'electron-updater';

import { getMainWindow } from '../shared';
import { restoreAndFocusWindow } from '../utils/window-focus';

import { verifyUpdate } from './update-manifest';
import {
  CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_PREFS,
  FIRST_CHECK_DELAY_MS,
  INITIAL_UPDATE_STATE,
  UPDATE_CHECK_TIMEOUT_MS,
  getUpdateSupport,
  parseUpdatePrefs,
  reminderWakeDelay,
  remindLater,
  resolveRemindAfter,
  sameUpdate,
  setAutoUpdate,
  shouldAutoDownload,
  shouldAutoInstallOnQuit,
  shouldNotifyUpdateReady,
  shouldShowDialog,
  shouldShowReadyBanner,
  skipVersion,
  type UpdateIdentity,
  type UpdatePrefs,
  type UpdateState,
  type UpdateTrigger,
} from './update-policy';

const logger = createLogger('update-service');

/**
 * electron-updater's own log, written to app.log. It is the only record of
 * whether an update came down as a differential (blockmap) download or fell
 * back to the whole file, and why: "Full: 258 MB, To download: 12 MB (5%)".
 * Without it a release that quietly ships every user the full installer looks
 * exactly like one that ships them a few MB. No `debug`: electron-updater only
 * calls it when it exists, and it is per-request noise.
 */
const electronUpdaterLog = createLogger('electron-updater');
/** Keeps an Error's stack; electron-updater mostly logs plain strings. */
const describeUpdaterMessage = (message: unknown): string =>
  message instanceof Error ? (message.stack ?? message.message) : String(message);
const updaterLogger: UpdaterLogger = {
  info: (message) => electronUpdaterLog.info(describeUpdaterMessage(message)),
  warn: (message) => electronUpdaterLog.warn(describeUpdaterMessage(message)),
  error: (message) => electronUpdaterLog.error(describeUpdaterMessage(message)),
};

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
/** Wakes the service when a "Remind me" snooze ends, so the banner comes back on time. */
let reminderTimer: NodeJS.Timeout | null = null;
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
/**
 * The update (version AND files) the release's SIGNED manifest vouched for (see
 * update-manifest.ts). electron-updater never downloads on its own (autoDownload
 * is forced off before any check, in wireEvents); this service starts every
 * download, only for this update, and stages only a download that matches it.
 */
let verifiedInfo: UpdateIdentity | null = null;
/**
 * The update the most recent check offered — what electron-updater would now
 * download. Cleared when a new check starts. A verification that finishes after
 * its update was replaced must not start (or approve) a download, because the
 * download would be of the newer, unverified update.
 */
let offeredInfo: UpdateIdentity | null = null;
/** The verification started by the last 'update-available', so a check awaits it. */
let pendingVerification: Promise<void> | null = null;
/**
 * The update that is downloaded, verified and waiting to install on quit.
 *
 * Checks keep running hourly after an update is staged (a newer release may
 * come out), and each used to overwrite the 'downloaded' phase: a slow check
 * timed out, or re-offered the SAME version and failed to re-verify it, and the
 * state became 'error'. A manual check then said "could not be verified" about
 * an update that was sitting on disk, and "Restart now" refused to run.
 */
let stagedInfo: UpdateIdentity | null = null;
/** The version the "ready to install" notification was shown for. Once each. */
let notifiedVersion: string | null = null;

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
  merged.banner = shouldShowReadyBanner({
    phase: merged.phase,
    version: merged.version,
    prefs,
    now: Date.now(),
    prompted: merged.prompt,
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
 * A check that brought nothing newer leaves a staged update exactly where it
 * was: 'downloaded', installable now and on quit. Returns false when nothing is
 * staged, so the caller reports its own outcome.
 */
const keepStagedUpdate = (outcome: string): boolean => {
  if (!stagedInfo) return false;
  logger.info(`[Update] ${outcome}; keeping the staged ${stagedInfo.version}, which still installs on quit`);
  setState({ phase: 'downloaded', version: stagedInfo.version, percent: 100, error: null });
  return true;
};

/**
 * Show the update dialog as if the user had asked — the click on the "ready to
 * install" notification. 'manual' is what makes the dialog open with automatic
 * updates on; the next check resets the trigger.
 */
const openUpdateDialog = (): void => {
  restoreAndFocusWindow(getMainWindow());
  currentTrigger = 'manual';
  dialogDismissed = false;
  setState({});
};

/** Tell the user, once, that an update is staged. A failure only costs the notice. */
const notifyUpdateReady = (version: string): void => {
  notifiedVersion = version;
  try {
    if (!Notification.isSupported()) return;
    const notice = new Notification({
      title: `Sarv Inbox ${version} is ready`,
      body: 'It installs the next time you quit the app. Click to restart now.',
      silent: true,
    });
    notice.on('click', openUpdateDialog);
    notice.show();
  } catch (error) {
    logger.warn('[Update] Could not show the update-ready notification:', error);
  }
};

/**
 * Wire electron-updater's events onto {@link setState}. Called once; the
 * listeners live for the process lifetime.
 */
const wireEvents = (): void => {
  // Before ANY check, not just the scheduled ones: electron-updater starts with
  // autoDownload on, and a "Check for Updates..." click can arrive before
  // startUpdateService runs. A download it started on its own would skip the
  // signed-manifest verification below.
  autoUpdater.autoDownload = false;
  if (wired) return;
  wired = true;

  autoUpdater.on('checking-for-update', () => {
    // Whatever was on offer is being replaced; an older verification still in
    // flight must not download the result of this check.
    offeredInfo = null;
    setState({ phase: 'checking', error: null });
  });

  autoUpdater.on('update-available', (info) => {
    offeredInfo = info;
    // Already downloaded and verified: nothing to verify or fetch again.
    if (stagedInfo && sameUpdate(info, stagedInfo)) {
      pendingVerification = null;
      keepStagedUpdate(`Check found ${info.version} again`);
      return;
    }
    // Verify BEFORE anything is downloaded: the found update must be one the
    // release's signed manifest vouches for, file for file (CASA M-3). The
    // check that found it awaits this, so the dialog never shows an
    // unverified update as available.
    pendingVerification = (async () => {
      verifiedInfo = null;
      const verdict = await verifyUpdate(info);
      if (offeredInfo !== info) {
        logger.info(`[Update] Verification of ${info.version} finished after a newer check replaced it; ignoring it`);
        return;
      }
      if (!verdict.ok) {
        logger.warn(`[Update] Refused ${info.version}: could not verify it against the signed release manifest (${verdict.reason})`);
        if (keepStagedUpdate(`Refused ${info.version}`)) return;
        setState({
          phase: 'error',
          version: null,
          error: `Version ${info.version} could not be verified as a genuine Sarv Inbox release, so it was not downloaded.`,
          checkedAt: Date.now(),
        });
        return;
      }
      verifiedInfo = info;
      // Logged with its cost: a check that takes 15 seconds and a check that
      // hangs are indistinguishable in a log that only records the outcome, and
      // that is precisely the gap that made "Checking for updates..." impossible
      // to diagnose from app.log.
      logger.info(
        `[Update] Update available and verified: ${info.version} (check took ${checkDurationMs()}ms,`,
        prefs.autoUpdate ? 'downloading now)' : 'waiting for the user to ask)',
      );
      if (shouldAutoDownload(prefs)) {
        setState({ phase: 'downloading', version: info.version, percent: 0, error: null });
        startVerifiedDownload();
      } else {
        // With automatic updates off nothing moves until the user presses the
        // button, and 'available' is the phase that asks.
        setState({ phase: 'available', version: info.version, percent: 0, error: null });
      }
    })();
  });

  autoUpdater.on('update-not-available', () => {
    offeredInfo = null;
    verifiedInfo = null;
    if (keepStagedUpdate('No newer update')) return;
    logger.info(`[Update] No update available (check took ${checkDurationMs()}ms)`);
    setState({ phase: 'up-to-date', version: null, checkedAt: Date.now(), error: null });
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', percent: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // Stage only what was verified, file for file. Anything else (a download
    // electron-updater started of a newer check's result) is never installed:
    // install-on-quit is disarmed and 'Restart now' needs phase 'downloaded'.
    if (!verifiedInfo || !sameUpdate(info, verifiedInfo)) {
      autoUpdater.autoInstallOnAppQuit = false;
      logger.warn(`[Update] Refused to stage ${info.version}: it is not the update verified against the signed manifest`);
      setState({
        phase: 'error',
        version: null,
        error: `Version ${info.version} could not be verified as a genuine Sarv Inbox release, so it will not be installed.`,
        checkedAt: Date.now(),
      });
      return;
    }
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
    stagedInfo = info;
    setState({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      checkedAt: Date.now(),
      error: null,
    });
    if (
      shouldNotifyUpdateReady({
        version: info.version,
        prefs,
        now: Date.now(),
        prompted: state.prompt,
        notifiedVersion,
      })
    ) {
      notifyUpdateReady(info.version);
    }
  });

  autoUpdater.on('error', (error) => {
    // Routinely non-fatal: offline, GitHub rate limit, a release with no asset
    // for this platform. Never surfaced for a quiet background cycle — `prompt`
    // stays false unless the user asked or is waiting on a download they
    // started — so it cannot become a recurring popup.
    logger.warn(`[Update] Update check failed after ${checkDurationMs()}ms:`, error);
    if (keepStagedUpdate('Check failed')) return;
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
  const coalescing = checkInFlight || state.phase === 'downloading';

  // A background tick that lands on a run already in progress asks nothing
  // new. Letting it set the trigger turned a manual check into a scheduled one
  // mid-flight (the first check fires 30s after launch, inside the check
  // timeout), so the answer the user pressed for was never shown — and
  // clearing the dismissal reopened a dialog they had closed.
  if (!(coalescing && trigger === 'scheduled')) {
    currentTrigger = trigger;
    // A new check is a new question, so an earlier "Close" no longer applies.
    dialogDismissed = false;
  }

  if (!support.supported) {
    setState({ phase: 'unsupported', error: support.message, version: null });
    return state;
  }

  // A manual press while a check is mid-flight — or while a download is
  // running — re-shows the dialog against the run already in progress rather
  // than starting a second one. Re-checking during a download is the worse of
  // the two: electron-updater would start fetching the same file again.
  if (coalescing) {
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
    // for minutes. An honest failure at the deadline beats a spinner.
    pendingVerification = null;
    await withTimeout(
      autoUpdater.checkForUpdates(),
      UPDATE_CHECK_TIMEOUT_MS,
      `The update server did not respond within ${Math.round(UPDATE_CHECK_TIMEOUT_MS / 1000)} seconds.`,
    );
    // An update found is verified before the check counts as finished (the
    // verification bounds its own requests and never throws).
    if (pendingVerification) await pendingVerification;
  } catch (error) {
    // Two different failures land here. A rejection from electron-updater has
    // already fired the 'error' event, so the state is set and there is nothing
    // to add. A TIMEOUT has fired nothing — the request is still out there —
    // so it has to report itself.
    if (isTimeoutError(error)) {
      logger.warn(`[Update] Check timed out after ${checkDurationMs()}ms`);
      if (!keepStagedUpdate('Check timed out')) {
        setState({
          phase: 'error',
          error: error.message,
          checkedAt: Date.now(),
        });
      }
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

  if (verifiedInfo?.version !== state.version) {
    logger.warn('[Update] Download refused: version', state.version, 'was not verified against a signed manifest');
    return false;
  }

  logger.info('[Update] User asked to download', state.version);
  downloadRequested = true;
  dialogDismissed = false;
  setState({ phase: 'downloading', percent: 0, error: null });
  startVerifiedDownload();
  return true;
};

/** Start electron-updater's download of the update just verified. */
function startVerifiedDownload(): void {
  // A new download replaces whatever was staged (electron-updater clears its
  // cache for it), so a failure from here on must not resurrect the old one.
  stagedInfo = null;
  // The rejection path is the 'error' event, which is already wired; this
  // catch only stops an unhandled rejection from reaching the process.
  void autoUpdater.downloadUpdate().catch((error) => {
    logger.warn('[Update] Download rejected:', error);
  });
}

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

/**
 * Re-arm the wake-up for the current snooze: when it ends, recompute the state
 * so the banner reappears at the moment the user picked — not up to an hour
 * later at the next scheduled check. A no-op when nothing is snoozed.
 */
const scheduleReminderWake = (): void => {
  if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
  const delay = reminderWakeDelay(prefs, Date.now());
  if (delay === null) return;
  reminderTimer = setTimeout(() => {
    reminderTimer = null;
    setState({});
  }, delay);
  reminderTimer.unref?.();
};

/**
 * Record "Remind me later" — no prompts of any kind until `untilMs` (epoch
 * ms, the moment the user picked), or for six hours when none was given.
 */
export const remindAboutUpdateLater = (untilMs?: number): UpdateState => {
  // Note this does NOT disarm the silent install: "later" is about the prompt,
  // not the update. If the user quits before then they still get the new
  // version, which is the whole point of automatic updates.
  const now = Date.now();
  savePrefs(remindLater(prefs, now, resolveRemindAfter(now, untilMs) - now));
  logger.info('[Update] Reminder snoozed until', new Date(prefs.remindAfter ?? 0).toISOString());
  scheduleReminderWake();
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

  // electron-updater never downloads on its own (wireEvents, below, forces
  // autoDownload off before any check): every download starts in this service,
  // after the update is verified against the release's signed manifest.
  // "Install updates automatically" is honoured there instead.
  // Updates are automatic by default: downloaded in the background, then
  // applied during the next ordinary quit, so a user who never touches the
  // dialog still ends up on the new version without doing anything. The
  // dialog's "Restart now" only makes that happen sooner.
  // `skipCurrentVersion()` is the one thing that turns this off, and only for
  // the version that was skipped.
  autoUpdater.autoInstallOnAppQuit = shouldAutoInstallOnQuit(prefs, null);
  autoUpdater.logger = updaterLogger;
  state = { ...state, currentVersion: runningVersion(), autoUpdate: prefs.autoUpdate };

  wireEvents();
  // A snooze chosen before the last quit still ends when it said it would.
  scheduleReminderWake();

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
  if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
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
  verifiedInfo = null;
  offeredInfo = null;
  pendingVerification = null;
  stagedInfo = null;
  notifiedVersion = null;
};
