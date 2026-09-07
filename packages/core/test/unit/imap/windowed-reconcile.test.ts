import { describe, it, expect, vi } from 'vitest';

import { LARGE_MAILBOX_THRESHOLD } from '../../../src/config/sync';

import { MessageProcessor } from '../../../src/imap/message-processor';

// Safety tests for the Phase-1 windowed flag reconcile in syncFlags. The bug this
// guards: on a huge mailbox the whole-mailbox `UID SEARCH ALL` / `FETCH 1:*`
// returns PARTIAL lists / times out, which drove wrong labels and risked mass
// "deletion" of local rows. On a large mailbox syncFlags MUST window (SEARCH
// SINCE) and MUST NOT run whole-folder deletion. All mocks — no network/DB.

function makeClient(over: Record<string, any> = {}) {
  return {
    supportsCondstore: () => false,
    getCurrentMailboxState: () => ({ path: 'INBOX', exists: 100 }),
    fetchAllFlags: vi.fn(async () => [] as any[]),
    fetchAllUIDs: vi.fn(async () => [] as number[]),
    fetchUidsSince: vi.fn(async () => [] as number[]),
    fetchFlagsOnly: vi.fn(async () => [] as any[]),
    ...over,
  };
}

function makeStorage(rows: Array<{ id: string; uid: number; tags: string }>) {
  return {
    getEmailTagsInFolder: vi.fn(async () => rows),
    getEmailUidsInFolder: vi.fn(async () => rows.map((r) => ({ id: r.id, uid: r.uid }))),
    bulkUpdateTags: vi.fn(async () => {}),
    updateFolder: vi.fn(async () => {}),
    deleteEmails: vi.fn(async () => {}),
    unlinkOrDeleteEmailsFromFolder: vi.fn(async () => ({ unlinked: 0, deleted: 0 })),
  };
}

const folder = { id: 'f1', path: 'INBOX', highestModseq: null, uidValidity: 1 } as any;
const LARGE = LARGE_MAILBOX_THRESHOLD + 1;

describe('syncFlags — large-mailbox windowed reconcile (Phase 1 safety)', () => {
  it('LARGE mailbox: windows (SEARCH SINCE) and NEVER enumerates the whole mailbox or deletes', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [9999]),
      fetchFlagsOnly: vi.fn(async () => [{ uid: 9999, flags: [] }]),
    });
    // Local rows include OLD mail (uid 5) that is NOT in the windowed server set —
    // a whole-mailbox diff would have "deleted" it. The windowed path must not.
    const storage = makeStorage([{ id: 'old', uid: 5, tags: '|INBOX|' }, { id: 'new', uid: 9999, tags: '|INBOX|' }]);

    const res = await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, undefined);

    expect(client.fetchUidsSince).toHaveBeenCalledTimes(1);   // windowed enumeration
    expect(client.fetchAllUIDs).not.toHaveBeenCalled();       // NO whole-mailbox SEARCH ALL
    expect(client.fetchAllFlags).not.toHaveBeenCalled();      // NO whole-mailbox FETCH 1:*
    expect(storage.deleteEmails).not.toHaveBeenCalled();      // deletion deferred, never fires
    expect(res.deleted).toBe(0);
  });

  it('SMALL mailbox: keeps the proven whole-mailbox path (no windowing)', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: 100 }),
      fetchAllFlags: vi.fn(async () => [{ uid: 9999, flags: [] }]),
    });
    const storage = makeStorage([{ id: 'a', uid: 9999, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, undefined);

    expect(client.fetchAllFlags).toHaveBeenCalledTimes(1);    // whole-mailbox path
    expect(client.fetchUidsSince).not.toHaveBeenCalled();     // not windowed
  });

  // The background pass DOES enumerate the whole mailbox (that's its job) — but
  // with BOUNDED commands. The unbounded `FETCH 1:*` streams one line per message
  // under a single 60s op timeout, and a timed-out IMAP command stays in-flight,
  // so every command queued behind it times out too — including IDLE:
  //   IMAP FETCH flags timed out after 60000ms — recycling the wedged connection
  //   Realtime: Failed to start IDLE: Connection not available
  // That is what took a 23,343-message INBOX off live mail. SEARCH ALL still
  // yields the COMPLETE uid set (so Phase-2 completeness is unchanged) and the
  // flags come in 500-uid batches, where a slow batch fails alone.
  it('LARGE mailbox with fullReconcile: whole-mailbox path via BOUNDED commands, never FETCH 1:*', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchAllFlags: vi.fn(async () => [{ uid: 9999, flags: [] }]),
      fetchAllUIDs: vi.fn(async () => [9999]),
      fetchFlagsOnly: vi.fn(async () => [{ uid: 9999, flags: [] }]),
    });
    const storage = makeStorage([{ id: 'a', uid: 9999, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, { fullReconcile: true });

    expect(client.fetchAllFlags).not.toHaveBeenCalled();      // the wedge, never issued
    expect(client.fetchAllUIDs).toHaveBeenCalledTimes(1);     // complete uid set, cheaply
    expect(client.fetchFlagsOnly).toHaveBeenCalledTimes(1);   // flags in bounded batches
    expect(client.fetchUidsSince).not.toHaveBeenCalled();     // full reconcile bypasses windowing
    // Nothing is "missing" from the server, so no row is touched.
    expect(storage.unlinkOrDeleteEmailsFromFolder).not.toHaveBeenCalled();
  });

  // A SMALL mailbox keeps the proven single-command path — the bounded route is
  // more round-trips, and only worth it where the unbounded one is dangerous.
  it('SMALL mailbox with fullReconcile: still uses the single FETCH 1:*', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: 100 }),
      fetchAllFlags: vi.fn(async () => [{ uid: 9999, flags: [] }]),
    });
    const storage = makeStorage([{ id: 'a', uid: 9999, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, { fullReconcile: true });

    expect(client.fetchAllFlags).toHaveBeenCalledTimes(1);
    expect(client.fetchAllUIDs).not.toHaveBeenCalled();
  });

  // Fallback safety: a client with no SEARCH ALL support must not be left with no
  // reconcile at all — it falls back to the unbounded fetch rather than nothing.
  it('LARGE mailbox on a client without fetchAllUIDs falls back to FETCH 1:*', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchAllFlags: vi.fn(async () => [{ uid: 9999, flags: [] }]),
    });
    delete (client as { fetchAllUIDs?: unknown }).fetchAllUIDs;
    const storage = makeStorage([{ id: 'a', uid: 9999, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, { fullReconcile: true });

    expect(client.fetchAllFlags).toHaveBeenCalledTimes(1);
  });
});

// ── Phase 2 on a large mailbox: additions run, deletions still never do ──────
//
// The tests above prove the windowed path is SAFE. These prove it is not also
// INERT. A large mailbox never produces a whole-folder server list, so Phase 2
// used to return early for both halves of its job at once — and the addition
// half is the only thing that repairs mail which never landed locally. Live
// result: a Gmail INBOX logging `Phase-2 deletion SKIPPED` on 258 consecutive
// syncs while 144 messages the server held were never fetched, with no path
// back (the forward sync was gated, and the backfill only pages BELOW the
// oldest local UID, so it cannot fill a hole above it).
//
// The window is a COMPLETE server list for its date range. That makes it
// authoritative for "this UID exists and we don't have it" and useless for
// "this UID is gone" — the asymmetry every test here turns on.
describe('syncFlags — large-mailbox addition reconcile (Phase 2)', () => {
  // A folder that HAS synced: additions only ever consider UIDs at or below the
  // watermark, since anything above it is live mail the forward sync will fetch.
  const synced = { ...folder, lastSyncUid: 500 } as any;

  it('fetches a windowed UID that never landed locally', async () => {
    // THE REGRESSION. Mail the server holds and we don't, inside the window and
    // below the watermark, is exactly the 144-message gap. If this stops firing,
    // the gap has no repair path at all and the folder is short forever.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [100, 200, 300]),
      fetchFlagsOnly: vi.fn(async () => [{ uid: 100, flags: [] }, { uid: 300, flags: [] }]),
      fetchMessagesByUID,
    });
    // We hold 100 and 300; 200 is the hole.
    const storage = makeStorage([{ id: 'a', uid: 100, tags: '|INBOX|' }, { id: 'b', uid: 300, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, undefined);

    expect(fetchMessagesByUID).toHaveBeenCalledTimes(1);
    expect(fetchMessagesByUID.mock.calls[0][0]).toEqual([200]);
  });

  it('still never deletes on the windowed path', async () => {
    // The reason the window was banned from Phase 2 in the first place. Every
    // message older than the cutoff is legitimately absent from the window, so a
    // deletion diff against it would wipe the entire back catalogue. Enabling
    // additions must not have re-opened that door by accident.
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [300]),
      fetchFlagsOnly: vi.fn(async () => [{ uid: 300, flags: [] }]),
      fetchMessagesByUID: vi.fn(async () => [] as any[]),
    });
    // uid 7 is years old — outside the window, so absent from the server list.
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }, { id: 'new', uid: 300, tags: '|INBOX|' }]);

    const res = await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, undefined);

    expect(storage.deleteEmails).not.toHaveBeenCalled();
    expect(storage.unlinkOrDeleteEmailsFromFolder).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
  });

  it('ignores UIDs above the watermark — those are the forward sync\'s job', async () => {
    // Claiming new mail here would insert it with `quiet: true`, which suppresses
    // the notification, the live list update, the AI pass and the body prefetch.
    // The mail would appear later with no sign it had arrived.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [400, 900]), // 900 is above the watermark
      fetchFlagsOnly: vi.fn(async () => [{ uid: 400, flags: [] }]),
      fetchMessagesByUID,
    });
    const storage = makeStorage([{ id: 'a', uid: 400, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, undefined);

    expect(fetchMessagesByUID).not.toHaveBeenCalled();
  });

  it('a folder with no rows of its own (Gmail label mirror) does NOT run additions', async () => {
    // A pure label mirror holds every message primarily in All Mail, so it has no
    // rows in its own folder_id UID space and EVERY windowed UID looks missing.
    // Without this bound it would re-fetch and re-link the same window on every
    // sync, forever, and never converge. All Mail's own reconcile covers it.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [100, 200]),
      fetchFlagsOnly: vi.fn(async () => []),
      fetchMessagesByUID,
    });
    const storage = makeStorage([]); // no rows in this folder's own UID space

    await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, undefined);

    expect(fetchMessagesByUID).not.toHaveBeenCalled();
  });

  it('skipDeletion still skips the whole of Phase 2, additions included', async () => {
    // Callers pass skipDeletion when they know their view of the server is not
    // trustworthy enough to act on. Additions are a write too — they must obey it.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [100, 200]),
      fetchFlagsOnly: vi.fn(async () => [{ uid: 100, flags: [] }]),
      fetchMessagesByUID,
    });
    const storage = makeStorage([{ id: 'a', uid: 100, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, { skipDeletion: true });

    expect(fetchMessagesByUID).not.toHaveBeenCalled();
    expect(storage.deleteEmails).not.toHaveBeenCalled();
  });

  it('a never-synced folder (no watermark) reconciles nothing', async () => {
    // Watermark 0 means the initial sync has not finished, so "we don't have it"
    // is expected for everything. Fetching here would race the initial sync and
    // insert its mail quietly.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [100, 200]),
      fetchFlagsOnly: vi.fn(async () => [{ uid: 100, flags: [] }]),
      fetchMessagesByUID,
    });
    const storage = makeStorage([{ id: 'a', uid: 100, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, undefined);

    expect(fetchMessagesByUID).not.toHaveBeenCalled();
  });

  it('an empty window is not read as "everything is missing"', async () => {
    // A quiet 30 days returns zero UIDs. The diff must produce nothing, not treat
    // the empty set as evidence about the mail we already hold.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [] as number[]),
      fetchMessagesByUID,
    });
    const storage = makeStorage([{ id: 'a', uid: 100, tags: '|INBOX|' }]);

    const res = await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, undefined);

    expect(fetchMessagesByUID).not.toHaveBeenCalled();
    expect(storage.deleteEmails).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
  });

  it('a small mailbox keeps the whole-folder addition source, not the window', async () => {
    // Regression guard on the branch itself: the window is a FALLBACK. Where a
    // complete server list exists it must stay authoritative, or a small mailbox
    // would silently lose its deletion reconcile too.
    const mp = new MessageProcessor();
    const fetchMessagesByUID = vi.fn(async () => [] as any[]);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: 3 }),
      fetchAllFlags: vi.fn(async () => [
        { uid: 100, flags: [] }, { uid: 200, flags: [] }, { uid: 300, flags: [] },
      ]),
      fetchMessagesByUID,
    });
    const storage = makeStorage([{ id: 'a', uid: 100, tags: '|INBOX|' }, { id: 'c', uid: 300, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, synced, storage as any, undefined, undefined, undefined);

    expect(client.fetchUidsSince).not.toHaveBeenCalled();
    expect(fetchMessagesByUID.mock.calls[0][0]).toEqual([200]);
  });
});

// ── The stale-flag sweep: the only flag reconcile old mail on a big folder gets ──
//
// Windowing fixed the wedge and created this hole. Everything older than the
// window kept the flags it had when it was first downloaded, because the
// whole-mailbox re-read that used to correct it is exactly the command that timed
// out and poisoned the connection — and the "background backfill will do it"
// deferral never completed on a big Gmail folder either. Live result: an INBOX
// badge of 5 whose five rows (May, July, August) were all already read on the
// server, and no amount of syncing would ever fix them.
//
// `selectStaleFlagCandidates` is unit-tested on its own; these prove it is wired,
// bounded, and that the flags it fetches actually reach the local row.
describe('syncFlags — stale-flag sweep for old mail outside the window', () => {
  // Each test needs its OWN folder id: the sweep throttle is a module-level map
  // keyed by folder.id, so sharing one would let the first test suppress the rest.
  const bigFolder = (id: string) =>
    ({ id, path: 'INBOX', highestModseq: null, uidValidity: 1, lastSyncUid: 500 }) as any;

  /** Serves flags per requested UID so the windowed read and the sweep can differ. */
  const flagsFor = (table: Record<number, string[]>) =>
    vi.fn(async (uids: number[]) => uids.filter((u) => u in table).map((u) => ({ uid: u, flags: table[u] })));

  it('corrects an old row we still show as unread', async () => {
    // THE REGRESSION, end to end. uid 7 is outside the 30-day window, unread
    // locally, and read on the server. If this stops working the badge keeps
    // counting mail the user dealt with months ago, forever.
    const mp = new MessageProcessor();
    const fetchFlagsOnly = flagsFor({ 300: ['\\Seen'], 7: ['\\Seen'] });
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => [300]),
      fetchFlagsOnly,
    });
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }, { id: 'new', uid: 300, tags: '|INBOX|read|' }]);

    const res = await mp.syncFlags(client as any, bigFolder('stale-1'), storage as any, undefined, undefined, undefined);

    // The sweep asked for the old uid — the window never would have.
    expect(fetchFlagsOnly.mock.calls.some((c) => c[0].includes(7))).toBe(true);
    // And the row is now read locally.
    expect(storage.bulkUpdateTags).toHaveBeenCalledWith([{ id: 'old', tags: '|INBOX|read|' }]);
    expect(res.updated).toBe(1);
  });

  it('never touches a row with an un-synced local change', async () => {
    // The server has not seen the local flag change yet, so applying its view here
    // would revert the user's own action — read springing back to unread.
    const mp = new MessageProcessor();
    mp.setPendingUidsProvider(async () => new Set([7]));
    const fetchFlagsOnly = flagsFor({ 7: ['\\Seen'] });
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => []),
      fetchFlagsOnly,
    });
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, bigFolder('stale-2'), storage as any, undefined, undefined, undefined);

    expect(fetchFlagsOnly).not.toHaveBeenCalled();
    expect(storage.bulkUpdateTags).not.toHaveBeenCalled();
  });

  it('is throttled — a second sync in the same interval does not re-sweep', async () => {
    // The sweep costs an extra IMAP command per folder. The non-CONDSTORE windowed
    // path re-reads its window on EVERY sync, so an unthrottled sweep would issue
    // that command every sync on exactly the accounts whose connection budget is
    // tightest — the failure mode this whole area is trying to stay clear of.
    const mp = new MessageProcessor();
    const fetchFlagsOnly = flagsFor({ 7: [] });
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => []),
      fetchFlagsOnly,
    });
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }]);
    const folderId = bigFolder('stale-3');

    await mp.syncFlags(client as any, folderId, storage as any, undefined, undefined, undefined);
    await mp.syncFlags(client as any, folderId, storage as any, undefined, undefined, undefined);

    expect(fetchFlagsOnly).toHaveBeenCalledTimes(1);
  });

  it('survives a failed sweep without touching local flags', async () => {
    // A blip on the flag fetch must leave local state exactly as it was — the
    // transient-vs-permanent split. Nothing is marked checked either, so the same
    // UIDs are retried rather than suppressed for the session on one bad response.
    const mp = new MessageProcessor();
    const fetchFlagsOnly = vi.fn(async () => { throw new Error('connection reset'); });
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => []),
      fetchFlagsOnly,
    });
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }]);

    const res = await mp.syncFlags(client as any, bigFolder('stale-4'), storage as any, undefined, undefined, undefined);

    expect(storage.bulkUpdateTags).not.toHaveBeenCalled();
    expect(storage.deleteEmails).not.toHaveBeenCalled();
    expect(res.updated).toBe(0);
  });

  it('does not run on a small mailbox — the whole-folder path already covers it', async () => {
    // Below the threshold every UID's flags are re-read anyway. Sweeping there
    // would be a second, redundant FLAGS command on every folder of every account.
    const mp = new MessageProcessor();
    const fetchFlagsOnly = vi.fn(async () => []);
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: 100 }),
      fetchAllFlags: vi.fn(async () => [{ uid: 7, flags: ['\\Seen'] }]),
      fetchFlagsOnly,
    });
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, bigFolder('stale-5'), storage as any, undefined, undefined, undefined);

    expect(client.fetchUidsSince).not.toHaveBeenCalled();
    expect(fetchFlagsOnly).not.toHaveBeenCalled();
    // The whole-folder path still corrected the row.
    expect(storage.bulkUpdateTags).toHaveBeenCalledWith([{ id: 'old', tags: '|INBOX|read|' }]);
  });

  it('still never deletes — the sweep reads flags and nothing else', async () => {
    // A UID the server does not return is a DELETION, and a windowed pass has no
    // authority to act on one. If a missing UID ever started removing rows here,
    // the sweep would quietly wipe the back catalogue it was written to protect.
    const mp = new MessageProcessor();
    const client = makeClient({
      getCurrentMailboxState: () => ({ path: 'INBOX', exists: LARGE }),
      fetchUidsSince: vi.fn(async () => []),
      fetchFlagsOnly: vi.fn(async () => []), // server returns nothing for the swept uids
    });
    const storage = makeStorage([{ id: 'old', uid: 7, tags: '|INBOX|' }]);

    const res = await mp.syncFlags(client as any, bigFolder('stale-6'), storage as any, undefined, undefined, undefined);

    expect(storage.deleteEmails).not.toHaveBeenCalled();
    expect(storage.unlinkOrDeleteEmailsFromFolder).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
  });
});
