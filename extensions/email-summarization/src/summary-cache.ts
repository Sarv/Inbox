/**
 * Remembering a summary so it is paid for once.
 *
 * A summary costs an AI call — money, a few seconds, and on a metered key a
 * quota. Opening the same thread twice must not cost it twice, and neither must
 * summarizing on arrival and then opening the mail.
 *
 * The key is a hash of the exact text the model was shown, not the message or
 * thread id. That is what makes the cache correct without a TTL: identical text
 * has an identical summary forever, and a thread that gains a reply renders to
 * different text and so misses, which is precisely when it should. An id-keyed
 * cache would have to guess at staleness and would serve a summary that stops
 * one message short.
 *
 * Writes go through the SDK's flush scheduler because the storage backend an
 * extension is given rewrites its whole JSON file synchronously per `set`.
 */

import { createHash } from 'node:crypto';

import { createFlushScheduler, type FlushScheduler } from '@sarvinbox/core/extension-sdk';

/** Cached summaries kept. Each is a paragraph and a few bullets. */
export const MAX_CACHED_SUMMARIES = 200;

/** Key under which the whole table is stored. */
export const TABLE_KEY = 'summaries';

/** Length of the content key. Collision risk over 200 entries is negligible. */
const KEY_LENGTH = 16;

export interface CachedSummary<T = unknown> {
  /** The summary itself, as returned to the caller. */
  value: T;
  /** UTC epoch ms of the last time this entry was written or read. */
  usedAt: number;
}

export type SummaryTable = Record<string, CachedSummary>;

export interface SummaryCacheOptions {
  load: () => Promise<unknown>;
  save: (table: SummaryTable) => Promise<void>;
  now?: () => number;
  flushIntervalMs?: number;
  maxEntries?: number;
  onError?: (error: unknown) => void;
}

export interface SummaryCache {
  /** Resolves once the stored table has been read. */
  ready: Promise<void>;
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  snapshot(): SummaryTable;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Content key for the text a model was shown.
 *
 * SHA-1 from the Node runtime rather than a hand-rolled hash: it is already
 * there, it is deterministic across platforms and versions, and a cache key is
 * exactly the non-security use it remains correct for. Truncated because the
 * key is stored as a JSON property name 200 times over and the full digest buys
 * nothing at that scale.
 */
export function contentKey(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, KEY_LENGTH);
}

/**
 * Rebuild a table from whatever was on disk, dropping anything malformed.
 *
 * The file is plain JSON in the user's data directory: a crash mid-write can
 * truncate it and a curious user can edit it. An entry with no `value` would
 * otherwise be served as a summary of `undefined`.
 */
export function sanitizeTable(raw: unknown): SummaryTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const table: SummaryTable = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (candidate.value === undefined || candidate.value === null) continue;
    const usedAt =
      typeof candidate.usedAt === 'number' && Number.isFinite(candidate.usedAt) && candidate.usedAt >= 0
        ? candidate.usedAt
        : 0;
    table[key] = { value: candidate.value, usedAt };
  }
  return table;
}

/**
 * Keep the `maxEntries` most recently USED summaries.
 *
 * Recency of use, not of writing: a long thread somebody returns to every day
 * should outlive fifty one-off messages summarized once and never opened again.
 */
export function pruneTable(table: SummaryTable, maxEntries: number): SummaryTable {
  const entries = Object.entries(table);
  if (entries.length <= maxEntries) return table;

  entries.sort((left, right) => right[1].usedAt - left[1].usedAt);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

/** Merge a stored table into one already holding live entries. */
export function mergeTables(stored: SummaryTable, live: SummaryTable): SummaryTable {
  // Live wins on a collision: it was computed from the same text this run, so
  // it is the same summary, and its `usedAt` is the newer one.
  return { ...stored, ...live };
}

export function createSummaryCache(options: SummaryCacheOptions): SummaryCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_CACHED_SUMMARIES;
  const onError = options.onError ?? (() => undefined);

  let table: SummaryTable = {};

  const ready = (async () => {
    try {
      // Merged, never assigned: a summary can be computed while this read is
      // still in flight, and assigning would throw away the AI call that
      // produced it.
      table = mergeTables(sanitizeTable(await options.load()), table);
    } catch (error) {
      // An unreadable cache is an empty one — the next summary recomputes. It
      // must never stop the extension activating.
      onError(error);
    }
  })();

  const scheduler: FlushScheduler = createFlushScheduler({
    ...(options.flushIntervalMs === undefined ? {} : { intervalMs: options.flushIntervalMs }),
    onError,
    write: async () => {
      table = pruneTable(table, maxEntries);
      await options.save(table);
    },
  });

  return {
    ready,

    get<T>(key: string): T | undefined {
      const entry = table[key];
      if (!entry) return undefined;
      // A read is a use. Without this, pruning evicts the threads somebody
      // actually reads in favour of whatever was summarized most recently.
      entry.usedAt = now();
      scheduler.markDirty();
      return entry.value as T;
    },

    set<T>(key: string, value: T): void {
      table[key] = { value, usedAt: now() };
      scheduler.markDirty();
    },

    snapshot(): SummaryTable {
      return { ...table };
    },

    flush: () => scheduler.flush(),

    dispose: () => scheduler.dispose(),
  };
}
