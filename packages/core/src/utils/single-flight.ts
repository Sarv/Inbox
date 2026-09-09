// Single-flight (request coalescing) — no imports, safe in the renderer.

/** A keyed set of in-flight operations. See `createSingleFlight`. */
export interface SingleFlight<T> {
  /**
   * Run `start()` under `key`, or join the run already in flight under that
   * key. The joiner gets the same settlement — value or rejection — as the
   * caller that started it.
   */
  run(key: string, start: () => Promise<T>): Promise<T>;
  /** The in-flight promise for `key`, if there is one. Diagnostics/tests. */
  pending(key: string): Promise<T> | undefined;
  /** How many operations are in flight right now. Diagnostics/tests. */
  readonly size: number;
}

/**
 * Coalesce concurrent calls that want the same thing.
 *
 * An operation that is expensive, stateful, or externally visible must not be
 * started twice just because two callers asked at once — and in this app they
 * routinely do. Mount, window focus, network-online and the reconnect ladder all
 * reach for the same connection, and React's StrictMode double-invokes mount
 * effects in development on top of that. Two overlapping connects then fight:
 * one tears down the socket the other is still opening ("Already connected or
 * connecting" → "Unexpected close"), and every write the operation performs on
 * the way through happens twice.
 *
 * Keying matters as much as the coalescing: same key means "the same thing", so
 * two connects to the SAME account join while connects to DIFFERENT accounts
 * both run.
 *
 * The entry is cleared only if it is still the one this run installed, so a
 * later run under the same key is never deleted by an earlier one's settlement.
 */
export function createSingleFlight<T>(): SingleFlight<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key: string, start: () => Promise<T>): Promise<T> {
      const pending = inFlight.get(key);
      if (pending) return pending;

      // start() is called inside the try so a SYNCHRONOUS throw rejects the
      // returned promise like any other failure, rather than escaping past the
      // bookkeeping and leaving a phantom entry behind.
      let run: Promise<T>;
      try {
        run = start();
      } catch (err) {
        return Promise.reject(err);
      }

      const tracked = run.finally(() => {
        if (inFlight.get(key) === tracked) inFlight.delete(key);
      });
      inFlight.set(key, tracked);
      return tracked;
    },

    pending(key: string): Promise<T> | undefined {
      return inFlight.get(key);
    },

    get size(): number {
      return inFlight.size;
    },
  };
}
