import { closeSync, constants, fstatSync, lstatSync, openSync, promises as fsp, readSync, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/**
 * Opened read-only, refusing a link at the open where the OS can (`O_NOFOLLOW`), and
 * without waiting (`O_NONBLOCK`): a named pipe would otherwise hold the open until
 * something writes to it. Windows has neither flag; `namesOpenedFile` covers it.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

const CHUNK_BYTES = 64 * 1024;

/**
 * Whether the path, looked at after the open, still names the very file that was
 * opened: a plain file (not a link) with the same device and inode.
 */
function namesOpenedFile(named: Stats, opened: Stats): boolean {
  return named.isFile() && named.dev === opened.dev && named.ino === opened.ino;
}

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
  const fd = openSync(path, OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < limits.minBytes || stat.size > limits.maxBytes) {
      throw new Error('Not a regular file of the expected size');
    }
    if (!namesOpenedFile(lstatSync(path), stat)) {
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

/**
 * The bytes of the plain file at `filePath`, or null when that path is anything else:
 * a link (wherever it points), a directory, a pipe or device, or a file larger than
 * `maxBytes`. A missing file throws, as `readFile` does. For files the app serves or
 * imports from a folder it does not control (an extension's files, a calendar the
 * user opened), where "not a plain file" is an answer rather than an error.
 *
 * Race-free in the same way as `readRegularFileSync`, which `lstat` followed by
 * `readFile` is not (CodeQL js/file-system-race): a link put in place between the two
 * would be followed. The read is bounded, because a file can grow after its size was read.
 */
export async function readRegularFile(
  filePath: string,
  maxBytes = Number.POSITIVE_INFINITY
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await fsp.open(filePath, OPEN_FLAGS);
  } catch (error) {
    // ELOOP: O_NOFOLLOW met a link (EMLINK on FreeBSD). EISDIR: Windows will not open a folder.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR') return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) return null;
    if (!namesOpenedFile(await fsp.lstat(filePath), opened)) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxBytes) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}
