// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../../../electron/services/update-policy';
import { UpdateReadyBanner } from '../../../../src/components/UpdateReadyBanner';
import { toEpochSeconds, updateReminderPresets } from '../../../../src/utils/time-presets';
import { act, cleanup, render, settle } from '../../../helpers/render';

/**
 * The in-app "update ready" banner.
 *
 * Before it, a staged update was announced by one silent notification and then
 * waited — for weeks — for a quit that never came. What is tested here is that
 * it shows only when the main process says so, that "Restart now" really
 * installs, and that each reminder choice reaches the main process as the
 * time the reader picked, not the default.
 */

const updater = {
  getState: vi.fn(),
  onState: vi.fn(),
  install: vi.fn(async () => ({ success: true })),
  remindLater: vi.fn(async () => ({ success: true })),
};

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  phase: 'downloaded',
  version: '1.4.4',
  currentVersion: '1.3.7',
  percent: 100,
  error: null,
  checkedAt: null,
  trigger: 'scheduled',
  prompt: false,
  banner: true,
  autoUpdate: true,
  ...over,
});

const mount = async (initial: UpdateState) => {
  let push: ((next: UpdateState) => void) | undefined;
  updater.getState.mockResolvedValue({ success: true, data: initial });
  updater.onState.mockImplementation((handler: (next: UpdateState) => void) => {
    push = handler;
    return () => {};
  });
  const view = render(<UpdateReadyBanner />);
  await settle();
  return { ...view, push: (next: UpdateState) => act(() => push?.(next)) };
};

const buttonStartingWith = (view: { all: (s: string) => HTMLElement[] }, label: string) =>
  view.all('button').find((el) => el.textContent?.trim().startsWith(label)) ?? null;

const click = async (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  act(() => element!.click());
  await settle();
};

beforeEach(() => {
  Object.values(updater).forEach((fn) => fn.mockClear());
  updater.install.mockImplementation(async () => ({ success: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { updater };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('UpdateReadyBanner', () => {
  // Regression: the renderer deciding on its own would show the banner next to
  // the dialog, or during a check, or for a version the reader skipped.
  it('shows only while the main process says so', async () => {
    const view = await mount(state({ banner: false }));
    expect(view.container.textContent).toBe('');

    view.push(state());
    await settle();
    expect(view.container.textContent).toContain('Sarv Inbox 1.4.4 is ready.');
    expect(view.container.textContent).toContain('installs the next time you quit');

    view.push(state({ banner: false }));
    await settle();
    expect(view.container.textContent).toBe('');
  });

  // Regression: without a bridge (older preload, teardown) the banner must
  // render nothing rather than throw and blank the mail window.
  it('renders nothing when the updater bridge is missing', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const view = render(<UpdateReadyBanner />);
    await settle();
    expect(view.container.textContent).toBe('');
  });

  // Regression: "Restart now" wired to anything but install would leave the
  // update sitting on disk — the exact failure this banner fixes.
  it('installs and restarts on "Restart now"', async () => {
    updater.install.mockImplementation(() => new Promise(() => {}));
    const view = await mount(state());

    await click(buttonStartingWith(view, 'Restart now'));

    expect(updater.install).toHaveBeenCalledTimes(1);
    const restarting = buttonStartingWith(view, 'Restarting');
    expect(restarting).not.toBeNull();
    expect((restarting as HTMLButtonElement).disabled).toBe(true);
  });

  // Regression: a refused install (the staged update vanished) left the button
  // stuck on "Restarting…" forever with nothing said.
  it('says so and re-enables the button when the install is refused', async () => {
    updater.install.mockImplementation(async () => ({ success: false }));
    const view = await mount(state());

    await click(buttonStartingWith(view, 'Restart now'));

    expect(view.container.textContent).toContain('no longer ready');
    expect((buttonStartingWith(view, 'Restart now') as HTMLButtonElement).disabled).toBe(false);
  });

  // Regression: "Tonight" sending no time (or milliseconds), so every choice
  // became the 6h default — or "already due" and the banner never left.
  it('sends the picked reminder time as epoch seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 23, 14, 0));
    const view = await mount(state());

    await click(buttonStartingWith(view, 'Remind me later'));
    expect(view.container.textContent).toContain('Remind me');
    const tonight = updateReminderPresets(new Date()).find((preset) => preset.label === 'Tonight')!;
    await click(buttonStartingWith(view, 'Tonight'));

    expect(updater.remindLater).toHaveBeenCalledWith(toEpochSeconds(tonight.time));
    // The menu closes on a pick.
    expect(buttonStartingWith(view, 'Tonight')).toBeNull();
  });

  // Regression: the reminder menu that stays open (or never opens) when the
  // trigger is pressed again.
  it('toggles the reminder menu from its trigger', async () => {
    const view = await mount(state());
    const trigger = buttonStartingWith(view, 'Remind me later');

    await click(trigger);
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(buttonStartingWith(view, 'In 1 hour')).not.toBeNull();

    await click(trigger);
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(buttonStartingWith(view, 'In 1 hour')).toBeNull();
    expect(updater.remindLater).not.toHaveBeenCalled();
  });
});
