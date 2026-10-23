import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface InboxAssistantCachedRecommendation {
  recommendation: 'mark_read' | 'keep_unread';
  reason: string;
  confidence: number;
}

interface RecommendationInput {
  accountId: string;
  accountEmail: string;
  providerIdentity: string;
  policyVersion: string;
  /** Exact current source-state hashes, sorted by message ID by the caller. */
  members: Array<[string, string]>;
  /** Complete classifier input; hashed immediately and never retained here. */
  content: string;
}

export function inboxAssistantRecommendationFingerprint(input: RecommendationInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

interface CacheEntry { expiresAt: number; value: InboxAssistantCachedRecommendation }
const MAX_TTL_MS = 15 * 60_000;

/**
 * Main-process, memory-only reuse of verified recommendations. A cache hit is
 * never mail-action authority: the caller must rerun all current safety gates
 * and construct a new host-held source snapshot before applying any action.
 */
export class InboxAssistantRecommendationCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? MAX_TTL_MS;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 1000
      || !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > MAX_TTL_MS) {
      throw new Error('Invalid recommendation cache limits.');
    }
  }

  get(key: string): InboxAssistantCachedRecommendation | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(key, entry); // LRU touch never extends the original TTL.
    return { ...entry.value };
  }

  set(key: string, value: { recommendation: string; reason: string; confidence: number }): void {
    if (!/^[a-f0-9]{64}$/.test(key) || !['mark_read', 'keep_unread'].includes(value.recommendation)
      || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 800
      || !Number.isFinite(value.confidence) || value.confidence < 0.9 || value.confidence > 1) return;
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expiresAt: now + this.ttlMs, value: {
      recommendation: value.recommendation as InboxAssistantCachedRecommendation['recommendation'], reason: value.reason, confidence: value.confidence,
    } });
  }

  clear(): void { this.entries.clear(); }
}
