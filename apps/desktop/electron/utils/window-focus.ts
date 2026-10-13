import type { BrowserWindow } from 'electron';

/**
 * Bring a window to the front: un-minimise it, show it if hidden, focus it.
 *
 * The one copy of what a notification click (or a second launch) does to the
 * main window. A missing or destroyed window is a no-op, not an error — the
 * click can land after the window has been closed.
 */
export const restoreAndFocusWindow = (window: BrowserWindow | null | undefined): void => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};
