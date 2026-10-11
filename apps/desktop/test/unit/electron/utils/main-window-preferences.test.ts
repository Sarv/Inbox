import { describe, expect, it } from 'vitest';

import { mainWindowWebPreferences } from '../../../../electron/utils/main-window-preferences';

// The main window's security boundary. What breaks if this file fails: a page
// in the window gets Node, shares the preload's context, leaves the OS
// sandbox, runs the preload in the email/attachment frames, or — CASA M-6 — a
// file dropped on the window opens IN it with the preload bridge.
describe('mainWindowWebPreferences', () => {
  it('keeps the window isolated and sandboxed', () => {
    const prefs = mainWindowWebPreferences({ preload: '/app/preload.js', isDev: false });
    expect(prefs).toMatchObject({
      preload: '/app/preload.js',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      navigateOnDragDrop: false,
    });
    expect(prefs.nodeIntegrationInSubFrames).toBeUndefined();
    expect(prefs.webSecurity).toBeUndefined();
  });

  // Breaks: DevTools (a console onto the whole IPC bridge) in release builds.
  it('allows DevTools only in development', () => {
    expect(mainWindowWebPreferences({ preload: 'p', isDev: false }).devTools).toBe(false);
    expect(mainWindowWebPreferences({ preload: 'p', isDev: true }).devTools).toBe(true);
  });
});
