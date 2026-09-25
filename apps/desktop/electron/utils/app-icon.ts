import { join } from 'path';

/**
 * Absolute path to the branded app icon PNG (the square SarvInbox mark).
 *
 * `apps/desktop/public/` is copied verbatim into `dist/` by Vite, and `dist/**`
 * is the only thing electron-builder packages (see `build.files` in
 * package.json). So the PNG under public/dist is the one icon asset that exists
 * in BOTH dev and a packaged build.
 *
 * `build/` is a SOURCE directory — electron-builder reads `build/icon.icns` and
 * `build/icon.png` at pack time to stamp the bundle/executable, but it never
 * ships them. Anything resolved under `build/` at runtime is therefore absent
 * in production, which is why this helper never points there.
 *
 * DEV gets a DIFFERENT file: `icon-dev.png`, the same mark on a blueprint-blue
 * ground (regenerate with `pnpm gen:dev-icon`). Dev and release windows are
 * otherwise two identical white squircles in the Dock/taskbar, which is how a
 * change gets tested against the wrong instance — and dev writes to its own
 * `Sarv Inbox Dev` userData, so telling them apart is not cosmetic.
 *
 * @param electronDir `__dirname` of the running main-process bundle.
 * @param isDev       true when running against the Vite dev server / unpackaged.
 */
export function resolveAppIconPath(electronDir: string, isDev: boolean): string {
  return isDev
    ? join(electronDir, '..', 'public', 'icon-dev.png')
    : join(electronDir, '..', 'dist', 'icon.png');
}
