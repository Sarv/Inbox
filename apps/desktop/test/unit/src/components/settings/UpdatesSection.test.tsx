// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../../../../electron/services/update-policy';
import { UpdatesSection } from '../../../../../src/components/settings/UpdatesSection';
import { act, fire, render, settle, toggle } from '../../../../helpers/render';

/**
 * Settings → Advanced → Updates.
 *
 * The toggle here is a promise about the user's connection: ON means bytes are
 * fetched without asking, OFF means nothing is downloaded until they say so.
 * A checkbox that renders the wrong position, or sends the wrong value, breaks
 * that promise silently — on a metered link the user finds out from their bill.
 */

const updater = {
  getState: vi.fn(),
  onState: vi.fn(),
  install: vi.fn(async () => ({ success: true })),
  download: vi.fn(async () => ({ success: true })),
  setAutoUpdate: vi.fn(async () => ({ success: true })),
  check: vi.fn(async () => ({ success: true })),
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
  prompt: false,
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
  const view = render(<UpdatesSection />);
  await settle();
  return { ...view, push: (next: UpdateState) => act(() => push?.(next)) };
};

const checkbox = (view: { find: (s: string) => HTMLElement | null }) =>
  view.find('input[type="checkbox"]') as HTMLInputElement | null;

beforeEach(() => {
  Object.values(updater).forEach((fn) => fn.mockClear?.());
  (window as unknown as { electronAPI: unknown }).electronAPI = { updater };
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('UpdatesSection', () => {
  // The switch must show what the main process actually has stored. Rendering
  // it checked while downloads are off tells the user updates are handled when
  // nothing will ever be fetched.
  it('renders the stored position, not a default', async () => {
    const on = await mount(state({ autoUpdate: true }));
    expect(checkbox(on)?.checked).toBe(true);
    on.unmount();

    const off = await mount(state({ autoUpdate: false }));
    expect(checkbox(off)?.checked).toBe(false);
    off.unmount();
  });

  // The value sent has to match the box, or the toggle does the opposite of
  // what it shows.
  it('sends the new position when toggled', async () => {
    const view = await mount(state({ autoUpdate: true }));

    toggle(checkbox(view));
    await settle();

    expect(updater.setAutoUpdate).toHaveBeenCalledWith(false);
    view.unmount();
  });

  // Truth comes back from the main process, which owns the prefs file. If the
  // pane kept local state instead, a write that failed would leave the switch
  // showing a setting that was never saved.
  it('follows the main process when the preference changes elsewhere', async () => {
    const view = await mount(state({ autoUpdate: true }));

    view.push(state({ autoUpdate: false }));
    await settle();

    expect(checkbox(view)?.checked).toBe(false);
    view.unmount();
  });

  // This pane is where someone looks when the app seems not to be updating, so
  // it has to name the actual state rather than a generic line.
  it('states what the updater is doing', async () => {
    const view = await mount(state({ phase: 'up-to-date' }));
    expect(view.container.textContent).toContain("You're on the latest version (1.2.1)");

    view.push(state({ phase: 'downloading', version: '1.3.0', percent: 40 }));
    await settle();
    expect(view.container.textContent).toContain('Downloading Sarv Inbox 1.3.0 — 40%');

    view.push(state({ phase: 'error', error: 'ENOTFOUND' }));
    await settle();
    expect(view.container.textContent).toContain('The last check failed: ENOTFOUND');
    view.unmount();
  });

  // Stored UTC, rendered in the reader's own zone at render time — the repo
  // rule. A preformatted server-side string would show the wrong clock abroad.
  it('renders the last-checked time in the reader locale', async () => {
    const checkedAt = Date.parse('2026-09-25T06:00:00Z');
    const view = await mount(state({ phase: 'up-to-date', checkedAt }));

    expect(view.container.textContent).toContain(
      `Last checked ${new Date(checkedAt).toLocaleString()}`,
    );
    view.unmount();
  });

  // The button is the manual path the user was told to use when a check seems
  // stuck; it must actually issue one.
  it('checks on request, and says so while it runs', async () => {
    const view = await mount(state({ phase: 'idle' }));

    const press = view.all('button')[0]!;
    fire(press, 'click');
    await settle();
    expect(updater.check).toHaveBeenCalledTimes(1);

    view.push(state({ phase: 'checking' }));
    await settle();
    const running = view.all('button')[0] as HTMLButtonElement;
    expect(running.textContent).toContain('Checking…');
    // Disabled so a second press cannot stack a second check.
    expect(running.disabled).toBe(true);
    view.unmount();
  });

  // A .deb/.rpm install or a dev build cannot update itself. Offering a live
  // toggle and a check button there promises something that cannot happen.
  it('offers no controls on a build that updates elsewhere', async () => {
    const view = await mount(
      state({ phase: 'unsupported', error: 'Updates for this build are handled by your package manager.' }),
    );

    expect(checkbox(view)?.disabled).toBe(true);
    expect((view.all('button')[0] as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.textContent).toContain('handled by your package manager');
    view.unmount();
  });

  // Before the first state arrives there is nothing to report — and claiming
  // "up to date" there would be a guess about the user's machine.
  it('claims nothing before the first state arrives', async () => {
    updater.getState.mockResolvedValue({ success: false });
    updater.onState.mockReturnValue(() => {});
    const view = render(<UpdatesSection />);
    await settle();

    expect(view.container.textContent).toContain('Loading…');
    expect(view.container.textContent).not.toContain('latest version');
    view.unmount();
  });
});
