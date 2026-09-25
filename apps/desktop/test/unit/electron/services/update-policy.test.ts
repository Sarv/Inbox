import { describe, it, expect } from 'vitest';

import {
  DEFAULT_UPDATE_PREFS,
  REMIND_LATER_MS,
  getUpdateSupport,
  parseUpdatePrefs,
  remindLater,
  setAutoUpdate,
  shouldAutoDownload,
  shouldAutoInstallOnQuit,
  shouldPromptForUpdate,
  shouldShowDialog,
  skipVersion,
  type UpdatePhase,
  type UpdatePrefs,
} from '../../../../electron/services/update-policy';

// The updater's real failure modes are all decisions, not downloads: nagging a
// user who pressed "Skip", re-prompting a minute after "Remind me later", or
// offering an in-app update to someone whose distro package manager owns the
// files. Each test below names the one it guards.

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const prefs = (over: Partial<UpdatePrefs> = {}): UpdatePrefs => ({
  ...DEFAULT_UPDATE_PREFS,
  ...over,
});

describe('parseUpdatePrefs', () => {
  // If this throws instead of degrading, a corrupt prefs file takes the whole
  // update system down with it - and on a bad enough path, startup too.
  it('falls back to defaults for anything that is not a usable object', () => {
    for (const bad of [null, undefined, 'nonsense', 42, [], true]) {
      expect(parseUpdatePrefs(bad)).toEqual(DEFAULT_UPDATE_PREFS);
    }
  });

  // If this fails, a hand-edited or partially-written file resurrects a prompt
  // the user already dismissed, or (worse) silences one forever.
  it('keeps only well-formed fields and drops junk', () => {
    expect(parseUpdatePrefs({ skippedVersion: '1.2.0', remindAfter: NOW })).toEqual({
      skippedVersion: '1.2.0',
      remindAfter: NOW,
      autoUpdate: true,
    });
    expect(parseUpdatePrefs({ skippedVersion: '', remindAfter: 0 })).toEqual(DEFAULT_UPDATE_PREFS);
    expect(parseUpdatePrefs({ skippedVersion: 7, remindAfter: 'soon' })).toEqual(DEFAULT_UPDATE_PREFS);
    expect(parseUpdatePrefs({ remindAfter: Number.NaN })).toEqual(DEFAULT_UPDATE_PREFS);
    // A negative timestamp is in the past anyway; treating it as "no snooze"
    // avoids a clock-skew value silently meaning "prompt always".
    expect(parseUpdatePrefs({ remindAfter: -1 })).toEqual(DEFAULT_UPDATE_PREFS);
  });
});

describe('skipVersion', () => {
  // If skipping did not clear the snooze, a leftover remindAfter would also
  // suppress the NEXT release for up to six hours.
  it('records the version and clears any pending snooze', () => {
    expect(skipVersion(prefs({ remindAfter: NOW + 1000 }), '1.2.0')).toEqual({
      skippedVersion: '1.2.0',
      remindAfter: null,
      autoUpdate: true,
    });
  });
});

describe('remindLater', () => {
  // If the delay were wrong the prompt would return within the same session,
  // which is the exact nagging the button exists to stop.
  it('snoozes for six hours from now', () => {
    expect(remindLater(prefs(), NOW)).toEqual({
      skippedVersion: null,
      remindAfter: NOW + REMIND_LATER_MS,
      autoUpdate: true,
    });
    expect(REMIND_LATER_MS).toBe(6 * 60 * 60 * 1000);
  });

  // If this dropped skippedVersion, pressing "later" would undo an earlier skip.
  it('leaves a recorded skip intact', () => {
    expect(remindLater(prefs({ skippedVersion: '1.1.0' }), NOW).skippedVersion).toBe('1.1.0');
  });
});

describe('shouldPromptForUpdate', () => {
  // If this returned false, "Check for Updates" would look like a dead menu
  // item for anyone who had ever pressed Skip or Later.
  it('always prompts for a MANUAL check, whatever the user answered before', () => {
    const answered = prefs({ skippedVersion: '1.2.0', remindAfter: NOW + REMIND_LATER_MS });
    expect(
      shouldPromptForUpdate({ version: '1.2.0', prefs: answered, now: NOW, trigger: 'manual' }),
    ).toBe(true);
  });

  // If this failed, "Skip this version" would do nothing on the next hourly tick.
  it('stays silent for a scheduled check on the exact version that was skipped', () => {
    expect(
      shouldPromptForUpdate({
        version: '1.2.0',
        prefs: prefs({ skippedVersion: '1.2.0' }),
        now: NOW,
        trigger: 'scheduled',
      }),
    ).toBe(false);
  });

  // THE important one: skipping a release must not swallow every release after
  // it. A user who skips 1.2.0 and never hears about 1.2.1 is stranded on an
  // old build forever - including through a security fix.
  it('still prompts for a DIFFERENT version than the one skipped', () => {
    const skipped = prefs({ skippedVersion: '1.2.0' });
    for (const version of ['1.2.1', '1.3.0', '2.0.0']) {
      expect(
        shouldPromptForUpdate({ version, prefs: skipped, now: NOW, trigger: 'scheduled' }),
      ).toBe(true);
    }
  });

  // If the comparison were inverted or off by a millisecond, "Remind me later"
  // would be a no-op on the very next hourly tick.
  it('honours the snooze window and prompts again once it expires', () => {
    const snoozed = prefs({ remindAfter: NOW + REMIND_LATER_MS });
    const ask = (now: number) =>
      shouldPromptForUpdate({ version: '1.2.0', prefs: snoozed, now, trigger: 'scheduled' });

    expect(ask(NOW)).toBe(false);
    expect(ask(NOW + REMIND_LATER_MS - 1)).toBe(false);
    // The boundary is inclusive: at exactly six hours the snooze is over.
    expect(ask(NOW + REMIND_LATER_MS)).toBe(true);
    expect(ask(NOW + REMIND_LATER_MS + 1)).toBe(true);
  });
});

describe('shouldShowDialog', () => {
  const everyPhase: UpdatePhase[] = [
    'checking',
    'available',
    'downloading',
    'downloaded',
    'up-to-date',
    'unsupported',
    'error',
  ];

  // If a manual check stayed silent for any of these, the menu item would
  // appear broken exactly when something had gone wrong.
  it('reports every outcome of a manual check, including failures', () => {
    for (const phase of everyPhase) {
      expect(
        shouldShowDialog({ phase, trigger: 'manual', version: '1.2.0', prefs: prefs(), now: NOW }),
      ).toBe(true);
    }
    // 'idle' is the one phase with nothing to say.
    expect(
      shouldShowDialog({ phase: 'idle', trigger: 'manual', version: null, prefs: prefs(), now: NOW }),
    ).toBe(false);
  });

  // BEHAVIOUR CHANGE (was: prompt at 'downloaded'). With automatic updates on
  // there is no decision left for the user to make - the download and the
  // install both happen without them - so a background cycle must never
  // interrupt. Someone mid-reply being asked to restart a mail client is the
  // exact interruption the toggle's ON position promises not to cause.
  it('never interrupts a background cycle while automatic updates are on', () => {
    for (const phase of everyPhase) {
      expect(
        shouldShowDialog({ phase, trigger: 'scheduled', version: '1.2.0', prefs: prefs(), now: NOW }),
      ).toBe(false);
    }
  });

  // The other half: with automatic updates OFF the app cannot proceed without
  // an answer, so it must ask - at 'available' (before spending bandwidth) and
  // again at 'downloaded' (before taking the app away). If this regressed,
  // turning the toggle off would mean never hearing about an update again.
  it('asks a background cycle at available and downloaded when automatic updates are off', () => {
    const manual = prefs({ autoUpdate: false });
    const ask = (phase: UpdatePhase) =>
      shouldShowDialog({ phase, trigger: 'scheduled', version: '1.2.0', prefs: manual, now: NOW });

    expect(ask('available')).toBe(true);
    expect(ask('downloaded')).toBe(true);
    for (const phase of ['checking', 'downloading', 'up-to-date', 'unsupported', 'error'] as UpdatePhase[]) {
      expect(ask(phase)).toBe(false);
    }
  });

  // A download the user pressed the button for owes them the "ready to install"
  // prompt, even though the cycle that found it was a background one and even
  // though they may have hidden the progress bar. Without this the request
  // finished in silence and the update just sat there.
  it('reports back on a download the user asked for', () => {
    const asked = { trigger: 'scheduled' as const, version: '1.2.0', now: NOW, downloadRequested: true };
    expect(shouldShowDialog({ ...asked, phase: 'downloading', prefs: prefs() })).toBe(true);
    expect(shouldShowDialog({ ...asked, phase: 'downloaded', prefs: prefs() })).toBe(true);
    // Including the failure: a download that dies after the user asked for it
    // must say so rather than leaving a dialog that never resolves.
    expect(shouldShowDialog({ ...asked, phase: 'error', prefs: prefs() })).toBe(true);
    // ...and it does not resurrect a dialog the user explicitly closed.
    expect(
      shouldShowDialog({ ...asked, phase: 'downloaded', prefs: prefs(), dismissed: true }),
    ).toBe(false);
  });

  // `prompt` is recomputed on every state change, so "the user closed it" has
  // to be an INPUT to the decision. Without this, Close on a manual check
  // recomputed to true a moment later and the dialog reopened itself.
  it('stays closed once dismissed, whatever the trigger or phase', () => {
    for (const phase of everyPhase) {
      for (const trigger of ['manual', 'scheduled'] as const) {
        expect(
          shouldShowDialog({
            phase,
            trigger,
            version: '1.2.0',
            prefs: prefs(),
            now: NOW,
            dismissed: true,
          }),
        ).toBe(false);
      }
    }
  });

  // If a background error raised the dialog, an offline laptop would produce a
  // popup every single hour.
  it('never surfaces a background check failure', () => {
    expect(
      shouldShowDialog({ phase: 'error', trigger: 'scheduled', version: null, prefs: prefs(), now: NOW }),
    ).toBe(false);
  });

  // The prefs must still apply at the point the dialog would actually appear,
  // not only inside shouldPromptForUpdate.
  it('respects skip and snooze for a completed scheduled download', () => {
    const base = { phase: 'downloaded' as const, trigger: 'scheduled' as const, version: '1.2.0', now: NOW };
    expect(shouldShowDialog({ ...base, prefs: prefs({ skippedVersion: '1.2.0' }) })).toBe(false);
    expect(shouldShowDialog({ ...base, prefs: prefs({ remindAfter: NOW + 1 }) })).toBe(false);
  });
});

describe('getUpdateSupport', () => {
  // If dev builds tried to self-update, every `pnpm dev` run would throw on the
  // missing app-update.yml 30 seconds after launch.
  it('refuses to update an unpackaged build on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
      const support = getUpdateSupport({ platform, isPackaged: false, isAppImage: false });
      expect(support).toMatchObject({ supported: false, reason: 'development' });
      expect(support.message).toBeTruthy();
    }
  });

  // THE one that protects users' machines: a .deb/.rpm install is owned by the
  // package manager and root. Letting electron-updater try to overwrite it
  // either fails confusingly or corrupts a system-managed install.
  it('refuses on a Linux distro package but allows an AppImage', () => {
    expect(
      getUpdateSupport({ platform: 'linux', isPackaged: true, isAppImage: false }),
    ).toMatchObject({ supported: false, reason: 'linux-package' });

    expect(
      getUpdateSupport({ platform: 'linux', isPackaged: true, isAppImage: true }),
    ).toMatchObject({ supported: true, reason: null });
  });

  // If these regressed, macOS and Windows - where auto-update genuinely works -
  // would silently lose it.
  it('allows a packaged macOS or Windows build', () => {
    for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
      expect(getUpdateSupport({ platform, isPackaged: true, isAppImage: false })).toMatchObject({
        supported: true,
        reason: null,
        message: '',
      });
    }
  });
});

describe('shouldAutoInstallOnQuit', () => {
  // This is what makes updates automatic: with no answer from the user at all,
  // the staged update must still apply on the next quit.
  it('installs on quit by default', () => {
    expect(shouldAutoInstallOnQuit(prefs(), '1.2.0')).toBe(true);
    expect(shouldAutoInstallOnQuit(prefs(), null)).toBe(true);
  });

  // If this returned true, "Skip this version" would be a lie - the version
  // would install itself anyway the next time the app closed.
  it('does not install a version the user explicitly skipped', () => {
    expect(shouldAutoInstallOnQuit(prefs({ skippedVersion: '1.2.0' }), '1.2.0')).toBe(false);
  });

  // A skip is scoped to one version here too, or a single skip would disable
  // automatic updates permanently.
  it('still auto-installs the NEXT version after a skip', () => {
    expect(shouldAutoInstallOnQuit(prefs({ skippedVersion: '1.2.0' }), '1.2.1')).toBe(true);
  });

  // "Remind me later" is about the prompt, not the update - the whole point of
  // automatic updates is that ignoring the dialog still gets you updated.
  it('still auto-installs while a snooze is active', () => {
    expect(shouldAutoInstallOnQuit(prefs({ remindAfter: NOW + REMIND_LATER_MS }), '1.2.0')).toBe(true);
  });
});

describe('setAutoUpdate / shouldAutoDownload', () => {
  // The toggle is the ONLY thing standing between a metered connection and a
  // hundred-megabyte download nobody asked for. If shouldAutoDownload ignored
  // it, turning it off would change nothing at all.
  it('gates background downloading on the preference', () => {
    expect(shouldAutoDownload(prefs())).toBe(true);
    expect(shouldAutoDownload(prefs({ autoUpdate: false }))).toBe(false);
    expect(shouldAutoDownload(setAutoUpdate(prefs(), false))).toBe(false);
    expect(shouldAutoDownload(setAutoUpdate(prefs({ autoUpdate: false }), true))).toBe(true);
  });

  // If the toggle cleared these, flipping it would quietly undo a skip the user
  // recorded - and re-offer a version they had declined.
  it('leaves the skip and snooze answers untouched', () => {
    const answered = prefs({ skippedVersion: '1.2.0', remindAfter: NOW + 1000 });
    expect(setAutoUpdate(answered, false)).toEqual({ ...answered, autoUpdate: false });
  });
});

describe('automatic updates default', () => {
  // THE upgrade-path regression. A prefs file written by any build before the
  // toggle existed has no `autoUpdate` key. Reading that absence as "off" would
  // silently strand every existing install on the version it happened to have -
  // a mail client that stops receiving security fixes and never says so.
  it('is ON for a prefs file that predates the toggle', () => {
    expect(parseUpdatePrefs({ skippedVersion: null, remindAfter: null }).autoUpdate).toBe(true);
    expect(DEFAULT_UPDATE_PREFS.autoUpdate).toBe(true);
  });

  // A hand-edited or corrupted value must not be read as a confident "off"
  // either - same stranding, harder to notice.
  it('is ON for a junk value, and only a real false turns it off', () => {
    expect(parseUpdatePrefs({ autoUpdate: 'no' }).autoUpdate).toBe(true);
    expect(parseUpdatePrefs({ autoUpdate: 0 }).autoUpdate).toBe(true);
    expect(parseUpdatePrefs({ autoUpdate: null }).autoUpdate).toBe(true);
    expect(parseUpdatePrefs({ autoUpdate: false }).autoUpdate).toBe(false);
  });
});
