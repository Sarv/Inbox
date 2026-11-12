// Whole-file replacement for small stores kept on disk

import writeFileAtomic from 'write-file-atomic';

/**
 * Replace `file` with `data` in one step, readable and writable by this user only
 * (0600; POSIX modes do nothing on Windows, where the profile folder's ACL applies).
 *
 * write-file-atomic writes a new file beside it and renames it over, so a reader sees
 * the old contents or the new, never part of either, and a crash or a full disk midway
 * leaves the old file whole. Checking a path and then writing it in place is a race
 * (CodeQL js/file-system-race) and leaves a half-written file behind on a crash.
 * Throws as `writeFileSync` does; the temporary file is removed on failure.
 */
export function writePrivateFileAtomicSync(file: string, data: string | Buffer): void {
  writeFileAtomic.sync(file, data, { mode: 0o600 });
}
