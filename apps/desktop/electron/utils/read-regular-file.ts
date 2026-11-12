import { constants, promises as fs } from 'fs';
import type { FileHandle } from 'fs/promises';

const CHUNK_BYTES = 64 * 1024;

/**
 * Opened read-only, refusing a link at the open where the OS can (`O_NOFOLLOW`), and
 * without waiting (`O_NONBLOCK`): a named pipe would otherwise hold the open until
 * something writes to it. Windows has neither flag; the identity check below covers it.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);

/**
 * Owner-only. Without O_CREAT nothing is created, so the OS never applies it; it is
 * passed so that a reader (and CodeQL's js/insecure-temporary-file) can see this open
 * cannot leave a file others may read.
 */
const OPEN_MODE = 0o600;

/**
 * The bytes of the plain file at `filePath`, or null when that path is anything else: a
 * link (wherever it points), a directory, a pipe or device, or a file larger than
 * `maxBytes`. A missing file throws, as `readFile` does.
 *
 * Race-free, which `lstat` followed by `readFile` is not (CodeQL js/file-system-race): a
 * link put in place between the two would be followed. This opens the path once, checks
 * what was opened, confirms the path still names that same file (which is what refuses a
 * link on Windows), and reads from the open handle.
 */
export async function readRegularFile(
  filePath: string,
  maxBytes = Number.POSITIVE_INFINITY
): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, OPEN_FLAGS, OPEN_MODE);
  } catch (error) {
    // ELOOP: O_NOFOLLOW met a link (EMLINK on FreeBSD). EISDIR: Windows will not open a folder.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK' || code === 'EISDIR') return null;
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const named = await fs.lstat(filePath);
    if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return null;
    return await readBounded(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

/** The rest of `handle`, or null once it passes `maxBytes`: a file can grow after its size was read. */
async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
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
}
