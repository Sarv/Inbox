import { describe, expect, it } from 'vitest';

import type { UpdateState } from '../../../../electron/services/update-policy';
import {
  describeUpdateDialog,
  describeUpdateStatus,
} from '../../../../src/components/update-dialog-view';

/**
 * The words the updater says, and the buttons it offers.
 *
 * Pure on purpose, so the copy is testable without an installer: the risk here
 * is not a crash, it is a dialog that tells the user the wrong thing about
 * their machine — that it is downloading when it is not, that it is about to
 * restart when it will not, or that a check is stuck when it is bounded.
 */

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  phase: 'idle',
  version: null,
  currentVersion: '1.2.1',
  percent: 0,
  error: null,
  checkedAt: null,
  trigger: null,
  prompt: false,
  autoUpdate: true,
  ...over,
});

const labels = (view: ReturnType<typeof describeUpdateDialog>) =>
  [view.tertiary?.label, view.secondary.label, view.primary?.label].filter(Boolean);

describe('describeUpdateDialog', () => {
  // The literal ask in this feature: a check that finds nothing must SAY so.
  // Before this, "no update" closed the dialog silently and the user could not
  // tell a successful check from one that died.
  it("names the running version when there is nothing to install", () => {
    const view = describeUpdateDialog(state({ phase: 'up-to-date' }));

    expect(view.title).toBe("You're on the latest version");
    expect(view.body).toBe('Sarv Inbox 1.2.1 is the newest version available.');
    expect(view.primary).toBeNull();
    expect(view.showProgress).toBe(false);
  });

  // A packaged build always knows its version, but a renderer that mounts
  // before the first state push does not. Interpolating undefined would put
  // "Sarv Inbox undefined" in front of the user.
  it('still reassures when the running version is unknown', () => {
    const view = describeUpdateDialog(state({ phase: 'up-to-date', currentVersion: null }));

    expect(view.body).toBe('You already have the newest version of Sarv Inbox.');
    expect(view.body).not.toMatch(/null|undefined/);
  });

  // 'available' exists only because downloading is not automatic here. If its
  // primary were 'install', the button would fire quitAndInstall on an update
  // that has not been downloaded — killing the app and installing nothing.
  it('asks before spending bandwidth, and offers all three answers', () => {
    const view = describeUpdateDialog(state({ phase: 'available', version: '1.3.0' }));

    expect(view.title).toBe('Sarv Inbox 1.3.0 is available');
    expect(view.primary).toEqual({ label: 'Download and install', action: 'download' });
    expect(labels(view)).toEqual(['Skip this version', 'Remind me later', 'Download and install']);
    // The promise that makes pressing it safe mid-reply.
    expect(view.body).toMatch(/will not interrupt you/);
    expect(view.showProgress).toBe(false);
  });

  // Mid-download there is nothing to confirm, and no button may take the app
  // away: the only way out is one that leaves the transfer running.
  it('offers only a way out of the way while downloading', () => {
    const view = describeUpdateDialog(state({ phase: 'downloading', version: '1.3.0', percent: 40 }));

    expect(view.title).toBe('Downloading Sarv Inbox 1.3.0');
    expect(view.primary).toBeNull();
    expect(view.secondary).toEqual({ label: 'Continue in background', action: 'close' });
    expect(view.tertiary).toBeNull();
    expect(view.showProgress).toBe(true);
  });

  /**
   * The moment the user asked to be protected: the update is staged, and the
   * app must not restart itself out from under someone mid-reply. "Later" has
   * to be present AND has to explain that it costs nothing, or people press
   * Restart now out of fear of missing the update.
   */
  it('asks before restarting, and says what Later does', () => {
    const view = describeUpdateDialog(state({ phase: 'downloaded', version: '1.3.0' }));

    expect(view.title).toBe('Sarv Inbox 1.3.0 is ready to install');
    expect(view.primary).toEqual({ label: 'Restart now', action: 'install' });
    expect(view.secondary).toEqual({ label: 'Later', action: 'later' });
    expect(view.tertiary).toEqual({ label: 'Skip this version', action: 'skip' });
    expect(view.body).toMatch(/installs on its own the next time you quit/);
    expect(view.showProgress).toBe(false);
  });

  // A bare spinner with no end in sight is exactly what made a slow check look
  // like a hung app. After a few seconds the dialog has to admit it is slow and
  // say that it gives up rather than hanging.
  it('explains a check that is taking a while, but only once it is', () => {
    const quick = describeUpdateDialog(state({ phase: 'checking' }));
    expect(quick.body).toBe('Contacting the update server.');

    const slow = describeUpdateDialog(state({ phase: 'checking' }), { slowCheck: true });
    expect(slow.body).toMatch(/taking longer than usual/);
    expect(slow.body).toMatch(/gives up shortly rather than hanging/);
  });

  // The real reason beats a generic one: "no route to host" and "rate limited"
  // need different things from the user. A blank body would say nothing at all.
  it('shows the real failure, and falls back when there is none', () => {
    const known = describeUpdateDialog(state({ phase: 'error', error: 'getaddrinfo ENOTFOUND' }));
    expect(known.title).toBe("Couldn't check for updates");
    expect(known.body).toMatch(/^getaddrinfo ENOTFOUND/);
    expect(known.body).toMatch(/next automatic check is in an hour/);

    const blank = describeUpdateDialog(state({ phase: 'error', error: null }));
    expect(blank.body).toMatch(/could not be reached/);
  });

  // A .deb/.rpm or a dev build must not offer a button that cannot work.
  it('offers no action on a build that updates elsewhere', () => {
    const view = describeUpdateDialog(
      state({ phase: 'unsupported', error: 'Updates for this build are handled by your package manager.' }),
    );

    expect(view.primary).toBeNull();
    expect(view.tertiary).toBeNull();
    expect(view.secondary).toEqual({ label: 'Close', action: 'close' });
  });

  // Every phase must produce a usable dialog. A missing case that returned
  // undefined would crash the renderer instead of showing anything.
  it('always leaves a way to close, in every phase', () => {
    const phases: Array<UpdateState['phase']> = [
      'idle', 'checking', 'available', 'downloading', 'downloaded', 'up-to-date', 'unsupported', 'error',
    ];

    for (const phase of phases) {
      const view = describeUpdateDialog(state({ phase, version: '1.3.0' }));
      expect(view.secondary, phase).toBeTruthy();
      expect(view.title, phase).not.toBe('');
    }
  });
});

describe('describeUpdateStatus', () => {
  // Settings is read by someone who came looking for the fact. Each phase has
  // to name its own state — a shared string would tell a user whose download is
  // half done the same thing it tells one who has never checked.
  it('reports each phase distinctly', () => {
    expect(describeUpdateStatus(state({ phase: 'up-to-date' }))).toBe(
      "You're on the latest version (1.2.1).",
    );
    expect(describeUpdateStatus(state({ phase: 'available', version: '1.3.0' }))).toBe(
      'Sarv Inbox 1.3.0 is available to download.',
    );
    expect(describeUpdateStatus(state({ phase: 'downloading', version: '1.3.0', percent: 40 }))).toBe(
      'Downloading Sarv Inbox 1.3.0 — 40%',
    );
    expect(describeUpdateStatus(state({ phase: 'downloaded', version: '1.3.0' }))).toBe(
      'Sarv Inbox 1.3.0 is ready, and installs the next time you quit.',
    );
    expect(describeUpdateStatus(state({ phase: 'checking' }))).toBe('Checking for updates…');
  });

  // The state the pane is in on a fresh launch, before any check has run. It
  // must not claim to be up to date - nothing has been checked yet.
  it('does not claim to be up to date before any check has run', () => {
    const line = describeUpdateStatus(state({ phase: 'idle' }));

    expect(line).toBe('Sarv Inbox 1.2.1. No check has run yet.');
    expect(line).not.toMatch(/latest version/);
  });

  // A failed check must be visible here too, with its reason - this pane is
  // where someone looks when the app seems not to be updating.
  it('surfaces the last failure', () => {
    expect(describeUpdateStatus(state({ phase: 'error', error: 'ENOTFOUND' }))).toBe(
      'The last check failed: ENOTFOUND',
    );
  });

  // The timestamp is deliberately NOT in this string: the caller renders
  // checkedAt with toLocaleString so it lands in the reader's own zone.
  it('leaves the timestamp to the caller', () => {
    const line = describeUpdateStatus(state({ phase: 'up-to-date', checkedAt: Date.parse('2026-09-25T06:00:00Z') }));

    expect(line).not.toMatch(/2026|:\d\d/);
  });
});

describe('the automatic-updates checkbox', () => {
  /**
   * The discovery problem this exists for: before it, the ONLY route to the
   * automatic-updates preference was knowing that Settings has an Advanced tab.
   * A user being asked about an update is exactly the user who wants to say
   * "stop asking me" — so the switch has to be reachable from here.
   */
  it('is offered at the moment the user is deciding about an update', () => {
    for (const phase of ['available', 'downloading', 'downloaded', 'up-to-date'] as const) {
      const view = describeUpdateDialog(state({ phase, version: '1.3.0' }));
      expect(view.autoUpdateToggle?.label, phase).toBe('Install updates automatically');
    }
  });

  /**
   * And NOT where it would be a lie or a non-sequitur. 'unsupported' is the one
   * that matters: no setting can make a .deb update itself, so a checkbox there
   * promises something that cannot happen. 'error' would read as an answer to
   * the failure, and 'checking' is still moving under the user.
   */
  it('is withheld where it would promise something untrue', () => {
    for (const phase of ['idle', 'checking', 'unsupported', 'error'] as const) {
      const view = describeUpdateDialog(state({ phase }));
      expect(view.autoUpdateToggle, phase).toBeNull();
    }
  });

  // It is the SAME switch as the one in Settings, so it must render the stored
  // preference. Local state here would let the two disagree, and the user would
  // have no way to tell which one was real.
  it('mirrors the stored preference rather than a default', () => {
    expect(describeUpdateDialog(state({ phase: 'downloaded', autoUpdate: true })).autoUpdateToggle)
      .toMatchObject({ checked: true });
    expect(describeUpdateDialog(state({ phase: 'downloaded', autoUpdate: false })).autoUpdateToggle)
      .toMatchObject({ checked: false });
  });

  /**
   * Ticking it at 'available' does not just record a preference — the main
   * process starts THIS download immediately. Without saying so, the dialog
   * would appear to begin a download the user never pressed a button for, on a
   * connection they may have turned this off to protect.
   */
  it('warns that ticking it at available starts this download now', () => {
    const available = describeUpdateDialog(state({ phase: 'available', version: '1.3.0' }));
    expect(available.autoUpdateToggle?.hint).toBe(
      'Downloads this update now, and future ones quietly in the background.',
    );

    // Everywhere else the bytes are already spent, so it is only about future
    // versions and must not claim to start anything.
    const staged = describeUpdateDialog(state({ phase: 'downloaded', version: '1.3.0' }));
    expect(staged.autoUpdateToggle?.hint).toBe(
      'New versions download quietly and install the next time you quit.',
    );
    expect(staged.autoUpdateToggle?.hint).not.toMatch(/now/);
  });

  // The checkbox is an aside, not an answer: it must never replace the buttons
  // that actually resolve the dialog.
  it('never displaces the dialog\'s own answers', () => {
    const view = describeUpdateDialog(state({ phase: 'downloaded', version: '1.3.0' }));

    expect(view.autoUpdateToggle).not.toBeNull();
    expect(view.primary).toEqual({ label: 'Restart now', action: 'install' });
    expect(view.secondary).toEqual({ label: 'Later', action: 'later' });
  });
});
