/**
 * Coalesce a burst of identical log events into ONE line per window.
 *
 * The pattern this replaces was hand-rolled twice (the IDLE-event storm in
 * `sync-handlers.ts` and the deferred category-label mirror in
 * `unified-pipeline-service.ts`) and is needed wherever a per-item condition can
 * fire hundreds of times in a burst: one server event per message, one
 * categorized mail per pipeline tick. Each individual line costs a synchronous
 * main-thread write and buries everything else in the log, while the only thing
 * a reader wants is "this happened, N times, here's a sample".
 *
 * Counts are keyed, so several accounts/folders bursting at once stay
 * distinguishable. The timer is `unref`'d — a pending summary never holds the
 * process open.
 */
export interface LogAggregatorOptions<T> {
  /** How long to collect before emitting. */
  windowMs: number;
  /** Emits the summary. Called once per window, only when something was noted. */
  emit: (summary: string) => void;
  /**
   * Renders the collected counts. Receives insertion-ordered entries, each with
   * the key, how many times it fired, and the FIRST sample noted for that key.
   */
  format?: (entries: Array<{ key: string; count: number; sample: T | undefined }>) => string;
}

/** Default rendering: `key`, or `key xN` when it fired more than once. */
const defaultFormat = (entries: Array<{ key: string; count: number }>): string =>
  entries.map(({ key, count }) => (count > 1 ? `${key} x${count}` : key)).join('; ');

export class LogAggregator<T = undefined> {
  private readonly counts = new Map<string, { count: number; sample: T | undefined }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LogAggregatorOptions<T>) {}

  /**
   * Record one occurrence. The first call in a window arms the timer; every
   * later call in that window only increments, so a burst of N events costs one
   * timer and one log line.
   */
  note(key: string, sample?: T): void {
    const existing = this.counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      this.counts.set(key, { count: 1, sample });
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.options.windowMs);
    // Never hold the process open just to print a log line.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Emit the pending summary now and clear it. Safe to call when nothing is
   * pending (does nothing), so a shutdown path can drain unconditionally.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.counts.size === 0) return;
    const entries = [...this.counts.entries()].map(([key, { count, sample }]) => ({ key, count, sample }));
    this.counts.clear();
    const summary = (this.options.format ?? defaultFormat)(entries);
    if (summary) this.options.emit(summary);
  }

  /** Drop anything pending WITHOUT emitting — for teardown in tests. */
  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.counts.clear();
  }

  /** Whether a summary is currently pending. */
  get pending(): boolean {
    return this.counts.size > 0;
  }
}
