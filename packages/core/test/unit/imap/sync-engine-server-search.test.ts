import { describe, expect, it, vi } from 'vitest';

import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';

import { SyncEngine } from '../../../src/imap/sync-engine';

// Server search reaches past the local index: SEARCH the folder on the server,
// then DOWNLOAD only the matches we don't already hold so the normal local search
// surfaces them. Regressions here look like "the mail is on the server but search
// never finds it", or a re-search that re-downloads what's already local — no
// crash, just wrong results or wasted fetches.

const INBOX = 'INBOX';

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer({ qresync: true, condstore: true });
  server.addFolder(INBOX, { uidValidity: 1 });
  const db = new FakeEmailStorage();
  db.addFolder(INBOX, { uidValidity: 1 });
  const engine = new SyncEngine(db.asStorage());
  vi.spyOn(engine, 'isConnected').mockReturnValue(true);
  (engine as unknown as { isSyncing: () => boolean }).isSyncing = () => false;
  (engine as unknown as { connectionManager: { _client: unknown } }).connectionManager._client = server;
  (engine as unknown as { reselectMonitoredFolder: () => Promise<void> }).reselectMonitoredFolder = async () => {};
  return { server, db, engine };
}

describe('SyncEngine.serverSearch', () => {
  it('downloads server matches missing locally and skips ones already stored', async () => {
    // Regression: the whole point — matches the local index never saw must be
    // fetched, and matches already in the DB must NOT be re-downloaded.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 5; i++) server.addMessage(INBOX, { uid: i, subject: `report q${i}`, messageId: `<r${i}@t>` });
    server.addMessage(INBOX, { uid: 6, subject: 'invoice', messageId: '<i6@t>' });
    // uid 1,2 already local → alreadyLocal, must be left alone.
    db.seedEmail({ folderId: db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<r1@t>' });
    db.seedEmail({ folderId: db.folderId(INBOX), uid: 2, tags: `|${INBOX}|`, messageId: '<r2@t>' });

    const result = await engine.serverSearch(INBOX, { subject: 'report' });

    expect(result).toMatchObject({ matched: 5, alreadyLocal: 2, inserted: 3 });
    // uid 3,4,5 downloaded; 1,2 kept; 'invoice' (uid 6) never matched.
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('recalculates folder counts after downloading new matches', async () => {
    // Regression: a download that doesn't recount leaves the folder's unread/total
    // badge disagreeing with the list — the classic "count drifts" bug.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 3; i++) server.addMessage(INBOX, { uid: i, subject: `note ${i}`, messageId: `<n${i}@t>` });
    const recount = vi.spyOn(db, 'recalculateFolderCounts');

    await engine.serverSearch(INBOX, { subject: 'note' });

    expect(recount).toHaveBeenCalledWith([INBOX]);
  });

  it('reports matched but inserts nothing when every match is already local', async () => {
    // Regression: a re-run of the same search must be a no-op download — otherwise
    // each search re-fetches the same mail and hammers the server.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 3; i++) server.addMessage(INBOX, { uid: i, subject: `memo ${i}`, messageId: `<m${i}@t>` });
    for (let i = 1; i <= 3; i++) db.seedEmail({ folderId: db.folderId(INBOX), uid: i, tags: `|${INBOX}|`, messageId: `<m${i}@t>` });
    const recount = vi.spyOn(db, 'recalculateFolderCounts');

    const result = await engine.serverSearch(INBOX, { subject: 'memo' });

    expect(result).toMatchObject({ matched: 3, alreadyLocal: 3, inserted: 0 });
    expect(db.rowsPrimaryIn(INBOX)).toHaveLength(3);
    expect(recount).not.toHaveBeenCalled(); // no inserts → no recount work
  });

  it('returns a zeroed result when the server matches nothing', async () => {
    // Regression: a no-match search must resolve cleanly to zeros, not throw or
    // return null (null means "couldn't run", a different UI state).
    const { server, engine } = setup();
    for (let i = 1; i <= 3; i++) server.addMessage(INBOX, { uid: i, subject: `hello ${i}`, messageId: `<h${i}@t>` });

    const result = await engine.serverSearch(INBOX, { subject: 'nonexistent' });

    expect(result).toEqual({ matched: 0, alreadyLocal: 0, inserted: 0 });
  });

  it('fetches only the newest matches when the match set exceeds maxFetch', async () => {
    // Regression: an unbounded match set would fetch thousands of messages on the
    // main thread and stall the app. The cap must keep the NEWEST (highest UID).
    const { server, db, engine } = setup();
    for (let i = 1; i <= 10; i++) server.addMessage(INBOX, { uid: i, subject: `bulk ${i}`, messageId: `<b${i}@t>` });

    const result = await engine.serverSearch(INBOX, { subject: 'bulk' }, { maxFetch: 3 });

    expect(result).toMatchObject({ matched: 10, alreadyLocal: 0, inserted: 3 });
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([8, 9, 10]);
  });

  it('returns null when disconnected without touching the server', async () => {
    // Regression: offline search must fail closed (null), not attempt a SEARCH on
    // a dead socket. null lets the UI say "couldn't reach the server".
    const { server, engine } = setup();
    (engine.isConnected as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(false);
    const searchSpy = vi.spyOn(server, 'search');

    const result = await engine.serverSearch(INBOX, { subject: 'anything' });

    expect(result).toBeNull();
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('yields to a foreground sync on the shared primary socket', async () => {
    // Regression: with no pool, server search shares the primary IMAP socket. It
    // must NOT barge in mid-sync — that corrupts the selected-folder state.
    const { server, engine } = setup();
    (engine as unknown as { isSyncing: () => boolean }).isSyncing = () => true;
    const searchSpy = vi.spyOn(server, 'search');

    const result = await engine.serverSearch(INBOX, { subject: 'anything' });

    expect(result).toBeNull();
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('returns null (no throw) when the server SEARCH fails', async () => {
    // Regression: a transient server error must be swallowed to null, not bubble
    // up and crash the search flow. The user retries; nothing is left half-done.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 3; i++) server.addMessage(INBOX, { uid: i, subject: `x ${i}`, messageId: `<x${i}@t>` });
    vi.spyOn(server, 'search').mockRejectedValueOnce(new Error('temporary server failure'));

    const result = await engine.serverSearch(INBOX, { subject: 'x' });

    expect(result).toBeNull();
    expect(db.rowsPrimaryIn(INBOX)).toHaveLength(0);
  });

  it('returns null when the folder is unknown locally', async () => {
    // Regression: searching a folder we don't track must fail closed rather than
    // fetch into a null folder and mis-file the results.
    const { engine } = setup();
    const result = await engine.serverSearch('Nonexistent', { subject: 'x' });
    expect(result).toBeNull();
  });
});
