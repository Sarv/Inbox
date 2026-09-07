import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { FakeImapServer } from '../../../src/test-support/fake-imap-server';

import { RealtimeManager, type RealtimeConfig, type RealtimeEvent } from '../../../src/imap/realtime-manager';

// The RealtimeManager owns every timer that keeps mail flowing: IDLE, the polling
// fallback, the polling->IDLE upgrade retry, the debounced flag reconciliation and
// the periodic sync. Its historic bugs were all "a timer chain outlived its
// session" (overnight sync churn with nobody at the keyboard, two loops after a
// reconnect, a stopped manager still touching IMAP) or "IDLE failed once and we
// stayed on 30s polling forever". Every test pins one of those.

const BASE_CONFIG: Partial<RealtimeConfig> = {
  pollingIntervalMs: 30_000,
  periodicSyncIntervalMs: 60_000,
  minPollIntervalMs: 5_000,
  idleUpgradeIntervalMs: 120_000,
  maxNewMessagesBatch: 20,
};

type Folder = { id: string; path: string; lastSyncUid: number; lastKnownMessageCount?: number };

function makeStorage(folder: Folder = { id: 'f1', path: 'INBOX', lastSyncUid: 0, lastKnownMessageCount: 0 }) {
  return {
    folder,
    getFolderByPath: vi.fn(async (path: string) => (path === folder.path ? folder : null)),
    updateFolder: vi.fn(async () => {}),
    recalculateFolderCounts: vi.fn(async () => {}),
    getEmailByFolderAndUid: vi.fn(async (_folderId: string, _uid: number) => null as null | { id: string }),
    unlinkOrDeleteEmailsFromFolder: vi.fn(async () => ({ unlinked: 0, deleted: 1 })),
    applyReadFlagToFolderCountsBatch: vi.fn(async () => {}),
  };
}

const EMPTY_BATCH = {
  inserted: 0, updated: 0, skipped: 0, errors: 0, maxUid: 0,
  insertedIds: [] as string[], relinkedFromFolders: [] as string[], erroredUids: [] as number[],
};

/** Stand-in for the real MessageProcessor — the sync logic it drives is tested
 *  in message-processor's own suites; here we only care WHEN it is invoked. */
function makeProcessor() {
  return {
    // Varargs so a test can assert on (or drive) the callbacks the manager passes.
    syncFlags: vi.fn(async (..._args: any[]) => ({ updated: 0, deleted: 0 })),
    processBatch: vi.fn(async (..._args: any[]) => ({ ...EMPTY_BATCH })),
    setPendingUidsProvider: vi.fn(),
  };
}

async function makeRealtime(options: {
  idle?: boolean;
  config?: Partial<RealtimeConfig>;
  folder?: Folder;
  connected?: boolean;
  qresync?: boolean;
} = {}) {
  // QRESYNC on: the IDLE expunge FAST PATH (per-UID handleExpunge) only runs when
  // the server advertises QRESYNC — without it ImapFlow can't guarantee event.uid
  // is a real UID, so we fall back to the coalesced Phase-2 sync.
  const client = new FakeImapServer({ idle: options.idle ?? true, qresync: options.qresync ?? true });
  client.addFolder('INBOX');
  client.addFolder('Trash');
  if (options.connected !== false) await client.connect({} as any);

  const storage = makeStorage(options.folder);
  const processor = makeProcessor();
  const onSyncRequest = vi.fn(async () => {});
  const realtime = new RealtimeManager({ ...BASE_CONFIG, ...options.config });
  (realtime as any).messageProcessor = processor;
  realtime.initialize({ client: client as any, storage: storage as any, onSyncRequest });

  const events: RealtimeEvent[] = [];
  const errors: Error[] = [];
  const newMessages: Array<[number, string]> = [];
  const flagsChanged: Array<[string, string[]]> = [];
  let disconnects = 0;
  realtime.on('event', (event) => events.push(event));
  realtime.on('error', (error) => errors.push(error));
  realtime.on('new-messages', (count, folderPath) => newMessages.push([count, folderPath]));
  realtime.on('flags-changed', (emailId, flags) => flagsChanged.push([emailId, flags]));
  realtime.on('disconnected', () => { disconnects++; });

  return {
    realtime, client, storage, processor, onSyncRequest, events, errors, newMessages, flagsChanged,
    disconnectCount: () => disconnects,
  };
}

/** A promise a test can settle by hand, to hold an async continuation open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Both the periodic-sync (±20%) and idle-upgrade (±25%) jitter multiply by
  // (base + random * span); 0.5 pins the factor to exactly 1.0.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  for (const level of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RealtimeManager — start', () => {
  it('refuses to start before initialize()', async () => {
    await expect(new RealtimeManager().start('INBOX')).rejects.toThrow('not initialized');
  });

  it('prefers IDLE, selects the folder, and reconciles flags that changed while away', async () => {
    const { realtime, client, processor } = await makeRealtime();

    const mode = await realtime.start('INBOX');

    expect(mode).toBe('idle');
    expect(realtime.getMode()).toBe('idle');
    expect(realtime.getMonitoredFolder()).toBe('INBOX');
    expect(realtime.isActive()).toBe(true);
    expect(client.callCount('startIdle')).toBe(1);
    expect(client.getCurrentFolder()).toBe('INBOX');

    // IDLE only pushes FUTURE events, so the initial reconcile is what catches
    // mail deleted from webmail while we weren't monitoring.
    await vi.advanceTimersByTimeAsync(1500);
    expect(processor.syncFlags).toHaveBeenCalledTimes(1);
  });

  // A server without IDLE must still see new mail — that's the whole point of the
  // polling fallback.
  it('falls back to polling on a server that does not support IDLE, and stops trying to upgrade', async () => {
    const { realtime, client, processor } = await makeRealtime({ idle: false });

    const mode = await realtime.start('INBOX');

    expect(mode).toBe('polling');
    expect(client.callCount('startIdle')).toBe(0);
    expect(processor.syncFlags).toHaveBeenCalledTimes(1); // the initial poll ran

    // Retrying an upgrade forever on a server that will never support IDLE is
    // pure churn, so the retry timer must be dropped.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.callCount('startIdle')).toBe(0);
  });

  it('reports "none" (and does not arm anything) when the connection is down', async () => {
    const { realtime, client, processor } = await makeRealtime({ connected: false });

    const mode = await realtime.start('INBOX');

    expect(mode).toBe('none');
    expect(realtime.isActive()).toBe(false);
    expect(client.callCount('startIdle')).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(processor.syncFlags).not.toHaveBeenCalled();
  });

  it('detaches an already-attached IDLE loop instead of double-subscribing', async () => {
    const { realtime, client } = await makeRealtime();
    await realtime.start('INBOX');

    // Belt-and-braces path: start IDLE while it is already active.
    await (realtime as any).startIdle('INBOX');

    expect(client.callCount('stopIdle')).toBeGreaterThanOrEqual(1);
    expect(client.callCount('startIdle')).toBe(2);
  });
});

describe('RealtimeManager — a session that failed to start AT ALL', () => {
  // When IDLE *and* its polling fallback both failed (both gate on
  // isConnected(), so a connection recycled mid-start fails both), mode stayed
  // 'none' and nothing ever tried again: no IDLE, no polling, no periodic sync —
  // that account received no live mail for the rest of the session while the UI
  // showed it connected. In the logs:
  //   Realtime: Failed to start IDLE: IMAPError: Connection not available
  //   Realtime: Failed to start monitoring (rt#2)
  // and then silence.
  const deadConnection = async () => {
    const ctx = await makeRealtime();
    const connected = vi.spyOn(ctx.client, 'isConnected').mockReturnValue(false);
    return { ...ctx, connected };
  };

  it('RETRIES on its own once the connection comes back', async () => {
    const { realtime, connected } = await deadConnection();

    expect(await realtime.start('INBOX')).toBe('none');
    expect(realtime.getMode()).toBe('none');

    // Still dead at the first retry — it must keep trying, not give up.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(realtime.getMode()).toBe('none');

    connected.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(60_000); // backed off to 60s
    expect(realtime.getMode()).toBe('idle');
  });

  it('backs off between retries and caps the delay', async () => {
    const { realtime, connected } = await deadConnection();
    expect(await realtime.start('INBOX')).toBe('none');

    await vi.advanceTimersByTimeAsync(29_999);      // 30s
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(59_999);      // 60s
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(120_000);     // 120s
    await vi.advanceTimersByTimeAsync(240_000);     // 240s
    // Capped at 5 min from here on.
    await vi.advanceTimersByTimeAsync(299_999);
    connected.mockReturnValue(true);
    expect(realtime.getMode()).toBe('none');
    await vi.advanceTimersByTimeAsync(1);
    expect(realtime.getMode()).toBe('idle');
  });

  it('gives a NEW client its chance immediately instead of waiting out the backoff', async () => {
    const { realtime, connected } = await deadConnection();
    expect(await realtime.start('INBOX')).toBe('none');

    const fresh = new FakeImapServer({ idle: true });
    fresh.addFolder('INBOX');
    await fresh.connect({} as never);
    connected.mockReturnValue(true); // (the old client, now irrelevant)
    await realtime.updateClient(fresh as never);

    expect(realtime.getMode()).toBe('idle');
    expect(fresh.callCount('startIdle')).toBe(1);
  });

  it('stops retrying after an explicit stop()', async () => {
    const { realtime, connected } = await deadConnection();
    expect(await realtime.start('INBOX')).toBe('none');

    await realtime.stop();
    connected.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(realtime.getMode()).toBe('none');
  });

  it('does not retry over a session that came up by another route', async () => {
    const { realtime, client, connected } = await deadConnection();
    expect(await realtime.start('INBOX')).toBe('none');

    connected.mockReturnValue(true);
    expect(await realtime.start('INBOX')).toBe('idle'); // e.g. the renderer re-asks
    const idleStarts = client.callCount('startIdle');

    // The pending retry must not tear that healthy session down and rebuild it.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(realtime.getMode()).toBe('idle');
    expect(client.callCount('startIdle')).toBe(idleStarts);
  });
});

describe('RealtimeManager — polling -> IDLE upgrade', () => {
  // IDLE start typically fails because its SELECT lost a race with a heavy sync
  // on the shared connection. Staying on 30s polling until the next reconnect was
  // the bug; the session has to self-heal.
  it('keeps polling after a failed IDLE start, then upgrades once the connection quiesces', async () => {
    // Periodic sync parked far away so the only syncFlags calls here are polls.
    const { realtime, client, processor } = await makeRealtime({ config: { periodicSyncIntervalMs: 3_600_000 } });
    const startIdle = vi.spyOn(client, 'startIdle');
    startIdle.mockRejectedValueOnce(new Error('Connection not available'));

    expect(await realtime.start('INBOX')).toBe('polling');
    expect(realtime.getMode()).toBe('polling');
    const pollsBefore = processor.syncFlags.mock.calls.length;

    await vi.advanceTimersByTimeAsync(120_000); // first upgrade retry

    expect(realtime.getMode()).toBe('idle');
    expect(client.callCount('startIdle')).toBe(1); // the successful one
    // Polling must be off now — no further poll-driven syncFlags beyond the
    // upgrade's own (debounced) reconcile.
    await vi.advanceTimersByTimeAsync(1500);
    const afterUpgrade = processor.syncFlags.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processor.syncFlags.mock.calls.length).toBe(afterUpgrade);
    expect(afterUpgrade).toBeGreaterThan(pollsBefore);
  });

  it('backs off exponentially between failed upgrades and caps the delay at 15 minutes', async () => {
    const { realtime, client } = await makeRealtime();
    const startIdle = vi.spyOn(client, 'startIdle');
    startIdle.mockRejectedValue(new Error('Connection not available'));

    expect(await realtime.start('INBOX')).toBe('polling');
    const attempts = () => startIdle.mock.calls.length - 1; // minus the initial start

    await vi.advanceTimersByTimeAsync(119_999);
    expect(attempts()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(1);                 // 120s

    await vi.advanceTimersByTimeAsync(239_999);
    expect(attempts()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(2);                 // +240s

    await vi.advanceTimersByTimeAsync(480_000);
    expect(attempts()).toBe(3);                 // +480s

    // Next would be 960s; the cap holds it at 900s.
    await vi.advanceTimersByTimeAsync(899_999);
    expect(attempts()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts()).toBe(4);

    expect(realtime.getMode()).toBe('polling');  // still alive on polling
  });

  it('retries later (without touching IMAP) while the connection is down', async () => {
    const { realtime, client } = await makeRealtime();
    const startIdle = vi.spyOn(client, 'startIdle');
    startIdle.mockRejectedValueOnce(new Error('busy'));
    await realtime.start('INBOX');
    await client.disconnect();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(startIdle).toHaveBeenCalledTimes(1); // skipped: not connected

    await client.connect({} as any);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(startIdle).toHaveBeenCalledTimes(2); // and it did come back
    expect(realtime.getMode()).toBe('idle');
  });

  it('abandons the upgrade once the session is no longer polling', async () => {
    const { realtime, client } = await makeRealtime();
    const startIdle = vi.spyOn(client, 'startIdle');
    startIdle.mockRejectedValueOnce(new Error('busy'));
    await realtime.start('INBOX');

    await realtime.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(startIdle).toHaveBeenCalledTimes(1);
  });
});

describe('RealtimeManager — periodic sync', () => {
  it('runs on its jittered interval and follows each sync with a deletion reconcile', async () => {
    const { realtime, onSyncRequest, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onSyncRequest).toHaveBeenCalledWith(['INBOX']);
    await vi.advanceTimersByTimeAsync(1500);
    // syncAll downloads new mail but never reconciles deletions — this backstop does.
    expect(processor.syncFlags).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSyncRequest).toHaveBeenCalledTimes(2); // self-rescheduling chain
  });

  // Syncing mid-reconnect only throws "Connection not available" and adds churn.
  it('skips the tick while disconnected but keeps the chain alive for later', async () => {
    const { realtime, client, onSyncRequest } = await makeRealtime();
    await realtime.start('INBOX');
    await client.disconnect();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSyncRequest).not.toHaveBeenCalled();

    await client.connect({} as any);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSyncRequest).toHaveBeenCalledTimes(1);
  });

  // A tick landing while a sync is already running is benign — the in-flight sync
  // already covers this folder. It must be a quiet skip, not an error event.
  it('treats "Sync already in progress" as a skip, not a failure', async () => {
    const { realtime, onSyncRequest, errors } = await makeRealtime();
    onSyncRequest.mockRejectedValueOnce(new Error('Sync already in progress'));
    await realtime.start('INBOX');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSyncRequest).toHaveBeenCalledTimes(2); // chain survived the rejection
  });

  it('keeps the chain alive after a genuine sync failure', async () => {
    const { realtime, onSyncRequest } = await makeRealtime();
    onSyncRequest.mockRejectedValueOnce(new Error('IMAP FETCH failed'));
    await realtime.start('INBOX');

    await vi.advanceTimersByTimeAsync(120_000);

    expect(onSyncRequest).toHaveBeenCalledTimes(2);
  });

  // THE overnight-churn regression: a tick that was awaiting onSyncRequest when
  // the session was torn down used to fall through and re-arm the timer, orphaning
  // a chain that could never be cleared again — one extra self-perpetuating sync
  // loop per reconnect-during-sync, forever.
  it('a sync still in flight during stop() must NOT re-arm the chain', async () => {
    const { realtime, onSyncRequest, processor } = await makeRealtime();
    const inFlight = deferred<void>();
    onSyncRequest.mockImplementationOnce(() => inFlight.promise);
    await realtime.start('INBOX');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onSyncRequest).toHaveBeenCalledTimes(1);

    await realtime.stop();
    inFlight.resolve();                       // the orphaned continuation resumes
    processor.syncFlags.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(onSyncRequest).toHaveBeenCalledTimes(1); // no second chain
    expect(processor.syncFlags).not.toHaveBeenCalled(); // and no re-armed flag sync
  });
});

describe('RealtimeManager — stop / restart', () => {
  it('stop() cancels every timer so nothing touches IMAP afterwards', async () => {
    const { realtime, client, storage, onSyncRequest, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();
    storage.getFolderByPath.mockClear();

    await realtime.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(realtime.getMode()).toBe('none');
    expect(realtime.getMonitoredFolder()).toBeNull();
    expect(realtime.isActive()).toBe(false);
    expect(client.callCount('stopIdle')).toBeGreaterThanOrEqual(1);
    expect(onSyncRequest).not.toHaveBeenCalled();
    expect(processor.syncFlags).not.toHaveBeenCalled();
    expect(storage.getFolderByPath).not.toHaveBeenCalled();
  });

  it('restarting leaves exactly ONE periodic-sync loop', async () => {
    const { realtime, onSyncRequest } = await makeRealtime();
    await realtime.start('INBOX');
    await realtime.start('INBOX');

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onSyncRequest).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent start()/stop() into one coherent session', async () => {
    const { realtime, onSyncRequest } = await makeRealtime();

    await Promise.all([realtime.start('INBOX'), realtime.start('INBOX'), realtime.start('INBOX')]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(realtime.getMode()).toBe('idle');
    expect(onSyncRequest).toHaveBeenCalledTimes(1);
  });

  // A stopped manager that keeps waking up to touch IMAP was a real bug: two
  // callers re-armed the debounce from continuations that outlived stop().
  it('refuses to arm the flag-sync debounce on a torn-down manager', async () => {
    const { realtime, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await realtime.stop();
    processor.syncFlags.mockClear();

    (realtime as any).scheduleFlagSync();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(processor.syncFlags).not.toHaveBeenCalled();
  });
});

describe('RealtimeManager — IDLE events', () => {
  it('fetches, stores and announces new mail per email (not just a count)', async () => {
    const { realtime, client, storage, processor, events, newMessages } = await makeRealtime();
    client.addMessage('INBOX', { subject: 'one' });
    client.addMessage('INBOX', { subject: 'two' });
    processor.processBatch.mockResolvedValueOnce({ ...EMPTY_BATCH, inserted: 2, insertedIds: ['e1', 'e2'] });
    await realtime.start('INBOX');

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(processor.processBatch).toHaveBeenCalledTimes(1);
    // Per-email events are what let the renderer merge rows in place; the old
    // count-only event was dropped downstream, so nothing refreshed.
    expect(events.filter((e) => e.type === 'new').map((e) => e.emailId)).toEqual(['e1', 'e2']);
    expect(newMessages).toEqual([[2, 'INBOX']]);
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { lastSyncUid: 2 });
    // The folder-count recount is now DEBOUNCED (coalesced per folder) — the
    // per-email 'new' events already moved the badge; the DB recount lands shortly.
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.recalculateFolderCounts).toHaveBeenCalledWith(['INBOX']);
  });

  it('does nothing when the server pushed a NEW notice but there is no new UID', async () => {
    const { realtime, client, storage, processor } = await makeRealtime();
    await realtime.start('INBOX');
    storage.updateFolder.mockClear();

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(processor.processBatch).not.toHaveBeenCalled();
    expect(storage.updateFolder).not.toHaveBeenCalled();
  });

  // A webmail Trash->Inbox move relinks the row here but leaves a stale tag on the
  // SOURCE folder, which isn't monitored — hence the "moved to Inbox but still in
  // Trash" report. Reconcile the source folder via the engine, off the IDLE socket.
  it('reconciles the source folder after a move-BACK into the monitored folder', async () => {
    const { realtime, client, processor, onSyncRequest } = await makeRealtime();
    client.addMessage('INBOX', { subject: 'moved back' });
    processor.processBatch.mockResolvedValueOnce({
      ...EMPTY_BATCH, inserted: 1, insertedIds: ['e1'], relinkedFromFolders: ['Trash', 'INBOX'],
    });
    await realtime.start('INBOX');
    onSyncRequest.mockClear();

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    // The monitored folder itself is filtered out — only real sources are synced.
    expect(onSyncRequest).toHaveBeenCalledWith(['Trash']);
  });

  it('coalesces a burst of flag pushes into ONE folder reconciliation', async () => {
    const { realtime, client, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();

    for (let i = 0; i < 5; i++) client.emitIdle({ type: 'update' } as any); // "mark all read"
    await vi.advanceTimersByTimeAsync(1500);

    expect(processor.syncFlags).toHaveBeenCalledTimes(1);
  });

  it('does NOT trust event.uid for the fast path when the server lacks QRESYNC', async () => {
    // Without QRESYNC, ImapFlow can't guarantee event.uid is a real UID (it may be
    // a sequence number that collides with a DIFFERENT message's UID). Deleting by
    // it would unlink the wrong row, so we must fall back to the completeness-
    // guarded Phase-2 sync instead of calling handleExpunge.
    const { realtime, client, storage } = await makeRealtime({ qresync: false });
    storage.getEmailByFolderAndUid.mockResolvedValue({ id: 'e9' });
    await realtime.start('INBOX');

    client.emitIdle({ type: 'expunge', uid: 42 } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.unlinkOrDeleteEmailsFromFolder).not.toHaveBeenCalled(); // no delete by an untrusted uid
  });

  // QRESYNC fast path: the server named the vanished UID, so the row goes now and
  // the renderer drops that exact row — no waiting on the throttled SEARCH-ALL diff.
  it('removes exactly the expunged UID and emits a per-email deleted event', async () => {
    const { realtime, client, storage, events } = await makeRealtime();
    storage.getEmailByFolderAndUid.mockResolvedValue({ id: 'e9' });
    await realtime.start('INBOX');

    client.emitIdle({ type: 'expunge', uid: 42 } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.unlinkOrDeleteEmailsFromFolder).toHaveBeenCalledWith(['e9'], 'f1');
    expect(events).toContainEqual({ type: 'deleted', folderPath: 'INBOX', emailId: 'e9', uid: 42 });
    // Recount is debounced now; the per-email 'deleted' event already updated the
    // badge in place.
    await vi.advanceTimersByTimeAsync(1000);
    expect(storage.recalculateFolderCounts).toHaveBeenCalledWith(['INBOX']);
  });

  // The regression this guards: a bulk webmail delete surfaces as a STORM of
  // per-UID expunge events, and each used to fire its own full-table recount
  // (~10s of synchronous main-thread stalls). They must coalesce into ONE.
  it('coalesces a burst of expunges into ONE folder recount', async () => {
    const { realtime, client, storage } = await makeRealtime();
    storage.getEmailByFolderAndUid.mockImplementation(async (_f: string, uid: number) => ({ id: `e${uid}` }));
    await realtime.start('INBOX');
    storage.recalculateFolderCounts.mockClear();

    for (let uid = 1; uid <= 20; uid++) client.emitIdle({ type: 'expunge', uid } as any);
    await vi.advanceTimersByTimeAsync(0);   // all 20 rows removed + per-email events fire
    await vi.advanceTimersByTimeAsync(1000); // debounce window elapses

    expect(storage.unlinkOrDeleteEmailsFromFolder).toHaveBeenCalledTimes(20); // each row removed
    expect(storage.recalculateFolderCounts).toHaveBeenCalledTimes(1);         // but ONE recount
  });

  it('ignores an expunge for a UID we never had locally', async () => {
    const { realtime, client, storage, events } = await makeRealtime();
    await realtime.start('INBOX');

    client.emitIdle({ type: 'expunge', uid: 7 } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.unlinkOrDeleteEmailsFromFolder).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'deleted')).toEqual([]);
  });

  it('falls back to the coalesced reconcile for a seq-only expunge (no UID)', async () => {
    const { realtime, client, processor, events } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();

    client.emitIdle({ type: 'expunge' } as any);
    await vi.advanceTimersByTimeAsync(1500);

    expect(events).toContainEqual({ type: 'deleted', folderPath: 'INBOX' });
    expect(processor.syncFlags).toHaveBeenCalledTimes(1);
  });

  it('reports a failure while handling new mail without killing the IDLE loop', async () => {
    const { realtime, client, errors } = await makeRealtime();
    client.addMessage('INBOX', { subject: 'boom' });
    // New mail is now pulled via the bounded windowed fetch (fetchMessagesByUidRange),
    // not the unbounded getNewMessages — reject that path.
    vi.spyOn(client, 'fetchMessagesByUidRange').mockRejectedValueOnce(new Error('FETCH exploded'));
    await realtime.start('INBOX');

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.map((e) => e.message)).toEqual(['FETCH exploded']);
    expect(realtime.getMode()).toBe('idle');
  });

  it('swallows an expunge-handling failure (it is a backstop, not a hard error)', async () => {
    const { realtime, client, storage, errors } = await makeRealtime();
    storage.getEmailByFolderAndUid.mockRejectedValueOnce(new Error('db locked'));
    await realtime.start('INBOX');

    client.emitIdle({ type: 'expunge', uid: 3 } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([]);
    expect(realtime.getMode()).toBe('idle');
  });

  it('recovers when the post-insert unread recount fails', async () => {
    const { realtime, client, storage, processor, newMessages } = await makeRealtime();
    client.addMessage('INBOX', { subject: 'one' });
    processor.processBatch.mockResolvedValueOnce({ ...EMPTY_BATCH, inserted: 1, insertedIds: ['e1'] });
    storage.recalculateFolderCounts.mockRejectedValueOnce(new Error('db busy'));
    await realtime.start('INBOX');

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(newMessages).toEqual([[1, 'INBOX']]); // the UI still got its update
  });
});

describe('RealtimeManager — coalesced flag sync', () => {
  it('emits per-email flag + deletion events for what the reconcile found', async () => {
    const { realtime, client, processor, events, flagsChanged } = await makeRealtime();
    processor.syncFlags.mockImplementation(async (
      _client: any, _folder: any, _storage: any,
      onFlags?: (id: string, uid: number, flags: string[]) => void,
      onDeleted?: (id: string, uid: number) => void,
    ) => {
      onFlags?.('e1', 11, ['\\Seen']);
      onDeleted?.('e2', 12);
      return { updated: 1, deleted: 1 };
    });
    await realtime.start('INBOX');

    await vi.advanceTimersByTimeAsync(1500);

    expect(events).toContainEqual({ type: 'flagsChanged', folderPath: 'INBOX', emailId: 'e1', uid: 11, flags: ['\\Seen'] });
    expect(events).toContainEqual({ type: 'deleted', folderPath: 'INBOX', emailId: 'e2', uid: 12 });
    expect(flagsChanged).toEqual([['e1', ['\\Seen']]]);
    expect(client.callCount('selectFolder')).toBeGreaterThanOrEqual(1);
  });

  // A flag-only change gets the precise, scan-free read delta; a deletion changes
  // message counts too, so it still needs the full recount.
  it('uses the read-delta fast path for flag-only changes and a full recount when rows vanished', async () => {
    const { realtime, storage, processor } = await makeRealtime();
    processor.syncFlags.mockImplementation(async (...args: any[]) => {
      // syncFlags(client, folder, storage, onFlags, onDeleted, _, onReadFlip)
      const onReadFlip = args[6] as ((id: string, nowRead: boolean) => void) | undefined;
      onReadFlip?.('e1', true);
      return { updated: 1, deleted: 0 };
    });
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);

    expect(storage.applyReadFlagToFolderCountsBatch).toHaveBeenCalledWith([{ emailId: 'e1', nowRead: true }]);
    expect(storage.recalculateFolderCounts).not.toHaveBeenCalled();

    processor.syncFlags.mockResolvedValue({ updated: 0, deleted: 2 });
    (realtime as any).scheduleFlagSync();
    await vi.advanceTimersByTimeAsync(1500);

    expect(storage.recalculateFolderCounts).toHaveBeenCalledWith(['INBOX']);
  });

  it('re-arms the debounce instead of running two reconciles at once', async () => {
    const { realtime, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();

    (realtime as any).flagSyncInProgress = true;
    (realtime as any).scheduleFlagSync();
    await vi.advanceTimersByTimeAsync(1500);
    expect(processor.syncFlags).not.toHaveBeenCalled(); // deferred, not concurrent

    (realtime as any).flagSyncInProgress = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(processor.syncFlags).toHaveBeenCalledTimes(1); // the re-armed run
  });

  it('does not reconcile over a dead connection', async () => {
    const { realtime, client, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();
    await client.disconnect();

    (realtime as any).scheduleFlagSync();
    await vi.advanceTimersByTimeAsync(1500);

    expect(processor.syncFlags).not.toHaveBeenCalled();
  });

  it('logs (and survives) a reconcile that throws', async () => {
    const { realtime, processor, errors } = await makeRealtime();
    processor.syncFlags.mockRejectedValue(new Error('SELECT timed out'));
    await realtime.start('INBOX');

    await vi.advanceTimersByTimeAsync(1500);

    expect(errors).toEqual([]);            // a warn, not an error event
    expect(realtime.getMode()).toBe('idle');
  });

  it('survives a failing unread refresh after a flag change', async () => {
    const { realtime, storage, processor } = await makeRealtime();
    processor.syncFlags.mockResolvedValue({ updated: 3, deleted: 0 });
    storage.recalculateFolderCounts.mockRejectedValue(new Error('db busy'));
    await realtime.start('INBOX');

    await expect(vi.advanceTimersByTimeAsync(1500)).resolves.toBeDefined();
    expect(storage.recalculateFolderCounts).toHaveBeenCalled();
  });
});

describe('RealtimeManager — polling loop', () => {
  it('polls on its interval, detects new mail from the folder status and stores the new counts', async () => {
    const { realtime, client, storage, processor } = await makeRealtime({
      idle: false,
      folder: { id: 'f1', path: 'INBOX', lastSyncUid: 0, lastKnownMessageCount: 1 },
    });
    client.addMessage('INBOX', { subject: 'fresh' });
    processor.processBatch.mockResolvedValue({ ...EMPTY_BATCH, inserted: 1, insertedIds: ['e1'] });

    await realtime.start('INBOX');

    // uidNext (2) > lastSyncUid + 1 → new mail; the poll pulls it in.
    expect(processor.processBatch).toHaveBeenCalledTimes(1);
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', expect.objectContaining({
      lastKnownMessageCount: 1, totalCount: 1,
    }));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(processor.syncFlags).toHaveBeenCalledTimes(2); // second poll ran
  });

  it('debounces polls that arrive inside minPollIntervalMs', async () => {
    const { realtime, processor } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    expect(processor.syncFlags).toHaveBeenCalledTimes(1);

    await (realtime as any).poll(); // same instant as the initial poll

    expect(processor.syncFlags).toHaveBeenCalledTimes(1);
  });

  it('never runs two polls concurrently', async () => {
    const { realtime, processor } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    processor.syncFlags.mockClear();
    (realtime as any).pollingInProgress = true;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(processor.syncFlags).not.toHaveBeenCalled();
  });

  it('recounts the folder after a server-driven flag change so the badge is not stale', async () => {
    const { realtime, storage, processor } = await makeRealtime({ idle: false });
    processor.syncFlags.mockResolvedValue({ updated: 2, deleted: 0 });

    await realtime.start('INBOX');

    expect(storage.recalculateFolderCounts).toHaveBeenCalledWith(['INBOX']);
  });

  it('survives a failing recount during polling', async () => {
    const { realtime, storage, processor, errors } = await makeRealtime({ idle: false });
    processor.syncFlags.mockResolvedValue({ updated: 1, deleted: 1 });
    storage.recalculateFolderCounts.mockRejectedValue(new Error('db busy'));

    await expect(realtime.start('INBOX')).resolves.toBe('polling');
    expect(errors).toEqual([]);
  });

  it('pauses monitoring (and says so) when the poll hits a connection error', async () => {
    const { realtime, client, processor, disconnectCount } = await makeRealtime({
      idle: false,
      config: { periodicSyncIntervalMs: 3_600_000 }, // isolate polls from the periodic chain
    });
    await realtime.start('INBOX');
    processor.syncFlags.mockRejectedValueOnce(new Error('Connection not available'));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(disconnectCount()).toBe(1);
    // handleReconnect detaches IDLE + polling; the ConnectionManager owns the
    // reconnect, and updateClient() restarts us on the new client.
    expect(client.callCount('stopIdle')).toBeGreaterThanOrEqual(1);
    const polls = processor.syncFlags.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(processor.syncFlags.mock.calls.length).toBe(polls);
  });

  it('reports a non-connection poll failure as an error event', async () => {
    const { realtime, processor, errors, disconnectCount } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    processor.syncFlags.mockRejectedValueOnce(new Error('NO server rejected the FETCH'));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(errors.map((e) => e.message)).toEqual(['NO server rejected the FETCH']);
    expect(disconnectCount()).toBe(0);
  });

  it('pauses instead of polling once the socket is gone', async () => {
    const { realtime, client, storage } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    await client.disconnect();
    storage.getFolderByPath.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(storage.getFolderByPath).not.toHaveBeenCalled();
  });

  it('does nothing when the monitored folder is unknown to storage', async () => {
    const { realtime, storage, processor } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    storage.getFolderByPath.mockResolvedValue(null);
    processor.syncFlags.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(processor.syncFlags).not.toHaveBeenCalled();
  });
});

describe('RealtimeManager — client swaps and config', () => {
  // The engine hands us a new client after every reconnect; monitoring has to
  // move across, and the OUTGOING client must not keep its IDLE listeners.
  it('restarts monitoring on the replacement client after a reconnect', async () => {
    const { realtime, client, storage } = await makeRealtime();
    await realtime.start('INBOX');
    const replacement = new FakeImapServer({ idle: true });
    replacement.addFolder('INBOX');
    await replacement.connect({} as any);

    await realtime.updateClient(replacement as any);

    expect(client.callCount('stopIdle')).toBeGreaterThanOrEqual(1);
    expect(replacement.callCount('startIdle')).toBe(1);
    expect(realtime.getMode()).toBe('idle');
    expect(realtime.getMonitoredFolder()).toBe('INBOX');
    expect(storage.getFolderByPath).toBeDefined();
  });

  it('does not start monitoring on a new client if it was not active', async () => {
    const { realtime } = await makeRealtime();
    const replacement = new FakeImapServer({ idle: true });
    replacement.addFolder('INBOX');
    await replacement.connect({} as any);

    await realtime.updateClient(replacement as any);

    expect(replacement.callCount('startIdle')).toBe(0);
    expect(realtime.getMode()).toBe('none');
  });

  // The engine re-initializes components with the NEW client BEFORE updateClient,
  // so the outgoing client is only reachable here — detach its IDLE now or it
  // keeps the listeners forever.
  it('detaches the previous client when initialize() swaps it out', async () => {
    const { realtime, client, storage } = await makeRealtime();
    await realtime.start('INBOX');
    const replacement = new FakeImapServer({ idle: true });
    replacement.addFolder('INBOX');
    await replacement.connect({} as any);
    const stopIdles = client.callCount('stopIdle');

    realtime.initialize({ client: replacement as any, storage: storage as any });

    expect(client.callCount('stopIdle')).toBe(stopIdles + 1);
  });

  it('re-arms polling with the new interval when the config changes', async () => {
    const { realtime, processor } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    processor.syncFlags.mockClear();

    realtime.setConfig({ pollingIntervalMs: 5_000, minPollIntervalMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    const afterRestart = processor.syncFlags.mock.calls.length; // setConfig re-polls once
    await vi.advanceTimersByTimeAsync(5_000);

    expect(processor.syncFlags.mock.calls.length).toBe(afterRestart + 1);
  });

  it('leaves an IDLE session alone when the config changes', async () => {
    const { realtime, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();

    realtime.setConfig({ pollingIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(processor.syncFlags).not.toHaveBeenCalled(); // no polling was started
    expect(realtime.getMode()).toBe('idle');
  });

  // The IDLE-poll syncFlags must not revert local flag changes that haven't been
  // pushed to the server yet.
  it('forwards the pending-flag-op provider to the message processor', async () => {
    const { realtime, processor } = await makeRealtime();
    const provider = vi.fn(async () => new Set<number>([1]));

    realtime.setPendingUidsProvider(provider);

    expect(processor.setPendingUidsProvider).toHaveBeenCalledWith(provider);
  });

  it('reports a failed polling restart instead of leaving a floating rejection', async () => {
    const { realtime } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    (realtime as any).startPolling = vi.fn(async () => { throw new Error('SELECT failed'); });

    expect(() => realtime.setConfig({ pollingIntervalMs: 1_000 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
  });
});

// Every async continuation captures the session's epoch and bails when it no
// longer matches. Without that, work in flight during a reconnect resumed
// against the NEW session: re-arming timers stop() had just cleared (the
// overnight timer accumulation) and issuing a SELECT on the freshly-armed IDLE
// connection. These drive each resume point directly.
describe('RealtimeManager — epoch guards on superseded work', () => {
  /** Simulate "a teardown happened while this await was pending". */
  const supersede = (realtime: RealtimeManager) => { (realtime as any).epoch++; };

  it('startInternal refuses to run without dependencies', async () => {
    const { realtime } = await makeRealtime();
    (realtime as any).client = null;

    await expect((realtime as any).startInternal('INBOX')).rejects.toThrow('not initialized');
  });

  it('does not leave IDLE attached when the session is superseded while it comes up', async () => {
    const { realtime, client } = await makeRealtime();
    vi.spyOn(client, 'startIdle').mockImplementationOnce(async () => { supersede(realtime); });

    expect(await (realtime as any).startInternal('INBOX')).toBe('none');
    expect(client.callCount('stopIdle')).toBeGreaterThanOrEqual(1);
    expect(realtime.getMode()).toBe('none');
  });

  it('does not leave polling running when the session is superseded during its first poll', async () => {
    const { realtime, storage } = await makeRealtime({ idle: false });
    storage.getFolderByPath.mockImplementationOnce(async () => { supersede(realtime); return null; });

    expect(await (realtime as any).startInternal('INBOX')).toBe('none');
    expect(realtime.getMode()).toBe('none');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(storage.getFolderByPath).toHaveBeenCalledTimes(1); // no polling loop survived
  });

  it('abandons a superseded IDLE start before falling back to polling', async () => {
    const { realtime, client } = await makeRealtime();
    vi.spyOn(client, 'selectFolder').mockImplementationOnce(async () => {
      supersede(realtime);
      throw new Error('Connection not available');
    });

    expect(await (realtime as any).startInternal('INBOX')).toBe('none');
  });

  it('stops handling new mail on a client the session no longer owns', async () => {
    const { realtime, client, processor } = await makeRealtime();
    client.addMessage('INBOX', { subject: 'stale' });
    await realtime.start('INBOX');
    vi.spyOn(client, 'selectFolder').mockImplementationOnce(async (path: string) => {
      supersede(realtime);
      return { path, exists: 1, uidNext: 2, uidValidity: 1, unseen: 0 } as any;
    });

    await (realtime as any).handleNewMessages();

    expect(processor.processBatch).not.toHaveBeenCalled();
  });

  it('stops a superseded flag reconcile before it can SELECT on the new session', async () => {
    const { realtime, client, storage, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await vi.advanceTimersByTimeAsync(1500);
    processor.syncFlags.mockClear();
    const selects = client.callCount('selectFolder');
    storage.getFolderByPath.mockImplementationOnce(async () => { supersede(realtime); return storage.folder; });

    await (realtime as any).syncMonitoredFolderFlags();

    expect(processor.syncFlags).not.toHaveBeenCalled();
    expect(client.callCount('selectFolder')).toBe(selects);
  });

  it('drops a superseded expunge before it emits into the new session', async () => {
    const { realtime, storage, events } = await makeRealtime();
    storage.getEmailByFolderAndUid.mockResolvedValue({ id: 'e1' });
    await realtime.start('INBOX');
    storage.unlinkOrDeleteEmailsFromFolder.mockImplementationOnce(async () => {
      supersede(realtime);
      return { unlinked: 0, deleted: 1 };
    });

    await (realtime as any).handleExpunge(5);

    expect(events.filter((e) => e.type === 'deleted')).toEqual([]);
  });

  it('skips a periodic tick that belongs to a previous session', async () => {
    const { realtime, onSyncRequest } = await makeRealtime();
    await realtime.start('INBOX');
    supersede(realtime); // e.g. a reconnect tore the session down mid-backoff

    await vi.advanceTimersByTimeAsync(120_000);

    expect(onSyncRequest).not.toHaveBeenCalled();
  });
});

describe('RealtimeManager — remaining edge paths', () => {
  it('processes an oversized new-mail batch in full rather than truncating it', async () => {
    // Truncating while still advancing lastSyncUid permanently skipped those mails.
    const { realtime, client, processor, storage } = await makeRealtime({ config: { maxNewMessagesBatch: 1 } });
    client.addMessage('INBOX', { subject: 'a' });
    client.addMessage('INBOX', { subject: 'b' });
    processor.processBatch.mockResolvedValueOnce({ ...EMPTY_BATCH, inserted: 2, insertedIds: ['e1', 'e2'] });
    await realtime.start('INBOX');

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(processor.processBatch.mock.calls[0][0]).toHaveLength(2);
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { lastSyncUid: 2 });
  });

  it('does not rewind lastSyncUid when the fetched mail is older than the stored floor', async () => {
    const { realtime, client, storage, processor } = await makeRealtime({
      folder: { id: 'f1', path: 'INBOX', lastSyncUid: 100 },
    });
    client.addMessage('INBOX', { uid: 5, subject: 'old' });
    vi.spyOn(client, 'getNewMessages').mockResolvedValueOnce([{ uid: 5 } as any]);
    processor.processBatch.mockResolvedValueOnce({ ...EMPTY_BATCH });
    await realtime.start('INBOX');
    storage.updateFolder.mockClear();

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.updateFolder).not.toHaveBeenCalled();
  });

  // Unlink-or-delete, not a blind delete: a row that still belongs to another
  // folder (a webmail move BACK, or a Gmail label) must survive.
  it('reports an expunged row that is kept in another folder as unlinked', async () => {
    const { realtime, storage, events } = await makeRealtime();
    storage.getEmailByFolderAndUid.mockResolvedValue({ id: 'e1' });
    storage.unlinkOrDeleteEmailsFromFolder.mockResolvedValue({ unlinked: 1, deleted: 0 });
    await realtime.start('INBOX');

    await (realtime as any).handleExpunge(9);

    expect(events).toContainEqual({ type: 'deleted', folderPath: 'INBOX', emailId: 'e1', uid: 9 });
  });

  it('still emits the deletion when the post-expunge recount fails', async () => {
    const { realtime, storage, events } = await makeRealtime();
    storage.getEmailByFolderAndUid.mockResolvedValue({ id: 'e1' });
    storage.recalculateFolderCounts.mockRejectedValue(new Error('db busy'));
    await realtime.start('INBOX');

    await (realtime as any).handleExpunge(9);

    expect(events.some((e) => e.type === 'deleted' && e.emailId === 'e1')).toBe(true);
  });

  it('emits per-email flag and deletion events found by a POLL reconcile', async () => {
    const { realtime, processor, events } = await makeRealtime({ idle: false });
    processor.syncFlags.mockImplementation(async (...args: any[]) => {
      args[3]?.('e1', 21, ['\\Flagged']);
      args[4]?.('e2', 22);
      return { updated: 1, deleted: 1 };
    });

    await realtime.start('INBOX');

    expect(events).toContainEqual({ type: 'flagsChanged', folderPath: 'INBOX', emailId: 'e1', uid: 21, flags: ['\\Flagged'] });
    expect(events).toContainEqual({ type: 'deleted', folderPath: 'INBOX', emailId: 'e2', uid: 22 });
  });

  it('does not let a failing source-folder reconcile break the IDLE handler', async () => {
    const { realtime, client, processor, onSyncRequest, newMessages } = await makeRealtime();
    client.addMessage('INBOX', { subject: 'moved back' });
    processor.processBatch.mockResolvedValueOnce({
      ...EMPTY_BATCH, inserted: 1, insertedIds: ['e1'], relinkedFromFolders: ['Trash'],
    });
    await realtime.start('INBOX');
    onSyncRequest.mockRejectedValueOnce(new Error('Trash sync failed'));

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(newMessages).toEqual([[1, 'INBOX']]); // the new mail still landed
    expect(realtime.getMode()).toBe('idle');
  });

  it('a poll on a stopped manager is a no-op', async () => {
    const { realtime, storage } = await makeRealtime({ idle: false });
    await realtime.start('INBOX');
    await realtime.stop();
    storage.getFolderByPath.mockClear();

    await (realtime as any).poll();

    expect(storage.getFolderByPath).not.toHaveBeenCalled();
  });

  it('stopIdle is safe with no client and swallows a failing detach', async () => {
    const { realtime, client } = await makeRealtime();
    await realtime.start('INBOX');
    vi.spyOn(client, 'stopIdle').mockRejectedValueOnce(new Error('dead socket'));
    await expect((realtime as any).stopIdle()).resolves.toBeUndefined();

    (realtime as any).client = null;
    await expect((realtime as any).stopIdle()).resolves.toBeUndefined();
  });

  it('keeps the IDLE loop alive when an event handler itself rejects', async () => {
    const { realtime, client, errors } = await makeRealtime();
    await realtime.start('INBOX');
    (realtime as any).handleNewMessages = vi.fn(async () => { throw new Error('handler exploded'); });

    client.emitIdle({ type: 'new' } as any);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors.map((e) => e.message)).toEqual(['handler exploded']);
    expect(realtime.getMode()).toBe('idle');
  });

  it('ignores an IDLE event that arrives after the folder was released', async () => {
    const { realtime, client, processor } = await makeRealtime();
    await realtime.start('INBOX');
    await realtime.stop();
    processor.syncFlags.mockClear();

    client.emitIdle({ type: 'update' } as any); // late push on a detached loop
    await vi.advanceTimersByTimeAsync(5000);

    expect(processor.syncFlags).not.toHaveBeenCalled();
  });
});
