import { describe, expect, it } from 'vitest';

import { isDevRun } from '../../../../electron/utils/dev-mode';

/**
 * Dev-run detection.
 *
 * What breaks if this goes red: the dev app is treated as a shipped build — it
 * takes the single-instance lock, publishes a heartbeat, and puts the
 * "Move to Applications?" modal in front of a startup that then waits on it
 * with no window, looking exactly like a dev app that will not start.
 */
describe('isDevRun', () => {
  // THE case: the renamed `Sarv Inbox Dev` binary makes Electron report
  // isPackaged === true; the dev server URL must still win.
  it('is dev under the vite dev server even when Electron claims packaged', () => {
    expect(isDevRun({ devServerUrl: 'http://localhost:5173', isPackaged: true })).toBe(true);
  });

  // A plain `electron .` run has no dev server but is unpackaged.
  it('is dev for an unpackaged run without a dev server', () => {
    expect(isDevRun({ devServerUrl: undefined, isPackaged: false })).toBe(true);
  });

  // A shipped build: no dev server and packaged. An empty URL is not a server.
  it('is not dev for a packaged build with no dev server', () => {
    expect(isDevRun({ devServerUrl: undefined, isPackaged: true })).toBe(false);
    expect(isDevRun({ devServerUrl: '', isPackaged: true })).toBe(false);
    expect(isDevRun({ devServerUrl: null, isPackaged: true })).toBe(false);
  });
});
