/*
 * Types for extension-archive-rules.mjs, which stays plain ESM so the build script
 * can load it with no build step. Keep this in step with the .mjs.
 */

/** The tar `filter`: an allowlisted plain file, or an expected folder (`entry` is tar's ReadEntry; only its `type` is read). */
export declare function isAllowedArchiveEntry(path: string, entry?: unknown): boolean;
