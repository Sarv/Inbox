/*
 * Types for extension-seed.mjs. The build script stays plain ESM (it runs
 * straight from `node scripts/…` with no build step), but apps/desktop
 * type-checks its tests under `strict`, so the helpers they exercise need
 * declarations. Keep this in step with the .mjs.
 */

/** Whether `id` may name a seed folder (the extension id rule). */
export declare function isSeedableId(id: unknown): id is string;

/** The seed folder and its temporary archive, both directly inside `outputDir`. Throws for an unsafe id. */
export declare function seedPaths(outputDir: string, id: string): { target: string; archivePath: string };

/** The tar `filter` for a seed: an allowlisted plain file, or the archive's root folder (`entry` is tar's ReadEntry; only its `type` is read). */
export declare function isAllowedArchiveEntry(path: string, entry?: unknown): boolean;
