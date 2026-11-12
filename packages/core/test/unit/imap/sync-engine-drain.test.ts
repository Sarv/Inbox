import { describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';


// Regression for the "Gmail stuck at ~8.6k, never finishes" strand in the DRAIN.
//
// The drain is oldest-first and, on a Gmail All-Mail superset, the oldest UIDs are
// messages that already exist locally under another folder (primary = Archive/label,
// tagged here) — folder_id-"missing" but real no-ops. The old drain fetched the
// oldest 300, counted those relinks as "progress" (remaining = genuinelyMissing −
// (inserted+linked)), computed remaining 0, returned `done`, and the scheduler
// skipped the folder for the whole session — so the genuinely-missing NEWER holes
// never downloaded. The fix: a per-folder tried-set + `done` derived from UNTRIED
// candidates, so the drain advances through to the real gaps.

const INBOX = 'INBOX';

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer({ qresync: true, condstore: true });
  server.addFolder(INBOX, { uidValidity: 1 });
  const db = new FakeEmailStorage();
  db.addFolder(INBOX, { uidValidity: 1 });
  db.addFolder('Archive', { uidValidity: 1 });
  const engine = new SyncEngine(db.asStorage());
  vi.spyOn(engine, 'isConnected').mockReturnValue(true);
  (engine as unknown as { isSyncing: () => boolean }).isSyncing = () => false;
  (engine as unknown as { connectionManager: { _client: unknown } }).connectionManager._client = server;
  (engine as unknown as { reselectMonitoredFolder: () => Promise<void> }).reselectMonitoredFolder = async () => {};
  return { server, db, engine };
}

describe('SyncEngine.drainFolderChunk — converges past cross-folder no-ops', () => {
  it('drains untried candidates across calls to reach the genuinely-missing (no premature done)', async () => {
    const { server, db, engine } = setup();
    // 400 server messages. uid 1..300 already exist locally (primary Archive, tagged
    // INBOX) → oldest-first NO-OPS. uid 301..400 are genuinely missing.
    for (let i = 1; i <= 400; i++) server.addMessage(INBOX, { uid: i, messageId: `<d${i}@t>` });
    for (let i = 1; i <= 300; i++) {
      db.seedEmail({ folderId: db.folderId('Archive'), uid: i, tags: `|Archive|${INBOX}|`, messageId: `<d${i}@t>` });
    }

    // Call 1: fetches the oldest 300 — all present-by-tag no-ops. NOT done (old bug:
    // counted the relinks as progress and returned done → folder skipped forever).
    const r1 = await engine.drainFolderChunk(INBOX);
    expect(r1).toMatchObject({ inserted: 0, done: false });
    expect(db.rowsPrimaryIn(INBOX)).toHaveLength(0);

    // Call 2: the 300 no-ops are marked tried, so it drains the untried 301..400 and
    // actually downloads them.
    const r2 = await engine.drainFolderChunk(INBOX);
    expect(r2!.inserted).toBe(100);
    expect(r2!.done).toBe(true);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 100 }, (_, k) => k + 301));
  });

  it('does NOT report done while a requested UID was DROPPED from a partial response — retries it', async () => {
    // "0 mistakes": a UID the server dropped from the FETCH response was never
    // downloaded. `done` must stay false so the drain comes back for it instead of
    // the scheduler marking the folder complete and stranding it.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 3; i++) server.addMessage(INBOX, { uid: i, messageId: `<p${i}@t>` });

    const realFetch = server.fetchMessagesByUID.bind(server);
    const spy = vi.spyOn(server, 'fetchMessagesByUID').mockImplementationOnce(async (uids: number[], opts: never) => {
      const all = await realFetch(uids, opts);
      return all.filter((m) => m.uid !== 2); // server drops uid 2
    });

    const r1 = await engine.drainFolderChunk(INBOX);
    expect(r1!.done).toBe(false);            // uid 2 dropped → not done
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 3]);

    spy.mockRestore();
    await engine.drainFolderChunk(INBOX);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 2, 3]); // 2 retried + stored
  });

  it('does NOT mark a transiently-ERRORED UID as tried — retries it next call', async () => {
    // A UID the server returned but that failed to store (transient) must not be
    // suppressed as "downloaded". processBatch reports it in erroredUids; the drain
    // must exclude it from the tried-set and come back for it.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 2; i++) server.addMessage(INBOX, { uid: i, messageId: `<e${i}@t>` });

    const mp = (engine as unknown as { messageProcessor: { processBatch: (...a: unknown[]) => Promise<unknown> } }).messageProcessor;
    const realProcess = mp.processBatch.bind(mp);
    const spy = vi.spyOn(mp, 'processBatch').mockImplementationOnce(async (msgs: any, ...rest: unknown[]) => {
      // uid 1 "transiently errors": store only uid 2, report uid 1 as errored.
      const r = await realProcess(msgs.filter((m: any) => m.uid === 2), ...rest) as { erroredUids: number[] };
      return { ...r, erroredUids: [1] };
    });

    const r1 = await engine.drainFolderChunk(INBOX);
    expect(r1!.done).toBe(false);            // uid 1 errored → unaccounted → not done
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!)).toEqual([2]);

    spy.mockRestore();
    await engine.drainFolderChunk(INBOX);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 2]); // uid 1 retried + stored
  });
});

// The 2026-11-12 incident in the drain. INBOX was ~490 messages short and the
// drain asked for 100 headers at a time; the server took about a second each,
// the fetch was cut, the call returned null with nothing stored and nothing
// logged, and the next tick asked for the same 100. Smaller folders drained
// (their whole gap fitted in one quick fetch) while INBOX never moved.
describe('SyncEngine.drainFolderChunk — a server too slow for the full batch', () => {
  /** A server that cannot complete a header fetch of more than `limit` messages. */
  function limitFetch(server: FakeImapServer, limit: number) {
    const sizes: number[] = [];
    const real = server.fetchMessagesByUID.bind(server);
    vi.spyOn(server, 'fetchMessagesByUID').mockImplementation(async (uids: number[], opts?: never) => {
      sizes.push(uids.length);
      if (uids.length > limit) throw new Error('IMAP FETCH timed out (no data for 30s)');
      return real(uids, opts);
    });
    return sizes;
  }
  const uidsIn = (db: FakeEmailStorage) => db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b);

  // THE regression: the failed batch must not be retried at the same size. If
  // the second call asks for 100 again, the folder is stranded exactly as before.
  it('asks for less after a batch fails, and the next call downloads mail', async () => {
    const { server, db, engine } = setup();
    for (let i = 1; i <= 60; i++) server.addMessage(INBOX, { uid: i, messageId: `<s${i}@t>` });
    const sizes = limitFetch(server, 30);

    expect(await engine.drainFolderChunk(INBOX)).toBeNull();        // 60 at once: cut, nothing stored
    expect(uidsIn(db)).toEqual([]);

    const second = await engine.drainFolderChunk(INBOX);
    expect(sizes.slice(0, 2)).toEqual([60, 25]);                    // a quarter of the 100-message batch
    expect(second!.inserted).toBeGreaterThan(0);
    expect(uidsIn(db).slice(0, 25)).toEqual(Array.from({ length: 25 }, (_, k) => k + 1));
  });

  // Partial/interrupted run: batches stored before the failure are real
  // progress. The call reports them (not null, not done) so the scheduler keeps
  // coming back, and the unfetched UIDs are not marked as tried.
  it('keeps the batches stored before a later batch fails and is not done', async () => {
    const { server, db, engine } = setup();
    for (let i = 1; i <= 250; i++) server.addMessage(INBOX, { uid: i, messageId: `<q${i}@t>` });
    const real = server.fetchMessagesByUID.bind(server);
    let call = 0;
    const spy = vi.spyOn(server, 'fetchMessagesByUID').mockImplementation(async (uids: number[], opts?: never) => {
      if (++call === 2) throw new Error('Connection not available');
      return real(uids, opts);
    });

    const first = await engine.drainFolderChunk(INBOX);
    expect(first).toMatchObject({ inserted: 100, done: false });
    expect(first!.remaining).toBe(150);
    expect(uidsIn(db)).toHaveLength(100);

    // Transient: once the server answers again the rest arrives, with no
    // duplicate rows for the mail that was already stored.
    spy.mockRestore();
    let result = await engine.drainFolderChunk(INBOX);
    for (let guard = 0; guard < 10 && result && !result.done; guard++) result = await engine.drainFolderChunk(INBOX);
    expect(result!.done).toBe(true);
    expect(uidsIn(db)).toEqual(Array.from({ length: 250 }, (_, k) => k + 1));
  });

  // Converges on a server that only ever serves small batches, however many
  // ticks it takes, and never reports done while mail is still missing.
  it('converges across calls on a server that only serves small batches', async () => {
    const { server, db, engine } = setup();
    for (let i = 1; i <= 120; i++) server.addMessage(INBOX, { uid: i, messageId: `<c${i}@t>` });
    limitFetch(server, 30);

    let done = false;
    for (let tick = 0; tick < 40 && !done; tick++) {
      const r = await engine.drainFolderChunk(INBOX);
      if (r) {
        if (r.done) expect(uidsIn(db)).toHaveLength(120);           // done only when nothing is missing
        done = r.done;
      }
    }
    expect(done).toBe(true);
    expect(uidsIn(db)).toEqual(Array.from({ length: 120 }, (_, k) => k + 1));
  });

  // One call must not hold a pooled connection for minutes on a slow server
  // (observed: eight silent minutes for one call). It stops at its time budget,
  // reports what it stored, and is not done, so the scheduler calls again.
  it('stops at its time budget, reports what it stored and leaves the rest for the next call', async () => {
    const { server, db, engine } = setup();
    for (let i = 1; i <= 300; i++) server.addMessage(INBOX, { uid: i, messageId: `<t${i}@t>` });
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const sizes: number[] = [];
    const real = server.fetchMessagesByUID.bind(server);
    vi.spyOn(server, 'fetchMessagesByUID').mockImplementation(async (uids: number[], opts?: never) => {
      sizes.push(uids.length);
      clock += 25_000;                                             // every fetch takes 25s, whatever its size
      return real(uids, opts);
    });

    const first = await engine.drainFolderChunk(INBOX);
    expect(sizes).toEqual([100, 40, 16]);                           // three fetches reach the 60s budget
    expect(first).toMatchObject({ inserted: 156, remaining: 144, done: false });

    const second = await engine.drainFolderChunk(INBOX);
    expect(second!.inserted).toBeGreaterThan(0);                    // continues with mail it had not reached
    expect(uidsIn(db).slice(0, 157)).toEqual(Array.from({ length: 157 }, (_, k) => k + 1));
  });

  // Idempotent re-run: draining a folder that is already complete fetches
  // nothing and stores nothing twice.
  it('does nothing when run again on a folder it already completed', async () => {
    const { server, db, engine } = setup();
    for (let i = 1; i <= 40; i++) server.addMessage(INBOX, { uid: i, messageId: `<i${i}@t>` });
    expect((await engine.drainFolderChunk(INBOX))!.done).toBe(true);
    const spy = vi.spyOn(server, 'fetchMessagesByUID');

    expect(await engine.drainFolderChunk(INBOX)).toMatchObject({ inserted: 0, done: true });
    expect(spy).not.toHaveBeenCalled();
    expect(uidsIn(db)).toHaveLength(40);
  });

  // A permanent refusal keeps failing honestly: null every time (the scheduler
  // retries later), never a faked "done", and the batch stops shrinking at the
  // floor instead of spinning ever smaller.
  it('keeps returning null, never done, while the server refuses every fetch', async () => {
    const { server, db, engine } = setup();
    for (let i = 1; i <= 60; i++) server.addMessage(INBOX, { uid: i, messageId: `<n${i}@t>` });
    const sizes = limitFetch(server, 0);

    for (let tick = 0; tick < 5; tick++) expect(await engine.drainFolderChunk(INBOX)).toBeNull();
    expect(sizes).toEqual([60, 25, 6, 5, 5]);
    expect(uidsIn(db)).toEqual([]);
  });

  // Multi-account, multi-folder: the learned size belongs to one folder of one
  // account's engine. A slow INBOX on one account must not shrink the batches
  // of another folder, or of another account.
  it('keeps the learned batch size to the folder and account it was learned on', async () => {
    const slow = setup();
    slow.server.addFolder('Sent', { uidValidity: 1 });
    slow.db.addFolder('Sent', { uidValidity: 1 });
    for (let i = 1; i <= 60; i++) slow.server.addMessage(INBOX, { uid: i, messageId: `<a${i}@t>` });
    for (let i = 1; i <= 60; i++) slow.server.addMessage('Sent', { uid: i, messageId: `<b${i}@t>` });
    const real = slow.server.fetchMessagesByUID.bind(slow.server);
    let failInbox = true;
    const sizes: number[] = [];
    vi.spyOn(slow.server, 'fetchMessagesByUID').mockImplementation(async (uids: number[], opts?: never) => {
      sizes.push(uids.length);
      if (failInbox) { failInbox = false; throw new Error('IMAP FETCH timed out (no data for 30s)'); }
      return real(uids, opts);
    });
    expect(await slow.engine.drainFolderChunk(INBOX)).toBeNull();
    expect((await slow.engine.drainFolderChunk('Sent'))!.inserted).toBe(60);
    expect(sizes).toEqual([60, 60]);                                // Sent was asked for everything at once

    const other = setup();
    for (let i = 1; i <= 60; i++) other.server.addMessage(INBOX, { uid: i, messageId: `<o${i}@t>` });
    const spy = vi.spyOn(other.server, 'fetchMessagesByUID');
    expect((await other.engine.drainFolderChunk(INBOX))!.inserted).toBe(60);
    expect(spy.mock.calls.map(([uids]) => (uids as number[]).length)).toEqual([60]);
  });
});
