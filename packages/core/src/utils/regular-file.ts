import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/**
 * Read a small file this app wrote itself at a fixed path — a one-time ticket,
 * a relaunch handoff — refusing anything else that may have been put there.
 *
 * Everything is decided from ONE open handle, so there is no window between a
 * check and the read for the path to be swapped:
 *  - opened with O_NOFOLLOW (a symlink at the path fails the open) and
 *    O_NONBLOCK (a FIFO at the path would otherwise block the open, and with it
 *    startup, until some process writes to it);
 *  - the handle must be a regular file within `minBytes`..`maxBytes`;
 *  - the path must still name that same file (`lstat` dev/ino), which also
 *    refuses a symlink where O_NOFOLLOW does not exist (Windows);
 *  - exactly `size` bytes are read from the handle, so a file that grows or
 *    shrinks while being read is refused instead of being half-trusted.
 *
 * Throws on any of those, and on a missing or unreadable file — callers treat
 * every throw as "no valid file", never as an empty one.
 */
export function readRegularFileSync(path: string, limits: { minBytes: number; maxBytes: number }): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < limits.minBytes || stat.size > limits.maxBytes) {
      throw new Error('Not a regular file of the expected size');
    }
    const named = lstatSync(path);
    if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw new Error('The file changed while it was being opened');
    }
    // One byte of headroom: reading past `size` is how a file that grew is seen.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error('The file changed while it was being read');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
