import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { restoreAndFocusWindow } from '../../../../electron/utils/window-focus';

const fakeWindow = ({ minimized = false, destroyed = false } = {}) => {
  const calls: string[] = [];
  const window = {
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: vi.fn(() => calls.push('restore')),
    show: vi.fn(() => calls.push('show')),
    focus: vi.fn(() => calls.push('focus')),
  };
  return { window: window as unknown as BrowserWindow, calls };
};

describe('restoreAndFocusWindow', () => {
  // A notification click on a minimised app that only called focus() left the
  // window in the Dock: the click appeared to do nothing.
  it('restores a minimised window before showing and focusing it', () => {
    const { window, calls } = fakeWindow({ minimized: true });
    restoreAndFocusWindow(window);
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });

  // Restoring a window that is not minimised would un-maximise it on some
  // platforms; it only needs to come forward.
  it('only shows and focuses a window that is not minimised', () => {
    const { window, calls } = fakeWindow();
    restoreAndFocusWindow(window);
    expect(calls).toEqual(['show', 'focus']);
  });

  // A click can arrive after the window was closed; touching a destroyed
  // BrowserWindow throws in the main process.
  it('does nothing for a missing or destroyed window', () => {
    const { window, calls } = fakeWindow({ destroyed: true });
    expect(() => restoreAndFocusWindow(window)).not.toThrow();
    expect(() => restoreAndFocusWindow(null)).not.toThrow();
    expect(calls).toEqual([]);
  });
});
