import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { FolderRecord } from '../../../src/types/models';

import { applyQresyncVanished } from '../../../src/imap/qresync-reconcile';

// applyQresyncVanished is the ONLY authoritative deletion signal we have: a
// resynchronising SELECT makes the server name the exact UIDs expunged since our
// stored modseq. Because it is ground truth it deliberately bypasses the
// SEARCH-ALL diff's ratio/empty-list safety guards — which is precisely why its
// PRECONDITIONS have to be airtight. Every no-op branch below is a case where a
// wrong "vanished" list would delete live mail by stale UID:
//   - a UIDVALIDITY mismatch means our UIDs address a UID space that no longer
//     exists (the server must report nothing, and we must delete nothing),
//   - a failed/absent resync SELECT means we learned nothing, which is NOT the
//     same as "nothing changed".
// Driven against the shared FakeImapServer + in-memory storage so the assertions
// are about the surviving ROWS, not about which mock was called.

const INBOX = 'INBOX';

function setup(options: { qresync?: boolean; condstore?: boolean } = {}) {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer({ qresync: options.qresync ?? true, condstore: options.condstore ?? true });
  server.addFolder(INBOX, { uidValidity: 1 });
  const db = new FakeEmailStorage();
  db.addFolder(INBOX, { uidValidity: 1, highestModseq: 5 } as Partial<FolderRecord>);
  return { server, db };
}

/** Put a message on the server AND a matching local row at the same UID. */
function seedSynced(server: FakeImapServer, db: FakeEmailStorage, path: string, extraTags: string[] = []): number {
  const uid = server.addMessage(path);
  db.seedEmail({ folderId: db.folderId(path), uid, tags: `|${[path, ...extraTags].join('|')}|` });
  return uid;
}

describe('applyQresyncVanished', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('applies VANISHED (EARLIER) UIDs — the rows go, and onDeleted fires per row', async () => {
    const { server, db } = setup();
    const gone = seedSynced(server, db, INBOX);
    const kept = seedSynced(server, db, INBOX);
    server.expungeOnServer(INBOX, gone);
    const deleted: Array<{ id: string; uid: number }> = [];

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage(), (id, uid) =>
      deleted.push({ id, uid }));

    expect(res).toEqual({ selected: true, removed: 1 });
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid)).toEqual([kept]);
    expect(deleted).toEqual([{ id: expect.any(String), uid: gone }]);
    // The folder badge must be recomputed — a QRESYNC removal is invisible to the
    // count otherwise.
    expect(db.callCount('recalculateFolderCounts')).toBe(1);
  });

  it('a UIDVALIDITY MISMATCH yields NO vanished-based deletions', async () => {
    const { server, db } = setup();
    seedSynced(server, db, INBOX);
    seedSynced(server, db, INBOX);
    server.expungeOnServer(INBOX, 1);
    // The server's UID space was recreated: our stored validity (1) no longer
    // addresses it, so the server reports no VANISHED and we must delete nothing.
    // The wipe-and-refetch belongs to FolderSyncer.handleUidValidity.
    server.bumpUidValidity(INBOX, 99);

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res).toEqual({ selected: true, removed: 0 });
    expect(db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
    expect(db.allRows()).toHaveLength(2);
  });

  it('IGNORES VANISHED from a NON-COMPLIANT server that changed UIDVALIDITY (belt-and-suspenders)', async () => {
    // RFC 7162 says a UIDVALIDITY mismatch must suppress VANISHED (EARLIER) — the
    // test above covers a compliant server. But a broken server could return UIDs
    // anyway; under the new validity those UIDs address DIFFERENT messages, so
    // applying them would delete live mail. We must detect the validity change from
    // the SELECT status and delete nothing, deferring to the re-key path.
    const { server, db } = setup();
    const a = seedSynced(server, db, INBOX);
    const b = seedSynced(server, db, INBOX);
    vi.spyOn(server, 'selectFolderWithQresync').mockResolvedValue({
      status: { uidValidity: 999 },
      vanishedUids: [a, b], // server wrongly reports our rows as vanished
    } as never);

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res).toEqual({ selected: true, removed: 0 });
    expect(db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
    expect(db.allRows()).toHaveLength(2); // both survive
  });

  it('a FAILED resync SELECT is "we learned nothing", never "nothing changed"', async () => {
    const { server, db } = setup();
    seedSynced(server, db, INBOX);
    vi.spyOn(server, 'selectFolderWithQresync').mockRejectedValue(new Error('resync failed'));

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    // selected:false matters as much as removed:0 — the caller must know the
    // folder was NOT opened and still needs its own SELECT.
    expect(res).toEqual({ selected: false, removed: 0 });
    expect(db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
    expect(db.allRows()).toHaveLength(1);
  });

  it('no-ops WITHOUT selecting when the server lacks QRESYNC', async () => {
    const { server, db } = setup({ qresync: false });
    seedSynced(server, db, INBOX);

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res).toEqual({ selected: false, removed: 0 });
    expect(server.callCount('selectFolderWithQresync')).toBe(0);
  });

  it('no-ops when there is no usable stored modseq (first sync, 0, or negative)', async () => {
    const { server, db } = setup();
    seedSynced(server, db, INBOX);
    server.expungeOnServer(INBOX, 1);

    for (const highestModseq of [null, 0, -1]) {
      const folder = { ...db.folder(INBOX), highestModseq } as FolderRecord;
      expect(await applyQresyncVanished(server, folder, db.asStorage())).toEqual({ selected: false, removed: 0 });
    }
    expect(server.callCount('selectFolderWithQresync')).toBe(0);
    expect(db.allRows()).toHaveLength(1);
  });

  it('no-ops when the folder has no stored uidValidity (nothing to resync FROM)', async () => {
    const { server, db } = setup();
    seedSynced(server, db, INBOX);
    server.expungeOnServer(INBOX, 1);

    const folder = { ...db.folder(INBOX), uidValidity: null } as FolderRecord;

    expect(await applyQresyncVanished(server, folder, db.asStorage())).toEqual({ selected: false, removed: 0 });
    expect(db.allRows()).toHaveLength(1);
  });

  it('UNLINKS a multi-folder (Gmail-label) row instead of destroying it', async () => {
    const { server, db } = setup();
    db.addFolder('Archive');
    // Same message visible in INBOX and Archive. Expunged from INBOX only — the
    // row must survive with its Archive membership, primary repointed.
    const uid = seedSynced(server, db, INBOX, ['Archive']);
    server.expungeOnServer(INBOX, uid);

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res.removed).toBe(1);
    expect(db.allRows()).toHaveLength(1);
    const row = db.allRows()[0];
    expect(db.tagsOf(row.id)).toEqual(['Archive']);
    expect(row.folderId).toBe(db.folderId('Archive'));
    // The INBOX uid is meaningless in Archive's UID space — it must be cleared so
    // Archive's next sync stamps the right one (a stale uid here is what made
    // restored mail vanish again on the next reconcile).
    expect(row.uid).toBeNull();
  });

  it('IGNORES vanished UIDs that were never local (no delete, no recount)', async () => {
    const { server, db } = setup();
    const kept = seedSynced(server, db, INBOX);
    // Expunge a message we never synced: nothing to reconcile.
    const neverLocal = server.addMessage(INBOX);
    server.expungeOnServer(INBOX, neverLocal);

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res).toEqual({ selected: true, removed: 0 });
    expect(db.callCount('unlinkOrDeleteEmailsFromFolder')).toBe(0);
    // No rows changed → no recount (a full recount on every empty tick was pure cost).
    expect(db.callCount('recalculateFolderCounts')).toBe(0);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid)).toEqual([kept]);
  });

  it('reports selected:true with nothing to do when the server lists NO vanished UIDs', async () => {
    const { server, db } = setup();
    seedSynced(server, db, INBOX);

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res).toEqual({ selected: true, removed: 0 });
    expect(db.allRows()).toHaveLength(1);
  });

  it('CHUNKS a huge VANISHED backlog and still applies every row', async () => {
    const { server, db } = setup();
    // A folder that drifted behind an auto-expiring server: 1200 expunged UIDs
    // must not become one giant transaction (main-thread stall) — but every row
    // still has to go.
    const uids = Array.from({ length: 1200 }, () => seedSynced(server, db, INBOX));
    const survivor = seedSynced(server, db, INBOX);
    for (const uid of uids) server.expungeOnServer(INBOX, uid);
    const resolveSpy = vi.spyOn(db, 'getEmailIdsByFolderAndUids');

    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res.removed).toBe(1200);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid)).toEqual([survivor]);
    // 1200 / 500 = 3 chunks, none of them larger than the chunk size.
    expect(resolveSpy).toHaveBeenCalledTimes(3);
    for (const [, chunk] of resolveSpy.mock.calls) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it('still reports the removals when the post-reconcile RECOUNT fails', async () => {
    const { server, db } = setup();
    const gone = seedSynced(server, db, INBOX);
    server.expungeOnServer(INBOX, gone);
    vi.spyOn(db, 'recalculateFolderCounts').mockRejectedValue(new Error('db busy'));

    // A failed badge recount must not throw out of the sync or lose the fact that
    // the rows were reconciled — the count self-heals on the next pass.
    const res = await applyQresyncVanished(server, db.folder(INBOX), db.asStorage());

    expect(res).toEqual({ selected: true, removed: 1 });
    expect(db.allRows()).toHaveLength(0);
  });
});
