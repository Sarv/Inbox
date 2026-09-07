import { basename, resolve, sep } from 'path';

import sanitize from 'sanitize-filename';

/**
 * Path-safety helpers for turning UNTRUSTED, attacker-controlled names (e.g.
 * attachment filenames straight from MIME headers) into safe on-disk paths.
 *
 * A malicious email can set an attachment filename like
 * "../../../../Library/Application Support/Sarv Inbox/db-key.bin" (or the
 * Windows "..\\..\\x" form). Writing that under a cache dir with a naive
 * `path.join` lets the write escape the directory and clobber arbitrary files.
 * Always run untrusted names through `safeFilename` and build the final path
 * with `resolveWithinDir`.
 */

/**
 * Reduce an untrusted filename to a safe, single-segment basename. We lean on the
 * mature `sanitize-filename` package (per CLAUDE.md: prefer a battle-tested lib
 * over hand-rolled regex) — it strips illegal/control/reserved chars, path
 * separators, and trailing dots/spaces, and truncates to 255 bytes. `basename`
 * first drops any directory component so legit names keep their last segment.
 * Falls back to `fallback` when nothing usable remains.
 */
export function safeFilename(name: string | undefined | null, fallback = 'unnamed'): string {
  const cleaned = sanitize(basename(name ?? '')).trim();
  return cleaned || fallback;
}

/**
 * Join `name` onto `dir` and guarantee the resolved path stays inside `dir`.
 * Throws on any attempt to escape (path traversal). `name` should already have
 * been through `safeFilename`; this is the belt-and-suspenders containment check.
 * (No library cleanly covers path containment; this is stdlib-based, not regex.)
 */
export function resolveWithinDir(dir: string, name: string): string {
  const base = resolve(dir);
  const full = resolve(base, name);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Refusing unsafe path outside base directory: "${name}"`);
  }
  return full;
}
