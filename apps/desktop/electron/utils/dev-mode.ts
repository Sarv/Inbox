import { app } from 'electron';

/**
 * Whether this main bundle was built for release (`vite build`). Vite inlines
 * `process.env.SARVINBOX_BUILD_MODE` at build time (vite.config.ts
 * buildDefines), so in a shipped app no environment variable or `.env` file
 * can change it. Run from source (tests), it reads the real environment, where
 * it is unset.
 */
export function isReleaseBundle(): boolean {
  return process.env.SARVINBOX_BUILD_MODE === 'production';
}

/**
 * Whether this is a dev run, from the facts that decide it.
 *
 * `app.isPackaged` alone is wrong here: Electron reports it as true for ANY
 * executable not named `electron`, and this dev setup runs a renamed binary
 * (`Sarv Inbox Dev`). vite-plugin-electron sets `VITE_DEV_SERVER_URL` only in
 * dev, so that is the reliable signal; `!isPackaged` keeps a plain
 * `electron .` run counted as dev too.
 *
 * A release bundle never takes the dev server URL as that signal: in a shipped
 * app the variable can only come from whoever launched it (a shell, or a
 * `.env` in the launch directory), and it would otherwise switch on DevTools
 * and the dev profile and point the window at their server (CASA L-3).
 */
export function isDevRun(facts: { devServerUrl?: string | null; isPackaged: boolean; releaseBundle?: boolean }): boolean {
  if (facts.releaseBundle) return !facts.isPackaged;
  return Boolean(facts.devServerUrl) || !facts.isPackaged;
}

/**
 * The URL the main window loads instead of the bundled `dist/index.html`, or
 * null. Only a dev bundle has one: a release bundle always loads its own
 * files, whatever the environment says — the window it loads gets the full
 * preload bridge (CASA L-3).
 */
export function devServerUrlFor(facts: { envUrl?: string | null; releaseBundle: boolean; isDev: boolean }): string | null {
  if (facts.releaseBundle) return null;
  return facts.envUrl || (facts.isDev ? 'http://localhost:5173' : null);
}

/** `isDevRun` against the live process — the one place that reads them. */
export function isDevBuild(): boolean {
  return isDevRun({
    devServerUrl: process.env['VITE_DEV_SERVER_URL'],
    isPackaged: app.isPackaged,
    releaseBundle: isReleaseBundle(),
  });
}
