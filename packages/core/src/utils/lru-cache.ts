/**
 * A size-budgeted LRU cache.
 *
 * Extracted because two places needed exactly this and the second copy was
 * about to be written: the renderer's inline-image cache (which keeps base64
 * out of LLM prompts for the lifetime of a window) and the storage layer's
 * resolved-image cache (which avoids re-encoding the same logo to base64 once
 * per email in a thread). Both hold a small number of very large strings, so
 * both need a budget in CHARACTERS rather than a count — an entry cap alone is
 * meaningless when one entry can be 2 MB and another 200 bytes.
 *
 * Insertion-order eviction using `Map`'s documented ordering; a `get` hit
 * re-inserts to move the entry to the tail, so hot entries survive.
 *
 * Pure and dependency-free: no timers, no I/O, nothing to dispose. Callers that
 * need a different notion of size pass their own `sizeOf`.
 */

export interface SizeBudgetedLruOptions<V> {
  /** Hard cap on the number of entries. */
  readonly maxEntries: number;
  /** Hard cap on the summed `sizeOf` of all entries. */
  readonly maxSize: number;
  /**
   * Cost of one value. Defaults to string length, which is the case both
   * current callers want (characters of a base64 data URI).
   */
  readonly sizeOf?: (value: V) => number;
}

export class SizeBudgetedLru<V> {
  private readonly entries = new Map<string, V>();
  private readonly maxEntries: number;
  private readonly maxSize: number;
  private readonly sizeOf: (value: V) => number;
  private currentSize = 0;

  constructor(options: SizeBudgetedLruOptions<V>) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxSize = Math.max(1, options.maxSize);
    this.sizeOf = options.sizeOf ?? ((value) => String(value).length);
  }

  /** Number of live entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Summed `sizeOf` of live entries. */
  get bytes(): number {
    return this.currentSize;
  }

  /** The value for `key`, refreshing its recency, or undefined on a miss. */
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move to the tail of the insertion order. Without this the
    // cache is FIFO, and a long thread would evict the logo it is about to
    // ask for again.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** True without disturbing recency — for tests and metrics, not hot paths. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Store `value`, evicting the least recently used entries until both budgets
   * are satisfied.
   *
   * A value larger than the whole budget is NOT stored: admitting it would
   * evict everything else and then sit there as the sole occupant. Callers get
   * a miss next time and re-derive it, which is strictly better than flushing a
   * useful cache for one outlier.
   */
  set(key: string, value: V): void {
    const size = this.sizeOf(value);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.currentSize -= this.sizeOf(existing);
      this.entries.delete(key);
    }
    if (size > this.maxSize) {
      return;
    }
    this.entries.set(key, value);
    this.currentSize += size;
    this.evict();
  }

  /** Drop everything. */
  clear(): void {
    this.entries.clear();
    this.currentSize = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.currentSize > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const value = this.entries.get(oldest.value);
      if (value !== undefined) this.currentSize -= this.sizeOf(value);
      this.entries.delete(oldest.value);
    }
  }
}
