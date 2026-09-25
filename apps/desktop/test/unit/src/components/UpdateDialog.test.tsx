// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../../../electron/services/update-policy';
import { UpdateDialog } from '../../../../src/components/UpdateDialog';
import { act, fire, render, settle, toggle } from '../../../helpers/render';

/**
 * The dialog's wiring: which IPC call each button makes.
 *
 * The copy is covered by update-dialog-view.test.ts; what is tested here is the
 * part that can send the WRONG command to the main process. A "Download and
 * install" button wired to `install` would quit the app and install nothing; a
 * "Later" wired to `skip` would permanently suppress a version the user only
 * wanted to postpone. Both look correct on screen.
 */

/** What every updater IPC call replies with. */
interface Reply {
  success: boolean;
  data?: UpdateState;
  error?: string;
}

const updater = {
  getState: vi.fn(),
  onState: vi.fn(),
  install: vi.fn(async (): Promise<Reply> => ({ success: true })),
  download: vi.fn(async (): Promise<Reply> => ({ success: true })),
  setAutoUpdate: vi.fn(async (): Promise<Reply> => ({ success: true })),
  check: vi.fn(async (): Promise<Reply> => ({ success: true })),
  skip: vi.fn(async () => ({ success: true })),
  remindLater: vi.fn(async () => ({ success: true })),
  dismiss: vi.fn(async () => ({ success: true })),
};

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  phase: 'idle',
  version: null,
  currentVersion: '1.2.1',
  percent: 0,
  error: null,
  checkedAt: null,
  trigger: null,
  prompt: true,
  autoUpdate: true,
  ...over,
});

/** Mount with the main process reporting `initial`, and a handle to push more. */
const mount = async (initial: UpdateState) => {
  let push: ((next: UpdateState) => void) | undefined;
  updater.getState.mockResolvedValue({ success: true, data: initial });
  updater.onState.mockImplementation((handler: (next: UpdateState) => void) => {
    push = handler;
    return () => {};
  });
  const view = render(<UpdateDialog />);
  await settle();
  // Wrapped in act: a push from the main process is a React state update, and
  // an unwrapped one asserts against a tree React has not flushed yet.
  return { ...view, push: (next: UpdateState) => act(() => push?.(next)) };
};

const button = (view: { all: (s: string) => HTMLElement[] }, label: string) =>
  view.all('button').find((el) => el.textContent?.trim() === label) ?? null;

beforeEach(() => {
  Object.values(updater).forEach((fn) => fn.mockClear?.());
  (window as unknown as { electronAPI: unknown }).electronAPI = { updater };
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('UpdateDialog', () => {
  // The main process decides when to interrupt (update-policy.ts). If the
  // renderer opened on its own it would raise a popup during a silent
  // background cycle - the exact interruption automatic updates promise not to
  // cause.
  it('shows nothing unless the main process asked for it', async () => {
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0', prompt: false }));

    expect(view.find('[role="dialog"]')).toBeNull();

    view.push(state({ phase: 'downloaded', version: '1.3.0', prompt: true }));
    await settle();

    expect(view.find('[role="dialog"]')).not.toBeNull();
    expect(view.container.textContent).toContain('Sarv Inbox 1.3.0 is ready to install');
    view.unmount();
  });

  // Each button's own IPC call, asserted against the others NOT being made.
  // Wiring Later to skip is invisible on screen and permanently suppresses a
  // version the user only postponed.
  it('sends install for Restart now, and nothing else', async () => {
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0' }));

    fire(button(view, 'Restart now'), 'click');
    await settle();

    expect(updater.install).toHaveBeenCalledTimes(1);
    expect(updater.skip).not.toHaveBeenCalled();
    expect(updater.remindLater).not.toHaveBeenCalled();
    view.unmount();
  });

  it('sends remindLater for Later, never skip', async () => {
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0' }));

    fire(button(view, 'Later'), 'click');
    await settle();

    expect(updater.remindLater).toHaveBeenCalledTimes(1);
    expect(updater.skip).not.toHaveBeenCalled();
    expect(updater.install).not.toHaveBeenCalled();
    view.unmount();
  });

  it('sends skip for Skip this version', async () => {
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0' }));

    fire(button(view, 'Skip this version'), 'click');
    await settle();

    expect(updater.skip).toHaveBeenCalledTimes(1);
    expect(updater.remindLater).not.toHaveBeenCalled();
    view.unmount();
  });

  /**
   * The button that only exists because downloading is not automatic. Wired to
   * `install` it would call quitAndInstall on an update that has not been
   * downloaded: the app dies and nothing is installed.
   */
  it('sends download - not install - for Download and install', async () => {
    const view = await mount(state({ phase: 'available', version: '1.3.0', autoUpdate: false }));

    fire(button(view, 'Download and install'), 'click');
    await settle();

    expect(updater.download).toHaveBeenCalledTimes(1);
    expect(updater.install).not.toHaveBeenCalled();
    view.unmount();
  });

  // Closing must record NOTHING: dismiss answers this one dialog, while skip and
  // remindLater are persisted answers that change what happens for hours or
  // forever.
  it('records nothing when closed, by button, backdrop or Escape', async () => {
    const view = await mount(state({ phase: 'up-to-date' }));

    fire(button(view, 'Close'), 'click');
    await settle();
    expect(updater.dismiss).toHaveBeenCalledTimes(1);

    view.push(state({ phase: 'up-to-date' }));
    await settle();
    fire(view.find('[role="dialog"]'), 'click');
    await settle();
    expect(updater.dismiss).toHaveBeenCalledTimes(2);

    view.push(state({ phase: 'up-to-date' }));
    await settle();
    fire(document.body, 'keydown', { key: 'Escape' });
    await settle();
    expect(updater.dismiss).toHaveBeenCalledTimes(3);

    expect(updater.skip).not.toHaveBeenCalled();
    expect(updater.remindLater).not.toHaveBeenCalled();
    view.unmount();
  });

  // A press that cannot proceed must say so. Without this the user gets a
  // spinner that never resolves, or silence, and presses again.
  it('explains a restart that can no longer happen', async () => {
    updater.install.mockResolvedValueOnce({ success: false });
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0' }));

    fire(button(view, 'Restart now'), 'click');
    await settle();

    expect(view.container.textContent).toContain('That update is no longer ready');
    // And the button must be pressable again, not stuck on "Restarting…".
    expect(button(view, 'Restart now')).not.toBeNull();
    view.unmount();
  });

  it('explains a download that can no longer happen', async () => {
    updater.download.mockResolvedValueOnce({ success: false });
    const view = await mount(state({ phase: 'available', version: '1.3.0', autoUpdate: false }));

    fire(button(view, 'Download and install'), 'click');
    await settle();

    expect(view.container.textContent).toContain('That update is no longer available');
    view.unmount();
  });

  // Progress has to be readable to a screen reader as well as visible, since
  // this is the one phase with no text that changes.
  it('reports download progress', async () => {
    const view = await mount(state({ phase: 'downloading', version: '1.3.0', percent: 40 }));

    const bar = view.find('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('40');
    expect(view.container.textContent).toContain('40%');
    view.unmount();
  });

  /**
   * The slow-check note, and the reason this whole area was reopened: a check
   * against a slow route to the update server sat on "Contacting the update
   * server" for fifteen seconds with nothing to say, which reads as a hung app.
   * It must NOT appear immediately - on a fast check the note would be a lie.
   */
  it('admits a slow check only after it has actually been slow', async () => {
    vi.useFakeTimers();
    const view = await mount(state({ phase: 'checking' }));

    expect(view.container.textContent).toContain('Contacting the update server.');
    expect(view.container.textContent).not.toContain('taking longer than usual');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(view.container.textContent).toContain('taking longer than usual');
    view.unmount();
  });

  // The note must not outlive the check: left on, a fast "you're on the latest
  // version" would carry a warning about a slow server that just answered.
  it('drops the slow note as soon as the check finishes', async () => {
    vi.useFakeTimers();
    const view = await mount(state({ phase: 'checking' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(view.container.textContent).toContain('taking longer than usual');

    view.push(state({ phase: 'up-to-date' }));
    await settle();

    expect(view.container.textContent).not.toContain('taking longer than usual');
    expect(view.container.textContent).toContain("You're on the latest version");
    view.unmount();
  });
});

describe('UpdateDialog automatic-updates checkbox', () => {
  const checkbox = (view: { find: (s: string) => HTMLElement | null }) =>
    view.find('input[type="checkbox"]') as HTMLInputElement | null;

  // The whole reason it is here: a user looking at an update prompt can turn
  // automatic updates on without first discovering that Settings has an
  // Advanced tab.
  it('offers the switch from inside the prompt', async () => {
    const view = await mount(state({ phase: 'available', version: '1.3.0', autoUpdate: false }));

    expect(checkbox(view)).not.toBeNull();
    expect(view.container.textContent).toContain('Install updates automatically');
    view.unmount();
  });

  // Sending the wrong value would turn automatic downloads ON for someone who
  // just turned them off - on a metered connection, the exact harm the setting
  // exists to prevent.
  it('sends the new position, and does not answer the dialog', async () => {
    const view = await mount(state({ phase: 'available', version: '1.3.0', autoUpdate: false }));

    toggle(checkbox(view));
    await settle();

    expect(updater.setAutoUpdate).toHaveBeenCalledWith(true);
    // It is a preference, not an answer: nothing is dismissed, skipped or
    // snoozed, and the dialog stays open for the user to finish deciding.
    expect(updater.dismiss).not.toHaveBeenCalled();
    expect(updater.skip).not.toHaveBeenCalled();
    expect(updater.remindLater).not.toHaveBeenCalled();
    expect(view.find('[role="dialog"]')).not.toBeNull();
    view.unmount();
  });

  it('sends false when unticked', async () => {
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0', autoUpdate: true }));

    toggle(checkbox(view));
    await settle();

    expect(updater.setAutoUpdate).toHaveBeenCalledWith(false);
    view.unmount();
  });

  // The box renders from the main process's state, so a write that failed
  // leaves it visibly unchanged. Without a message that reads as a broken
  // checkbox the user clicks repeatedly.
  it('explains a preference that could not be saved', async () => {
    updater.setAutoUpdate.mockResolvedValueOnce({ success: false });
    const view = await mount(state({ phase: 'downloaded', version: '1.3.0', autoUpdate: false }));

    toggle(checkbox(view));
    await settle();

    expect(view.container.textContent).toContain('That preference could not be saved');
    view.unmount();
  });

  // Ticking it at 'available' starts the download in the main process, which
  // pushes 'downloading'. The dialog must follow that push rather than sitting
  // on a stale 'available' with a now-wrong button.
  it('follows the download that ticking it starts', async () => {
    const view = await mount(state({ phase: 'available', version: '1.3.0', autoUpdate: false }));

    toggle(checkbox(view));
    await settle();
    view.push(state({ phase: 'downloading', version: '1.3.0', percent: 5, autoUpdate: true }));
    await settle();

    expect(view.container.textContent).toContain('Downloading Sarv Inbox 1.3.0');
    expect(checkbox(view)?.checked).toBe(true);
    view.unmount();
  });

  // No setting can make a .deb or a dev build update itself, so the dialog must
  // not offer one there - nor while a check is still moving.
  it('offers no switch where it could not be honoured', async () => {
    const dead = await mount(
      state({ phase: 'unsupported', error: 'Updates for this build are handled by your package manager.' }),
    );
    expect(checkbox(dead)).toBeNull();
    dead.unmount();

    const checking = await mount(state({ phase: 'checking' }));
    expect(checkbox(checking)).toBeNull();
    checking.unmount();
  });
});
