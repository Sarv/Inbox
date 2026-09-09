/* Types for dev-processes.mjs — see userdata-dirs.d.mts for why these exist. */

/** Escape a literal for safe use inside a POSIX extended regular expression. */
export declare function escapeEre(literal: string): string;

/** `pkill -f` patterns for the dev processes started from `repoRoot`. */
export declare function stalePatterns(repoRoot: string): string[];
