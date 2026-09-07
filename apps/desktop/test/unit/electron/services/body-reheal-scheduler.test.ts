import { createDeferredFetchError } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Body re-heal scheduler. It walks a whole mailbox looking for mojibake bodies,
 * so the throttling IS the feature:
 *   - first tick only after 90s, then every 3 minutes,
 *   - the scan is chunked (500 rows) and yields between chunks,
 *   - at most DRAIN_BATCH (5) re-fetches per account per tick,
 *   - a disconnected account is skipped (no connection pressure),
 *   - an email is attempted at most once per session,
 *   - a tick already in progress is never re-entered, and stop() cancels
 *     everything pending.
 *
 * The same scan also feeds a LOCAL pass (see the last describe) that rebuilds an
 * empty clean_body from raw_body — no network, so it drains for an offline
 * account too, bounded at 25 rows per tick.
 */

const FFFD = '�';
const FIRST_TICK_MS = 90_000;
const TICK_MS = 3 * 60_000;

interface Row {
  id: string;
  uid: number | null;
  folderId: string;
  threadId: string | null;
  body: string;
  /** raw_body — present for the LOCAL repair path (empty clean_body, HTML on disk). */
  raw?: string;
}

const h = vi.hoisted(() => ({
  runtimes: [] as Array<[string, unknown]>,
}));

vi.mock('../../../../electron/shared', () => ({ getAllAccountRuntimes: () => h.runtimes }));

// A PARTIAL mock: only the three helpers below are stood in for. Everything else
// must stay real, because @sarvinbox/storage-node (loaded for real here) imports
// from core too — a total mock breaks this whole file the moment storage-node
// starts using one more core export, which is exactly what happened when the
// inline-image store began importing SizeBudgetedLru.
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
  // Real yielder semantics minus the clock. The real one yields once ~8ms of work
  // has accumulated, so cheap iterations mostly DON'T hit the event loop; this
  // stand-in yields every 100th call and resolves in a microtask otherwise, which
  // keeps the loop under test bounded in setImmediate turns (see `settle`).
  createLoopYielder: () => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls % 100 === 0 ? new Promise((resolve) => setImmediate(resolve)) : Promise.resolve();
    };
  },
  // Stand-in for the real rule (unit-tested in packages/core: utils/html-text).
  // Faithful about the CONTRACT the scheduler depends on — null means "do not
  // write" — and argument-order-sensitive, so a swapped call fails these tests.
  repairedCleanBody: (cleanBody: string | null | undefined, rawBody: string | null | undefined) => {
    if (typeof cleanBody === 'string' && cleanBody.trim() !== '') return null;
    if (typeof rawBody !== 'string' || rawBody.trim() === '') return null;
    const text = rawBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return text === '' ? null : text;
  },
}));

type Scheduler = typeof import('../../../../electron/services/body-reheal-scheduler');

/** Fresh module — scan/queue/attempted state is module-scoped. */
const load = async (): Promise<Scheduler> => {
  vi.resetModules();
  return import('../../../../electron/services/body-reheal-scheduler');
};

interface FakeAccount {
  rows: Row[];
  connected: boolean;
  prepareThrows: boolean;
  probeThrows: boolean;
  readThrows: boolean;
  updateThrows: boolean;
  folders: Map<string, { path: string } | null>;
  fetched: string[];
  /** [emailId, new clean_body] for every local repair write. */
  updated: Array<[string, string]>;
  /** ids passed to the cheap raw-body-length probe, in order. */
  probed: string[];
  /** ids whose full bodies were actually read (the expensive step). */
  read: string[];
  deletedConversations: string[];
  fetchBody: (id: string, path: string, uid: number) => Promise<void>;
  runtime: { storage: unknown; syncEngine: unknown; smtpClient: null };
}

const makeAccount = (rows: Row[], over: Partial<FakeAccount> = {}): FakeAccount => {
  const acct: FakeAccount = {
    rows,
    connected: true,
    prepareThrows: false,
    probeThrows: false,
    readThrows: false,
    updateThrows: false,
    folders: new Map([['INBOX', { path: 'INBOX' }]]),
    fetched: [],
    updated: [],
    probed: [],
    read: [],
    deletedConversations: [],
    fetchBody: async () => {},
    ...over,
  } as FakeAccount;

  const storage = {
    db: {
      prepare: (sql: string) => {
        if (acct.prepareThrows) throw new Error('db busy');
        // Stage 1 of the local repair: LENGTH(raw_body) only, so a row whose body
        // never downloaded is dropped without paging in a fat record.
        if (sql.includes('rawLen')) {
          return {
            get: (id: string) => {
              if (acct.probeThrows) throw new Error('probe failed');
              acct.probed.push(id);
              const found = acct.rows.find((r) => r.id === id);
              return { rawLen: found?.raw?.length ?? 0 };
            },
          };
        }
        // Stage 2 reads one row's bodies by id; the scan pages by PK.
        if (sql.includes('WHERE id = ?')) {
          return {
            get: (id: string) => {
              if (acct.readThrows) throw new Error('read failed');
              acct.read.push(id);
              const found = acct.rows.find((r) => r.id === id);
              return found ? { cleanBody: found.body, rawBody: found.raw ?? null } : undefined;
            },
          };
        }
        // Mirrors the scan SQL: no uid predicate, and `bad` is true when EITHER
        // body carries the replacement character.
        return {
          all: (cursor: string) =>
            acct.rows
              .filter((r) => r.id > cursor)
              .sort((a, b) => (a.id < b.id ? -1 : 1))
              .slice(0, 500)
              .map((r) => ({
                id: r.id,
                uid: r.uid,
                folderId: r.folderId,
                threadId: r.threadId,
                bad: r.body.includes(FFFD) || (r.raw ?? '').includes(FFFD) ? 1 : 0,
                cleanLen: r.body.length,
              })),
        };
      },
    },
    getFolder: async (id: string) => acct.folders.get(id) ?? null,
    deleteConversation: async (threadId: string) => { acct.deletedConversations.push(threadId); },
    updateEmail: async (id: string, patch: { cleanBody?: string }) => {
      if (acct.updateThrows) throw new Error('write failed');
      acct.updated.push([id, patch.cleanBody ?? '']);
      const found = acct.rows.find((r) => r.id === id);
      if (found && patch.cleanBody !== undefined) found.body = patch.cleanBody;
    },
  };

  const syncEngine = {
    isConnected: () => acct.connected,
    fetchBody: async (id: string, path: string, uid: number) => {
      acct.fetched.push(id);
      await acct.fetchBody(id, path, uid);
    },
  };

  acct.runtime = { storage, syncEngine, smtpClient: null };
  return acct;
};

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  uid: Number(id.replace(/\D/g, '')) || 1,
  folderId: 'INBOX',
  threadId: `thread-${id}`,
  body: `broken ${FFFD} text`,
  ...over,
});

// `setImmediate` is deliberately NOT faked: the scan/drain yield through it, and
// vitest's fake `setImmediate` is not flushed by advanceTimersByTimeAsync — which
// would freeze the very loop under test. `advance()` moves the fake clock and then
// drains the real setImmediate queue.
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  h.runtimes = [];
});

afterEach(() => { vi.useRealTimers(); });

/** Let every pending setImmediate-yield resolve. */
const settle = async (turns = 60): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};

describe('start / stop pacing', () => {
  it('waits 90s for the first tick, then ticks every 3 minutes', async () => {
    const acct = makeAccount([row('e1')]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS - 1);
    expect(acct.fetched).toEqual([]);

    await advance(1);
    expect(acct.fetched).toEqual(['e1']);

    // Next tick: nothing left to do, but the interval is armed.
    acct.rows = [row('e2')];
    await advance(TICK_MS);
    // The one-time scan already ran for this account, so e2 is not picked up —
    // healed rows stop matching and new corruption is found on the next launch.
    expect(acct.fetched).toEqual(['e1']);
    svc.stopBodyRehealScheduler();
  });

  it('is idempotent — a second start does not add a second timer chain', async () => {
    const acct = makeAccount([row('e1'), row('e2'), row('e3')]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1', 'e2', 'e3']);
    svc.stopBodyRehealScheduler();
  });

  it('stop() before the first tick cancels it entirely', async () => {
    const acct = makeAccount([row('e1')]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    svc.stopBodyRehealScheduler();
    await advance(10 * TICK_MS);
    expect(acct.fetched).toEqual([]);
  });

  it('stop() after the first tick cancels the interval', async () => {
    const acct = makeAccount(Array.from({ length: 12 }, (_, i) => row(`e${String(i).padStart(2, '0')}`)));
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toHaveLength(5);

    svc.stopBodyRehealScheduler();
    await advance(10 * TICK_MS);
    expect(acct.fetched).toHaveLength(5);
  });

  it('can be restarted after a stop', async () => {
    const acct = makeAccount([row('e1')]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    svc.stopBodyRehealScheduler();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    svc.stopBodyRehealScheduler();
  });
});

describe('the scan', () => {
  it('queues ONLY bodies containing the replacement character', async () => {
    const acct = makeAccount([
      row('e1'),
      row('e2', { body: 'perfectly fine' }),
      row('e3'),
    ]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1', 'e3']);
    svc.stopBodyRehealScheduler();
  });

  // A corrupted body whose raw HTML is the ONLY garbled half must still queue.
  // clean_body is the text/plain alternative and raw_body the HTML; a sender
  // whose plain part is ASCII loses only the HTML, so testing clean_body alone
  // left a correct list snippet sitting over a body that opens as mojibake —
  // permanently, since a row that never matches the scan never re-queues.
  it('queues a row whose RAW body is the corrupted one', async () => {
    const acct = makeAccount([
      row('e1', { body: 'perfectly fine', raw: `<p>broken ${FFFD} html</p>` }),
      row('e2', { body: 'perfectly fine', raw: '<p>fine</p>' }),
    ]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    svc.stopBodyRehealScheduler();
  });

  // Rows with no UID used to be filtered out of the scan entirely. fetchBody
  // re-resolves them by message-id (Gmail blanks the uid when a label change
  // re-homes a message), so excluding them stranded corrupted mail on the one
  // class of row that never re-syncs on its own either. uid 0 is what tells
  // fetchBody to take the message-id path.
  it('queues a corrupted row with no UID and lets fetchBody re-resolve it', async () => {
    const seen: number[] = [];
    const acct = makeAccount([row('e1', { uid: null }), row('e2')], {
      fetchBody: async (_id, _path, uid) => { seen.push(uid); },
    });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1', 'e2']);
    expect(seen).toEqual([0, 2]);
    svc.stopBodyRehealScheduler();
  });

  it('pages through more than one chunk (keyset scan over 1200 rows)', async () => {
    const rows = Array.from({ length: 1_200 }, (_, i) => row(`e${String(i).padStart(5, '0')}`));
    const acct = makeAccount(rows);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    // Whole backlog queued; only the first batch of 5 is drained this tick.
    expect(acct.fetched).toHaveLength(5);
    await advance(TICK_MS);
    expect(acct.fetched).toHaveLength(10);
    svc.stopBodyRehealScheduler();
  });
});

describe('the drain', () => {
  it('re-fetches at most 5 per account per tick and busts the thread cache', async () => {
    const acct = makeAccount(Array.from({ length: 7 }, (_, i) => row(`e${i}`)));
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(acct.deletedConversations).toEqual(['thread-e0', 'thread-e1', 'thread-e2', 'thread-e3', 'thread-e4']);

    await advance(TICK_MS);
    expect(acct.fetched).toHaveLength(7);
    svc.stopBodyRehealScheduler();
  });

  it('skips a DISCONNECTED account entirely (no connection pressure)', async () => {
    const acct = makeAccount([row('e1')], { connected: false });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual([]);

    // ...and picks it up once it reconnects.
    acct.connected = true;
    await advance(TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    svc.stopBodyRehealScheduler();
  });

  it('never retries an email whose re-fetch failed', async () => {
    const acct = makeAccount([row('e1')], {
      fetchBody: async () => { throw new Error('server said no'); },
    });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    expect(acct.deletedConversations).toEqual([]); // never reached the cache bust

    await advance(5 * TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    svc.stopBodyRehealScheduler();
  });

  it('DOES retry an email the engine only deferred', async () => {
    // A defer ("folder wouldn't open", "cooling down after timeouts") says
    // nothing about this message. `attempted` is session-scoped, so treating a
    // defer like a failure abandoned a still-garbled body until the next app
    // start — one transient IMAP hiccup and the re-heal never came back.
    let calls = 0;
    const acct = makeAccount([row('e1')], {
      fetchBody: async () => {
        calls += 1;
        if (calls === 1) throw createDeferredFetchError('folder "INBOX" would not open');
      },
    });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();

    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    expect(acct.deletedConversations).toEqual([]); // deferred — nothing repaired yet

    // Re-queued, not retired: the next tick picks it up and it heals.
    await advance(TICK_MS);
    expect(acct.fetched).toEqual(['e1', 'e1']);
    expect(acct.deletedConversations).toEqual(['thread-e1']);
    svc.stopBodyRehealScheduler();
  });

  it('skips a row whose folder cannot be resolved', async () => {
    const acct = makeAccount([row('e1', { folderId: 'gone' }), row('e2')]);
    acct.folders.set('gone', null);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e2']);
    svc.stopBodyRehealScheduler();
  });

  it('does not bust the conversation cache for a thread-less email', async () => {
    const acct = makeAccount([row('e1', { threadId: null })]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    expect(acct.deletedConversations).toEqual([]);
    svc.stopBodyRehealScheduler();
  });

  it('tolerates a failing conversation-cache bust', async () => {
    const acct = makeAccount([row('e1')]);
    (acct.runtime.storage as { deleteConversation: (t: string) => Promise<void> }).deleteConversation =
      async () => { throw new Error('no such row'); };
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toEqual(['e1']);
    svc.stopBodyRehealScheduler();
  });
});

describe('robustness', () => {
  it('skips runtimes with no DB or no engine', async () => {
    h.runtimes = [
      ['no-db', { storage: {}, syncEngine: {}, smtpClient: null }],
      ['no-engine', { storage: { db: {} }, syncEngine: null, smtpClient: null }],
      ['null-rt', { storage: null, syncEngine: null, smtpClient: null }],
    ];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await expect(advance(FIRST_TICK_MS)).resolves.toBeUndefined();
    svc.stopBodyRehealScheduler();
  });

  it('isolates one account failure so the others still heal', async () => {
    const broken = makeAccount([row('b1')], { prepareThrows: true });
    const ok = makeAccount([row('g1')]);
    h.runtimes = [['broken', broken.runtime], ['ok', ok.runtime]];
    const svc = await load();
    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(broken.fetched).toEqual([]);
    expect(ok.fetched).toEqual(['g1']);
    svc.stopBodyRehealScheduler();
  });

  it('does NOT re-enter a tick that is still running', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const acct = makeAccount(Array.from({ length: 12 }, (_, i) => row(`e${String(i).padStart(2, '0')}`)), {
      fetchBody: async () => { await blocked; },
    });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.fetched).toHaveLength(1); // stuck inside the first re-fetch

    // Several intervals elapse while the first tick is still in flight.
    await advance(5 * TICK_MS);
    expect(acct.fetched).toHaveLength(1);

    release();
    await settle();
    expect(acct.fetched).toHaveLength(5); // the original batch finishes
    svc.stopBodyRehealScheduler();
  });

  it('handles having no accounts at all', async () => {
    const svc = await load();
    svc.startBodyRehealScheduler();
    await expect(advance(FIRST_TICK_MS + TICK_MS)).resolves.toBeUndefined();
    svc.stopBodyRehealScheduler();
  });
});

/**
 * The LOCAL repair pass — a second defect the same scan collects: clean_body
 * empty while raw_body is on disk. Those are HTML-only mails (mailparser emits
 * no text for an HTML part that is neither the root node nor accompanied by a
 * text/plain part), so the list showed no snippet and the AI passes saw no body.
 * The cure needs no network, which is the whole reason it is a separate pass.
 */
describe('local rebuild of an empty clean_body', () => {
  /** A row with clean_body empty and HTML already downloaded. */
  const emptyRow = (id: string, raw = '<html><body><div>Emergent raised $130M</div></body></html>'): Row =>
    row(id, { body: '', raw });

  // The regression: the snippet comes back, from local data only.
  it('rebuilds clean_body from raw_body without touching IMAP', async () => {
    const acct = makeAccount([emptyRow('e1')]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toEqual([['e1', 'Emergent raised $130M']]);
    expect(acct.fetched).toEqual([]); // no re-download — the body was already here
    svc.stopBodyRehealScheduler();
  });

  // The point of a local pass: an account in quota back-off (or simply offline)
  // still gets these rows fixed. Before this, everything waited on a connection.
  it('runs even while the account is DISCONNECTED', async () => {
    const acct = makeAccount([emptyRow('e1'), row('e2')], { connected: false });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toEqual([['e1', 'Emergent raised $130M']]);
    expect(acct.fetched).toEqual([]); // the mojibake row correctly waits for a connection
    svc.stopBodyRehealScheduler();
  });

  // Regression: an image-only mail has HTML but no readable text. Writing '' back
  // rewrites a fat inline-body record for nothing, every single session.
  it('writes nothing for a row whose raw body has no readable text', async () => {
    const acct = makeAccount([emptyRow('e1', '<img src="https://x.test/a.png">')]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toEqual([]);
    svc.stopBodyRehealScheduler();
  });

  // Regression: a row with no raw body at all is a body that never downloaded —
  // a different problem, and not this pass's to solve.
  it('writes nothing when raw_body is absent', async () => {
    const acct = makeAccount([row('e1', { body: '', raw: undefined })]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toEqual([]);
    svc.stopBodyRehealScheduler();
  });

  // ...and it must reach that verdict from the LENGTH probe alone. On the real
  // mailbox 7,705 of the 7,915 empty-clean_body rows are this tier; paging in a
  // whole record each just to discard it is the stall this drain has to avoid.
  it('rules out a never-downloaded body from the cheap probe, without reading it', async () => {
    const acct = makeAccount([row('e1', { body: '', raw: undefined })]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.probed).toEqual(['e1']);
    expect(acct.read).toEqual([]);
    expect(acct.updated).toEqual([]);
    svc.stopBodyRehealScheduler();
  });

  // The regression this pair of budgets exists for: the ~210 repairable rows sit
  // behind thousands of not-downloaded ones. If a discard consumed repair budget,
  // the rows that matter would be hours of ticks away.
  it('still spends its full repair budget when repairable rows are a needle in a haystack', async () => {
    const haystack = Array.from({ length: 300 }, (_, i) => row(`h${String(i).padStart(3, '0')}`, { body: '', raw: undefined }));
    const needles = Array.from({ length: 25 }, (_, i) => emptyRow(`z${String(i).padStart(2, '0')}`));
    const acct = makeAccount([...haystack, ...needles]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toHaveLength(25);
    expect(acct.read).toHaveLength(25);   // only the needles were read
    expect(acct.probed).toHaveLength(325);
    svc.stopBodyRehealScheduler();
  });

  // The other half of the bound: probing is cheap (measured ~5us/row) but not
  // free, so a tick that finds nothing repairable must still end. 2,000 probes,
  // then wait 3 minutes.
  it('stops after 2000 probes even if it has repaired nothing', async () => {
    const rows = Array.from({ length: 4500 }, (_, i) => row(`h${String(i).padStart(4, '0')}`, { body: '', raw: undefined }));
    const acct = makeAccount(rows);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.probed).toHaveLength(2000);

    // ...and it resumes where it stopped rather than re-probing from the top.
    await advance(TICK_MS);
    expect(acct.probed).toHaveLength(4000);
    expect(acct.probed[2000]).toBe('h2000');
    svc.stopBodyRehealScheduler();
  });

  // Regression: a not-downloaded row must NOT be marked attempted. Its body can
  // arrive minutes later from the body-prefetch, and then it IS repairable — if
  // this pass had written it off, the mail would show no snippet forever.
  it('leaves a not-downloaded row repairable once its body arrives', async () => {
    const target = row('e1', { body: '', raw: undefined });
    const acct = makeAccount([target]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.updated).toEqual([]);

    // The body-prefetch lands the raw body; a fresh session re-scans and repairs it.
    target.raw = '<p>arrived late</p>';
    const svc2 = await load();
    svc2.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toEqual([['e1', 'arrived late']]);
    svc.stopBodyRehealScheduler();
    svc2.stopBodyRehealScheduler();
  });

  // Regression: a probe that throws must be written off, not retried every tick.
  // A row that keeps throwing would otherwise re-enter the queue head forever and
  // starve the rest of the batch.
  it('carries on past a failing probe and does not retry it', async () => {
    const acct = makeAccount([emptyRow('e1'), emptyRow('e2')], { probeThrows: true });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.updated).toEqual([]);
    expect(acct.read).toEqual([]);

    // Probes work again, but both rows were already written off this session.
    acct.probeThrows = false;
    await advance(TICK_MS);
    expect(acct.updated).toEqual([]);
    svc.stopBodyRehealScheduler();
  });

  // Regression: a healthy row must never be queued. Rewriting every row in the
  // mailbox is exactly the write amplification the perf work removed.
  it('never touches a row that already has a clean body', async () => {
    const acct = makeAccount([row('e1', { body: 'already fine', raw: '<p>whatever</p>' })]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.updated).toEqual([]);
    expect(acct.fetched).toEqual([]);
    svc.stopBodyRehealScheduler();
  });

  // Each row means reading a whole inline body and rewriting the record, so the
  // batch has to stay bounded or the pass becomes the stall it is fixing.
  it('repairs at most 25 rows per tick and resumes on the next one', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => emptyRow(`e${String(i).padStart(2, '0')}`));
    const acct = makeAccount(rows);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.updated).toHaveLength(25);

    await advance(TICK_MS);
    expect(acct.updated).toHaveLength(30);

    // Idempotent re-run: nothing is rewritten once the queue is drained.
    await advance(TICK_MS);
    expect(acct.updated).toHaveLength(30);
    svc.stopBodyRehealScheduler();
  });

  // A transient DB error on one row must not abandon the rest of the batch, and
  // must not be retried forever within the session either.
  it('carries on past a failing read and a failing write', async () => {
    const acct = makeAccount([emptyRow('e1'), emptyRow('e2')], { readThrows: true });
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(acct.updated).toEqual([]); // both reads threw, neither killed the tick

    const other = makeAccount([emptyRow('f1'), emptyRow('f2')], { updateThrows: true });
    h.runtimes = [['acct-b', other.runtime]];
    const svc2 = await load();
    svc2.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);
    expect(other.updated).toEqual([]); // writes threw; the tick still completed

    svc.stopBodyRehealScheduler();
    svc2.stopBodyRehealScheduler();
  });

  // Multi-account: one account's queue must not consume another's budget, and a
  // second account's rows must be repaired too.
  it('keeps each account’s local queue independent', async () => {
    const a = makeAccount([emptyRow('a1'), emptyRow('a2')]);
    const b = makeAccount([emptyRow('b1')]);
    h.runtimes = [['acct-a', a.runtime], ['acct-b', b.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(a.updated.map(([id]) => id)).toEqual(['a1', 'a2']);
    expect(b.updated.map(([id]) => id)).toEqual(['b1']);
    svc.stopBodyRehealScheduler();
  });

  // A mojibake row is NOT a local-repair candidate: its clean_body has text, it
  // is just wrong text. Locally "repairing" it would overwrite a corrupted body
  // with a conversion of the equally-corrupted raw one and mark it done forever.
  it('leaves a mojibake row to the re-fetch path', async () => {
    const acct = makeAccount([row('e1', { raw: '<p>also broken</p>' })]);
    h.runtimes = [['acct-a', acct.runtime]];
    const svc = await load();

    svc.startBodyRehealScheduler();
    await advance(FIRST_TICK_MS);

    expect(acct.fetched).toEqual(['e1']);
    expect(acct.updated).toEqual([]);
    svc.stopBodyRehealScheduler();
  });
});
