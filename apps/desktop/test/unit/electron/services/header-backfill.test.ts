import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Header backfill — giving already-synced mail the verdicts its headers imply.
 *
 * THE incident, twice over: 5,768 of 5,872 messages had `auth_status = NULL`
 * because the headers were never stored, so the whole history showed
 * "Unverified" whatever the server had recorded; then v86 added `spam_score`
 * and, because the scorer only runs at ingest, every message already in the
 * mailbox read "Not scored — this message was never put through the filter".
 * One sweep fills both, off one headers-only FETCH.
 *
 * What these pin: both columns are written from ONE fetch; verdicts are written
 * only for uids the server actually answered for; a message the server has NO
 * auth header for is finalised (an all-unknown verdict) rather than retried
 * forever; a uid the server did not return stays NULL for the next pass; own
 * mail is kept out of the spam half of the backlog so it cannot churn; a write
 * may fill a gap but never restates what ingest decided; one account's failure
 * never stops the others; a churning connection is skipped; stop() ends
 * everything.
 */

const h = vi.hoisted(() => ({
  activeStorage: null as unknown,
  activeEngine: null as unknown,
  runtimes: [] as Array<[string, { storage: unknown; syncEngine: unknown; smtpClient: null }]>,
  window: { destroyed: false, sent: [] as Array<{ channel: string; payload: unknown }> },
  unstable: new Set<unknown>(),
  logs: [] as string[],
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getSyncEngine: () => h.activeEngine,
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () => ({
    isDestroyed: () => h.window.destroyed,
    webContents: { send: (channel: string, payload: unknown) => h.window.sent.push({ channel, payload }) },
  }),
}));

// The real barrel pulls in better-sqlite3; the service needs one constant.
vi.mock('@sarvinbox/storage-node', () => ({ HEADER_STAGE_MAX_ATTEMPTS: 3 }));

vi.mock('../../../../electron/services/connection-health', () => ({
  isConnectionRecentlyUnstable: (engine: unknown) => h.unstable.has(engine),
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: (...a: unknown[]) => { h.logs.push(a.join(' ')); },
    warn: (...a: unknown[]) => { h.logs.push(a.join(' ')); },
    error: () => {}, debug: () => {},
  }),
  // The real parser is exercised in core's own tests; here we only need a
  // stable, recognisable mapping from header text to verdict. Note it answers
  // for absent input too — that is the property the backfill depends on.
  parseAuthenticationHeaders: (raw: string | undefined) => ({
    spf: raw?.includes('spf=pass') ? 'pass' : 'unknown',
    dkim: raw?.includes('dkim=pass') ? 'pass' : 'unknown',
    dmarc: raw?.includes('dmarc=fail') ? 'fail' : raw?.includes('dmarc=pass') ? 'pass' : 'unknown',
    overall: raw ? (raw.includes('fail') ? 'fail' : 'pass') : 'none',
  }),
  // Core's own tests exercise the real derivation; the shape and the two
  // decisions this service cares about are what matter here: own mail is never
  // scored, and a reported sender scores worse.
  headerStage: (message: FakeMessage, opts?: { ownMail?: boolean; knownSpammer?: boolean }) => ({
    auth: message.authHeaders ? { overall: 'pass' } : null,
    spam: opts?.ownMail
      ? null
      : {
          score: (message.authHeaders?.includes('dmarc=fail') ? 6 : 1) + (opts?.knownSpammer ? 4 : 0),
          reasons: opts?.knownSpammer ? ['KNOWN_SPAMMER'] : ['BASE'],
        },
    originIp: message.originIp ?? null,
  }),
  isOwnMailFolder: (folder: { path: string }) => folder.path.toLowerCase().includes('sent'),
}));

type Mod = typeof import('../../../../electron/services/header-backfill');
const load = async (): Promise<Mod> => { vi.resetModules(); return import('../../../../electron/services/header-backfill'); };

/** Just enough of an IMAPMessage for the mocked `headerStage` and the spammer lookup. */
interface FakeMessage {
  uid: number;
  authHeaders?: string;
  originIp?: string | null;
  envelope: { from: Array<{ address: string }> };
}

interface Row {
  id: string;
  uid: number;
  folderPath: string;
  folderId: string;
  authStatus: string | null;
  spamScore: number | null;
  spamReasons: string | null;
  originIp: string | null;
  /** Mirrors `emails.header_stage_attempts` — fruitless fetches, not writes. */
  attempts: number;
}

/** A backlog row with everything unfilled — the state the whole history is in. */
const row = (id: string, uid: number, folderPath = 'INBOX', folderId = 'f-inbox'): Row => ({
  id, uid, folderPath, folderId, authStatus: null, spamScore: null, spamReasons: null, originIp: null, attempts: 0,
});

const message = (uid: number, authHeaders?: string, from = 'sender@example.com'): FakeMessage => ({
  uid, authHeaders, originIp: '203.0.113.9', envelope: { from: [{ address: from }] },
});

/**
 * A fake account: a backlog of rows, a folder list, and a server that answers
 * for some uids. The storage mirrors the SQL the real one runs — including the
 * own-mail exclusion on the spam half and the COALESCE guard on the write —
 * because those two are exactly what this service must not get wrong.
 */
const makeAccount = (
  rows: Row[],
  serverHeaders: Record<string, string | undefined | 'MISSING'> = {},
  folders: Array<{ id: string; path: string }> = [{ id: 'f-inbox', path: 'INBOX' }, { id: 'f-sent', path: 'Sent' }],
) => {
  const state = {
    rows,
    fetchCalls: [] as Array<{ folder: string; uids: number[] }>,
    connected: true,
    fetchThrows: false,
    writes: 0,
    spammers: new Set<string>(),
    spammerLookups: [] as string[],
  };
  const inBacklog = (r: Row, ownMailFolderIds: readonly string[]): boolean =>
    r.attempts < 3
    && (r.authStatus === null || (r.spamScore === null && !ownMailFolderIds.includes(r.folderId)));
  const storage = {
    getFolders: async () => folders,
    isSpammer: async (address: string) => { state.spammerLookups.push(address); return state.spammers.has(address); },
    getEmailsMissingHeaderStage: (limit: number, ownMailFolderIds: readonly string[] = []) =>
      state.rows
        .filter((r) => inBacklog(r, ownMailFolderIds))
        .slice(0, limit)
        .map(({ id, uid, folderPath, folderId }) => ({ id, uid, folderPath, folderId })),
    countEmailsMissingHeaderStage: (ownMailFolderIds: readonly string[] = []) =>
      state.rows.filter((r) => inBacklog(r, ownMailFolderIds)).length,
    recordHeaderStageMiss: (ids: readonly string[]) => {
      let n = 0;
      for (const id of ids) {
        const r = state.rows.find((x) => x.id === id);
        if (r) { r.attempts += 1; n++; }
      }
      return n;
    },
    updateEmailHeaderStageBatch: (
      batch: Array<{ id: string; authStatus: string | null; spamScore: number | null; spamReasons: string | null; originIp: string | null }>,
    ) => {
      let n = 0;
      for (const b of batch) {
        const r = state.rows.find((x) => x.id === b.id);
        // The WHERE guard: a row with no gap is not a write, and must not be
        // counted as one or the progress line lies.
        if (!r || (r.authStatus !== null && r.spamScore !== null && r.originIp !== null)) continue;
        r.authStatus ??= b.authStatus;
        r.spamScore ??= b.spamScore;
        r.spamReasons ??= b.spamReasons;
        r.originIp ??= b.originIp;
        n++; state.writes++;
      }
      return n;
    },
  };
  const engine = {
    isConnected: () => state.connected,
    fetchHeaderMessages: async (folder: string, uids: number[]) => {
      state.fetchCalls.push({ folder, uids });
      if (state.fetchThrows) throw new Error('socket reset');
      const fetched = new Map<number, FakeMessage>();
      for (const uid of uids) {
        const headers = serverHeaders[String(uid)];
        if (headers === 'MISSING') continue;     // server did not return this uid
        fetched.set(uid, message(uid, headers)); // undefined headers = returned, no auth header
      }
      return fetched;
    },
  };
  return { state, storage, engine };
};

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const FIRST = 45_000;
const ACTIVE = 1_500;

beforeEach(() => {
  vi.useFakeTimers();
  h.activeStorage = null; h.activeEngine = null; h.runtimes = [];
  h.window = { destroyed: false, sent: [] }; h.unstable = new Set(); h.logs = [];
});
afterEach(() => { vi.useRealTimers(); });

describe('pure helpers', () => {
  it('groups a backlog slice into one UID list per folder, keeping the folder id', async () => {
    const { groupByFolder } = await load();
    const g = groupByFolder([
      { id: 'a', uid: 1, folderPath: 'INBOX', folderId: 'f-inbox' },
      { id: 'b', uid: 2, folderPath: 'Archive', folderId: 'f-arch' },
      { id: 'c', uid: 3, folderPath: 'INBOX', folderId: 'f-inbox' },
    ]);
    expect([...g.keys()]).toEqual(['INBOX', 'Archive']);
    expect(g.get('INBOX')?.map((r) => r.uid)).toEqual([1, 3]);
    // The own-mail check needs the id, not the path — dropping it here silently
    // scored Sent mail.
    expect(g.get('Archive')?.[0]?.folderId).toBe('f-arch');
  });

  // THE distinction the whole backfill rests on. Absent = not answered, keep
  // NULL and retry. Present-but-no-header = answered "nothing recorded", finalise.
  it('writes a verdict only for uids the server answered, finalising "no header" as unknown', async () => {
    const { verdictRows } = await load();
    const fetched = new Map<number, never>([
      [1, message(1, 'spf=pass dkim=pass dmarc=pass') as never],
      [2, message(2) as never],
    ]);
    const rows = verdictRows(
      [
        { id: 'a', uid: 1, ownMail: false, knownSpammer: false },
        { id: 'b', uid: 2, ownMail: false, knownSpammer: false },
        { id: 'c', uid: 3, ownMail: false, knownSpammer: false },
      ],
      fetched,
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);            // c (uid 3) stays NULL
    expect(JSON.parse(rows[0]!.authStatus!).overall).toBe('pass');
    expect(JSON.parse(rows[1]!.authStatus!)).toMatchObject({ spf: 'unknown', overall: 'none' });
  });

  // `headerStage`'s own `auth` is null for a message with no auth header — the
  // value the SCORER must see. Storing that null would leave the row in the
  // backlog to be fetched again forever, and storing the string "null" would be
  // worse still: unparseable JSON in a column the shield reads.
  it('never stores a null (or the string "null") authStatus for an answered uid', async () => {
    const { verdictRows } = await load();
    const rows = verdictRows(
      [{ id: 'a', uid: 1, ownMail: false, knownSpammer: false }],
      new Map<number, never>([[1, message(1) as never]]),
    );
    expect(rows[0]!.authStatus).not.toBeNull();
    expect(rows[0]!.authStatus).not.toBe('null');
    expect(() => JSON.parse(rows[0]!.authStatus!)).not.toThrow();
  });

  // Own mail is never scored — at ingest or here. A score on the user's own
  // Sent mail would file their own replies under Spam.
  it('leaves the spam columns null for own mail while still writing its auth verdict', async () => {
    const { verdictRows } = await load();
    const rows = verdictRows(
      [{ id: 'a', uid: 1, ownMail: true, knownSpammer: false }],
      new Map<number, never>([[1, message(1, 'spf=pass') as never]]),
    );
    expect(rows[0]!.spamScore).toBeNull();
    expect(rows[0]!.spamReasons).toBeNull();
    expect(rows[0]!.authStatus).not.toBeNull();
  });

  // A sender the user reported must score here exactly as they would on
  // arrival, or the Spam view disagrees with itself about the same sender.
  it('passes the reported-sender flag into the score', async () => {
    const { verdictRows } = await load();
    const fetched = new Map<number, never>([[1, message(1) as never]]);
    const clean = verdictRows([{ id: 'a', uid: 1, ownMail: false, knownSpammer: false }], fetched);
    const reported = verdictRows([{ id: 'a', uid: 1, ownMail: false, knownSpammer: true }], fetched);
    expect(reported[0]!.spamScore!).toBeGreaterThan(clean[0]!.spamScore!);
    expect(JSON.parse(reported[0]!.spamReasons!)).toContain('KNOWN_SPAMMER');
  });
});

describe('the tick', () => {
  it('fills both columns off one fetch and reports progress', async () => {
    const a = makeAccount(
      [row('a', 1), row('b', 2)],
      { '1': 'spf=pass dkim=pass dmarc=pass', '2': 'dmarc=fail' },
    );
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill();
    await advance(FIRST + 10);

    expect(a.state.rows.every((r) => r.authStatus !== null)).toBe(true);
    expect(a.state.rows.every((r) => r.spamScore !== null)).toBe(true);
    expect(a.state.rows.every((r) => r.originIp !== null)).toBe(true);
    expect(a.state.rows[1]!.spamScore).toBeGreaterThan(a.state.rows[0]!.spamScore!);
    // One fetch for both columns — re-reading the same bytes per column would
    // have doubled the IMAP traffic to learn nothing new.
    expect(a.state.fetchCalls).toHaveLength(1);
    expect(svc.getHeaderBackfillState()).toMatchObject({ done: 2, remaining: 0, drained: true });
    expect(h.window.sent.at(-1)?.channel).toBe('header-backfill:progress');
  });

  it('issues one fetch per folder, not per message', async () => {
    const a = makeAccount([
      row('a', 1), row('b', 2), row('c', 9, 'Archive', 'f-arch'),
    ], { '1': 'spf=pass', '2': 'spf=pass', '9': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toEqual([{ folder: 'INBOX', uids: [1, 2] }, { folder: 'Archive', uids: [9] }]);
  });

  // A uid the server did not return (expunged, or a blip) must not be written
  // — and must still be there for the next pass rather than silently finalised.
  it('leaves a uid the server did not answer for as NULL and retries it', async () => {
    const a = makeAccount([row('a', 1), row('gone', 2)], { '1': 'spf=pass', '2': 'MISSING' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill();
    await advance(FIRST + 10);

    expect(a.state.rows.find((r) => r.id === 'gone')?.authStatus).toBeNull();
    expect(a.state.rows.find((r) => r.id === 'gone')?.spamScore).toBeNull();
    expect(svc.getHeaderBackfillState().remaining).toBe(1);
    expect(svc.getHeaderBackfillState().drained).toBe(false);
    // ...and the next tick asks for it again.
    await advance(1_500 + 10);
    expect(a.state.fetchCalls.filter((c) => c.uids.includes(2))).toHaveLength(2);
  });

  // Own mail enters the backlog for its auth verdict and must LEAVE it after
  // one sweep. Selecting on `spam_score IS NULL` without excluding Sent would
  // fetch, decline to score, and reselect the same rows every 1.5s forever.
  it('drains own mail after one pass even though its spam score stays null', async () => {
    const a = makeAccount([row('sent', 7, 'Sent', 'f-sent')], { '7': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill();
    await advance(FIRST + 10);

    const sent = a.state.rows[0]!;
    expect(sent.authStatus).not.toBeNull();
    expect(sent.spamScore).toBeNull();
    expect(svc.getHeaderBackfillState()).toMatchObject({ remaining: 0, drained: true });

    const fetches = a.state.fetchCalls.length;
    await advance(1_500 * 5);
    expect(a.state.fetchCalls).toHaveLength(fetches); // not reselected
  });

  // The sweep may FILL a gap, never restate what ingest decided: a message
  // scored on arrival keeps that score even if a later rule change would give
  // it a different one.
  it('fills only the missing columns and leaves what ingest wrote alone', async () => {
    const a = makeAccount([{ ...row('a', 1), spamScore: 4, spamReasons: '["INGEST"]' }], { '1': 'dmarc=fail' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);

    expect(a.state.rows[0]!.spamScore).toBe(4);
    expect(a.state.rows[0]!.spamReasons).toBe('["INGEST"]');
    expect(a.state.rows[0]!.authStatus).not.toBeNull();  // the actual gap, filled
  });

  // The reported-sender list is consulted per message, exactly as ingest does.
  it('asks storage whether the sender is a reported spammer', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    a.state.spammers.add('sender@example.com');
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);

    expect(a.state.spammerLookups).toEqual(['sender@example.com']);
    expect(JSON.parse(a.state.rows[0]!.spamReasons!)).toContain('KNOWN_SPAMMER');
  });

  it('skips a churning connection instead of piling on, and comes back', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine; h.unstable.add(a.engine);
    const svc = await load();
    svc.startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(0);
    expect(svc.getHeaderBackfillState().drained).toBe(false);

    h.unstable.clear();
    await advance(1_500 + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  it('one account failing never stops the others', async () => {
    const bad = makeAccount([row('x', 1)]);
    bad.state.fetchThrows = true;
    const good = makeAccount([row('y', 1)], { '1': 'spf=pass' });
    h.activeStorage = bad.storage; h.activeEngine = bad.engine;
    h.runtimes = [['acct-b', { storage: good.storage, syncEngine: good.engine, smtpClient: null }]];
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);

    expect(good.state.rows[0]!.authStatus).not.toBeNull();
    expect(h.logs.some((l) => l.includes('tick failed (isolated)'))).toBe(true);
  });

  it('does nothing when no account is connected, then picks up once one is', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    a.state.connected = false;
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(0);
    a.state.connected = true;
    await advance(1_500 + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  // An older storage or engine (a downgrade, a partially-migrated profile) must
  // be a no-op, not a crash in the main process.
  it('does nothing when storage or engine predates the header stage', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    delete (a.storage as Partial<typeof a.storage>).getEmailsMissingHeaderStage;
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(0);
    expect(svc.getHeaderBackfillState().drained).toBe(true);
  });
});

describe('a backlog the server cannot satisfy', () => {
  // THE silent spin. A uid the server no longer has can never be filled, and
  // the old loop had no way to say so: it re-selected, re-fetched and wrote
  // nothing every 1.5s for as long as the app ran — 12.7% of the main thread,
  // invisible because a tick that writes nothing also logged nothing.
  it('retires a row after HEADER_STAGE_MAX_ATTEMPTS fruitless fetches, and stops asking', async () => {
    const a = makeAccount([row('gone', 7)], { '7': 'MISSING' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();

    await advance(FIRST + 10);
    expect(a.state.rows[0].attempts).toBe(1);
    await advance(ACTIVE + 10);
    await advance(ACTIVE + 10);
    expect(a.state.rows[0].attempts).toBe(3);
    expect(a.state.fetchCalls).toHaveLength(3);

    // Three strikes: out of the backlog, and never fetched again.
    await advance(ACTIVE * 5);
    expect(a.state.fetchCalls).toHaveLength(3);
    // Still NULL, which remains the truth — retiring the retry is not a verdict.
    expect(a.state.rows[0].authStatus).toBeNull();
  });

  // A blip is not an expunge: one miss must not retire real mail.
  it('leaves a row that has missed once still in the backlog', async () => {
    const a = makeAccount([row('blip', 7)], { '7': 'MISSING' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.rows[0].attempts).toBe(1);
    await advance(ACTIVE + 10);
    expect(a.state.fetchCalls).toHaveLength(2); // asked again
  });

  // Older storage has no recordHeaderStageMiss. The sweep must still run —
  // degraded to the old forever-retry, never crashed.
  it('runs against storage that cannot count misses', async () => {
    const a = makeAccount([row('gone', 7)], { '7': 'MISSING' });
    delete (a.storage as Partial<typeof a.storage>).recordHeaderStageMiss;
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  // The trail that would have made the spin visible in an afternoon instead of
  // a profiler session. Throttled, so a long unsatisfiable backlog is a note,
  // not a flood.
  it('warns when a tick writes nothing and the backlog has not moved', async () => {
    const a = makeAccount([row('gone', 7)], { '7': 'MISSING' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    const warned = h.logs.filter((l) => l.includes('no progress'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('1 remaining');
    expect(warned[0]).toContain('retired after 3 tries');

    // Second fruitless tick stays quiet — the throttle.
    await advance(ACTIVE + 10);
    expect(h.logs.filter((l) => l.includes('no progress'))).toHaveLength(1);
  });

  // A tick that DOES write resets the counter, so the next stall warns again
  // instead of being swallowed by the throttle.
  it('resets the no-progress counter once a tick writes', async () => {
    const a = makeAccount([row('gone', 7), row('ok', 8)], { '7': 'MISSING', '8': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);                 // writes row 8
    expect(h.logs.filter((l) => l.includes('no progress'))).toHaveLength(0);
    await advance(ACTIVE + 10);                // nothing left to write
    expect(h.logs.filter((l) => l.includes('no progress'))).toHaveLength(1);
  });
});

describe('the tick time budget', () => {
  // Row-count limits assume a fixed cost per row; this loop pays a network
  // FETCH plus a synchronous write per chunk, and neither is fixed. Without a
  // TIME budget one slow folder holds the main thread for as long as it likes.
  it('stops starting new chunks once the budget is spent', async () => {
    const { TICK_BUDGET_MS } = await load();
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`, i + 1, `F${i}`, `f${i}`));
    const headers = Object.fromEntries(rows.map((r) => [String(r.uid), 'spf=pass']));
    const a = makeAccount(rows, headers, rows.map((r) => ({ id: r.folderId, path: r.folderPath })));
    // Each fetch burns the whole budget, so exactly one may start.
    const realFetch = a.engine.fetchHeaderMessages;
    a.engine.fetchHeaderMessages = async (folder: string, uids: number[]) => {
      vi.setSystemTime(Date.now() + TICK_BUDGET_MS);
      return realFetch(folder, uids);
    };
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  // The budget must not cost a fast account its folders: three cheap folders
  // still go in one tick, as they did before.
  it('still does the full FOLDERS_PER_TICK when each folder is cheap', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`, i + 1, `F${i}`, `f${i}`));
    const headers = Object.fromEntries(rows.map((r) => [String(r.uid), 'spf=pass']));
    const a = makeAccount(rows, headers, rows.map((r) => ({ id: r.folderId, path: r.folderPath })));
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(3);
  });
});

describe('lifecycle', () => {
  it('sleeps the long idle interval once drained', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    (await load()).startHeaderBackfill();
    await advance(FIRST + 10);
    const calls = a.state.fetchCalls.length;
    await advance(29 * 60_000);
    expect(a.state.fetchCalls).toHaveLength(calls); // still asleep
  });

  it('kick pulls the next tick forward', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill();
    svc.kickHeaderBackfill();
    await advance(300);
    expect(a.state.fetchCalls).toHaveLength(1);
  });

  it('stop() prevents any further tick', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill();
    svc.stopHeaderBackfill();
    await advance(FIRST + 60_000);
    expect(a.state.fetchCalls).toHaveLength(0);
  });

  it('start is idempotent', async () => {
    const a = makeAccount([row('a', 1)], { '1': 'spf=pass' });
    h.activeStorage = a.storage; h.activeEngine = a.engine;
    const svc = await load();
    svc.startHeaderBackfill(); svc.startHeaderBackfill();
    await advance(FIRST + 10);
    expect(a.state.fetchCalls).toHaveLength(1);
  });
});
