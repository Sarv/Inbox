import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LARGE_MAILBOX_THRESHOLD } from '../../../src/config/sync';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IEmailStorage } from '../../../src/types/storage';

import { MessageProcessor } from '../../../src/imap/message-processor';

// syncFlags is where "server state wins" is decided, and it is the single most
// dangerous function in the sync: it MATCHES SERVER STATE TO LOCAL ROWS BY UID
// NUMBER and then rewrites flags / deletes rows on that basis. Every historical
// data-loss bug in this app came from doing that against an untrustworthy or
// wrong-mailbox server view. So the tests here are mostly about REFUSING to act:
//
//   Phase 1 (flags)    — apply only to the UID it belongs to, in the right folder,
//                        never over a pending local change, never over a snoozed
//                        row's read state, never touching non-flag tags.
//   Phase 2 (deletion) — remove a local row ONLY when the server UID list is
//                        PROVABLY complete. A failed, truncated or empty
//                        enumeration must delete nothing; a message that also
//                        lives in another folder is UNLINKED, not destroyed.
//
// Existing siblings cover the UIDVALIDITY bail (uidvalidity-safety.test.ts) and
// the large-mailbox windowed reconcile (windowed-reconcile.test.ts); this file
// deliberately does not repeat them.
//
// Determinism: syncFlags keeps module-global reconcile throttles keyed by
// folder.id, so every setup() gets a FRESH folder id — no test can inherit
// another's throttle. Nothing here depends on the wall clock otherwise.

const INBOX = 'INBOX';
let folderSeq = 0;

interface Ctx {
  server: FakeImapServer;
  db: FakeEmailStorage;
  mp: MessageProcessor;
  /** The live folder record (syncFlags mutates it through updateFolder). */
  folder: () => ReturnType<FakeEmailStorage['folder']>;
  storage: IEmailStorage;
}

function setup(options: { condstore?: boolean } = {}): Ctx {
  resetFakeMessageIds();
  resetFakeStorageIds();
  folderSeq += 1;
  const server = new FakeImapServer({ condstore: options.condstore ?? false });
  const db = new FakeEmailStorage();
  for (const path of [INBOX, 'Archive', 'Trash']) {
    server.addFolder(path, { uidValidity: 1 });
    db.addFolder(path, { id: `f-${path}-${folderSeq}`, uidValidity: 1 });
  }
  return {
    server,
    db,
    mp: new MessageProcessor(),
    folder: () => db.folder(INBOX),
    storage: db.asStorage(),
  };
}

/** Put a message on the server AND a matching local row at the same UID. */
function seedSynced(ctx: Ctx, flags: string[] = [], tags: string[] = []): number {
  const uid = ctx.server.addMessage(INBOX, { flags });
  ctx.db.seedEmail({
    folderId: ctx.db.folderId(INBOX),
    uid,
    tags: `|${[INBOX, ...tags].join('|')}|`,
  });
  return uid;
}

const tagsAt = (ctx: Ctx, uid: number): string[] => {
  const row = ctx.db.rowsPrimaryIn(INBOX).find((e) => e.uid === uid);
  return row ? ctx.db.tagsOf(row.id).sort() : [];
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('syncFlags — Phase 1: server flags win', () => {
  it('applies read / starred / answered / draft / deleted from the server', async () => {
    const ctx = setup();
    const seen = seedSynced(ctx, ['\\Seen']);
    const flagged = seedSynced(ctx, ['\\Flagged']);
    const answered = seedSynced(ctx, ['\\Answered']);
    const draft = seedSynced(ctx, ['\\Draft']);
    const deleted = seedSynced(ctx, ['\\Deleted']);
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(5);
    expect(tagsAt(ctx, seen)).toEqual([INBOX, 'read']);
    expect(tagsAt(ctx, flagged)).toEqual([INBOX, 'starred']);
    expect(tagsAt(ctx, answered)).toEqual([INBOX, 'answered']);
    expect(tagsAt(ctx, draft)).toEqual([INBOX, 'draft']);
    expect(tagsAt(ctx, deleted)).toEqual([INBOX, 'deleted']);
  });

  it('REMOVES a flag tag the server no longer reports (unread-again in webmail)', async () => {
    const ctx = setup();
    const uid = seedSynced(ctx, [], ['read', 'starred']);
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(1);
    expect(tagsAt(ctx, uid)).toEqual([INBOX]);
  });

  it('never disturbs NON-flag tags (folder membership, AI category slugs)', async () => {
    // The reconcile rebuilds the flag part of the tag string; a category slug or a
    // second folder's membership living in the same string must survive untouched.
    const ctx = setup();
    const uid = seedSynced(ctx, ['\\Seen'], ['Archive', 'work', 'bulk']);
    await ctx.server.selectFolder(INBOX);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(tagsAt(ctx, uid)).toEqual(['Archive', INBOX, 'bulk', 'read', 'work']);
  });

  it('SKIPS a UID with a pending local flag op (no springing back to unread)', async () => {
    // The server hasn't seen our change yet, so "server wins" would revert it.
    const ctx = setup();
    const pending = seedSynced(ctx, ['\\Seen']);
    const other = seedSynced(ctx, ['\\Seen']);
    ctx.mp.setPendingUidsProvider(async (path) => (path === INBOX ? new Set([pending]) : new Set()));
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(1);
    expect(tagsAt(ctx, pending)).toEqual([INBOX]);        // left alone
    expect(tagsAt(ctx, other)).toEqual([INBOX, 'read']);  // reconciled normally
  });

  it('a flag change for a UID that is NOT local is IGNORED, never mis-applied', async () => {
    // The failure this guards: applying server entry #2's flags to local row #2 by
    // position instead of by UID. Local holds ONE row; the server reports flags for
    // two UIDs, and the one that matches has no flags.
    const ctx = setup();
    const localUid = seedSynced(ctx, []);              // local + server, no flags
    ctx.server.addMessage(INBOX, { flags: ['\\Seen', '\\Flagged'] }); // server only
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(0);
    expect(tagsAt(ctx, localUid)).toEqual([INBOX]);
  });

  it('keeps a SNOOZED row\'s local read state in BOTH directions', async () => {
    // A snoozed mail is deliberately unread-again locally; the server still has it
    // \Seen. Neither side may win over the other or the snooze looks broken.
    const ctx = setup();
    const readLocally = seedSynced(ctx, [], ['snoozed', 'read']);       // server: unread
    const unreadLocally = seedSynced(ctx, ['\\Seen'], ['snoozed']);      // server: read
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(0);
    expect(tagsAt(ctx, readLocally)).toEqual([INBOX, 'read', 'snoozed']);
    expect(tagsAt(ctx, unreadLocally)).toEqual([INBOX, 'snoozed']);
  });

  it('still syncs a snoozed row\'s STAR while holding its read state', async () => {
    const ctx = setup();
    const uid = seedSynced(ctx, ['\\Seen', '\\Flagged'], ['snoozed']);
    await ctx.server.selectFolder(INBOX);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(tagsAt(ctx, uid)).toEqual([INBOX, 'snoozed', 'starred']);
  });

  it('fires onReadChange ONLY on a genuine read flip, not on a star-only change', async () => {
    // onReadChange drives the scan-free unread-count delta; firing it on a star
    // change corrupts the badge, and missing a real flip strands it.
    const ctx = setup();
    const starOnly = seedSynced(ctx, ['\\Flagged']);
    const nowRead = seedSynced(ctx, ['\\Seen']);
    const nowUnread = seedSynced(ctx, [], ['read']);
    await ctx.server.selectFolder(INBOX);
    const flagChanges: number[] = [];
    const readChanges: boolean[] = [];

    await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage,
      (_id, uid) => flagChanges.push(uid),
      undefined, undefined,
      (_id, read) => readChanges.push(read),
    );

    expect(flagChanges.sort()).toEqual([starOnly, nowRead, nowUnread].sort());
    expect(readChanges).toEqual([true, false]); // the star change contributed nothing
  });

  it('leaves everything alone when the flag fetch FAILS outright', async () => {
    const ctx = setup();
    const uid = seedSynced(ctx, ['\\Seen']);
    await ctx.server.selectFolder(INBOX);
    vi.spyOn(ctx.server, 'fetchAllFlags').mockRejectedValue(new Error('Command failed'));
    vi.spyOn(ctx.server, 'fetchAllUIDs').mockRejectedValue(new Error('Command failed'));

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res).toEqual({ updated: 0, deleted: 0 });
    expect(tagsAt(ctx, uid)).toEqual([INBOX]);
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
  });

  it('rescues a server that REJECTS `FETCH 1:*` via SEARCH ALL + batched flags', async () => {
    // imap.sarv.com answers a whole-mailbox FETCH with "Command failed" but serves
    // bounded ranges fine. Before the rescue, that server never reconciled flags OR
    // deletions — mail read/trashed in webmail stayed wrong in the app forever.
    const ctx = setup();
    const read = seedSynced(ctx, ['\\Seen']);
    const gone = seedSynced(ctx, []);
    await ctx.server.selectFolder(INBOX);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    vi.spyOn(ctx.server, 'fetchAllFlags').mockRejectedValue(new Error('Command failed'));

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(tagsAt(ctx, read)).toEqual([INBOX, 'read']); // flags reconciled
    expect(res.deleted).toBe(1);                        // and deletions too
  });

  it('does not match a row whose PRIMARY folder is elsewhere against this folder\'s UIDs', async () => {
    // A message in both Sent and Inbox appears in the INBOX view but carries SENT's
    // uid. On the storage impls that lack the lightweight query, Phase 1 walks the
    // tag-based folder view, so it MUST re-check folder_id — otherwise it reads
    // INBOX's UID 5 flags onto a row whose 5 means a different message.
    const ctx = setup();
    ctx.db.addFolder('Sent', { id: `f-Sent-${folderSeq}` });
    const foreign = ctx.db.seedEmail({
      folderId: ctx.db.folderId('Sent'), uid: 1, tags: `|Sent|${INBOX}|`,
    });
    ctx.server.addMessage(INBOX, { flags: ['\\Seen', '\\Flagged'] }); // INBOX uid 1
    await ctx.server.selectFolder(INBOX);
    // Storage without the lightweight (id, uid, tags) query — the mobile shape.
    const legacy = Object.create(ctx.db) as FakeEmailStorage & { getEmailTagsInFolder?: undefined };
    legacy.getEmailTagsInFolder = undefined;

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), legacy as unknown as IEmailStorage);

    expect(res.updated).toBe(0);
    expect(ctx.db.tagsOf(foreign.id).sort()).toEqual([INBOX, 'Sent'].sort());
  });
});

describe('syncFlags — Phase 2: deletion detection', () => {
  it('removes a row whose UID vanished from a PROVABLY COMPLETE server list', async () => {
    const ctx = setup();
    const gone = seedSynced(ctx);
    const kept = seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    const deleted: number[] = [];

    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, (_id, uid) => deleted.push(uid),
    );

    expect(res.deleted).toBe(1);
    expect(deleted).toEqual([gone]);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid)).toEqual([kept]);
  });

  it('UNLINKS a row that also lives in another folder instead of destroying it', async () => {
    // Gmail label / cross-folder row: vanishing from INBOX means it was moved or
    // unlabelled, NOT that the message is gone. Destroying it here is how a
    // Trash->Archive move made mail disappear from every folder.
    const ctx = setup();
    const uid = seedSynced(ctx, [], ['Archive']);
    ctx.server.expungeOnServer(INBOX, uid);
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(1); // reconciled...
    expect(ctx.db.allRows()).toHaveLength(1); // ...but the row survives
    const row = ctx.db.allRows()[0];
    expect(ctx.db.tagsOf(row.id)).toEqual(['Archive']);
    expect(row.folderId).toBe(ctx.db.folderId('Archive'));
    expect(row.uid).toBeNull(); // stale INBOX uid dropped
  });

  it('a TRUNCATED server list (newest UIDs missing) deletes NOTHING', async () => {
    // `1:* FLAGS` / SEARCH ALL stream low→high, so a mid-stream drop truncates the
    // NEWEST uids. Diffing against that would "delete" the whole recent tail.
    const ctx = setup();
    const uids = Array.from({ length: 10 }, () => seedSynced(ctx));
    await ctx.server.selectFolder(INBOX);
    const truncated = uids.slice(0, 5).map((uid) => ({ uid, flags: [] as string[] }));
    vi.spyOn(ctx.server, 'fetchAllFlags').mockResolvedValue(truncated);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(10);
  });

  it('an EMPTY server list against a non-empty mailbox deletes NOTHING', async () => {
    // Server says "no UIDs" while EXISTS says 10 → a fetch problem, not an empty
    // folder. This is the guard that stops a bad connection wiping a mailbox.
    const ctx = setup();
    Array.from({ length: 10 }, () => seedSynced(ctx));
    await ctx.server.selectFolder(INBOX);
    vi.spyOn(ctx.server, 'fetchAllFlags').mockResolvedValue([]);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(10);
  });

  it('a PARTIAL list that still holds the newest UID deletes nothing (>50% guard)', async () => {
    // The nastiest shape: the truncation guard can't see this (the newest local uid
    // IS in the list) and the list is NOT provably complete, so the >50%-missing
    // ratio is the only thing standing between a bad fetch and a wiped folder.
    const ctx = setup();
    const uids = Array.from({ length: 10 }, () => seedSynced(ctx));
    ctx.server.addMessages(INBOX, 10); // server holds 20; EXISTS proves the list short
    await ctx.server.selectFolder(INBOX);
    const partial = [uids[9], uids[2], uids[1], uids[0]].map((uid) => ({ uid, flags: [] as string[] }));
    vi.spyOn(ctx.server, 'fetchAllFlags').mockResolvedValue(partial);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(10);
  });

  it('APPLIES a mass removal when the server is empty on TWO consecutive reads (real expiry)', async () => {
    // CHANGED (was single-read): a genuine empty and a transient EXISTS-0 blip are
    // indistinguishable in one read (a spurious 0 makes serverListComplete 0>=0 →
    // "complete"), and a single-read wipe of a full folder is unacceptable. So real
    // expiry now self-heals on the SECOND consecutive empty read, one sync later.
    const ctx = setup();
    const uids = Array.from({ length: 8 }, () => seedSynced(ctx));
    for (const uid of uids) ctx.server.expungeOnServer(INBOX, uid);
    await ctx.server.selectFolder(INBOX);

    // First empty read → deferred, nothing deleted.
    const first = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(first.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(8);

    // Second consecutive empty read → confirmed real expiry, applied.
    await ctx.server.selectFolder(INBOX);
    const second = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(second.deleted).toBe(8);
    expect(ctx.db.allRows()).toHaveLength(0);
  });

  it('does NOT wipe a full folder on a SINGLE spurious EXISTS-0, and recovers when the next read is normal', async () => {
    // The reported risk: a flaky/proxied server transiently reports a non-empty
    // folder as empty (EXISTS 0). One such read must never delete the folder; a
    // following correct read must leave everything intact (the blip mark clears).
    const ctx = setup();
    const uids = Array.from({ length: 8 }, () => seedSynced(ctx));
    await ctx.server.selectFolder(INBOX);

    // Blip: server momentarily returns zero UIDs though the mail is really there.
    const realFlags = ctx.server.fetchAllFlags.bind(ctx.server);
    const spy = vi.spyOn(ctx.server, 'fetchAllFlags').mockResolvedValueOnce([]);
    const blip = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(blip.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(8); // nothing wiped

    // Recovery: the next read is correct → mail intact, and the empty mark is cleared
    // so it would again take TWO empties (not one) to ever act.
    spy.mockRestore();
    void realFlags;
    await ctx.server.selectFolder(INBOX);
    const ok = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(ok.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(8);
    void uids;
  });

  it('never treats a UID with a PENDING local op as a server-side deletion', async () => {
    // A local move/delete in flight has already left this folder on the server; the
    // reconcile must not race ahead and clobber the row before the op round-trips.
    const ctx = setup();
    const pending = seedSynced(ctx);
    const kept = seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, pending);
    await ctx.server.selectFolder(INBOX);
    ctx.mp.setPendingUidsProvider(async () => new Set([pending]));

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort()).toEqual([pending, kept].sort());
  });

  it('skipDeletion still reconciles flags but removes nothing', async () => {
    const ctx = setup();
    const read = seedSynced(ctx, ['\\Seen']);
    const gone = seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined, { skipDeletion: true },
    );

    expect(tagsAt(ctx, read)).toEqual([INBOX, 'read']);
    expect(res.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(2);
  });

  it('ABORTS entirely when a DIFFERENT folder is selected on the connection', async () => {
    // A folder-selection race (IDLE re-selecting INBOX under a parallel sync) would
    // otherwise apply one mailbox's flags to another's rows and delete every row
    // that only looks missing because we diffed the wrong mailbox.
    const ctx = setup();
    const uid = seedSynced(ctx, ['\\Seen']);
    await ctx.server.selectFolder('Trash'); // NOT the folder we're about to sync

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res).toEqual({ updated: 0, deleted: 0 });
    expect(tagsAt(ctx, uid)).toEqual([INBOX]);
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
  });
});

describe('syncFlags — Phase 2: addition reconcile (mid-range holes)', () => {
  it('fetches and inserts UIDs the server has and the DB does not', async () => {
    // Neither the forward sync (uid > last) nor the downward backfill (uid < oldest)
    // ever revisits a MID-RANGE hole, so a failed insert left the folder
    // permanently short of the server ("Sent shows 100 of 108").
    const ctx = setup();
    const uids = ctx.server.addMessages(INBOX, 5);
    for (const uid of uids) {
      if (uid !== 3) ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|` });
    }
    // The forward sync has already passed UID 5, so the hole at 3 is genuinely
    // mid-range. Anything ABOVE the watermark is new mail and belongs to the
    // forward sync, which announces it (notification + AI); reconciling it here
    // would insert it silently.
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 5 });
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does NOT re-fetch a message already present by TAG (cross-folder row)', async () => {
    // Such a row lives primarily in another folder, so it never enters this
    // folder's folder_id UID space and shows as "missing" on EVERY sync —
    // re-fetching it each cycle is pure waste that never converges.
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 2, tags: `|${INBOX}|` });
    // The third message is here by TAG only (primary elsewhere) — the folder view
    // already shows all three.
    ctx.db.seedEmail({ folderId: ctx.db.folderId('Archive'), uid: 91, tags: `|Archive|${INBOX}|` });
    await ctx.server.selectFolder(INBOX);
    const fetchSpy = vi.spyOn(ctx.server, 'fetchMessagesByUID');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(3);
  });

  it('DRAINS past cross-folder no-op UIDs to reach the genuinely-missing (converges, not stuck)', async () => {
    // The reported "Gmail stuck at ~8.6k, never finishes": the NEWEST server UIDs
    // are messages whose PRIMARY folder is another (a Gmail INBOX message primary
    // in [Gmail]/All Mail) — tagged here but with no folder_id-space uid, so they
    // fill missingFromLocal EVERY sync. Being more than the per-sync cap, they
    // crowded out the OLDER genuinely-missing UIDs, which never got fetched: the
    // reconcile re-fetched the same no-op band forever. It must remember what it
    // already tried and drain through to the real gaps.
    const ctx = setup();
    // 300 server messages (uid == i). 101..300 already exist locally, primary in
    // Archive but tagged INBOX → no-ops here. 1..100 are genuinely missing.
    for (let i = 1; i <= 300; i++) ctx.server.addMessage(INBOX, { uid: i, messageId: `<m${i}@t>` });
    for (let i = 101; i <= 300; i++) {
      ctx.db.seedEmail({ folderId: ctx.db.folderId('Archive'), uid: i, tags: `|Archive|${INBOX}|`, messageId: `<m${i}@t>` });
    }
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 300 });
    await ctx.server.selectFolder(INBOX);
    const fetchSpy = vi.spyOn(ctx.server, 'fetchMessagesByUID');

    // Sync 1: fetches the newest 200 (101..300) — all present-by-tag no-ops.
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    const firstFetched = fetchSpy.mock.calls.flatMap(([uids]) => uids);
    expect(Math.min(...firstFetched)).toBe(101);          // newest-first: the no-op band
    expect(ctx.db.rowsPrimaryIn(INBOX)).toHaveLength(0);  // nothing genuinely downloaded yet

    fetchSpy.mockClear();
    // Sync 2: must NOT re-fetch 101..300 — it drains to the genuinely-missing 1..100.
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    const secondFetched = fetchSpy.mock.calls.flatMap(([uids]) => uids);
    expect(Math.max(...secondFetched)).toBe(100);         // reached the real gap
    expect(secondFetched).toHaveLength(100);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 100 }, (_, k) => k + 1)); // 1..100 now downloaded → converged
  });

  it('retries a UID the server DROPPED from a partial fetch response (not suppressed by the tried-set)', async () => {
    // The tried-set must record only UIDs the server actually RETURNED. If it
    // marked every REQUESTED uid, a single flaky partial FETCH would exclude a
    // genuinely-missing message from the reconcile for the rest of the session.
    const ctx = setup();
    for (let i = 1; i <= 3; i++) ctx.server.addMessage(INBOX, { uid: i, messageId: `<p${i}@t>` });
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 3 });
    await ctx.server.selectFolder(INBOX);

    // Sync 1: the server returns ONLY uid 3 for the reconcile fetch (drops 1, 2).
    const realFetch = ctx.server.fetchMessagesByUID.bind(ctx.server);
    const spy = vi.spyOn(ctx.server, 'fetchMessagesByUID').mockImplementation(async (uids: number[], opts: never) => {
      const all = await realFetch(uids, opts);
      return all.filter((m) => m.uid === 3);
    });
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid!)).toEqual([3]); // only the returned one landed

    // Sync 2: full responses again. 1 and 2 were NOT marked tried, so they fetch now.
    spy.mockRestore();
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('DRAINS a large gap newest-first, bounded per sync and sub-batched', async () => {
    // Bounded so a huge gap can't stall the loop, sub-batched so one slow FETCH
    // can't time out and insert nothing (all-or-nothing was stalling the drain).
    const ctx = setup();
    ctx.server.addMessages(INBOX, 250);
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    // The gap is HISTORY, not new mail: the forward sync has been through 250, so
    // these are holes it left behind (failed inserts / a gutted folder).
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 250 });
    await ctx.server.selectFolder(INBOX);
    const fetchSpy = vi.spyOn(ctx.server, 'fetchMessagesByUID');

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    // 200 per sync, in sub-batches of 100 → 2 FETCHes, newest UIDs first.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const fetched = fetchSpy.mock.calls.flatMap(([uids]) => uids);
    expect(fetched).toHaveLength(200);
    expect(Math.max(...fetched)).toBe(250);
    expect(Math.min(...fetched)).toBe(51);
    expect(ctx.db.allRows()).toHaveLength(201); // the remainder drains next sync
  });

  /**
   * Breaks: the folder badge freezes. OBSERVED live — an INBOX badge stuck at 5
   * unread for over half an hour while the folder actually held 15, with
   * `addition reconcile … linked 200` logged on every single sync.
   *
   * The sidebar reads the STORED `folders.unread_count`, never a live query, and
   * syncFlags reports only `{updated, deleted}` — flag flips and expunges. All
   * six of its callers gate their recount on exactly those two numbers, so a
   * pass that inserted or relinked hundreds of messages changed the folder's
   * membership and told nobody. The counts then stayed wrong until something
   * unrelated triggered a full recount.
   */
  it('refreshes the folder\'s stored counts after it inserts mail', async () => {
    const ctx = setup();
    const uids = ctx.server.addMessages(INBOX, 5);
    for (const uid of uids) {
      if (uid !== 3) ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|` });
    }
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 5 });
    await ctx.server.selectFolder(INBOX);
    // The badge the user is looking at, stale (as it is in the field: it was
    // last written before the hole was filled).
    await ctx.storage.updateFolder!(ctx.folder().id, { totalCount: 4, unreadCount: 4 });

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(ctx.db.rowsTaggedWith(INBOX)).toHaveLength(5);
    expect(ctx.folder().totalCount).toBe(5);
    expect(ctx.folder().unreadCount).toBe(5);
  });

  /**
   * Breaks: the recount stops being scoped and starts costing. A full
   * `recalculateFolderCounts()` is a synchronous main-thread pass over every row
   * (~200ms on a big mailbox → beachball), which is why it is scoped to the one
   * folder AND fired only when the reconcile actually stored something. A
   * converged folder syncs on every tick and must pay nothing.
   */
  it('does NOT recount when the reconcile found nothing to add', async () => {
    const ctx = setup();
    const uids = ctx.server.addMessages(INBOX, 3);
    for (const uid of uids) {
      ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|` });
    }
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 3 });
    await ctx.server.selectFolder(INBOX);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(ctx.db.callCount('recalculateFolderCounts')).toBe(0);
  });

  // NEW mail is the forward sync's job, NOT this pass's. Reconciling UIDs above
  // the watermark inserted them with `quiet: true`, which suppresses the
  // `email:synced` emit (no AI categorisation, no body prefetch) AND the
  // renderer's new-email event (no notification, no live list update) — mail just
  // appeared later with no sign it had arrived, and the following getNewMessages
  // reported "0 inserted" because this pass had already swallowed it.
  it('leaves mail ABOVE the sync watermark to the forward sync', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 5);
    // Synced through UID 3; 4 and 5 are brand-new arrivals.
    for (const uid of [1, 2, 3]) {
      ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|` });
    }
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 3 });
    await ctx.server.selectFolder(INBOX);
    const fetchSpy = vi.spyOn(ctx.server, 'fetchMessagesByUID');

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(fetchSpy).not.toHaveBeenCalled();          // nothing reconciled
    expect(ctx.db.allRows()).toHaveLength(3);         // 4 and 5 still unseen here
  });

  // …but a hole BELOW the watermark is still repaired, in the same pass.
  it('still repairs a hole below the watermark while ignoring newer mail', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 5);
    for (const uid of [1, 2, 4]) {          // 3 is the hole, 5 is new mail
      ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid, tags: `|${INBOX}|` });
    }
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 4 });
    await ctx.server.selectFolder(INBOX);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4]);
  });

  // A Gmail label mirror (`Sarv Inbox/Access`, `[Gmail]/Important`) has NO rows
  // of its own: every message there lives primarily in All Mail and belongs to
  // the mirror by tag. Phase 2 used to `return` the moment this folder's own uid
  // space was empty, which skipped the ADDITION reconcile for exactly those
  // folders — so a mirror folder that was short of the server could never catch
  // up, no matter how many syncs ran.
  it('still reconciles ADDITIONS for a folder with no rows of its OWN', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 4);
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 4 });
    await ctx.server.selectFolder(INBOX);
    const fetchSpy = vi.spyOn(ctx.server, 'fetchMessagesByUID');

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(fetchSpy).toHaveBeenCalled();
    expect(fetchSpy.mock.calls.flatMap(([uids]) => uids).sort()).toEqual([1, 2, 3, 4]);
    expect(ctx.db.allRows()).toHaveLength(4);
  });

  // …and with nothing of its own AND nothing missing, it must not delete or
  // re-fetch anything — the messages are all present under another folder's
  // primary, visible here by tag.
  it('does nothing for a mirror folder that is already complete by tag', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    // Rows whose PRIMARY folder is Archive but which carry INBOX's tag too.
    for (const uid of [1, 2, 3]) {
      ctx.db.seedEmail({ folderId: ctx.db.folderId('Archive'), uid, tags: `|Archive|${INBOX}|` });
    }
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 3 });
    await ctx.server.selectFolder(INBOX);
    const fetchSpy = vi.spyOn(ctx.server, 'fetchMessagesByUID');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(3);
  });

  it('keeps what already stuck when a later sub-batch FAILS', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 250);
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    // The gap is HISTORY, not new mail: the forward sync has been through 250, so
    // these are holes it left behind (failed inserts / a gutted folder).
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 250 });
    await ctx.server.selectFolder(INBOX);
    const real = ctx.server.fetchMessagesByUID.bind(ctx.server);
    let call = 0;
    vi.spyOn(ctx.server, 'fetchMessagesByUID').mockImplementation(async (uids, opts) => {
      call += 1;
      if (call > 1) throw new Error('timeout');
      return real(uids, opts);
    });

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    // First sub-batch's 100 rows are durable; the rest drains on the next sync.
    expect(ctx.db.allRows()).toHaveLength(101);
  });
});

describe('syncFlags — degraded storage and servers', () => {
  it('reconciles DELETIONS even when the batched flag fetch fails (flags are best-effort)', async () => {
    // The SEARCH-ALL rescue gets UIDs but no flags; if the follow-up flag fetch
    // also fails, local flags must be left untouched (safe) while deletions still
    // reconcile — losing flag freshness is acceptable, stranding deletions is not.
    const ctx = setup();
    const read = seedSynced(ctx, ['\\Seen']);
    const gone = seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    vi.spyOn(ctx.server, 'fetchAllFlags').mockRejectedValue(new Error('Command failed'));
    vi.spyOn(ctx.server, 'fetchFlagsOnly').mockRejectedValue(new Error('Command failed'));

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(0);
    expect(tagsAt(ctx, read)).toEqual([INBOX]); // untouched, not corrupted
    expect(res.deleted).toBe(1);
  });

  it('falls back to per-row updates when the storage has no bulk tag writer', async () => {
    const ctx = setup();
    const uid = seedSynced(ctx, ['\\Seen']);
    await ctx.server.selectFolder(INBOX);
    const noBulk = Object.create(ctx.db) as FakeEmailStorage & { bulkUpdateTags?: undefined };
    noBulk.bulkUpdateTags = undefined;

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), noBulk as unknown as IEmailStorage);

    expect(res.updated).toBe(1);
    expect(tagsAt(ctx, uid)).toEqual([INBOX, 'read']);
  });

  it('reconciles through the legacy queries when BOTH lightweight queries are missing', async () => {
    // Mobile storage shape: no getEmailTagsInFolder and no getEmailUidsInFolder, so
    // both phases fall back to the paginated folder view. It must still apply flags
    // to this folder's own rows and still detect a deletion.
    const ctx = setup();
    const read = seedSynced(ctx, ['\\Seen']);
    const gone = seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    const legacy = Object.create(ctx.db) as FakeEmailStorage & {
      getEmailTagsInFolder?: undefined; getEmailUidsInFolder?: undefined;
    };
    legacy.getEmailTagsInFolder = undefined;
    legacy.getEmailUidsInFolder = undefined;

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), legacy as unknown as IEmailStorage);

    expect(tagsAt(ctx, read)).toEqual([INBOX, 'read']);
    expect(res.deleted).toBe(1);
  });

  it('a failed MODSEQ persist does not fail the sync', async () => {
    const ctx = setup({ condstore: true });
    const uid = seedSynced(ctx, ['\\Seen']);
    await ctx.server.selectFolder(INBOX);
    vi.spyOn(ctx.db, 'updateFolder').mockRejectedValue(new Error('db locked'));

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.updated).toBe(1);                 // the flag work still counted
    expect(tagsAt(ctx, uid)).toEqual([INBOX, 'read']);
  });

  it('skips per-row UI events on a MASS reconcile (no IPC flood)', async () => {
    // Above the cap the folder isn't being viewed at that size and reloads fresh, so
    // thousands of per-row events would be pure cost. (The mass delete lands on the
    // SECOND consecutive empty read — see the two-read EXISTS-0 guard.)
    const ctx = setup();
    const uids = Array.from({ length: 600 }, () => seedSynced(ctx));
    for (const uid of uids) ctx.server.expungeOnServer(INBOX, uid);
    await ctx.server.selectFolder(INBOX);
    const deleted: number[] = [];

    // First empty read defers; second confirms and applies.
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage, undefined, (_id, uid) => deleted.push(uid));
    await ctx.server.selectFolder(INBOX);
    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, (_id, uid) => deleted.push(uid),
    );

    expect(res.deleted).toBe(600);
    expect(deleted).toEqual([]);            // events suppressed above the cap
    expect(ctx.db.allRows()).toHaveLength(0); // but every row IS reconciled
  });
});

describe('syncFlags — LARGE CONDSTORE mailbox', () => {
  /** Just over the windowing threshold, with local rows only for the tail. */
  function largeSetup() {
    const ctx = setup({ condstore: true });
    // +2 so the mailbox stays LARGE even after a test expunges one message.
    ctx.server.addMessages(INBOX, LARGE_MAILBOX_THRESHOLD + 2);
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 2, tags: `|${INBOX}|` });
    return ctx;
  }

  it('WINDOWS the flag re-read and defers whole-folder deletion', async () => {
    // On a lakh+ mailbox the whole-mailbox SEARCH ALL returns partial lists or times
    // out; the delta already carried recent flag changes, and deletions arrive via
    // VANISHED. Diffing against a windowed UID set would "delete" everything older.
    const ctx = largeSetup();
    await ctx.server.selectFolder(INBOX);
    await ctx.db.updateFolder(ctx.folder().id, {
      highestModseq: ((await ctx.server.getFolderStatus(INBOX)) as { highestModseq?: number }).highestModseq,
    });
    ctx.server.expungeOnServer(INBOX, 1); // a real deletion the hot path must NOT apply
    await ctx.server.selectFolder(INBOX);
    const uidsSpy = vi.spyOn(ctx.server, 'fetchAllUIDs');
    const sinceSpy = vi.spyOn(ctx.server, 'fetchUidsSince');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(sinceSpy).toHaveBeenCalledTimes(1); // windowed enumeration only
    expect(uidsSpy).not.toHaveBeenCalled();    // never the whole mailbox
    expect(res.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(2);
  });

  it('a background fullReconcile enumerates + applies deletions but still WINDOWS the flag re-read', async () => {
    // The rate-limiting root cause: the deferred-deletion background pass
    // (fullReconcile) on [Gmail]/All Mail (~26k UIDs) used to re-read EVERY flag
    // — 52 FETCH batches on ONE pooled connection — which reliably timed out
    // ("flags for 0/1" every cycle), poisoned the connection, starved the pool
    // and tripped the connect-cap back-off ("mail stops arriving"). The full
    // pass must still enumerate + APPLY whole-folder deletions (its whole reason
    // to exist — one cheap SEARCH ALL), but the flag re-read must go through the
    // bounded recent WINDOW, never the whole-mailbox 52-batch FETCH.
    const ctx = largeSetup();
    await ctx.server.selectFolder(INBOX);
    await ctx.db.updateFolder(ctx.folder().id, {
      highestModseq: ((await ctx.server.getFolderStatus(INBOX)) as { highestModseq?: number }).highestModseq,
    });
    ctx.server.expungeOnServer(INBOX, 1); // a real deletion the FULL pass MUST apply
    await ctx.server.selectFolder(INBOX);
    const uidsSpy = vi.spyOn(ctx.server, 'fetchAllUIDs');
    const sinceSpy = vi.spyOn(ctx.server, 'fetchUidsSince');

    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined,
      { forceDeletion: true, fullReconcile: true },
    );

    expect(uidsSpy).toHaveBeenCalled();        // deletions still enumerated whole-mailbox (one SEARCH ALL)
    expect(sinceSpy).toHaveBeenCalledTimes(1); // flags via the recent WINDOW, not the 52-batch re-read
    expect(res.deleted).toBe(1);               // and the real deletion IS applied (full pass, not hot path)
    expect(ctx.db.allRows()).toHaveLength(1);
  });

  it('THROTTLES even the windowed flag re-read between ticks', async () => {
    const ctx = largeSetup();
    await ctx.server.selectFolder(INBOX);
    await ctx.db.updateFolder(ctx.folder().id, {
      highestModseq: ((await ctx.server.getFolderStatus(INBOX)) as { highestModseq?: number }).highestModseq,
    });

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage); // consumes the tick
    const sinceSpy = vi.spyOn(ctx.server, 'fetchUidsSince');
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage, undefined, undefined, { forceDeletion: true });

    // forceDeletion still can't buy a whole-mailbox enumeration here, and the
    // windowed re-read stays on its own (separate) throttle.
    expect(sinceSpy).not.toHaveBeenCalled();
  });
});

describe('syncFlags — CONDSTORE delta path', () => {
  /** Stored modseq == the server's current one, so only later changes are a delta. */
  const syncModseq = async (ctx: Ctx): Promise<number> =>
    ((await ctx.server.getFolderStatus(INBOX)) as { highestModseq?: number }).highestModseq ?? 0;

  it('applies the CHANGED flags via CHANGEDSINCE without enumerating the whole mailbox', async () => {
    const ctx = setup({ condstore: true });
    const changed = seedSynced(ctx, ['\\Seen'], ['read']);
    const untouched = seedSynced(ctx, ['\\Seen'], ['read']);
    await ctx.db.updateFolder(ctx.folder().id, { highestModseq: await syncModseq(ctx) });
    await ctx.server.selectFolder(INBOX);
    // The FIRST tick on a folder always runs the periodic full reconcile; the delta
    // is what the many ticks BETWEEN those do, so prime the throttle first.
    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    const baseline = ctx.folder().highestModseq;
    ctx.server.setFlagsOnServer(INBOX, changed, []); // marked unread again in webmail
    await ctx.server.selectFolder(INBOX);
    const changedSince = vi.spyOn(ctx.server, 'fetchFlagsChangedSince');
    const allFlags = vi.spyOn(ctx.server, 'fetchAllFlags');
    const allUids = vi.spyOn(ctx.server, 'fetchAllUIDs');
    const flagsOnly = vi.spyOn(ctx.server, 'fetchFlagsOnly');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(changedSince).toHaveBeenCalledWith(baseline);
    // No whole-mailbox work of ANY kind on a delta tick — that is the optimization.
    expect(allFlags).not.toHaveBeenCalled();
    expect(allUids).not.toHaveBeenCalled();
    expect(flagsOnly).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
    expect(tagsAt(ctx, changed)).toEqual([INBOX]);
    expect(tagsAt(ctx, untouched)).toEqual([INBOX, 'read']);
  });

  it('persists the current modseq (with its uidValidity) as the next baseline', async () => {
    const ctx = setup({ condstore: true });
    seedSynced(ctx);
    await ctx.db.updateFolder(ctx.folder().id, { highestModseq: 2 });
    await ctx.server.selectFolder(INBOX);
    const current = await syncModseq(ctx);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(ctx.folder().highestModseq).toBe(current);
    expect(ctx.folder().uidValidity).toBe(1);
  });

  it('THROTTLES the whole-mailbox deletion reconcile between ticks', async () => {
    // The delta is cheap; the SEARCH ALL behind deletion detection is not, so it
    // must not fire on every IDLE tick. On a throttled tick the UID set is
    // incomplete by design — and an incomplete set must never drive deletions.
    const ctx = setup({ condstore: true });
    seedSynced(ctx);
    const gone = seedSynced(ctx);
    await ctx.db.updateFolder(ctx.folder().id, { highestModseq: await syncModseq(ctx) });
    await ctx.server.selectFolder(INBOX);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage); // consumes the tick
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    const uidsSpy = vi.spyOn(ctx.server, 'fetchAllUIDs');
    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(uidsSpy).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(2);
  });

  it('forceDeletion (manual Refresh / periodic sync) OVERRIDES that throttle', async () => {
    // "A user hitting Refresh expects mail deleted on webmail to disappear NOW."
    const ctx = setup({ condstore: true });
    seedSynced(ctx);
    const gone = seedSynced(ctx);
    await ctx.db.updateFolder(ctx.folder().id, { highestModseq: await syncModseq(ctx) });
    await ctx.server.selectFolder(INBOX);

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined, { forceDeletion: true },
    );

    expect(res.deleted).toBe(1);
    expect(ctx.db.allRows()).toHaveLength(1);
  });

  it('falls back to the FULL path when the delta fetch fails — correctness never depends on it', async () => {
    const ctx = setup({ condstore: true });
    const read = seedSynced(ctx, ['\\Seen']);
    const gone = seedSynced(ctx);
    await ctx.db.updateFolder(ctx.folder().id, { highestModseq: await syncModseq(ctx) });
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);
    vi.spyOn(ctx.server, 'fetchFlagsChangedSince').mockRejectedValue(new Error('CHANGEDSINCE failed'));

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(tagsAt(ctx, read)).toEqual([INBOX, 'read']); // flags still reconciled
    expect(res.deleted).toBe(1);                        // deletions still applied
  });

  it('takes the FULL path (not the delta) when there is no stored modseq yet', async () => {
    // First sync has nothing to diff against; the delta would silently sync nothing.
    const ctx = setup({ condstore: true });
    const read = seedSynced(ctx, ['\\Seen']);
    await ctx.server.selectFolder(INBOX);
    const changedSpy = vi.spyOn(ctx.server, 'fetchFlagsChangedSince');

    await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(changedSpy).not.toHaveBeenCalled();
    expect(tagsAt(ctx, read)).toEqual([INBOX, 'read']);
  });
});

describe('syncFlags — pool stuck-eviction heartbeat (touch)', () => {
  // The regression these guard: a whole-mailbox reconcile ([Gmail]/All Mail,
  // ~26k UIDs) runs on ONE pooled connection. Each internal step lives under a
  // 60s op timeout, but the STEPS CHAIN — a UID search, a batched flag re-read,
  // then up to two 100-UID addition FETCHes (ADDITION_RECONCILE_MAX/BATCH) — so
  // the lease routinely out-lasts the pool's 120s stuck-eviction. Before the fix
  // syncFlags got no `touch`, so it could not refresh the connection's
  // acquiredAt; the pool reclaimed the socket MID-reconcile, poisoned it, dropped
  // the primary and set off the connect-timeout back-off storm (mail stops
  // arriving). Each step that makes progress must now heartbeat via `touch`.
  // `touch` is the 8th positional arg (after onReadChange).

  it('heartbeats once per addition-reconcile SUB-BATCH (the 2×60s ≈ 124s hold)', async () => {
    // The exact shape that out-lasted 120s: a gap large enough to fetch the
    // per-sync cap (200) in two 100-UID sub-batches, each its own 60s FETCH. Two
    // chained FETCHes with no heartbeat is what got the connection evicted.
    const ctx = setup();
    ctx.server.addMessages(INBOX, 250);
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    // History, not new mail: the forward sync already passed 250, so these are
    // holes below the watermark that the addition reconcile must drain.
    await ctx.storage.updateFolder!(ctx.folder().id, { lastSyncUid: 250 });
    await ctx.server.selectFolder(INBOX);
    const touch = vi.fn();

    await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined, undefined, undefined, touch,
    );

    // Small mailbox → the full 1:* FLAGS fetch serves both maps (no SEARCH-ALL
    // fallback), so the ONLY heartbeats come from the two addition sub-batches.
    expect(touch).toHaveBeenCalledTimes(2);
  });

  it('heartbeats through the whole-mailbox re-read on a LARGE fullReconcile (non-CONDSTORE)', async () => {
    // The background deferred-deletion pass on a big folder: fullReconcile forces
    // the whole-mailbox path even though the folder is large. It enumerates via
    // SEARCH ALL then re-reads flags in 500-UID batches — the long lease that must
    // heartbeat after the UID search AND after each flag batch.
    const ctx = setup();
    ctx.server.addMessages(INBOX, LARGE_MAILBOX_THRESHOLD + 2); // above the windowing threshold
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    ctx.db.seedEmail({ folderId: ctx.db.folderId(INBOX), uid: 2, tags: `|${INBOX}|` });
    await ctx.server.selectFolder(INBOX);
    const touch = vi.fn();

    await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined,
      { forceDeletion: true, fullReconcile: true }, undefined, touch,
    );

    // fetchAllUIDs heartbeat + one per 500-UID flag batch → many calls, never zero.
    expect(touch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('heartbeats through the CONDSTORE delta whole-mailbox re-read (SMALL CONDSTORE mailbox)', async () => {
    // A SMALL condstore folder with a stored MODSEQ takes the CONDSTORE delta
    // path, and its background-fullReconcile dueForDeletion branch still does a
    // whole-mailbox fetchAllUIDs + batched fetchFlagsOnly — that branch must
    // heartbeat too. (A LARGE mailbox now WINDOWS this re-read instead — see the
    // "LARGE CONDSTORE mailbox" block — precisely because the 52-batch
    // whole-mailbox FETCH times out and poisons the pool; that path is covered
    // by loadWindowedFlags' own windowed heartbeat.)
    const ctx = setup({ condstore: true });
    seedSynced(ctx, ['\\Seen']);
    seedSynced(ctx, []);
    const currentModseq =
      ((await ctx.server.getFolderStatus(INBOX)) as { highestModseq?: number }).highestModseq ?? 0;
    await ctx.db.updateFolder(ctx.folder().id, { highestModseq: currentModseq });
    await ctx.server.selectFolder(INBOX);
    const touch = vi.fn();

    await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined,
      { forceDeletion: true, fullReconcile: true }, undefined, touch,
    );

    // fetchAllUIDs heartbeat + at least one flag-batch heartbeat.
    expect(touch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT require touch — a caller that omits it still reconciles', async () => {
    // touch is optional (hot-path callers with a short lease pass nothing); its
    // absence must never break the reconcile or throw.
    const ctx = setup();
    const read = seedSynced(ctx, ['\\Seen']);
    const gone = seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, gone);
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, undefined, { forceDeletion: true },
    );

    expect(tagsAt(ctx, read)).toEqual([INBOX, 'read']);
    expect(res.deleted).toBe(1);
  });
});

describe('syncFlags — Phase 2b: stale tag-only memberships', () => {
  // The deletion diff only sees rows whose PRIMARY folder is the one being
  // synced. A Trash copy that Trash's sync linked onto an existing INBOX row
  // (tags |INBOX|Trash|, primary Trash) is invisible to it, so when the message
  // left INBOX on the server while no expunge was observed, the INBOX tag stayed
  // forever: the badge counted it, "Filtered: Unread" hid it. Phase 2b verifies
  // such tag-only members by Message-ID under the same "server list is complete"
  // proof, and unlinks the ones the server no longer has here.

  /** A row whose primary is Trash but that still carries the INBOX tag. */
  function seedTagOnlyMember(ctx: Ctx, messageId: string, onServerInbox: boolean): string {
    const trashUid = ctx.server.addMessage('Trash', { messageId });
    if (onServerInbox) ctx.server.addMessage(INBOX, { messageId });
    const row = ctx.db.seedEmail({
      folderId: ctx.db.folderId('Trash'),
      uid: trashUid,
      messageId,
      tags: `|${INBOX}|Trash|`,
    });
    return row.id;
  }

  it('UNLINKS the folder tag from a member the server no longer holds here', async () => {
    const ctx = setup();
    seedSynced(ctx);
    const stale = seedTagOnlyMember(ctx, '<stale@test.local>', false);
    await ctx.server.selectFolder(INBOX);
    const deletedIds: string[] = [];

    const res = await ctx.mp.syncFlags(
      ctx.server, ctx.folder(), ctx.storage, undefined, (id) => deletedIds.push(id),
    );

    expect(res.deleted).toBe(1);            // gates the caller's badge recount
    expect(deletedIds).toEqual([stale]);    // renderer drops the row from INBOX in place
    expect(ctx.db.tagsOf(stale)).toEqual(['Trash']); // membership dropped, row kept
    expect(ctx.db.row(stale)?.folderId).toBe(ctx.db.folderId('Trash'));
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(1);
  });

  it('keeps a member the server DOES hold here, and never re-searches it', async () => {
    // A reply that genuinely lives in both folders must survive every sweep and
    // cost one HEADER search per session, not one per sync.
    const ctx = setup();
    seedSynced(ctx);
    const legit = seedTagOnlyMember(ctx, '<both@test.local>', true);
    const stale = seedTagOnlyMember(ctx, '<stale@test.local>', false);
    await ctx.server.selectFolder(INBOX);
    const search = vi.spyOn(ctx.server, 'search');

    const first = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(first.deleted).toBe(1);
    expect(ctx.db.tagsOf(legit).sort()).toEqual([INBOX, 'Trash']);
    expect(ctx.db.tagsOf(stale)).toEqual(['Trash']);
    expect(search).toHaveBeenCalledTimes(2);

    // Next sync: a NEW stale member appears; only IT is searched (legit is cached).
    const stale2 = seedTagOnlyMember(ctx, '<stale2@test.local>', false);
    await ctx.server.selectFolder(INBOX);
    const second = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(second.deleted).toBe(1);
    expect(ctx.db.tagsOf(stale2)).toEqual(['Trash']);
    expect(ctx.db.tagsOf(legit).sort()).toEqual([INBOX, 'Trash']);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('issues NO searches when every tag-only member can be a real server message', async () => {
    // Converged folder (a Gmail label mirror, Inbox+Sent replies): the arithmetic
    // gate must keep the sweep at zero round-trips per sync.
    const ctx = setup();
    seedSynced(ctx);
    seedTagOnlyMember(ctx, '<both@test.local>', true);
    await ctx.server.selectFolder(INBOX);
    const search = vi.spyOn(ctx.server, 'search');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
  });

  it('does NOTHING when the server list is not provably complete', async () => {
    // Same proof the deletion diff demands: a truncated enumeration must not turn
    // "unaccounted" arithmetic into unlinks.
    const ctx = setup();
    const uids = Array.from({ length: 10 }, () => seedSynced(ctx));
    const stale = seedTagOnlyMember(ctx, '<stale@test.local>', false);
    await ctx.server.selectFolder(INBOX);
    const truncated = uids.slice(0, 5).map((uid) => ({ uid, flags: [] as string[] }));
    vi.spyOn(ctx.server, 'fetchAllFlags').mockResolvedValue(truncated);
    const search = vi.spyOn(ctx.server, 'search');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(ctx.db.tagsOf(stale).sort()).toEqual([INBOX, 'Trash']);
  });

  it('a failing HEADER search is a connection verdict: stops, unlinks nothing, retries next sync', async () => {
    const ctx = setup();
    seedSynced(ctx);
    const stale = seedTagOnlyMember(ctx, '<stale@test.local>', false);
    await ctx.server.selectFolder(INBOX);
    const search = vi.spyOn(ctx.server, 'search').mockRejectedValueOnce(new Error('socket closed'));

    const failed = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(failed.deleted).toBe(0);
    expect(ctx.db.tagsOf(stale).sort()).toEqual([INBOX, 'Trash']);
    expect(ctx.db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);

    // Transient, not permanent: the next sync completes the sweep.
    await ctx.server.selectFolder(INBOX);
    const retried = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(retried.deleted).toBe(1);
    expect(ctx.db.tagsOf(stale)).toEqual(['Trash']);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('skips a member whose primary copy has a pending local operation', async () => {
    // A local move in flight: the server view is about to change, so the sweep
    // must not race it (unlinking INBOX just before the move lands would drop
    // the message from the very folder the user is moving it into).
    const ctx = setup();
    seedSynced(ctx);
    const moving = seedTagOnlyMember(ctx, '<moving@test.local>', false);
    const trashUid = ctx.db.row(moving)!.uid as number;
    ctx.mp.setPendingUidsProvider(async (path) => new Set(path === 'Trash' ? [trashUid] : []));
    await ctx.server.selectFolder(INBOX);
    const search = vi.spyOn(ctx.server, 'search');

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(ctx.db.tagsOf(moving).sort()).toEqual([INBOX, 'Trash']);
  });

  it('bounds one sweep to 100 searches and finishes the rest on later syncs', async () => {
    const ctx = setup();
    seedSynced(ctx);
    const ids = Array.from({ length: 103 }, (_, i) => seedTagOnlyMember(ctx, `<stale-${i}@test.local>`, false));
    await ctx.server.selectFolder(INBOX);
    const search = vi.spyOn(ctx.server, 'search');

    const first = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(first.deleted).toBe(100);
    expect(search).toHaveBeenCalledTimes(100);

    await ctx.server.selectFolder(INBOX);
    const second = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);
    expect(second.deleted).toBe(3);
    expect(ids.every((id) => ctx.db.tagsOf(id).join() === 'Trash')).toBe(true);
  });

  it('a storage failure inside the sweep never fails the flag sync', async () => {
    // Stale tags are cosmetic; the flag/deletion results already computed must
    // still be returned so the caller's badge recount and UI events proceed.
    const ctx = setup();
    const gone = seedSynced(ctx);
    seedSynced(ctx);
    ctx.server.expungeOnServer(INBOX, gone);
    seedTagOnlyMember(ctx, '<stale@test.local>', false);
    vi.spyOn(ctx.db, 'getFolderMembersOutsideUidSpace').mockRejectedValue(new Error('disk I/O error'));
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(1); // the primary-row deletion still counted
    expect(ctx.db.allRows()).toHaveLength(2);
  });

  it('is skipped entirely on a storage that does not expose tag-only members', async () => {
    // Optional method: older/lighter storages must keep working unchanged.
    const ctx = setup();
    seedSynced(ctx);
    const stale = seedTagOnlyMember(ctx, '<stale@test.local>', false);
    (ctx.db as unknown as { getFolderMembersOutsideUidSpace?: unknown }).getFolderMembersOutsideUidSpace = undefined;
    await ctx.server.selectFolder(INBOX);

    const res = await ctx.mp.syncFlags(ctx.server, ctx.folder(), ctx.storage);

    expect(res.deleted).toBe(0);
    expect(ctx.db.tagsOf(stale).sort()).toEqual([INBOX, 'Trash']);
  });
});
