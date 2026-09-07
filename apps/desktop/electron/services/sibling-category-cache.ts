/**
 * Dual-delivery de-dup cache (framework-agnostic, unit-testable).
 *
 * When the SAME message (same Message-ID) is delivered to two linked accounts
 * (e.g. sarv + gmail), it must be categorized by the LLM exactly ONCE and the
 * result shared — otherwise we pay for a second call and, worse, the second
 * (non-deterministic) run can return a different/empty result and flip the label.
 *
 * This holds the categories assigned this session, keyed by Message-ID, so a
 * copy that reaches the pipeline slightly later can reuse the result even before
 * the first copy's categories are committed to its DB. Bounded by TTL + size; the
 * per-account DB is the durable fallback (the service's findSiblingCategories
 * consults this first, then the DB).
 *
 * `now` is injectable so TTL/eviction are deterministically testable.
 */
export class SiblingCategoryCache {
  private readonly map = new Map<string, { categories: string[]; at: number }>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record the categories assigned to `messageId`. No-op for a missing id or empty list. */
  record(messageId: string | undefined, categories: string[]): void {
    if (!messageId || !Array.isArray(categories) || categories.length === 0) return;
    this.map.set(messageId, { categories: [...categories], at: this.now() });
    if (this.map.size > this.max) {
      // First sweep TTL-expired entries, then FIFO-trim (insertion order) down to cap.
      const cutoff = this.now() - this.ttlMs;
      for (const [k, v] of this.map) if (v.at < cutoff) this.map.delete(k);
      while (this.map.size > this.max) {
        const first = this.map.keys().next().value;
        if (first === undefined) break;
        this.map.delete(first);
      }
    }
  }

  /** Categories for `messageId` if recorded and still fresh; null otherwise. */
  get(messageId: string | undefined): string[] | null {
    if (!messageId) return null;
    const mem = this.map.get(messageId);
    if (mem && this.now() - mem.at < this.ttlMs && mem.categories.length > 0) return mem.categories;
    return null;
  }

  /** Test/introspection helper. */
  get size(): number { return this.map.size; }
}
