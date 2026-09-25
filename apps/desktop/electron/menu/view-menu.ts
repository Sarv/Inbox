/**
 * The View menu.
 *
 * Hand-built instead of `{ role: 'viewMenu' }` for ONE reason: the three zoom
 * items. Electron's `zoomIn`/`zoomOut`/`resetZoom` roles change the frame zoom
 * directly, behind the app's back — the size is lost on restart, and the
 * Appearance tab's zoom slider would sit there showing a stale number. These
 * items instead report the INTENT to the renderer, which owns the persisted
 * zoom setting, applies it, and saves it. Cmd +/- and the slider are then the
 * same control.
 *
 * Everything else here reproduces the stock viewMenu role exactly.
 *
 * Kept free of runtime Electron imports (the `Electron.*` types are erased) so
 * the unit suite can build and click the template without an Electron process.
 */

export type ZoomCommand = 'in' | 'out' | 'reset';

/**
 * Delivers a zoom intent to the window that owns the menu.
 *
 * `BaseWindow`, not `BrowserWindow`, because that is what Electron hands a menu
 * click — resolving it to the window with a `webContents` is main.ts's job.
 */
export type ZoomDispatch = (window: Electron.BaseWindow | undefined, command: ZoomCommand) => void;

const zoomItem = (
  label: string,
  command: ZoomCommand,
  accelerator: string,
  dispatch: ZoomDispatch,
  visible = true,
): Electron.MenuItemConstructorOptions => ({
  label,
  accelerator,
  visible,
  click: (_menuItem, browserWindow) => dispatch(browserWindow, command),
});

export const buildViewMenu = (dispatch: ZoomDispatch): Electron.MenuItemConstructorOptions => ({
  label: 'View',
  submenu: [
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    zoomItem('Actual Size', 'reset', 'CommandOrControl+0', dispatch),
    zoomItem('Zoom In', 'in', 'CommandOrControl+Plus', dispatch),
    // The unshifted "=" key is what people actually press for zoom-in on a US
    // layout. macOS fires a hidden item's accelerator (acceleratorWorksWhenHidden
    // defaults to true), so this costs nothing and catches it; on Windows and
    // Linux the visible Ctrl+Plus above is the one that fires.
    zoomItem('Zoom In', 'in', 'CommandOrControl+=', dispatch, false),
    zoomItem('Zoom Out', 'out', 'CommandOrControl+-', dispatch),
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ],
});
