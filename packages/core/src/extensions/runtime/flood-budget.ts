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

import { MAX_MESSAGE_BYTES, messageBytes } from '../../utils/json-size';

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
 * The most one message may hold, and how it is measured: the main process's one rule for
 * how large a value may be before it is stringified (see `utils/json-size`). Everything an
 * extension legitimately sends is a tenth of it.
 */
export { MAX_MESSAGE_BYTES, messageBytes };

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
