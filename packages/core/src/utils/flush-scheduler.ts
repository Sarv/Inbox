/**
 * Coalesce many in-memory changes into few writes.
 *
 * The problem this solves is the extension storage backend, which rewrites the
 * WHOLE of its `storage.json` synchronously, on the main thread, for every
 * `set`. Anything an extension records per message — a sender counter, a cached
 * summary — would otherwise turn a 40,000-message first sync into 40,000
 * synchronous whole-file writes of an ever-growing file. That is quadratic work
 * on the thread that draws the window.
 *
 * So callers hold their state in memory, call {@link FlushScheduler.markDirty}
 * at no I/O cost, and the write happens at most once per interval and only when
 * something actually changed. The cost is bounded and acceptable: a crash loses
 * at most one interval of changes, which the caller can relearn or recompute.
 *
 * Dependency-free on purpose — it is re-exported to extensions through
 * `@sarvinbox/core/extension-sdk`, which every extension bundles verbatim.
 */

/** Default gap between writes. Long enough to coalesce a sync burst. */
export const DEFAULT_FLUSH_INTERVAL_MS = 30_000;

export interface FlushSchedulerOptions {
  /**
   * Performs the write. Called only when there are pending changes, never
   * concurrently with itself.
   */
  write: () => Promise<void>;

  /** Gap between writes. Defaults to {@link DEFAULT_FLUSH_INTERVAL_MS}. */
  intervalMs?: number;

  /** Reports a failed write. The scheduler itself never throws. */
  onError?: (error: unknown) => void;
}

export interface FlushScheduler {
  /** Record that state changed and schedule a write. */
  markDirty(): void;

  /** True while changes are waiting to be written. */
  isDirty(): boolean;

  /** Write now, if anything changed. Resolves once the write has finished. */
  flush(): Promise<void>;

  /** Stop scheduling and write whatever is pending. */
  dispose(): Promise<void>;
}

export function createFlushScheduler(options: FlushSchedulerOptions): FlushScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const onError = options.onError ?? (() => undefined);

  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelTimer(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  async function flush(): Promise<void> {
    cancelTimer();
    if (!dirty) return;

    // Cleared BEFORE the write so a change made while the write is in flight is
    // not swallowed by it: that change re-marks the scheduler dirty and gets its
    // own flush, rather than being silently counted as already written.
    dirty = false;
    try {
      await options.write();
    } catch (error) {
      // Put the flag back so the next interval retries rather than dropping
      // everything accumulated since the last successful write.
      dirty = true;
      onError(error);
    }
  }

  return {
    markDirty(): void {
      dirty = true;
      if (timer || disposed) return;
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, intervalMs);
      // Never hold the process open for a flush.
      timer.unref?.();
    },

    isDirty(): boolean {
      return dirty;
    },

    flush,

    async dispose(): Promise<void> {
      disposed = true;
      await flush();
    },
  };
}
