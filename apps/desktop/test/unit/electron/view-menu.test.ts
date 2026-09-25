import { describe, expect, it, vi } from 'vitest';

import { buildViewMenu, type ZoomCommand } from '../../../electron/menu/view-menu';

// What breaks if this suite goes red: Cmd +/- stops reaching the renderer. The
// symptom is not an error — it is a keyboard shortcut that does nothing, or one
// that zooms the frame behind the app's back so the size is lost on restart and
// the Appearance tab shows a stale number.

const submenuOf = (menu: Electron.MenuItemConstructorOptions) =>
  menu.submenu as Electron.MenuItemConstructorOptions[];

const click = (item: Electron.MenuItemConstructorOptions) =>
  (item.click as (...args: any[]) => void)(undefined, undefined, undefined);

describe('buildViewMenu', () => {
  it('keeps the stock View menu items alongside the zoom ones', () => {
    const items = submenuOf(buildViewMenu(vi.fn()));
    const roles = items.map((item) => item.role).filter(Boolean);
    expect(roles).toEqual(['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']);
  });

  // Regression: `role: 'zoomIn'` and friends change the frame zoom directly and
  // bypass the persisted setting entirely. Reintroducing one would look correct
  // in the menu and quietly break persistence.
  it('carries no built-in zoom roles', () => {
    const roles = submenuOf(buildViewMenu(vi.fn())).map((item) => item.role);
    expect(roles).not.toContain('zoomIn');
    expect(roles).not.toContain('zoomOut');
    expect(roles).not.toContain('resetZoom');
  });

  it('dispatches the matching command for each zoom item', () => {
    const dispatched: ZoomCommand[] = [];
    const items = submenuOf(buildViewMenu((_window, command) => dispatched.push(command)));
    for (const item of items) if (item.click) click(item);
    // Actual Size, Zoom In, the hidden "=" duplicate of Zoom In, Zoom Out.
    expect(dispatched).toEqual(['reset', 'in', 'in', 'out']);
  });

  it('binds the conventional accelerators', () => {
    const items = submenuOf(buildViewMenu(vi.fn()));
    const accelerators = items.filter((item) => item.click).map((item) => item.accelerator);
    expect(accelerators).toEqual([
      'CommandOrControl+0',
      'CommandOrControl+Plus',
      'CommandOrControl+=',
      'CommandOrControl+-',
    ]);
  });

  // Regression: the unshifted "=" binding must stay HIDDEN, or the View menu
  // shows "Zoom In" twice.
  it('hides the duplicate "=" zoom-in binding from the menu', () => {
    const zoomIns = submenuOf(buildViewMenu(vi.fn())).filter((item) => item.label === 'Zoom In');
    expect(zoomIns).toHaveLength(2);
    expect(zoomIns.filter((item) => item.visible !== false)).toHaveLength(1);
  });

  // Electron hands the click the window that owns the menu; it is what tells
  // main which renderer to send the command to in a multi-window future.
  it('passes the clicked window through to the dispatch', () => {
    const dispatch = vi.fn();
    const items = submenuOf(buildViewMenu(dispatch));
    const zoomOut = items.find((item) => item.label === 'Zoom Out')!;
    const fakeWindow = { id: 7 } as unknown as Electron.BaseWindow;
    (zoomOut.click as (...args: any[]) => void)(undefined, fakeWindow, undefined);
    expect(dispatch).toHaveBeenCalledWith(fakeWindow, 'out');
  });
});
