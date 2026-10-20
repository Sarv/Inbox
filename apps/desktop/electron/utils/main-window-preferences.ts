import type { WebPreferences } from 'electron';

/**
 * The main window's webPreferences — its security boundary, kept in one
 * testable place (main.ts cannot be imported by a test).
 */
export function mainWindowWebPreferences({ preload, isDev }: { preload: string; isDev: boolean }): WebPreferences {
  return {
    preload,
    nodeIntegration: false,
    contextIsolation: true,
    // Chromium OS sandbox ON: a compromised renderer (e.g. via malicious email
    // HTML) is confined to the process and can only reach main through the
    // explicit contextBridge IPC. Safe here because the bundled preload only
    // `require("electron")` (contextBridge/ipcRenderer) — no fs/os/stream/etc.,
    // which the sandbox would forbid. If a future preload dep pulls a Node
    // builtin, the app blank-screens at launch and this must go back to false.
    sandbox: true,
    // Chromium's built-in PDF viewer is a plugin; without this an <iframe>
    // pointing at a PDF downloads instead of rendering, which is the exact
    // behaviour the in-app viewer exists to remove. This does NOT widen the
    // email-content surface: the sandboxed email-body iframe runs under
    // `default-src 'none'`, which already blocks <embed>/<object>.
    plugins: true,
    // A file dropped outside the app's own drop zones must never be opened IN
    // the window: it would run with the preload bridge and no CSP (CASA M-6).
    // Electron's default is already false; stated here so the boundary does
    // not rest on a default.
    navigateOnDragDrop: false,
    // No DevTools in release builds: it is a console onto the full IPC
    // bridge for anyone at an unlocked machine. Off here (not just hidden
    // from the menu) so the keyboard shortcut can't open it either.
    devTools: isDev,
  };
}
