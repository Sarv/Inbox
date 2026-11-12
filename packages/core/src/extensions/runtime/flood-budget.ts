/**
 * How much an extension may ask of the main process, and how that is counted.
 *
 * A port message costs main its deserialization and whatever it then does, and a
 * stranger's code chooses how many it sends and how large they are. Measured in Electron:
 * a loop posting 50 MB strings stopped main's event loop outright. So past a limit the
 * extension is stopped, not throttled, because a throttled flood still holds main's time.
 *
 * Two things keep this off a healthy extension. Only what main did not ask for counts: a
 * reply to one of main's own calls is main's doing, and counting those killed the real
 * vip-scoring at mail 3,331 while a backlog drained. And the allowance grows with the
 * work main hands over, because a workflow that reads its storage for every message makes
 * host calls at the rate the mail arrives, which is not the extension's choice either.
 *
 * Pure, with the clock passed in, so the limits can be pinned without waiting for them.
 */

/** The window everything here is counted over. */
export const FLOOD_WINDOW_MS = 5_000;

/** Messages main did not ask for, per window, with no work handed over: 2,000 a second. */
export const FLOOD_BASE_MESSAGES = 10_000;

/**
 * More allowed for each call main made in the window. Generous: an extension that does a
 * dozen host calls for each message is doing a lot, not attacking anything.
 */
export const FLOOD_MESSAGES_PER_CALL = 16;

/**
 * Bytes per window, from all messages together, replies included: 100 MB a second, where
 * the largest legitimate message is a 10 MB network body. It is what stops a loop posting
 * huge strings, which reaches the message limit long after main has stopped responding.
 */
export const FLOOD_BYTES = 512 * 1024 * 1024;

/**
 * The most one message may hold, in characters and bytes, whatever it is for.
 *
 * Not a nicety. Measured in Electron 44: `JSON.stringify` of one flat string of about
 * 256 MB (128 million two-byte characters) ends the whole process, "Zone Allocation failed",
 * and no try/catch sees it. So a stranger's 300 MB string only has to reach ANY code in main
 * that stringifies, and there is plenty. 64 million characters is measured safe in all
 * three forms: one-byte, two-byte, and all control characters that escape to six times
 * their length. Everything an extension legitimately sends is a tenth of this.
 */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** What a container costs, so a message of nothing but empty ones still adds up. */
const CONTAINER_BYTES = 32;

/**
 * How large a message is, stopping as soon as it is known to be over `stopAt`.
 *
 * It walks everything, because one string out of a thousand is all it takes (see
 * `MAX_MESSAGE_BYTES`), so an estimate from a sample would leave the hole open. That is
 * affordable because the limit bounds the walk: every value counted costs at least 8
 * bytes, so it stops after a few million values, and main has already paid more than that
 * to deserialize them. Lengths are counted before any looping, so an array claiming four
 * billion empty slots stops the walk rather than running it.
 *
 * A message can contain anything structured clone can: cycles, Maps, Sets, and Errors and
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

export type FloodVerdict = 'ok' | 'too-many' | 'too-large';

export interface FloodBudget {
  /** Main handed the extension a call to make: more is allowed back. */
  noteCall(): void;
  /** One message arrived. `solicited` means it is a reply main was waiting for. */
  noteMessage(message: unknown, solicited: boolean): FloodVerdict;
}

export function createFloodBudget(now: () => number = Date.now): FloodBudget {
  let windowStart = now();
  let unsolicited = 0;
  let calls = 0;
  let bytes = 0;

  const roll = (): void => {
    const time = now();
    if (time - windowStart < FLOOD_WINDOW_MS) return;
    windowStart = time;
    unsolicited = 0;
    calls = 0;
    bytes = 0;
  };

  return {
    noteCall() {
      roll();
      calls += 1;
    },
    noteMessage(message, solicited) {
      roll();
      const size = messageBytes(message);
      if (size > MAX_MESSAGE_BYTES) return 'too-large';
      bytes += size;
      if (bytes > FLOOD_BYTES) return 'too-large';
      if (solicited) return 'ok';
      unsolicited += 1;
      return unsolicited > FLOOD_BASE_MESSAGES + calls * FLOOD_MESSAGES_PER_CALL ? 'too-many' : 'ok';
    },
  };
}
