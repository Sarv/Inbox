import { describe, expect, it } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';
import { withFolderSelected } from '../../../src/imap/with-folder';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IIMAPClient } from '../../../src/types/imap';


/**
 * The folder-selection race, end to end.
 *
 * On the shared primary connection the realtime manager re-selects INBOX on a
 * timer (IDLE re-arm, poll, coalesced flag sync) while folder-scoped work — a
 * flag reconcile, a deletion sweep, a Trash/All Mail drain — is midway through
 * its own select-then-fetch. The whole-mailbox fetches pass their folder as
 * `expectedPath`, so the loser of the race hits the `Mailbox mismatch` guard.
 * That guard is right — it stops the reconcile from matching ANOTHER mailbox's
 * UIDs onto this folder's rows, which is how flags get corrupted and rows get
 * deleted — but `syncFlags` swallows the fetch failure and returns "nothing
 * changed". The visible symptom is not an error: it is mail that quietly stops
 * agreeing with the server. Production logged 16 of these in three minutes.
 *
 * `withFolderSelected` fixes it by holding the connection's mailbox lock across
 * the whole sequence, so the barging re-select QUEUES instead of landing inside.
 */

const INBOX = 'INBOX';
const OTHER = 'Archive';
let folderSeq = 0;

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  folderSeq += 1;
  const server = new FakeImapServer();
  const db = new FakeEmailStorage();
  for (const path of [INBOX, OTHER]) {
    server.addFolder(path, { uidValidity: 1 });
    db.addFolder(path, { id: `f-${path}-race-${folderSeq}`, uidValidity: 1 });
  }
  // Five messages the server reports as read; the local rows still say unread,
  // so a reconcile that actually runs must report five updates.
  for (let i = 0; i < 5; i++) {
    const uid = server.addMessage(INBOX, { flags: ['\\Seen'] });
    db.seedEmail({ folderId: db.folderId(INBOX), uid, tags: `|${INBOX}|` });
  }
  return { server, db, mp: new MessageProcessor(), storage: db.asStorage() };
}

describe('flag reconcile under a concurrent re-select', () => {
  // THE regression. The reconcile must complete against its own folder while the
  // realtime timer re-selects INBOX's neighbour on the same connection.
  it('completes the reconcile instead of aborting on a mailbox mismatch', async () => {
    const { server, db, mp, storage } = setup();
    await server.selectFolder(INBOX);

    const reconcile = withFolderSelected(server, INBOX, () =>
      mp.syncFlags(server, db.folder(INBOX), storage));
    // The opportunistic re-select the realtime manager fires on a timer. It
    // needs no awareness of the lock — every select goes through it.
    const barge = server.selectFolder(OTHER);

    const [result] = await Promise.all([reconcile, barge]);

    expect(result.updated).toBe(5);
    // The barging select is not dropped — it runs, just after the section.
    expect(server.getCurrentFolder()).toBe(OTHER);
  });

  // The bug itself, pinned so the fix can't be quietly reverted: the SAME
  // sequence without the lock loses the mailbox and reports zero updates. A
  // client double with no `withFolder` stands in for the old select-then-work
  // shape (and for any IIMAPClient implementation that lacks the method).
  it('WITHOUT the lock the same race silently reconciles nothing', async () => {
    const { server, db, mp, storage } = setup();
    // The same connection with the lock taken away: `withFolderSelected` then
    // degrades to plain select-then-work, which is what every call site did
    // before this fix. Each SELECT is still atomic on its own — that was never
    // the problem; the sequence is what needs to be.
    const unlocked = server as unknown as { withFolder?: unknown };
    unlocked.withFolder = undefined;

    await server.selectFolder(INBOX);
    const reconcile = withFolderSelected(server, INBOX, () =>
      mp.syncFlags(server, db.folder(INBOX), storage));
    const barge = server.selectFolder(OTHER);

    const [result] = await Promise.all([reconcile, barge]);

    expect(result.updated).toBe(0);
    expect(server.getCurrentFolder()).toBe(OTHER);
  });

  // Idempotent re-run: once the race is survived, running the reconcile again
  // must be a no-op rather than re-reporting the same updates.
  it('is a no-op on an immediate re-run', async () => {
    const { server, db, mp, storage } = setup();
    await withFolderSelected(server, INBOX, () => mp.syncFlags(server, db.folder(INBOX), storage));

    const again = await withFolderSelected(server, INBOX, () =>
      mp.syncFlags(server, db.folder(INBOX), storage));

    expect(again.updated).toBe(0);
  });

  // Multi-account: two accounts are two connections, each with its own lock.
  // Interleaved work on both must still reconcile both — a lock that was shared
  // across accounts would serialize every account's sync behind the slowest.
  it('reconciles two accounts concurrently', async () => {
    const first = setup();
    const second = setup();
    await Promise.all([first.server.selectFolder(INBOX), second.server.selectFolder(INBOX)]);

    const [a, b] = await Promise.all([
      withFolderSelected(first.server, INBOX, () =>
        first.mp.syncFlags(first.server, first.db.folder(INBOX), first.storage)),
      withFolderSelected(second.server, INBOX, () =>
        second.mp.syncFlags(second.server, second.db.folder(INBOX), second.storage)),
    ]);

    expect(a.updated).toBe(5);
    expect(b.updated).toBe(5);
  });
});

describe('withFolderSelected', () => {
  it('selects the folder before running the section', async () => {
    const { server } = setup();
    await server.selectFolder(OTHER);

    const seen = await withFolderSelected(server, INBOX, async () => server.getCurrentFolder());

    expect(seen).toBe(INBOX);
  });

  it('hands back the section value and propagates its failure', async () => {
    const { server } = setup();

    await expect(withFolderSelected(server, INBOX, async () => 'value')).resolves.toBe('value');
    await expect(
      withFolderSelected(server, INBOX, async () => { throw new Error('transient blip'); }),
    ).rejects.toThrow('transient blip');
  });

  // `select: false` is for a section that issues its own specialised SELECT (the
  // QRESYNC resynchronising select, whose VANISHED response is the whole point).
  // It must take the lock without spending a redundant SELECT round-trip.
  it('skips the select when select is false', async () => {
    const { server } = setup();
    await server.selectFolder(OTHER);
    const before = server.callCount('selectFolder');

    const seen = await withFolderSelected(server, INBOX, async () => server.getCurrentFolder(), {
      select: false,
    });

    expect(seen).toBe(OTHER);
    expect(server.callCount('selectFolder')).toBe(before);
  });

  // A client that doesn't implement the optional method must degrade to the old
  // select-then-work behaviour, not throw — pooled/worker doubles and any future
  // IIMAPClient implementation go through this same helper.
  it('falls back to a plain select on a client without withFolder', async () => {
    const selected: string[] = [];
    const legacy = {
      selectFolder: async (path: string) => { selected.push(path); },
    } as unknown as IIMAPClient;

    await expect(withFolderSelected(legacy, INBOX, async () => 'ran')).resolves.toBe('ran');
    expect(selected).toEqual([INBOX]);
  });

  it('skips even the fallback select when select is false', async () => {
    const selected: string[] = [];
    const legacy = {
      selectFolder: async (path: string) => { selected.push(path); },
    } as unknown as IIMAPClient;

    await withFolderSelected(legacy, INBOX, async () => undefined, { select: false });

    expect(selected).toEqual([]);
  });
});
