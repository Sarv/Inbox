/**
 * Update policy — the pure decision layer behind auto-update.
 *
 * Everything here is a plain function over plain data: no Electron, no
 * `autoUpdater`, no filesystem, no clock. The I/O lives in
 * `update-service.ts`, which is the only file that touches electron-updater.
 *
 * The split matters because the interesting bugs in an updater are all
 * *decisions*, not downloads: prompting for a version the user skipped,
 * re-prompting a minute after "remind me later", downloading a hundred
 * megabytes over someone's tether without asking, or nagging someone whose
 * package manager owns the app and for whom the button cannot work at all.
 * Those are cheap to test here and expensive to test through a real download.
 *
 * ## The two modes
 *
 * `prefs.autoUpdate` picks between the two shapes mature desktop apps use:
 *
 *  - **On** (the default, the Chrome/VS Code shape): check quietly, download
 *    quietly, install during a quit the user was performing anyway. The user is
 *    never interrupted; they simply end up on the new version.
 *  - **Off** (the Signal/Slack "ask me" shape): check quietly, then ASK before
 *    spending bandwidth. Nothing downloads until the user presses the button,
 *    and nothing restarts until they press the other one.
 *
 * In both modes a finished download installs on the next ordinary quit, so
 * "Later" is never a decision to stay out of date — only a decision about when
 * to be interrupted.
 */

/** How long "Remind me later" silences the prompt. */
export const REMIND_LATER_MS = 6 * 60 * 60 * 1000;

/** How often the background scheduler asks GitHub whether a release exists. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delay before the FIRST check after launch. Startup is already the busiest
 * moment in the app's life (storage init, IMAP connect, initial sync) and an
 * update is never urgent enough to compete with getting mail on screen.
 */
export const FIRST_CHECK_DELAY_MS = 30 * 1000;

/**
 * How long a single check may take before it is called a failure.
 *
 * There has to be a number here, and it has to be ours. electron-updater's
 * transport (builder-util-runtime) defaults to a 60-SECOND socket timeout and
 * retries server errors three times with a growing backoff, so an unbounded
 * check can legitimately sit there for minutes — which is exactly what it did:
 * "Checking for updates..." with no end and no log line.
 *
 * 20s is chosen against a measured worst case, not a guess. The GitHub feed is
 * two requests: the releases atom feed, and `latest-mac.yml` from
 * `release-assets.githubusercontent.com`. On a network that slow-paths that
 * asset host the TCP connect alone was reproducibly ~14.8s (15.5s wall, three
 * runs). So the budget must clear ~16s to avoid failing a check that would
 * have succeeded, and must stay far enough under a minute that the dialog
 * always answers. Below this, an honest "couldn't reach the server, the next
 * check is in an hour" beats a spinner that never resolves.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 20 * 1000;

/** Who asked. A manual check always reports back, even to say "you're current". */
export type UpdateTrigger = 'manual' | 'scheduled';

export type UpdatePhase =
  /** Nothing in flight and nothing to report. */
  | 'idle'
  /** Asking the update feed whether a newer release exists. */
  | 'checking'
  /** A newer release exists and nothing is being downloaded — waiting on the user. */
  | 'available'
  /** Downloading the update. `percent` is meaningful. */
  | 'downloading'
  /** Staged on disk. "Restart now" is instant from here. */
  | 'downloaded'
  /** The check succeeded and this build is the newest. */
  | 'up-to-date'
  /** This build can never self-update (dev, or a distro package). */
  | 'unsupported'
  /** The check or download failed. `error` carries a human-readable reason. */
  | 'error';

/**
 * The single object the main process pushes to the renderer. The renderer
 * renders it and owns no update state of its own, so a reopened window or a
 * reloaded renderer always shows the truth rather than a stale copy.
 */
export interface UpdateState {
  phase: UpdatePhase;
  /** The version being offered, when one is. */
  version: string | null;
  /** The version running right now, so "you're up to date" can name it. */
  currentVersion: string | null;
  /** Download progress 0-100. Only meaningful while `phase` is 'downloading'. */
  percent: number;
  /** Human-readable failure, set only when `phase` is 'error' or 'unsupported'. */
  error: string | null;
  /** When the last check completed (epoch ms), for "checked just now" copy. */
  checkedAt: number | null;
  /**
   * Whether the renderer should show the dialog. The main process decides this
   * — it is the side that knows the prefs — so the renderer cannot accidentally
   * surface an update the user already skipped.
   */
  prompt: boolean;
  /** What started the current cycle, so the UI can stay quiet for a scheduled one. */
  trigger: UpdateTrigger | null;
  /**
   * Mirror of `prefs.autoUpdate`, so the settings toggle renders from the same
   * pushed state as the dialog instead of keeping a second copy that can drift.
   */
  autoUpdate: boolean;
}

export const INITIAL_UPDATE_STATE: UpdateState = {
  phase: 'idle',
  version: null,
  currentVersion: null,
  percent: 0,
  error: null,
  checkedAt: null,
  prompt: false,
  trigger: null,
  autoUpdate: true,
};

/** What the user has told us to stop doing, persisted across restarts. */
export interface UpdatePrefs {
  /** Exact version the user pressed "Skip" on, or null. */
  skippedVersion: string | null;
  /** Epoch ms before which no prompt may appear, or null. */
  remindAfter: number | null;
  /**
   * Download new versions in the background without asking.
   *
   * Defaults to ON: an out-of-date mail client is a security problem, and the
   * overwhelming majority of users never open a settings pane to turn updates
   * on. The toggle exists for the people who need to control when a hundred
   * megabytes moves — metered connections, locked-down machines — and for them
   * OFF must mean genuinely nothing is fetched until they press the button.
   */
  autoUpdate: boolean;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = Object.freeze({
  skippedVersion: null,
  remindAfter: null,
  autoUpdate: true,
});

/**
 * Read prefs from whatever was on disk. Deliberately total: a corrupt,
 * truncated or hand-edited file degrades to "no preferences" rather than
 * throwing, because a parse error here must never be able to stop the app from
 * updating — or, worse, from starting.
 *
 * Note which way `autoUpdate` falls when the field is missing or the wrong
 * type: ON. A prefs file written by an older build has no such key, and those
 * users were already on automatic updates — reading the absence as "off" would
 * silently strand every existing install on the version it happens to have.
 */
export const parseUpdatePrefs = (raw: unknown): UpdatePrefs => {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_UPDATE_PREFS };
  const record = raw as Record<string, unknown>;

  const skippedVersion =
    typeof record['skippedVersion'] === 'string' && record['skippedVersion'].length > 0
      ? record['skippedVersion']
      : null;

  const remindAfterValue = record['remindAfter'];
  const remindAfter =
    typeof remindAfterValue === 'number' && Number.isFinite(remindAfterValue) && remindAfterValue > 0
      ? remindAfterValue
      : null;

  const autoUpdate =
    typeof record['autoUpdate'] === 'boolean' ? record['autoUpdate'] : DEFAULT_UPDATE_PREFS.autoUpdate;

  return { skippedVersion, remindAfter, autoUpdate };
};

/**
 * Record a "Skip this version" press.
 *
 * Skipping also clears any pending snooze: the user has given a stronger and
 * more specific answer about this version than "not now", and leaving a stale
 * `remindAfter` behind would suppress the NEXT version too.
 */
export const skipVersion = (prefs: UpdatePrefs, version: string): UpdatePrefs => ({
  ...prefs,
  skippedVersion: version,
  remindAfter: null,
});

/** Record a "Remind me later" press: silence every prompt for `delayMs`. */
export const remindLater = (
  prefs: UpdatePrefs,
  now: number,
  delayMs: number = REMIND_LATER_MS,
): UpdatePrefs => ({ ...prefs, remindAfter: now + delayMs });

/** Record the automatic-updates toggle. */
export const setAutoUpdate = (prefs: UpdatePrefs, enabled: boolean): UpdatePrefs => ({
  ...prefs,
  autoUpdate: enabled,
});

/**
 * May electron-updater start fetching the moment it finds a release?
 *
 * This is the whole of what the toggle buys: with it off the check still runs
 * (knowing a version exists costs one small request) but not a byte of the
 * package moves until the user asks.
 */
export const shouldAutoDownload = (prefs: UpdatePrefs): boolean => prefs.autoUpdate;

/**
 * Should the dialog appear for `version`?
 *
 * A MANUAL check always shows something — the user pressed a menu item and
 * silence would read as a broken button, even when they skipped this exact
 * version an hour ago. Only the hourly background check is subject to the
 * user's earlier "skip" and "later" answers.
 *
 * `skippedVersion` is compared by exact string equality rather than by semver
 * ordering on purpose: skipping 1.2.0 must not also swallow 1.2.1. A user who
 * skips one release still gets offered the next one.
 */
export const shouldPromptForUpdate = ({
  version,
  prefs,
  now,
  trigger,
}: {
  version: string;
  prefs: UpdatePrefs;
  now: number;
  trigger: UpdateTrigger;
}): boolean => {
  if (trigger === 'manual') return true;
  if (prefs.skippedVersion === version) return false;
  if (prefs.remindAfter !== null && now < prefs.remindAfter) return false;
  return true;
};

/** Why this build cannot self-update, or null when it can. */
export type UnsupportedReason = 'development' | 'linux-package' | 'unconfigured';

export interface UpdateSupport {
  supported: boolean;
  reason: UnsupportedReason | null;
  /** Copy shown to the user. Empty when supported. */
  message: string;
}

const SUPPORTED: UpdateSupport = Object.freeze({ supported: true, reason: null, message: '' });

/**
 * Can this particular build replace itself?
 *
 * Three cases where it cannot, and all three must be detected rather than
 * discovered through a failed download:
 *
 *  - **A development run** (`pnpm dev:desktop`). Detected through
 *    `process.defaultApp`, which Electron sets when the binary was handed a
 *    script to run, and deliberately NOT through `app.isPackaged`: Electron
 *    derives that from the executable's FILE NAME, and `scripts/postinstall.mjs`
 *    renames the dev binary to brand the Dock tile, so `app.isPackaged` is true
 *    inside `pnpm dev:desktop` on this repo.
 *  - **No update configuration.** electron-updater opens `app-update.yml` in
 *    the resources directory on every check and throws ENOENT when it is
 *    absent. That file is the decisive fact about whether a build can update
 *    itself, so it is checked rather than inferred.
 *  - **A Linux distro package** (.deb / .rpm / .tar.gz). The files are owned by
 *    dpkg/rpm and root; electron-updater cannot and must not overwrite them.
 *    Only the AppImage is self-contained enough to swap itself out, and it
 *    announces itself through the APPIMAGE environment variable that the
 *    AppImage runtime sets.
 *  - Everything else on macOS and Windows is fine: a signed .app updates from
 *    the published .zip, and NSIS updates from the published installer.
 */
export const getUpdateSupport = ({
  platform,
  isDefaultApp,
  hasUpdateConfig,
  isAppImage,
}: {
  platform: NodeJS.Platform;
  /** `process.defaultApp` - Electron running a script rather than an app. */
  isDefaultApp: boolean;
  /** Does `app-update.yml` exist in the build's resources directory? */
  hasUpdateConfig: boolean;
  isAppImage: boolean;
}): UpdateSupport => {
  if (isDefaultApp) {
    return {
      supported: false,
      reason: 'development',
      message: 'Automatic updates are disabled in a development build.',
    };
  }

  if (!hasUpdateConfig) {
    return {
      supported: false,
      reason: 'unconfigured',
      message:
        'This copy was built without update settings, so it cannot update ' +
        'itself. Download the latest version from the website instead.',
    };
  }

  if (platform === 'linux' && !isAppImage) {
    return {
      supported: false,
      reason: 'linux-package',
      message:
        'This copy was installed from a system package, so it updates through ' +
        'your package manager rather than from inside the app.',
    };
  }

  return { ...SUPPORTED };
};

/**
 * Should the renderer show the update dialog right now?
 *
 * Four rules, in the order they are applied, because each exists to stop a
 * specific way of annoying someone:
 *
 *  1. **`dismissed` wins over everything.** This function is re-run on EVERY
 *     state change: without it, "Close" on a manual check computed `true` again
 *     a moment later ("manual, and the phase isn't idle") and the dialog
 *     reopened itself — a Close button that could never close.
 *  2. **Manual: always show something.** The user pressed a button, so
 *     "Downloading 42%", "You're on the latest version" and "Check failed" are
 *     all useful answers, and silence would read as a broken menu item.
 *  3. **A download the user asked for reports back.** Once they press
 *     "Download and install" they are owed the "ready to install" prompt, even
 *     though the cycle that found the update was a background one, and even
 *     though they may have hidden the progress in the meantime.
 *  4. **Otherwise, a background cycle interrupts only when there is a decision
 *     to make.** With automatic updates ON there is none — the download and the
 *     install both happen without the user, so the dialog never opens. With
 *     them OFF the app cannot proceed without an answer, so it asks once the
 *     update is found (and again when a requested download is staged), subject
 *     to the user's earlier "skip" and "later".
 */
export const shouldShowDialog = ({
  phase,
  trigger,
  version,
  prefs,
  now,
  dismissed = false,
  downloadRequested = false,
}: {
  phase: UpdatePhase;
  trigger: UpdateTrigger;
  version: string | null;
  prefs: UpdatePrefs;
  now: number;
  /** The user closed the dialog for the current check; keep it closed. */
  dismissed?: boolean;
  /** The user pressed "Download and install" during this cycle. */
  downloadRequested?: boolean;
}): boolean => {
  if (dismissed) return false;
  if (trigger === 'manual') return phase !== 'idle';
  if (downloadRequested && (phase === 'downloading' || phase === 'downloaded' || phase === 'error')) {
    return true;
  }
  if (prefs.autoUpdate) return false;
  if (phase !== 'available' && phase !== 'downloaded') return false;
  if (version === null) return false;
  return shouldPromptForUpdate({ version, prefs, now, trigger });
};

/**
 * May a downloaded update install ITSELF the next time the app quits, with no
 * button pressed and nothing for the user to do?
 *
 * This is what makes "Later" safe to press. The bytes are already on disk, so
 * the swap costs nothing and happens during a quit the user was performing
 * anyway — the next launch is simply the new version. It applies in BOTH modes:
 * turning automatic updates off means "ask before downloading", not "make me
 * sit through an installer", and a user who has already agreed to the download
 * has agreed to the update.
 *
 * The single exception is an explicit "Skip this version". Silently installing
 * a version the user just declined would make that button a lie, so a skip
 * turns the silent path off for that version — and only that version: the next
 * release installs automatically again.
 */
export const shouldAutoInstallOnQuit = (prefs: UpdatePrefs, version: string | null): boolean =>
  version === null || prefs.skippedVersion !== version;
