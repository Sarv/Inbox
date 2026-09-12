import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Historical backfill scheduler. It is a background crawler over whole mailboxes,
 * so the pacing and the yield-to-live-mail rules ARE the contract:
 *   - first tick 30s after start; then FAST (3s / 24 chunks) only on a quiet
 *     machine, GENTLE (15s / 4 chunks, one folder per tick) while mail is landing,
 *     and a 30-minute sleep once everything is archived,
 *   - Trash/Spam and unsubscribed folders are never crawled; an All-Mail superset
 *     replaces the per-folder crawl,
 *   - a folder that reports "caught up" is not re-scanned every tick,
 *   - one account's failure never stops the others,
 *   - a tick already in flight is not re-entered, and stop() cancels the chain.
 */

const FIRST_DELAY_MS = 30_000;
const GENTLE_INTERVAL_MS = 15_000;
const FAST_INTERVAL_MS = 3_000;
const IDLE_INTERVAL_MS = 30 * 60_000;
const DELETION_RECONCILE_MS = 15 * 60_000;
const LARGE_MAILBOX_THRESHOLD = 5_000;

interface Folder {
  path: string;
  subscribed?: boolean;
  backfillComplete?: boolean;
  serverMessageCount?: number;
  // Sync state the duplicate-mailbox collapse reads: two names are only folded
  // together when the server proved they are one store.
  uidValidity?: number;
  totalCount?: number;
  specialUse?: string;
  allMail?: boolean;
}

const h = vi.hoisted(() => ({
  activeStorage: null as unknown,
  activeEngine: null as unknown,
  activeId: 'acct-active' as string | null,
  runtimes: [] as Array<[string, { storage: unknown; syncEngine: unknown; smtpClient: null }]>,
  busHandlers: [] as Array<(event: unknown) => void>,
  busThrows: false,
  unsubThrows: false,
  unsubCalls: 0,
  bulkCalls: [] as string[],
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getSyncEngine: () => h.activeEngine,
  getCurrentAccountId: () => h.activeId,
  getAllAccountRuntimes: () => h.runtimes,
}));

vi.mock('@sarvinbox/core', async () => ({
  // The REAL rule, not a stand-in: what may be collapsed into one mailbox is a
  // data-loss decision, so the scheduler must be tested against the same
  // function sync uses.
  buildStandardFolderAliasMap: (
    await import('../../../../../../packages/core/src/config/folder-mapping')
  ).buildStandardFolderAliasMap,
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
  getEventBus: () => ({
    on: (_event: string, cb: (event: unknown) => void) => {
      if (h.busThrows) throw new Error('bus unavailable');
      h.busHandlers.push(cb);
      return () => {
        h.unsubCalls += 1;
        if (h.unsubThrows) throw new Error('unsub failed');
      };
    },
  }),
  isTrashFolder: (f: Folder) => f.path.toLowerCase().includes('trash'),
  isSpamFolder: (f: Folder) => f.path.toLowerCase().includes('spam'),
  isAllMailSuperset: (f: Folder) => f.allMail === true,
  LARGE_MAILBOX_THRESHOLD,
}));

vi.mock('../../../../electron/services/bulk-backfill', () => ({
  maybeBackfillBulk: async (_storage: unknown, _engine: unknown, accountId: string) => {
    h.bulkCalls.push(accountId);
  },
}));

// Stands in for `registry_meta` in the core DB: a plain Map that OUTLIVES a
// `load()`, exactly as the real table outlives a relaunch. The thread-repair
// watermark lives here, so this is what makes "one full pass ever" testable.
const meta = new Map<string, string>();
vi.mock('../../../../electron/services/core-db', () => ({
  getMeta: (key: string) => meta.get(key) ?? null,
  setMeta: (key: string, value: string | null) => {
    if (value == null) meta.delete(key); else meta.set(key, value);
  },
}));

type Scheduler = typeof import('../../../../electron/services/backfill-scheduler');

/** Fresh module — timers, in-flight flag and per-storage sets are module state. */
const load = async (): Promise<Scheduler> => {
  vi.resetModules();
  return import('../../../../electron/services/backfill-scheduler');
};

interface AccountState {
  folders: Folder[];
  connected: boolean;
  drain: (path: string) => { done?: boolean; remaining?: number } | null;
  backfill: (path: string) => { done?: boolean } | null;
  reconcile: (path: string) => { deleted: number; updated: number };
  repairResult: unknown;
  repairThrows: boolean;
  hasRepair: boolean;
  drainCalls: string[];
  backfillCalls: string[];
  reconcileCalls: string[];
  repairCalls: number;
  /** `sinceCreatedAt` of every repairThreading call, in order. */
  repairWindows: Array<number | undefined>;
  foldersThrows: boolean;
}

const makeAccount = (folders: Folder[], over: Partial<AccountState> = {}) => {
  const state: AccountState = {
    folders,
    connected: true,
    drain: () => ({ done: true, remaining: 0 }),
    backfill: () => ({ done: true }),
    reconcile: () => ({ deleted: 0, updated: 0 }),
    repairResult: { emailsRetargeted: 3, threadsBefore: 10, threadsAfter: 8, iterations: 2 },
    repairThrows: false,
    hasRepair: true,
    drainCalls: [],
    backfillCalls: [],
    reconcileCalls: [],
    repairCalls: 0,
    repairWindows: [],
    foldersThrows: false,
    ...over,
  };

  const storage: Record<string, unknown> = {
    getFolders: async () => {
      if (state.foldersThrows) throw new Error('db closed');
      return state.folders;
    },
  };
  if (state.hasRepair) {
    storage.repairThreading = async (options: { sinceCreatedAt?: number } = {}) => {
      state.repairCalls += 1;
      state.repairWindows.push(options.sinceCreatedAt);
      if (state.repairThrows) throw new Error('repair failed');
      return state.repairResult;
    };
  }

  const engine = {
    isConnected: () => state.connected,
    drainFolderChunk: async (path: string) => {
      state.drainCalls.push(path);
      return state.drain(path);
    },
    backfillOlderChunk: async (path: string) => {
      state.backfillCalls.push(path);
      return state.backfill(path);
    },
    reconcileFolderDeletionsFull: async (path: string) => {
      state.reconcileCalls.push(path);
      return state.reconcile(path);
    },
  };

  return { state, storage, engine };
};

const folder = (path: string, over: Partial<Folder> = {}): Folder => ({
  path,
  subscribed: true,
  backfillComplete: false,
  serverMessageCount: 100,
  ...over,
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 5, 15, 12, 0, 0));
  h.activeStorage = null;
  h.activeEngine = null;
  h.activeId = 'acct-active';
  h.runtimes = [];
  h.busHandlers = [];
  h.busThrows = false;
  h.unsubThrows = false;
  h.unsubCalls = 0;
  h.bulkCalls = [];
  meta.clear(); // a fresh install per test; a launch is a `load()`, not a beforeEach
});

afterEach(() => { vi.useRealTimers(); });

describe('start / stop', () => {
  it('runs the first tick 30s after start and subscribes to new mail', async () => {
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBackfillScheduler();
    expect(h.busHandlers).toHaveLength(1);
    await advance(FIRST_DELAY_MS - 1);
    expect(a.state.backfillCalls).toEqual([]);

    await advance(1);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('is idempotent', async () => {
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('stop() cancels the pending tick and unsubscribes', async () => {
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    svc.stopBackfillScheduler();

    await advance(10 * IDLE_INTERVAL_MS);
    expect(a.state.backfillCalls).toEqual([]);
    expect(h.unsubCalls).toBe(1);
  });

  it('stop() mid-chain prevents any further tick', async () => {
    const a = makeAccount([folder('INBOX')], { backfill: () => ({ done: false }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    const after = a.state.backfillCalls.length;

    svc.stopBackfillScheduler();
    await advance(10 * GENTLE_INTERVAL_MS);
    expect(a.state.backfillCalls).toHaveLength(after);
  });

  it('starts even when the event bus refuses the subscription', async () => {
    h.busThrows = true;
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    expect(() => svc.startBackfillScheduler()).not.toThrow();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('tolerates an unsubscribe that throws, and is safe to stop twice', async () => {
    h.unsubThrows = true;
    const svc = await load();
    svc.startBackfillScheduler();
    expect(() => svc.stopBackfillScheduler()).not.toThrow();
    expect(() => svc.stopBackfillScheduler()).not.toThrow();
  });
});

describe('target enumeration', () => {
  it('retries when nothing is connected yet', async () => {
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    // Not drained -> retried on the gentle interval (mail landed recently).
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    await advance(GENTLE_INTERVAL_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('skips a DISCONNECTED active account and disconnected background accounts', async () => {
    const active = makeAccount([folder('INBOX')], { connected: false });
    const background = makeAccount([folder('INBOX')], { connected: false });
    h.activeStorage = active.storage;
    h.activeEngine = active.engine;
    h.runtimes = [['acct-bg', { storage: background.storage, syncEngine: background.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(active.state.backfillCalls).toEqual([]);
    expect(background.state.backfillCalls).toEqual([]);
    svc.stopBackfillScheduler();
  });

  it('crawls the active account AND every connected background account', async () => {
    const active = makeAccount([folder('INBOX')]);
    const background = makeAccount([folder('INBOX')]);
    h.activeStorage = active.storage;
    h.activeEngine = active.engine;
    h.runtimes = [['acct-bg', { storage: background.storage, syncEngine: background.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(active.state.backfillCalls).toEqual(['INBOX']);
    expect(background.state.backfillCalls).toEqual(['INBOX']);
    expect(h.bulkCalls.sort()).toEqual(['acct-active', 'acct-bg']);
    svc.stopBackfillScheduler();
  });

  it('never crawls the same storage twice (active also listed as a runtime)', async () => {
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    h.runtimes = [['acct-active', { storage: a.storage, syncEngine: a.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('labels the active account "active" when it has no id yet', async () => {
    h.activeId = null;
    const a = makeAccount([folder('INBOX')]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(h.bulkCalls).toEqual(['active']);
    svc.stopBackfillScheduler();
  });

  it('isolates one account’s failure from the others', async () => {
    const broken = makeAccount([folder('INBOX')], { foldersThrows: true });
    const ok = makeAccount([folder('INBOX')]);
    h.activeStorage = broken.storage;
    h.activeEngine = broken.engine;
    h.runtimes = [['acct-ok', { storage: ok.storage, syncEngine: ok.engine, smtpClient: null }]];
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(ok.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });
});

describe('folder selection', () => {
  it('never crawls Trash / Spam / unsubscribed folders', async () => {
    const a = makeAccount([
      folder('Trash'), folder('[Gmail]/Spam'), folder('Archive', { subscribed: false }), folder('INBOX'),
    ]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.drainCalls).toEqual(['INBOX']);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  // Breaks: a mailbox the server published twice (Sarv lists `Sent` AND
  // `Sent Mail` for one store) having its whole history paged a second time,
  // into a folder the sidebar never shows — thousands of fetches for mail
  // already on disk, and a second backfill that never settles.
  it('never crawls a duplicate of a mailbox it is already crawling', async () => {
    // One store under two names, as the SERVER reports it: same UIDVALIDITY and
    // same message count. Nothing is skipped without that proof — a shared role
    // is not evidence, and dropping a genuinely separate mailbox would stop its
    // history from ever being fetched. `Sent` is the name holding the mail.
    const twin = { uidValidity: 42, serverMessageCount: 1718 };
    const a = makeAccount([
      folder('Sent Mail', { ...twin, totalCount: 0 }),
      folder('Sent', { ...twin, totalCount: 1713 }),
    ]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.drainCalls).toEqual(['Sent']);
    expect(a.state.backfillCalls).toEqual(['Sent']);
    svc.stopBackfillScheduler();
  });

  it('crawls ONLY the All-Mail superset when the provider has one', async () => {
    const a = makeAccount([
      folder('INBOX'), folder('Work'), folder('[Gmail]/All Mail', { allMail: true }),
    ]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['[Gmail]/All Mail']);
    svc.stopBackfillScheduler();
  });

  // Gmail's superset crawl only works if the LABELS come with it: rows synced
  // before labels were fetched are tagged `|[Gmail]/All Mail|` and nothing else,
  // so they sit on disk while INBOX looks frozen. The repair is labels-only, so
  // it runs once per session over All Mail — never per tick (it walks the whole
  // mailbox) and never on a provider without a superset.
  it('runs the Gmail label repair once per session, on the superset only', async () => {
    const a = makeAccount([folder('INBOX'), folder('[Gmail]/All Mail', { allMail: true })]);
    const repaired: string[] = [];
    (a.engine as Record<string, unknown>).repairGmailLabels = async (path: string) => {
      repaired.push(path);
      return { scanned: 10, updated: 4 };
    };
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();

    await advance(FIRST_DELAY_MS);
    expect(repaired).toEqual(['[Gmail]/All Mail']);
    await advance(IDLE_INTERVAL_MS);
    await advance(IDLE_INTERVAL_MS);
    expect(repaired).toEqual(['[Gmail]/All Mail']);   // still just the one pass
    svc.stopBackfillScheduler();
  });

  it('never runs the Gmail label repair on a provider with no All-Mail superset', async () => {
    const a = makeAccount([folder('INBOX'), folder('Archive')]);
    let called = 0;
    (a.engine as Record<string, unknown>).repairGmailLabels = async () => { called += 1; return null; };
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(called).toBe(0);
    svc.stopBackfillScheduler();
  });

  // An engine too old to have the method (or one that rejects) must not break the
  // tick that carries the actual history backfill.
  it('tolerates an engine without the repair, and a repair that rejects', async () => {
    const a = makeAccount([folder('[Gmail]/All Mail', { allMail: true })]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;                        // no repairGmailLabels at all
    const svc = await load();
    svc.startBackfillScheduler();
    await expect(advance(FIRST_DELAY_MS)).resolves.toBeDefined();
    expect(a.state.backfillCalls).toEqual(['[Gmail]/All Mail']);
    svc.stopBackfillScheduler();

    const b = makeAccount([folder('[Gmail]/All Mail', { allMail: true })]);
    (b.engine as Record<string, unknown>).repairGmailLabels = async () => { throw new Error('nope'); };
    h.activeStorage = b.storage;
    h.activeEngine = b.engine;
    const svc2 = await load();
    svc2.startBackfillScheduler();
    await expect(advance(FIRST_DELAY_MS)).resolves.toBeDefined();
    expect(b.state.backfillCalls).toEqual(['[Gmail]/All Mail']);
    svc2.stopBackfillScheduler();
  });

  it('prioritises INBOX, then the biggest folders', async () => {
    const a = makeAccount(
      [
        folder('Small', { serverMessageCount: 10 }),
        folder('Huge', { serverMessageCount: 50_000 }),
        folder('INBOX', { serverMessageCount: 500 }),
      ],
      // Nothing progresses, so every folder is visited in priority order.
      { drain: () => null, backfill: () => null },
    );
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX', 'Huge', 'Small']);
    svc.stopBackfillScheduler();
  });

  it('skips folders whose history is already fully archived', async () => {
    const a = makeAccount([
      folder('Done', { backfillComplete: true }),
      folder('INBOX'),
    ]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });
});

describe('the missing-message drain', () => {
  it('marks a caught-up folder so it is not re-scanned every tick', async () => {
    const a = makeAccount([folder('INBOX', { backfillComplete: true })]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.drainCalls).toEqual(['INBOX']);

    // Fully archived -> long sleep; the folder is not re-drained on the next tick.
    await advance(IDLE_INTERVAL_MS);
    expect(a.state.drainCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('keeps draining a folder that still reports a gap, and stays ACTIVE', async () => {
    const a = makeAccount([folder('INBOX', { backfillComplete: true })], {
      drain: () => ({ done: false, remaining: 500 }),
    });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    // Gentle mode: 4 chunks this tick.
    expect(a.state.drainCalls).toHaveLength(4);

    // Not drained -> gentle retry (not the 30-minute sleep).
    await advance(GENTLE_INTERVAL_MS);
    expect(a.state.drainCalls).toHaveLength(8);
    svc.stopBackfillScheduler();
  });

  it('retries next tick when the drain cannot run at all', async () => {
    const a = makeAccount([folder('INBOX', { backfillComplete: true })], { drain: () => null });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.drainCalls).toEqual(['INBOX']); // bailed after the first chunk
    await advance(GENTLE_INTERVAL_MS);
    expect(a.state.drainCalls).toEqual(['INBOX', 'INBOX']);
    svc.stopBackfillScheduler();
  });

  it('drains INBOX before other folders', async () => {
    const a = makeAccount(
      [folder('Zzz', { backfillComplete: true }), folder('INBOX', { backfillComplete: true })],
      { drain: () => ({ done: false, remaining: 10 }) },
    );
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    // Gentle: stops after the first folder that progressed — INBOX.
    expect(new Set(a.state.drainCalls)).toEqual(new Set(['INBOX']));
    svc.stopBackfillScheduler();
  });
});

describe('pacing modes', () => {
  it('GENTLE while mail is landing: 4 chunks and only one folder advanced', async () => {
    const a = makeAccount([folder('INBOX'), folder('Work')], { backfill: () => ({ done: false }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX', 'INBOX', 'INBOX', 'INBOX']);
    svc.stopBackfillScheduler();
  });

  it('FAST on a quiet machine: 24 chunks and every folder swept', async () => {
    const a = makeAccount([folder('INBOX'), folder('Work')], { backfill: () => ({ done: false }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();

    // Let the machine go quiet (no new mail for > 60s) so the loop switches modes.
    await advance(FIRST_DELAY_MS);              // gentle tick at +30s
    await advance(GENTLE_INTERVAL_MS * 3);      // ticks at 45s / 60s / 75s -> now fast
    a.state.backfillCalls.length = 0;

    await advance(FAST_INTERVAL_MS);            // exactly ONE fast tick
    expect(a.state.backfillCalls.filter((p) => p === 'INBOX')).toHaveLength(24);
    expect(a.state.backfillCalls).toContain('Work');
    svc.stopBackfillScheduler();
  });

  it('new mail drops it back out of FAST mode', async () => {
    const a = makeAccount([folder('INBOX'), folder('Work')], { backfill: () => ({ done: false }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS + 3 * GENTLE_INTERVAL_MS); // reach fast mode

    // A new mail arrives -> activity -> the next tick must be gentle again.
    h.busHandlers[0]({ isNew: true });
    a.state.backfillCalls.length = 0;
    await advance(FAST_INTERVAL_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX', 'INBOX', 'INBOX', 'INBOX']);

    // A non-new sync event is NOT activity.
    h.busHandlers[0]({ isNew: false });
    h.busHandlers[0](undefined);
    svc.stopBackfillScheduler();
  });

  it('sleeps for 30 minutes once everything is archived', async () => {
    const a = makeAccount([folder('INBOX', { backfillComplete: true })]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    const calls = a.state.drainCalls.length + a.state.backfillCalls.length;

    await advance(IDLE_INTERVAL_MS - 1);
    expect(a.state.drainCalls.length + a.state.backfillCalls.length).toBe(calls);
    await advance(1);
    expect(a.state.drainCalls.length + a.state.backfillCalls.length).toBeGreaterThanOrEqual(calls);
    svc.stopBackfillScheduler();
  });

  it('does NOT re-enter a tick that is still in flight', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const a = makeAccount([folder('INBOX')]);
    const slowStorage = {
      getFolders: async () => { await blocked; return a.state.folders; },
    };
    h.activeStorage = slowStorage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual([]); // stuck on getFolders

    await advance(10 * GENTLE_INTERVAL_MS);    // several would-be ticks
    expect(a.state.backfillCalls).toEqual([]); // none re-entered

    release();
    await advance(1);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });
});

describe('the deferred deletion reconcile', () => {
  it('runs only for LARGE folders', async () => {
    const a = makeAccount([
      folder('INBOX', { serverMessageCount: LARGE_MAILBOX_THRESHOLD + 1 }),
      folder('Small', { serverMessageCount: 10 }),
    ], { backfill: () => null });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.reconcileCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });

  it('kickBackfillScheduler wakes the loop before its next scheduled tick (resume on reconnect)', async () => {
    // When the connection returns, downloading must resume promptly instead of
    // waiting out the interval. The reconnect handler calls kickBackfillScheduler().
    const a = makeAccount([folder('INBOX')], { drain: () => ({ done: false, remaining: 1, inserted: 0 }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    const before = a.state.drainCalls.length;

    await advance(2_000); // well under the next scheduled tick → nothing yet
    expect(a.state.drainCalls.length).toBe(before);

    svc.kickBackfillScheduler();
    await advance(1_000);
    expect(a.state.drainCalls.length).toBeGreaterThan(before); // woke and drained
    svc.stopBackfillScheduler();
  });

  it('STILL reconciles a large folder AFTER backfill completes (not coupled to backfillComplete)', async () => {
    // Regression for "Gmail stuck at ~8.6k, never finishes": the full reconcile —
    // the ONLY mid-range-hole filler AND server-deletion detector for a large
    // mailbox whose hot-path syncFlags is windowed — used to run only inside the
    // backfill loop (folders with !backfillComplete). The moment downward paging
    // finished, it switched off forever, stranding mid-range gaps. It must run
    // regardless of backfillComplete.
    const a = makeAccount([folder('INBOX', { serverMessageCount: 50_000, backfillComplete: true })]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.reconcileCalls).toEqual(['INBOX']); // reconciled despite backfillComplete
    svc.stopBackfillScheduler();
  });

  it('is throttled to once every 15 minutes per folder', async () => {
    const a = makeAccount(
      [folder('INBOX', { serverMessageCount: 50_000 })],
      { backfill: () => null, reconcile: () => ({ deleted: 3, updated: 1 }) },
    );
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.reconcileCalls).toHaveLength(1);

    await advance(GENTLE_INTERVAL_MS * 4); // ~1 min of ticks
    expect(a.state.reconcileCalls).toHaveLength(1);

    await advance(DELETION_RECONCILE_MS);
    expect(a.state.reconcileCalls.length).toBeGreaterThan(1);
    svc.stopBackfillScheduler();
  });

  it('isolates a failing reconcile from the crawl', async () => {
    const a = makeAccount([folder('INBOX', { serverMessageCount: 50_000 })], {
      backfill: () => ({ done: true }),
      reconcile: () => { throw new Error('reconcile blew up'); },
    });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    expect(a.state.backfillCalls).toEqual(['INBOX']);
    svc.stopBackfillScheduler();
  });
});

describe('the one-time post-backfill thread repair', () => {
  it('runs ONCE on the pending -> done transition', async () => {
    const folders = [folder('INBOX')];
    const a = makeAccount(folders, { backfill: () => ({ done: false }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();

    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);          // pending observed
    expect(a.state.repairCalls).toBe(0);

    folders[0].backfillComplete = true;     // history finished downloading
    await advance(GENTLE_INTERVAL_MS);
    await advance(1);                       // the repair is deferred to its own timer
    expect(a.state.repairCalls).toBe(1);

    // Never again this session.
    await advance(IDLE_INTERVAL_MS * 2);
    expect(a.state.repairCalls).toBe(1);
    svc.stopBackfillScheduler();
  });

  // Regression (the launch freeze): the "once" above is a WeakSet, which dies with
  // the process. On an account whose history never finishes downloading, every
  // launch saw the pending→done transition again and re-walked the whole mailbox —
  // measured at 26.5s, 0 emails retargeted, 71.9% of main-thread JS while it ran.
  // The persisted watermark is what makes the SECOND launch cheap.
  it('walks the whole mailbox once, then only what arrived since (across launches)', async () => {
    const folders = [folder('INBOX')];
    const a = makeAccount(folders, { backfill: () => ({ done: false }) });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    folders[0].backfillComplete = true;
    await advance(GENTLE_INTERVAL_MS);
    await advance(1);
    expect(a.state.repairWindows).toEqual([undefined]); // full pass, once
    const firstLaunchAt = Date.now();
    svc.stopBackfillScheduler();

    // Second launch: new process (fresh module + fresh account state), same meta.
    const folders2 = [folder('INBOX')];
    const b = makeAccount(folders2, { backfill: () => ({ done: false }) });
    h.activeStorage = b.storage;
    h.activeEngine = b.engine;
    const svc2 = await load();
    await advance(60_000);
    svc2.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    folders2[0].backfillComplete = true;
    await advance(GENTLE_INTERVAL_MS);
    await advance(1);

    // Bounded to what was stored since the previous pass began, minus the 15-min
    // overlap that covers rows inserted while that pass was running.
    expect(b.state.repairWindows).toEqual([Math.floor(firstLaunchAt / 1000) - 15 * 60]);
    svc2.stopBackfillScheduler();
  });

  // A pass that threw proved nothing about what was scanned, so the watermark must
  // not move — losing mail to a skipped window is worse than one more full pass.
  it('a failed repair leaves the window alone, so the next launch is full again', async () => {
    const folders = [folder('INBOX')];
    const a = makeAccount(folders, { backfill: () => ({ done: false }), repairThrows: true });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    folders[0].backfillComplete = true;
    await advance(GENTLE_INTERVAL_MS);
    await advance(1);
    expect(a.state.repairWindows).toEqual([undefined]);
    svc.stopBackfillScheduler();

    const folders2 = [folder('INBOX')];
    const b = makeAccount(folders2, { backfill: () => ({ done: false }) });
    h.activeStorage = b.storage;
    h.activeEngine = b.engine;
    const svc2 = await load();
    await advance(60_000);
    svc2.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    folders2[0].backfillComplete = true;
    await advance(GENTLE_INTERVAL_MS);
    await advance(1);
    expect(b.state.repairWindows).toEqual([undefined]);
    svc2.stopBackfillScheduler();
  });

  it('does NOT repair an already-archived account on launch', async () => {
    const a = makeAccount([folder('INBOX', { backfillComplete: true })]);
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    await advance(1);
    expect(a.state.repairCalls).toBe(0);
    svc.stopBackfillScheduler();
  });

  it('isolates a failing repair, and tolerates a storage without the API', async () => {
    const foldersA = [folder('INBOX')];
    const a = makeAccount(foldersA, { backfill: () => ({ done: false }), repairThrows: true });
    h.activeStorage = a.storage;
    h.activeEngine = a.engine;
    const svc = await load();
    svc.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    foldersA[0].backfillComplete = true;
    await advance(GENTLE_INTERVAL_MS);
    await expect(advance(1)).resolves.toBeDefined();
    expect(a.state.repairCalls).toBe(1);
    svc.stopBackfillScheduler();

    const foldersB = [folder('INBOX')];
    const b = makeAccount(foldersB, { backfill: () => ({ done: false }), hasRepair: false });
    const svc2 = await load();
    h.activeStorage = b.storage;
    h.activeEngine = b.engine;
    svc2.startBackfillScheduler();
    await advance(FIRST_DELAY_MS);
    foldersB[0].backfillComplete = true;
    await advance(GENTLE_INTERVAL_MS);
    await expect(advance(1)).resolves.toBeDefined();
    svc2.stopBackfillScheduler();
  });
});

describe('storage without the folders API', () => {
  it('treats a folder-less storage as fully archived', async () => {
    const svc = await load();
    h.activeStorage = {};
    h.activeEngine = { isConnected: () => true };
    svc.startBackfillScheduler();
    await expect(advance(FIRST_DELAY_MS)).resolves.toBeDefined();
    svc.stopBackfillScheduler();
  });
});
