/*
 * Types for userdata-dirs.mjs. The maintenance scripts stay plain ESM (they run
 * straight from `node scripts/…` with no build step), but apps/desktop
 * type-checks its tests under `strict`, so the shared helpers they exercise need
 * declarations. Keep this in step with the .mjs.
 */

export interface AppDataDir {
  /** The app.name this directory belongs to, e.g. "Sarv Inbox Dev". */
  label: string;
  /** Absolute path to the userData directory. */
  dir: string;
}

export declare function appDataBase(): string;
export declare const APP_NAMES: string[];
export declare function getAppDataDirs(): AppDataDir[];
export declare function exists(p: string): boolean;
export declare function fileSize(p: string): number;
export declare function humanSize(bytes: number): string;

/** app.log plus its rotated siblings (app.log.1, …), sorted. */
export declare function listLogFiles(dir: string): string[];

/** Paths that could not be removed because something holds them open. */
export declare const lockedPaths: string[];

export declare function rmFile(p: string): boolean;
export declare function rmDir(p: string): boolean;
