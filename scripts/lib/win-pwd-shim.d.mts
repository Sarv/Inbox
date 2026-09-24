/* Types for win-pwd-shim.mjs — see userdata-dirs.d.mts for why these exist. */

/** Filename the shim must have for Windows to resolve a bare `pwd` to it. */
export declare const SHIM_FILENAME: string;

/** Contents of the batch file that stands in for coreutils `pwd`. */
export declare function pwdShimScript(): string;

/** Where the shim has to live for `pnpm exec` to put it on PATH. */
export declare function shimPath(repoRoot: string): string;

/** Write the shim, creating `node_modules/.bin` if needed. Returns its path. */
export declare function writePwdShim(repoRoot: string): string;

/** Whether a workspace-root probe result is one electron-builder can use. */
export declare function isUsableWorkspaceRoot(candidate: string): boolean;
