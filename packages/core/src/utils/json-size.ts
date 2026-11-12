/**
 * How large a value is as JSON, measured without making the JSON — and the one place
 * that decides how large is too large to stringify in the main process.
 *
 * Stringifying is the danger, not the size itself. Measured in Electron 44: `JSON.stringify`
 * of one flat string of about 256 MB (128 million two-byte characters, the shape a string
 * has after a structured clone or a decode) ends the whole process, "Zone Allocation
 * failed", and no try/catch sees it. A stranger chooses the size of plenty that reaches
 * main: an email body, an extension's message, a server's answer. So a value whose size
 * nobody bounded is measured first and stringified only when it is under the limit.
 *
 * Pure and dependency-free: the extension sandbox bundles it too.
 */

/**
 * The most one value may hold, in characters and bytes, before main will stringify it.
 *
 * 64 million characters is measured safe in all three forms: one-byte, two-byte, and all
 * control characters that escape to six times their length. Nothing the app stringifies
 * legitimately comes near it — the largest real email body measured is 21 MB.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** What a container costs, so a value of nothing but empty ones still adds up. */
const CONTAINER_BYTES = 32;

/**
 * How large a value is, stopping as soon as it is known to be over `stopAt`.
 *
 * It walks everything, because one string out of a thousand is all it takes (see
 * `MAX_MESSAGE_BYTES`), so an estimate from a sample would leave the hole open. That is
 * affordable because the limit bounds the walk: every value counted costs at least 8
 * bytes, so it stops after a few million values. Lengths are counted before any looping,
 * so an array claiming four billion empty slots stops the walk rather than running it.
 *
 * A value can contain anything structured clone can: cycles, Maps, Sets, and Errors and
 * RegExps whose strings are not enumerable.
 */
export function messageBytes(message: unknown, stopAt: number = MAX_MESSAGE_BYTES): number {
  let bytes = 0;
  const seen = new Set<object>();
  const pending: object[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string') bytes += value.length;
    else if (value !== null && typeof value === 'object') pending.push(value);
  };

  add(message);
  while (pending.length > 0 && bytes <= stopAt) {
    const value = pending.pop() as object;
    if (seen.has(value)) continue;
    seen.add(value);
    bytes += CONTAINER_BYTES;

    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength;
    } else if (Array.isArray(value)) {
      bytes += value.length * 8;
      for (let index = 0; index < value.length && bytes <= stopAt; index += 1) add(value[index]);
    } else if (value instanceof Map) {
      for (const [key, entry] of value) {
        if (bytes > stopAt) break;
        bytes += 8;
        add(key);
        add(entry);
      }
    } else if (value instanceof Set) {
      for (const entry of value) {
        if (bytes > stopAt) break;
        bytes += 8;
        add(entry);
      }
    } else if (value instanceof RegExp) {
      bytes += value.source.length;
    } else {
      if (value instanceof Error) {
        add(value.message);
        add(value.stack);
      }
      for (const key of Object.keys(value)) {
        if (bytes > stopAt) break;
        bytes += key.length + 8;
        add((value as Record<string, unknown>)[key]);
      }
    }
  }
  return bytes;
}

/**
 * `JSON.stringify(value)`, or `null` when the value measures over `limit` — in which case
 * it was never stringified, so the caller can refuse, skip or summarise instead.
 *
 * The limit may be lower than `MAX_MESSAGE_BYTES` (a log line needs a few kilobytes, not
 * sixty megabytes), never higher: past it, stringifying is what crashes.
 */
export function stringifyBounded(value: unknown, limit: number = MAX_MESSAGE_BYTES): string | null {
  const bound = Math.min(limit, MAX_MESSAGE_BYTES);
  if (messageBytes(value, bound) > bound) return null;
  return JSON.stringify(value);
}
