// Async mutex (critical section) — no imports, safe in the renderer.

/** A serializer for async critical sections. See {@link createMutex}. */
export interface Mutex {
  /**
   * Run `fn` with exclusive access: it starts only once every previously
   * queued section has settled, and the next one waits for it. The caller
   * gets `fn`'s own settlement — a rejection is NOT swallowed, and never
   * wedges the queue for the sections behind it.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Sections queued or running right now. Diagnostics/tests. */
  readonly pending: number;
}

/**
 * Serialize async sections that must not interleave.
 *
 * The hazard this exists for is a multi-step operation on a piece of SHARED,
 * STATEFUL infrastructure — one where each step is fine on its own but the
 * sequence is only correct if nothing else touches the resource in between. An
 * IMAP connection is the canonical case in this app: `SELECT` sets a mailbox on
 * the socket and every following command is interpreted against it, so a second
 * caller's `SELECT` landing between another's select and its fetch silently
 * redirects that fetch to the wrong mailbox.
 *
 * Chaining is what makes it work: each section is appended to a promise that
 * only resolves when the one before it has settled. The chain is kept alive
 * across a rejection (the internal link is neutralised with a double-handler)
 * so one failed section can neither reject an unrelated later one nor leave an
 * unhandled rejection behind — while the ORIGINAL promise handed back to the
 * caller still rejects, as it must.
 *
 * Not reentrant: calling `runExclusive` from inside a section deadlocks. A
 * caller that needs reentrancy must track "already held" itself (see
 * ImapFlowClient's folder lock, which uses an AsyncLocalStorage flag).
 */
export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      pending++;
      // Both handlers run `fn`, so a rejected predecessor still lets this
      // section start rather than skipping it.
      const next = tail.then(fn, fn) as Promise<T>;
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next.finally(() => {
        pending--;
      });
    },
    get pending() {
      return pending;
    },
  };
}
