// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../../../electron/services/update-policy';
import { useUpdater } from '../../../../src/hooks/useUpdater';
import { act, render, settle } from '../../../helpers/render';

/**
 * The renderer's mirror of the main process's update state.
 *
 * It owns no state of its own on purpose, so the two can never disagree. What
 * is tested here is the other half of that contract: the bridge it reads
 * through is OPTIONAL. An older preload, a reload mid-teardown or a test
 * harness all leave `window.electronAPI.updater` missing, and every one of
 * those must mean "no update UI" — never a renderer that throws on mount and
 * takes the mail window down with it.
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

/** Captures the hook's return so a test can call its actions directly. */
let latest: ReturnType<typeof useUpdater>;

function Probe() {
  latest = useUpdater();
  return <span>{latest.state?.phase ?? 'none'}</span>;
}

const bridge = (updater: Record<string, unknown>) => {
  (window as unknown as { electronAPI: unknown }).electronAPI = { updater };
};

beforeEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useUpdater', () => {
  // The seed read. A renderer usually mounts long after the first background
  // check, so waiting only for pushes would show nothing at all until the next
  // hourly cycle.
  it('seeds from the current state instead of waiting for a push', async () => {
    bridge({
      getState: vi.fn(async () => ({ success: true, data: state({ phase: 'downloaded' }) })),
      onState: vi.fn(() => () => {}),
    });

    const view = render(<Probe />);
    await settle();

    expect(view.container.textContent).toBe('downloaded');
    view.unmount();
  });

  // Pushes are how the renderer learns about a change it did not cause; without
  // this the dialog would only ever reflect the moment it mounted.
  it('follows pushes from the main process', async () => {
    let push: ((next: UpdateState) => void) | undefined;
    bridge({
      getState: vi.fn(async () => ({ success: true, data: state() })),
      onState: vi.fn((handler: (next: UpdateState) => void) => {
        push = handler;
        return () => {};
      }),
    });

    const view = render(<Probe />);
    await settle();

    act(() => push?.(state({ phase: 'downloading' })));
    await settle();

    expect(view.container.textContent).toBe('downloading');
    view.unmount();
  });

  // Without detaching, a remount stacks a second listener and every push is
  // handled twice — and the first mount's setState fires on an unmounted tree.
  it('detaches its listener on unmount', async () => {
    const dispose = vi.fn();
    bridge({
      getState: vi.fn(async () => ({ success: true, data: state() })),
      onState: vi.fn(() => dispose),
    });

    const view = render(<Probe />);
    await settle();
    view.unmount();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  /**
   * No bridge at all. Every action must resolve false rather than throwing on
   * `undefined.install()` — an exception here unmounts the React tree, so a
   * missing updater would black out the whole mail window.
   */
  it('reports every action as unavailable when the bridge is missing', async () => {
    const view = render(<Probe />);
    await settle();

    expect(view.container.textContent).toBe('none');
    await expect(latest.install()).resolves.toBe(false);
    await expect(latest.download()).resolves.toBe(false);
    await expect(latest.setAutoUpdate(true)).resolves.toBe(false);
    await expect(latest.check()).resolves.toBe(false);
    await expect(latest.skip()).resolves.toBeUndefined();
    await expect(latest.remindLater()).resolves.toBeUndefined();
    await expect(latest.dismiss()).resolves.toBeUndefined();
    view.unmount();
  });

  // A rejected seed read (bridge present, main process not ready yet) must
  // leave the hook empty rather than raising an unhandled rejection.
  it('stays empty when the seed read fails', async () => {
    bridge({
      getState: vi.fn(async () => {
        throw new Error('not ready');
      }),
      onState: vi.fn(() => () => {}),
    });

    const view = render(<Probe />);
    await settle();

    expect(view.container.textContent).toBe('none');
    view.unmount();
  });

  // A failed action must not overwrite the state with an empty reply: the
  // dialog would then render from nothing while the update is still staged.
  it('keeps the last known state when an action fails', async () => {
    bridge({
      getState: vi.fn(async () => ({ success: true, data: state({ phase: 'available' }) })),
      onState: vi.fn(() => () => {}),
      download: vi.fn(async () => ({ success: false, error: 'nothing waiting' })),
      check: vi.fn(async () => ({ success: true })),
    });

    const view = render(<Probe />);
    await settle();

    await act(async () => {
      await latest.download();
    });
    expect(view.container.textContent).toBe('available');

    await act(async () => {
      await latest.check();
    });
    expect(view.container.textContent).toBe('available');
    view.unmount();
  });

  // The happy path for an action's reply: the renderer renders from it directly
  // rather than waiting for the push, which can race the reply.
  it('adopts the state an action replies with', async () => {
    bridge({
      getState: vi.fn(async () => ({ success: true, data: state({ phase: 'available' }) })),
      onState: vi.fn(() => () => {}),
      setAutoUpdate: vi.fn(async () => ({
        success: true,
        data: state({ phase: 'downloading', autoUpdate: true }),
      })),
    });

    const view = render(<Probe />);
    await settle();

    await act(async () => {
      await latest.setAutoUpdate(true);
    });

    expect(view.container.textContent).toBe('downloading');
    view.unmount();
  });
});
