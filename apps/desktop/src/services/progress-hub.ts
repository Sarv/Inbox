/**
 * A latest-value broadcast channel for one long-running job.
 *
 * Why this exists: conversation extraction is single-flight per thread — the
 * FIRST caller to ask for a thread owns the run and everyone after it joins the
 * same promise. That dedup is right (a thread must never be extracted twice
 * concurrently) but it used to drop the joiner's progress callback on the
 * floor, so a user who opened a thread the BACKGROUND extractor had already
 * started got the final result and nothing before it: a full-pane spinner for
 * the entire multi-minute run, no bubbles, no counter, no way into the AI view.
 *
 * The hub separates "who is running the job" from "who is watching it". The run
 * publishes every update here whether or not anyone is listening; a subscriber
 * that arrives late is handed the most recent snapshot immediately, so joining a
 * run in progress paints what has been extracted so far instead of an empty
 * pane.
 *
 * Pure and framework-agnostic — no timers, no I/O, nothing to clean up beyond
 * the unsubscribe each subscriber gets back.
 */

export type ProgressListener<T> = (update: T) => void;

export interface ProgressHub<T> {
  /** Broadcast an update and remember it as the replay snapshot. */
  publish(update: T): void;
  /**
   * Start receiving updates. The most recent published update (if any) is
   * replayed synchronously before this returns, so a late joiner never has to
   * wait for the next one. Returns an unsubscribe function; calling it twice is
   * harmless.
   */
  subscribe(listener: ProgressListener<T>): () => void;
  /** The last published update, or null when nothing has been published yet. */
  readonly last: T | null;
}

/**
 * Deliver one update to one listener, swallowing (but reporting) a listener
 * that throws. A watcher's failure — a React setState against an unmounted
 * tree, say — must never abort the job being watched or rob the OTHER
 * watchers of the update.
 */
const deliver = <T>(listener: ProgressListener<T>, update: T): void => {
  try {
    listener(update);
  } catch (error) {
    console.warn('[ProgressHub] progress listener threw — ignoring:', error);
  }
};

export function createProgressHub<T>(): ProgressHub<T> {
  const listeners = new Set<ProgressListener<T>>();
  let lastUpdate: T | null = null;

  return {
    get last(): T | null {
      return lastUpdate;
    },
    publish(update: T): void {
      lastUpdate = update;
      // Iterate a copy: a listener that unsubscribes itself (or another) while
      // being notified must not mutate the set mid-iteration.
      for (const listener of [...listeners]) deliver(listener, update);
    },
    subscribe(listener: ProgressListener<T>): () => void {
      listeners.add(listener);
      if (lastUpdate !== null) deliver(listener, lastUpdate);
      return () => { listeners.delete(listener); };
    },
  };
}
