import { sep } from 'path';

/**
 * Redirect a path inside `app.asar` to its unpacked twin, leaving any other
 * path untouched.
 *
 * In a packaged build the app's own files live inside the `app.asar` archive.
 * File READS see through it — Electron patches `fs` — but anything that SPAWNS
 * a file by path does not: `new Worker(path)` and `utilityProcess.fork(path)`
 * both need a real file on disk. Those entries have to be listed in
 * electron-builder's `asarUnpack` (which writes a second, plain copy to
 * `app.asar.unpacked/`) and then addressed here.
 *
 * Getting this wrong is invisible in development, where there is no archive and
 * this function is a no-op: the feature works all the way through testing and
 * is dead on release day.
 *
 * Matching on the platform separator rather than the bare string keeps a
 * directory merely NAMED `app.asar-backup` from being rewritten, and works on
 * Windows too.
 */
export function resolveUnpacked(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}
