// What the update dialog SAYS and which buttons it offers, per phase — pure, so
// the wording and the button set are tested without rendering a dialog or
// faking an installer. Kept out of UpdateDialog.tsx to keep the business logic
// separate from the framework code, same as empty-list-view.ts beside it.
//
// The buttons are the product decision that matters here. An updater that
// restarts a mail client out from under someone mid-reply is worse than one
// that is a week out of date, so every destructive step is a button and never
// an automatic consequence: 'available' asks before spending bandwidth,
// 'downloaded' asks before taking the app away, and "Later" in both places is a
// complete answer — the update still lands on the next ordinary quit.

import type { UpdateState } from '../../electron/services/update-policy';

/** Which handler a button runs. The component owns the IPC; this owns the map. */
export type UpdateDialogAction =
  /** Quit, install the staged update, relaunch. */
  | 'install'
  /** Start fetching the available update. */
  | 'download'
  /** Snooze the prompt for six hours; the update still installs on quit. */
  | 'later'
  /** Never prompt for this exact version again, and don't install it on quit. */
  | 'skip'
  /** Close without recording anything. */
  | 'close';

export interface UpdateDialogButton {
  label: string;
  action: UpdateDialogAction;
}

/**
 * The "Install updates automatically" checkbox, offered inside the dialog.
 *
 * The same switch as the one in Settings -> Advanced -> Updates, deliberately
 * worded identically so it is recognisable as one setting rather than two. It
 * is offered HERE because this is the moment the user is actually thinking
 * about updates; Settings is where you go once you already know the choice
 * exists, which is a poor place to be the only route to it.
 */
export interface UpdateDialogToggle {
  label: string;
  /** Mirrors the main process's stored preference — never local state. */
  checked: boolean;
  /** What ticking it does from HERE, which differs at 'available'. */
  hint: string;
}

export interface UpdateDialogView {
  title: string;
  body: string;
  /** The affirmative button, when there is something to affirm. */
  primary: UpdateDialogButton | null;
  /** The neutral right-hand button. There is always a way out. */
  secondary: UpdateDialogButton;
  /** "Skip this version", far left, only while a specific version is pending. */
  tertiary: UpdateDialogButton | null;
  /** Render the progress bar (phase 'downloading'). */
  showProgress: boolean;
  /** The automatic-updates checkbox, where offering it is truthful. */
  autoUpdateToggle: UpdateDialogToggle | null;
}

/** The product name, so the copy names the thing rather than "an update". */
const PRODUCT = 'Sarv Inbox';

const CLOSE: UpdateDialogButton = { label: 'Close', action: 'close' };
const SKIP: UpdateDialogButton = { label: 'Skip this version', action: 'skip' };

/**
 * A check that is taking long enough for the user to wonder whether it is
 * stuck. It is NOT stuck — the main process bounds it — but a spinner with no
 * explanation is what made this feel broken in the first place, so say so.
 */
const SLOW_CHECK_NOTE =
  '\n\nThis is taking longer than usual. The update server may be slow to reach ' +
  'from your network; the check gives up shortly rather than hanging.';

/** The copy and buttons for a phase. The toggle is added by the caller below. */
function dialogCopy(
  state: UpdateState,
  options: { slowCheck?: boolean },
): Omit<UpdateDialogView, 'autoUpdateToggle'> {
  const named = state.version ? `${PRODUCT} ${state.version}` : `A new version of ${PRODUCT}`;

  switch (state.phase) {
    case 'checking':
      return {
        title: 'Checking for updates…',
        body: `Contacting the update server.${options.slowCheck ? SLOW_CHECK_NOTE : ''}`,
        primary: null,
        secondary: CLOSE,
        tertiary: null,
        showProgress: false,
      };

    // Only reachable with automatic updates off: nothing has been downloaded,
    // and nothing will be until this button is pressed.
    case 'available':
      return {
        title: `${named} is available`,
        body:
          'Downloading it will not interrupt you — you can keep working, and the ' +
          'update is applied when you choose to restart, or the next time you quit.',
        primary: { label: 'Download and install', action: 'download' },
        secondary: { label: 'Remind me later', action: 'later' },
        tertiary: SKIP,
        showProgress: false,
      };

    case 'downloading':
      return {
        title: `Downloading ${named}`,
        body:
          'You can keep working — this happens in the background, and nothing ' +
          'restarts until you say so.',
        primary: null,
        secondary: { label: 'Continue in background', action: 'close' },
        tertiary: null,
        showProgress: true,
      };

    // The one moment worth interrupting for, and still not worth deciding FOR
    // the user: the bytes are on disk, so "Later" costs nothing and keeps
    // whatever they were in the middle of.
    case 'downloaded':
      return {
        title: `${named} is ready to install`,
        body:
          'Restarting takes a few seconds and reopens the app. If you are in the ' +
          'middle of something, choose Later — it installs on its own the next ' +
          'time you quit.',
        primary: { label: 'Restart now', action: 'install' },
        secondary: { label: 'Later', action: 'later' },
        tertiary: SKIP,
        showProgress: false,
      };

    case 'up-to-date':
      return {
        title: "You're on the latest version",
        body: state.currentVersion
          ? `${PRODUCT} ${state.currentVersion} is the newest version available.`
          : `You already have the newest version of ${PRODUCT}.`,
        primary: null,
        secondary: CLOSE,
        tertiary: null,
        showProgress: false,
      };

    case 'unsupported':
      return {
        title: 'Updates are managed elsewhere',
        body: state.error ?? '',
        primary: null,
        secondary: CLOSE,
        tertiary: null,
        showProgress: false,
      };

    case 'error':
      return {
        title: "Couldn't check for updates",
        body: `${state.error ?? 'The update server could not be reached.'}\n\nThis usually means no connection, or a slow route to the update server. The next automatic check is in an hour.`,
        primary: null,
        secondary: CLOSE,
        tertiary: null,
        showProgress: false,
      };

    default:
      return {
        title: 'Updates',
        body: '',
        primary: null,
        secondary: CLOSE,
        tertiary: null,
        showProgress: false,
      };
  }
}

/**
 * Where offering the checkbox is TRUTHFUL.
 *
 * Only phases that reflect a completed, successful look at the update
 * situation. Deliberately not:
 *  - 'checking', where the state is still moving under the user;
 *  - 'unsupported', where no setting can make this build update itself, so a
 *    checkbox would promise something that cannot happen;
 *  - 'error', where the app could not reach the server at all — offering a
 *    preference about automatic downloads while the last one failed reads as
 *    an answer to the failure, which it is not.
 */
const TOGGLE_PHASES: ReadonlySet<UpdateState['phase']> = new Set([
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
]);

function describeAutoUpdateToggle(state: UpdateState): UpdateDialogToggle | null {
  if (!TOGGLE_PHASES.has(state.phase)) return null;

  return {
    label: 'Install updates automatically',
    // The stored preference, not a local guess: this checkbox and the one in
    // Settings are the same switch and must never show different positions.
    checked: state.autoUpdate,
    hint:
      // At 'available' the tick is not just a preference — the main process
      // starts THIS download straight away. Saying so stops it reading as a
      // setting that quietly did something the user did not ask for.
      state.phase === 'available'
        ? 'Downloads this update now, and future ones quietly in the background.'
        : 'New versions download quietly and install the next time you quit.',
  };
}

export function describeUpdateDialog(
  state: UpdateState,
  options: { slowCheck?: boolean } = {},
): UpdateDialogView {
  return {
    ...dialogCopy(state, options),
    autoUpdateToggle: describeAutoUpdateToggle(state),
  };
}

/**
 * The one-line status for the Settings pane.
 *
 * Separate wording from the dialog on purpose: the dialog interrupts and has to
 * justify itself, while this is read by someone who came looking and wants the
 * fact, not the pitch. It deliberately excludes the timestamp — the caller
 * formats that in the reader's own locale and zone at render time.
 */
export function describeUpdateStatus(state: UpdateState): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `${PRODUCT} ${state.version} is available to download.`;
    case 'downloading':
      return `Downloading ${PRODUCT} ${state.version} — ${state.percent}%`;
    case 'downloaded':
      return `${PRODUCT} ${state.version} is ready, and installs the next time you quit.`;
    case 'up-to-date':
      return state.currentVersion
        ? `You're on the latest version (${state.currentVersion}).`
        : "You're on the latest version.";
    case 'unsupported':
      return state.error ?? 'This build cannot update itself.';
    case 'error':
      return `The last check failed: ${state.error ?? 'the update server could not be reached.'}`;
    default:
      return state.currentVersion
        ? `${PRODUCT} ${state.currentVersion}. No check has run yet.`
        : 'No check has run yet.';
  }
}
