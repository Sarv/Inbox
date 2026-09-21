/**
 * Where sender profiles live, and — more importantly — how rarely they are
 * written.
 *
 * The table is held in memory, mutated per message at no I/O cost, and written
 * through the SDK's flush scheduler, which coalesces a whole sync burst into one
 * write (the storage backend rewrites its whole JSON file synchronously per
 * `set` — see `createFlushScheduler` for why that matters). The cost of the
 * trade is bounded and acceptable: a crash loses at most one interval of
 * counters, which the next sync re-observes anyway.
 */

import { createFlushScheduler, DEFAULT_FLUSH_INTERVAL_MS } from '@sarvinbox/core/extension-sdk';

import { applyObservation, emptyProfile, type SenderObservation, type SenderProfile } from './relationship';

/** A mailbox can hold tens of thousands of distinct senders; storage.json is a
 *  single JSON file read in full on every load. Cap it. */
export const MAX_TRACKED_SENDERS = 2_000;

/** How long changes may sit in memory before being written. */
export const FLUSH_INTERVAL_MS = DEFAULT_FLUSH_INTERVAL_MS;

/** Key under which the whole table is stored. */
export const TABLE_KEY = 'sender-profiles';

export type ProfileTable = Record<string, SenderProfile>;

export interface ProfileStoreOptions {
  load: () => Promise<unknown>;
  save: (table: ProfileTable) => Promise<void>;
  now?: () => number;
  flushIntervalMs?: number;
  maxSenders?: number;
  onError?: (error: unknown) => void;
}

export interface ProfileStore {
  /** Resolves once the table on disk has been read. */
  ready: Promise<void>;
  /** Fold one message in and return the sender's updated profile. */
  observe(key: string, observation: SenderObservation): SenderProfile;
  get(key: string): SenderProfile | undefined;
  snapshot(): ProfileTable;
  /** Write now, if anything changed. */
  flush(): Promise<void>;
  /** Stop the timer and write any pending changes. */
  dispose(): Promise<void>;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Rebuild a table from whatever was on disk, dropping anything malformed.
 *
 * The file is plain JSON in the user's data directory: it can be truncated by a
 * crash mid-write, or edited by hand. A NaN count silently poisons every score
 * that sender ever gets, so entries are validated rather than trusted.
 */
export function sanitizeTable(raw: unknown): ProfileTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const table: ProfileTable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    // `sent` defaults rather than disqualifies: a table written by an older
    // build is still worth keeping, and relearning the counters would throw
    // away months of history over one missing field.
    const sent = isFiniteNonNegative(entry.sent) ? entry.sent : 0;
    if (
      !isFiniteNonNegative(entry.received) ||
      !isFiniteNonNegative(entry.replied) ||
      !isFiniteNonNegative(entry.starred) ||
      !isFiniteNonNegative(entry.direct) ||
      !isFiniteNonNegative(entry.firstSeen) ||
      !isFiniteNonNegative(entry.lastSeen)
    ) {
      continue;
    }
    table[key] = {
      received: entry.received,
      replied: entry.replied,
      sent,
      starred: entry.starred,
      direct: entry.direct,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
    };
  }
  return table;
}

/**
 * Keep the `maxSenders` most recently active senders.
 *
 * Recency rather than volume: a bulk sender wins any volume contest, and the
 * whole point of the table is the people you are currently dealing with.
 */
/**
 * Add two profiles for the same sender together.
 *
 * Needed because loading the table from disk is asynchronous while observing a
 * message is not: messages synced during activation are folded into an empty
 * in-memory profile before the stored one arrives. Replacing the table on load
 * would silently discard them — the counters simply come out low, with nothing
 * to indicate anything was lost. Summing is exact here precisely because the
 * in-memory profile was built from zero, never from the stored one.
 */
export function mergeProfiles(left: SenderProfile, right: SenderProfile): SenderProfile {
  return {
    received: left.received + right.received,
    replied: left.replied + right.replied,
    sent: left.sent + right.sent,
    starred: left.starred + right.starred,
    direct: left.direct + right.direct,
    firstSeen: Math.min(left.firstSeen, right.firstSeen),
    lastSeen: Math.max(left.lastSeen, right.lastSeen),
  };
}

/** Merge a stored table into one already holding live observations. */
export function mergeTables(stored: ProfileTable, live: ProfileTable): ProfileTable {
  const merged: ProfileTable = { ...stored };
  for (const [key, profile] of Object.entries(live)) {
    const existing = merged[key];
    merged[key] = existing ? mergeProfiles(existing, profile) : profile;
  }
  return merged;
}

export function pruneTable(table: ProfileTable, maxSenders: number): ProfileTable {
  const entries = Object.entries(table);
  if (entries.length <= maxSenders) return table;

  entries.sort((left, right) => right[1].lastSeen - left[1].lastSeen);
  return Object.fromEntries(entries.slice(0, maxSenders));
}

export function createProfileStore(options: ProfileStoreOptions): ProfileStore {
  const now = options.now ?? Date.now;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const maxSenders = options.maxSenders ?? MAX_TRACKED_SENDERS;
  const onError = options.onError ?? (() => undefined);

  let table: ProfileTable = {};

  const ready = (async () => {
    try {
      // Merged, never assigned: messages can be observed while this read is
      // still in flight. See mergeTables.
      table = mergeTables(sanitizeTable(await options.load()), table);
    } catch (error) {
      // A missing or unreadable table is an empty one — we relearn from the
      // next sync. It must never stop the extension activating.
      onError(error);
    }
  })();

  const scheduler = createFlushScheduler({
    intervalMs: flushIntervalMs,
    onError,
    write: async () => {
      table = pruneTable(table, maxSenders);
      await options.save(table);
    },
  });

  return {
    ready,

    observe(key: string, observation: SenderObservation): SenderProfile {
      const existing = table[key] ?? emptyProfile(observation.at || now());
      const updated = applyObservation(existing, observation);
      table[key] = updated;
      scheduler.markDirty();
      return updated;
    },

    get(key: string): SenderProfile | undefined {
      return table[key];
    },

    snapshot(): ProfileTable {
      return { ...table };
    },

    flush: () => scheduler.flush(),

    dispose: () => scheduler.dispose(),
  };
}
