import { app } from 'electron';

/**
 * Whether this is a dev run, from the facts that decide it.
 *
 * `app.isPackaged` alone is wrong here: Electron reports it as true for ANY
 * executable not named `electron`, and this dev setup runs a renamed binary
 * (`Sarv Inbox Dev`). vite-plugin-electron sets `VITE_DEV_SERVER_URL` only in
 * dev, so that is the reliable signal; `!isPackaged` keeps a plain
 * `electron .` run counted as dev too.
 */
export function isDevRun(facts: { devServerUrl?: string | null; isPackaged: boolean }): boolean {
  return Boolean(facts.devServerUrl) || !facts.isPackaged;
}

/** `isDevRun` against the live process — the one place that reads them. */
export function isDevBuild(): boolean {
  return isDevRun({ devServerUrl: process.env['VITE_DEV_SERVER_URL'], isPackaged: app.isPackaged });
}
