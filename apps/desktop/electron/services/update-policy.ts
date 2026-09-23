/**
 * Update policy — the pure decision layer behind auto-update.
 *
 * Everything here is a plain function over plain data: no Electron, no
 * `autoUpdater`, no filesystem, no clock. The I/O lives in
 * `update-service.ts`, which is the only file that touches electron-updater.
 *
 * The split matters because the interesting bugs in an updater are all
 * *decisions*, not downloads: prompting for a version the user skipped,
 * re-prompting a minute after "remind me later", or nagging someone whose
 * package manager owns the app and for whom the button cannot work at all.
 * Those are cheap to test here and expensive to test through a real download.
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

/** Who asked. A manual check always reports back, even to say "you're current". */
export type UpdateTrigger = 'manual' | 'scheduled';

export type UpdatePhase =
  /** Nothing in flight and nothing to report. */
  | 'idle'
  /** Asking the update feed whether a newer release exists. */
  | 'checking'
  /** A newer release exists; the download has not finished. */
  | 'available'
  /** Downloading the update in the background. `percent` is meaningful. */
  | 'downloading'
  /** Staged on disk. "Install and Relaunch" is instant from here. */
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
}

export const INITIAL_UPDATE_STATE: UpdateState = {
  phase: 'idle',
  version: null,
  percent: 0,
  error: null,
  checkedAt: null,
  prompt: false,
  trigger: null,
};

/** What the user has told us to stop doing, persisted across restarts. */
export interface UpdatePrefs {
  /** Exact version the user pressed "Skip" on, or null. */
  skippedVersion: string | null;
  /** Epoch ms before which no prompt may appear, or null. */
  remindAfter: number | null;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = Object.freeze({
  skippedVersion: null,
  remindAfter: null,
});

/**
 * Read prefs from whatever was on disk. Deliberately total: a corrupt,
 * truncated or hand-edited file degrades to "no preferences" rather than
 * throwing, because a parse error here must never be able to stop the app from
 * updating — or, worse, from starting.
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

  return { skippedVersion, remindAfter };
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
export type UnsupportedReason = 'development' | 'linux-package';

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
 *  - **Not packaged** (`pnpm dev`). There is no `app-update.yml` beside the
 *    binary, so electron-updater throws on the first check.
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
  isPackaged,
  isAppImage,
}: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isAppImage: boolean;
}): UpdateSupport => {
  if (!isPackaged) {
    return {
      supported: false,
      reason: 'development',
      message: 'Automatic updates are disabled in a development build.',
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
 * The two triggers deserve different answers, which is the whole reason this is
 * a function rather than `phase === 'downloaded'`:
 *
 *  - **Manual** ("Check for Updates"): always show something. The user pressed a
 *    button, so "Downloading 42%", "You're up to date" and "Check failed" are
 *    all useful answers, and silence would read as a broken menu item.
 *  - **Scheduled** (hourly): only interrupt once the update is fully downloaded,
 *    so the primary button installs instantly instead of appearing and then
 *    making the user wait on a progress bar they did not ask for. And only then
 *    if the user has not skipped this version or asked to be reminded later.
 */
export const shouldShowDialog = ({
  phase,
  trigger,
  version,
  prefs,
  now,
}: {
  phase: UpdatePhase;
  trigger: UpdateTrigger;
  version: string | null;
  prefs: UpdatePrefs;
  now: number;
}): boolean => {
  if (trigger === 'manual') return phase !== 'idle';
  if (phase !== 'downloaded' || version === null) return false;
  return shouldPromptForUpdate({ version, prefs, now, trigger });
};

/**
 * May a downloaded update install ITSELF the next time the app quits, with no
 * button pressed and nothing for the user to do?
 *
 * This is what makes updates automatic in the Chrome sense: the download
 * happens in the background, and the swap happens during a quit the user was
 * performing anyway, so the next launch is simply the new version. The dialog's
 * "Install and Relaunch" only exists to do that sooner.
 *
 * The single exception is an explicit "Skip this version". Silently installing
 * a version the user just declined would make that button a lie, so a skip
 * turns the silent path off for that version — and only that version: the next
 * release installs automatically again.
 */
export const shouldAutoInstallOnQuit = (prefs: UpdatePrefs, version: string | null): boolean =>
  version === null || prefs.skippedVersion !== version;
