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
 * @param electronDir `__dirname` of the running main-process bundle.
 * @param isDev       true when running against the Vite dev server / unpackaged.
 */
export function resolveAppIconPath(electronDir: string, isDev: boolean): string {
  return join(electronDir, '..', isDev ? 'public' : 'dist', 'icon.png');
}
