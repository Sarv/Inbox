// A per-account, observable, in-memory copy of a list the main process keeps in
// each account's database — the shape every remote-image trust source has (the
// "always load images" allowlist, the trusted senders, the people the user has
// emailed).
//
// Why it exists, in the order the bugs happened:
//
//  * READS ARE SYNCHRONOUS. The block-vs-load decision is made while a message
//    renders, so the list has to be in memory already; a miss answers "no"
//    (the conservative answer) and starts a load.
//  * A LOAD THAT LANDS MUST RE-RENDER. The old caches warmed in the background
//    and told nobody, so the first message opened after launch kept its banner
//    even for an allowed sender. Every change here bumps a version and notifies
//    subscribers (see `useSyncExternalStore` in the components).
//  * PER ACCOUNT. The unified view shows other accounts' mail in the reading
//    pane, so a single "active account" copy answered for the wrong mailbox.
//    Each account has its own entry; a read names its account, or means the
//    active one.
//  * A FAILED LOAD IS NOT AN EMPTY LIST. The old allowlist cached `new Set()`
//    on an IPC error — "nobody is allowed" until the next account switch. Here a
//    failure leaves the entry unloaded (reads stay conservative), retries on a
//    bounded backoff, and after that retries on the next read once the backoff
//    has passed. An unreadable store and an empty one are opposite facts.
//  * OPTIMISTIC WRITES THAT CAN FAIL. A write shows immediately, survives a load
//    that races it, and is rolled back if the main process refuses it.

import { createLogger } from '@sarvinbox/core/logger';

const log = createLogger('AccountScopedCache');

/** Backoff between timed retries of a failed load, in ms. Bounded on purpose:
 *  after the last one a read retries instead (once the last delay has passed),
 *  so a store that stays down never keeps a timer chain alive. */
export const LOAD_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000];

/** Holds the active account's data while its id is not known yet (early boot,
 *  single-account tests). Loaded with no account id, i.e. main's active one. */
const UNKNOWN_ACTIVE = '';

let activeAccount: string | null = null;
const registry = new Set<{ dropUnknownActive: () => void }>();

/** The account a read with no account means. */
export function activeCacheAccount(): string | null {
  return activeAccount;
}

/** The account id to hand the main process for a call about `accountId`: the
 *  one named, else the active one, else none (main's active account). Naming
 *  the account explicitly keeps a write in the account the cache filed it
 *  under even if main switches accounts while the call is in flight. */
export function resolveCacheAccount(accountId?: string | null): string | undefined {
  return accountId || activeAccount || undefined;
}

/**
 * Point every cache's "active account" at `accountId`. Entries held under the
 * not-yet-known active account are dropped, because they may belong to the
 * account being left. Returns whether the active account changed.
 */
export function setActiveCacheAccount(accountId: string | null | undefined): boolean {
  const next = accountId || null;
  if (next === activeAccount) return false;
  activeAccount = next;
  registry.forEach((cache) => cache.dropUnknownActive());
  return true;
}

export interface AccountScopedCacheOptions<T> {
  /** For logs only. */
  name: string;
  /**
   * Read the whole list for one account (`undefined` = the active one). MUST
   * throw (or reject) when the list could not be read — resolving `[]` on an
   * error is exactly the "nobody is trusted" bug this cache exists to avoid.
   */
  load: (accountId: string | undefined) => Promise<T[]>;
  /** The normalised key an item is looked up by ('' = not a usable item). */
  keyOf: (item: T) => string;
  /** Override the retry backoff (tests). */
  retryDelaysMs?: readonly number[];
}

export interface AccountScopedCache<T> {
  /** Every key for the account (optimistic writes included). Starts a load on a miss. */
  keys: (accountId?: string | null) => ReadonlySet<string>;
  /** `keys(accountId).has(key)`. */
  has: (accountId: string | null | undefined, key: string) => boolean;
  /** The items, optimistic additions first. Starts a load on a miss. */
  items: (accountId?: string | null) => readonly T[];
  /** Has this account's list been read at least once? */
  isLoaded: (accountId?: string | null) => boolean;
  /** Start a load if the account has none and none is running or backing off. */
  ensure: (accountId?: string | null) => void;
  /** Load now, coalescing with one already running. Never rejects. Existing
   *  data stays readable until the new list lands. */
  reload: (accountId?: string | null) => Promise<void>;
  /**
   * Apply a change optimistically and persist it with `persist`, which resolves
   * true when the main process stored it. On false (or a throw) the change is
   * rolled back. Resolves with the outcome.
   */
  write: (
    accountId: string | null | undefined,
    change: { add: T } | { remove: string },
    persist: () => Promise<boolean>,
  ) => Promise<boolean>;
  /** Forget every account (and cancel pending retries). */
  clear: () => void;
  /** Forget one account (a removed one): its list, pending retries and all. */
  forget: (accountId: string) => void;
  subscribe: (listener: () => void) => () => void;
  /** Changes whenever anything a read could return changes. */
  getVersion: () => number;
}

interface Entry<T> {
  loaded: T[] | null;
  pendingAdds: Map<string, T>;
  pendingRemoves: Set<string>;
  keys: Set<string>;
  view: T[];
  inflight: Promise<void> | null;
  failures: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** Reads before this time (ms) do not start another load after a failure. */
  coolUntil: number;
  /** Counts stored writes, so a load knows which ones it may have missed. */
  writeSeq: number;
  /** Writes stored while a load was in flight, or before the first load — the
   *  load may have read the database before them, so they are re-applied to
   *  its result (and, until one lands, they are what the view shows). */
  settledWrites: Array<{ seq: number; key: string; add?: T }>;
}

export function createAccountScopedCache<T>(options: AccountScopedCacheOptions<T>): AccountScopedCache<T> {
  const delays = options.retryDelaysMs ?? LOAD_RETRY_DELAYS_MS;
  const entries = new Map<string, Entry<T>>();
  const listeners = new Set<() => void>();
  let version = 0;

  const notify = () => {
    version += 1;
    listeners.forEach((listener) => {
      try { listener(); } catch (error) { log.warn(`${options.name}: a listener threw: ${(error as Error)?.message ?? error}`); }
    });
  };

  const keyFor = (accountId?: string | null): string => accountId || activeAccount || UNKNOWN_ACTIVE;
  const argFor = (key: string): string | undefined => (key === UNKNOWN_ACTIVE ? undefined : key);
  const label = (key: string) => (key === UNKNOWN_ACTIVE ? 'the active account' : key);

  const entryFor = (key: string): Entry<T> => {
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        loaded: null, pendingAdds: new Map(), pendingRemoves: new Set(), keys: new Set(), view: [],
        inflight: null, failures: 0, retryTimer: null, coolUntil: 0, writeSeq: 0, settledWrites: [],
      };
      entries.set(key, entry);
    }
    return entry;
  };

  /** Apply stored writes, in order, to a list. */
  const applyWrites = (list: T[], writes: Entry<T>['settledWrites']): T[] => {
    let out = list;
    for (const write of writes) {
      out = out.filter((item) => options.keyOf(item) !== write.key);
      if (write.add !== undefined) out = [write.add, ...out];
    }
    return out;
  };

  /** Recompute the read view: loaded (or, before the first load, the writes
   *  stored so far) ∪ pending adds − pending removes. */
  const rebuild = (entry: Entry<T>) => {
    const loadedOrStored = entry.loaded ?? applyWrites([], entry.settledWrites);
    const base = loadedOrStored.filter((item) => {
      const k = options.keyOf(item);
      return !!k && !entry.pendingRemoves.has(k) && !entry.pendingAdds.has(k);
    });
    entry.view = [...entry.pendingAdds.values(), ...base];
    entry.keys = new Set(entry.view.map(options.keyOf).filter(Boolean));
  };

  const cancelRetry = (entry: Entry<T>) => {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  };

  const runLoad = (key: string): Promise<void> => {
    const entry = entryFor(key);
    if (entry.inflight) return entry.inflight;
    cancelRetry(entry);
    const startSeq = entry.writeSeq;
    // Started from a resolved promise, never run inline: a loader that throws
    // synchronously would otherwise settle before `inflight` is even set, and
    // leave it pointing at a finished load forever (no load would ever start
    // again for this account).
    const task: Promise<void> = Promise.resolve().then(async () => {
      try {
        const items = await options.load(argFor(key));
        if (entries.get(key) !== entry) return; // cleared / account dropped meanwhile
        // A write stored after this read began may be missing from it.
        const loaded = applyWrites(
          Array.isArray(items) ? items : [],
          entry.settledWrites.filter((write) => write.seq > startSeq),
        );
        entry.settledWrites = [];
        entry.loaded = loaded;
        entry.failures = 0;
        entry.coolUntil = 0;
        rebuild(entry);
        notify();
      } catch (error) {
        if (entries.get(key) !== entry) return;
        entry.failures += 1;
        const delay = delays[Math.min(entry.failures, delays.length) - 1] ?? 0;
        entry.coolUntil = Date.now() + delay;
        const timed = entry.failures <= delays.length;
        if (entry.failures === 1 || !timed) {
          log.warn(
            `${options.name}: could not load for ${label(key)} (${(error as Error)?.message ?? error}) — ` +
            `treating it as unknown, not empty; ${timed ? `retrying in ${delay} ms` : 'retrying on the next read'}`,
          );
        }
        if (timed) {
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = null;
            if (entries.get(key) === entry) void runLoad(key);
          }, delay);
        }
      } finally {
        if (entry.inflight === task) entry.inflight = null;
      }
    });
    entry.inflight = task;
    return task;
  };

  const ensureKey = (key: string) => {
    const entry = entryFor(key);
    if (entry.loaded || entry.inflight || entry.retryTimer) return;
    if (entry.failures > 0 && Date.now() < entry.coolUntil) return;
    void runLoad(key);
  };

  const cache: AccountScopedCache<T> = {
    keys: (accountId) => {
      const key = keyFor(accountId);
      ensureKey(key);
      return entryFor(key).keys;
    },
    has: (accountId, k) => !!k && cache.keys(accountId).has(k),
    items: (accountId) => {
      const key = keyFor(accountId);
      ensureKey(key);
      return entryFor(key).view;
    },
    isLoaded: (accountId) => !!entries.get(keyFor(accountId))?.loaded,
    ensure: (accountId) => ensureKey(keyFor(accountId)),
    reload: (accountId) => runLoad(keyFor(accountId)),
    write: async (accountId, change, persist) => {
      const key = keyFor(accountId);
      const entry = entryFor(key);
      const k = 'add' in change ? options.keyOf(change.add) : change.remove;
      if (!k) return false;
      if ('add' in change) {
        entry.pendingRemoves.delete(k);
        entry.pendingAdds.set(k, change.add);
      } else {
        entry.pendingAdds.delete(k);
        entry.pendingRemoves.add(k);
      }
      rebuild(entry);
      notify();

      let stored = false;
      try {
        stored = await persist();
      } catch (error) {
        log.warn(`${options.name}: a write for ${label(key)} failed: ${(error as Error)?.message ?? error}`);
        stored = false;
      }
      if (entries.get(key) !== entry) return stored; // cleared meanwhile: the next load reads the truth
      if (stored) {
        entry.writeSeq += 1;
        if (entry.inflight || !entry.loaded) {
          entry.settledWrites.push({ seq: entry.writeSeq, key: k, ...('add' in change ? { add: change.add } : {}) });
        }
      }
      // Settle: fold a stored change into the loaded list, drop a refused one.
      if ('add' in change) {
        entry.pendingAdds.delete(k);
        if (stored && entry.loaded && !entry.loaded.some((item) => options.keyOf(item) === k)) {
          entry.loaded = [change.add, ...entry.loaded];
        }
      } else {
        entry.pendingRemoves.delete(k);
        if (stored && entry.loaded) entry.loaded = entry.loaded.filter((item) => options.keyOf(item) !== k);
      }
      rebuild(entry);
      notify();
      return stored;
    },
    clear: () => {
      entries.forEach(cancelRetry);
      entries.clear();
      notify();
    },
    forget: (accountId) => {
      const entry = entries.get(accountId);
      if (!entry) return;
      cancelRetry(entry);
      entries.delete(accountId);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getVersion: () => version,
  };

  registry.add({
    dropUnknownActive: () => {
      const entry = entries.get(UNKNOWN_ACTIVE);
      if (entry) cancelRetry(entry);
      entries.delete(UNKNOWN_ACTIVE);
      // A read with no account now means another account: re-render.
      notify();
    },
  });

  return cache;
}
