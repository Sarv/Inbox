import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import { captureLogs, type CapturedLogs } from '../../../src/test-support/log-capture';
import { IMAPError, type IMAPFolder } from '../../../src/types/imap';
import { folderLogLabel } from '../../../src/utils/log-labels';
import { getLogLevel, setLogLevel, setLogSink } from '../../../src/utils/logger';

/**
 * A folder recorded as caught up only when it is.
 *
 * Every default sync (the periodic one included) runs with skipUnchanged: a
 * folder whose server STATUS (UIDVALIDITY, EXISTS, UIDNEXT) matches what the
 * last sync recorded is skipped. The UIDNEXT used to be recorded at the START
 * of a folder's sync, before the fetch. A fetch that then failed — a timeout, a
 * dropped connection, a busy server — left the folder looking caught up, so
 * every later sync skipped it and the new mail stayed on the server until
 * something else changed there. Nothing reported an error after the first
 * pass: mail just quietly stopped arriving.
 *
 * What breaks if this file fails: mail that a failed or partial pass missed is
 * not fetched by the next sync; or a folder that IS caught up is synced again
 * on every pass (the skip stops working).
 */

const FOLDER = 'Projects';
const LABEL = folderLogLabel(FOLDER);

const imapFolder = (path: string): IMAPFolder => ({
  name: path, path, delimiter: '/', specialUse: null, subscribed: true, selectable: true, children: [],
});

const timeout = () => Object.assign(new Error('IMAP FETCH timed out'), { code: 'ETIMEDOUT' });
const refused = () => new IMAPError('Command failed: BAD Invalid messageset', 'FETCH_ERROR', 'Invalid messageset', 'UID FETCH', 'BAD');

let logs: CapturedLogs;
beforeEach(() => {
  resetFakeMessageIds();
  resetFakeStorageIds();
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => {
  logs.stop();
  vi.restoreAllMocks();
});

/** One account: a fake server with INBOX and FOLDER, and an engine wired to it. */
function account(host = 'imap.example.com') {
  const server = new FakeImapServer({ condstore: true, host });
  server.addFolder('INBOX', { uidValidity: 1 });
  server.addFolder(FOLDER, { uidValidity: 7 });
  const db = new FakeEmailStorage();
  db.addFolder('INBOX', { uidValidity: 1 });
  db.addFolder(FOLDER, { uidValidity: 7 });
  const engine = new SyncEngine(db.asStorage());
  vi.spyOn(engine, 'isConnected').mockReturnValue(true);
  const internals = engine as unknown as {
    connectionManager: { _client: unknown; ensureConnection: () => Promise<boolean> };
    reselectMonitoredFolder: () => Promise<void>;
  };
  internals.connectionManager._client = server;
  internals.connectionManager.ensureConnection = async () => true;
  internals.reselectMonitoredFolder = async () => {};
  vi.spyOn(server, 'listFolders').mockResolvedValue([imapFolder('INBOX'), imapFolder(FOLDER)]);
  const add = (count: number) => server.addMessages(FOLDER, count, { subject: 'Status', from: 'sender@example.org', to: ['me@example.com'] });
  const rows = () => db.rowsTaggedWith(FOLDER).length;
  return { server, db, engine, add, rows };
}

/** How many of `logs` say FOLDER was skipped as unchanged. */
const skipped = (): number => logs.containing(`Skipping unchanged: ${LABEL}`).length;

describe('a failed incremental fetch', () => {
  // THE bug: a transient failure of the incremental fetch, then the next
  // default sync skipped the folder as unchanged and the mail never landed.
  it('leaves the folder to be fetched by the next default sync (transient failure)', async () => {
    const a = account();
    a.add(2);
    await a.engine.syncAll();
    a.add(2);
    vi.spyOn(a.server, 'fetchMessagesByUidRange').mockRejectedValueOnce(timeout());

    await a.engine.syncAll(); // fails
    expect(a.rows()).toBe(2);
    await a.engine.syncAll(); // the default: skipUnchanged

    expect(a.rows()).toBe(4);
    expect(skipped()).toBe(0);
  });

  // A failure that repeats (the server refuses the command every time) is
  // retried on every sync, not skipped silently after the first; when it
  // clears, the mail lands and the folder is skipped again from then on.
  it('retries a repeating (permanent) failure on every sync until it clears', async () => {
    const a = account();
    a.add(2);
    await a.engine.syncAll();
    a.add(1);
    const fetch = vi.spyOn(a.server, 'fetchMessagesByUidRange').mockRejectedValue(refused());

    await a.engine.syncAll();
    await a.engine.syncAll();
    expect(logs.containing(`Failed to sync folder ${LABEL}`)).toHaveLength(2);
    expect(skipped()).toBe(0);

    fetch.mockRestore();
    await a.engine.syncAll();
    expect(a.rows()).toBe(3);
    await a.engine.syncAll();
    expect(skipped()).toBe(1);
  });

  // Idempotent re-run: the recovery pass does not insert anything twice, and
  // a folder that is caught up is still skipped (the skip is what keeps a
  // quiet poll cheap).
  it('inserts nothing twice on recovery, and skips a caught-up folder', async () => {
    const a = account();
    a.add(3);
    await a.engine.syncAll();
    await a.engine.syncAll();
    expect(skipped()).toBe(1);

    a.add(2);
    vi.spyOn(a.server, 'fetchMessagesByUidRange').mockRejectedValueOnce(timeout());
    await a.engine.syncAll();
    await a.engine.syncAll();
    await a.engine.syncAll();

    expect(a.rows()).toBe(5);
    expect(new Set(a.db.rowsTaggedWith(FOLDER).map((row) => row.uid)).size).toBe(5);
    expect(skipped()).toBe(2);
  });
});

describe('a partial pass', () => {
  // Partial run: a full sync whose only batch failed used to record the
  // folder as caught up, so it stayed empty until new mail arrived.
  it('re-checks a folder whose full-sync batch failed', async () => {
    const a = account();
    a.add(3);
    vi.spyOn(a.server, 'fetchMessages').mockRejectedValueOnce(timeout());

    await a.engine.syncAll();
    expect(a.rows()).toBe(0);
    expect(logs.containing(`Full sync ${LABEL}: batch`).join('\n')).toContain('failed: ETIMEDOUT; continuing');
    await a.engine.syncAll();

    expect(a.rows()).toBe(3);
  });

  // Partial run: an incremental fetch whose lower window failed after the
  // newer one arrived keeps what arrived and holds the watermark below the
  // hole — and must also leave the folder for the next sync to finish.
  it('finishes an incremental fetch that was interrupted between windows', async () => {
    const a = account();
    a.add(2);
    await a.engine.syncAll();
    // New UIDs 3..102 with a run expunged from the middle: more than one paced
    // window (64 UIDs) apart, while the server still holds only 20 messages
    // (more would trip the low-local-count recovery into a full sync instead).
    const uids = a.add(100);
    for (const uid of uids.slice(9, 91)) a.server.expungeOnServer(FOLDER, uid);
    const real = a.server.fetchMessagesByUidRange.bind(a.server);
    let calls = 0;
    vi.spyOn(a.server, 'fetchMessagesByUidRange').mockImplementation(async (lo, hi, options) => {
      calls += 1;
      if (calls === 2) throw timeout(); // the newer window arrived; the older one fails
      return real(lo, hi, options);
    });

    await a.engine.syncAll();
    expect(a.rows()).toBe(2 + 9);
    expect(logs.containing('New-mail fetch stopped early').join('\n')).toContain('ETIMEDOUT');
    await a.engine.syncAll();

    expect(a.rows()).toBe(20);
    expect(skipped()).toBe(0);
  });

  // A flags-only pass fetches no new mail, so it must not record the folder
  // as caught up to a UIDNEXT whose messages it never fetched.
  it('does not let a flags-only pass hide new mail from the next sync', async () => {
    const a = account();
    a.add(2);
    await a.engine.syncAll();
    a.add(2);

    await a.engine.syncAll({ flagsOnly: true });
    expect(a.rows()).toBe(2);
    await a.engine.syncAll();

    expect(a.rows()).toBe(4);
  });
});

describe('two accounts', () => {
  // Multi-account: one account's failure leaves only ITS folder for a re-check;
  // the other account, caught up, keeps being skipped.
  it('re-checks only the account whose fetch failed', async () => {
    const a = account('imap.a.example');
    const b = account('imap.b.example');
    a.add(1);
    b.add(1);
    await Promise.all([a.engine.syncAll(), b.engine.syncAll()]);
    a.add(2);
    vi.spyOn(a.server, 'fetchMessagesByUidRange').mockRejectedValueOnce(timeout());

    await Promise.all([a.engine.syncAll(), b.engine.syncAll()]);
    await Promise.all([a.engine.syncAll(), b.engine.syncAll()]);

    expect(a.rows()).toBe(3);
    expect(b.rows()).toBe(1);
    // b was skipped on both later passes; a on neither.
    expect(skipped()).toBe(2);
  });
});

describe('when the bookkeeping write itself fails', () => {
  // A failed sync whose "re-check this folder" write also fails (storage is
  // what broke) is logged by its kind and does not throw out of the sync.
  it('logs the failed write and still reports the folder as failed', async () => {
    const a = account();
    a.add(2);
    await a.engine.syncAll();
    a.add(1);
    vi.spyOn(a.server, 'fetchMessagesByUidRange').mockRejectedValueOnce(timeout());
    const update = a.db.updateFolder.bind(a.db);
    vi.spyOn(a.db, 'updateFolder').mockImplementation(async (id, updates) => {
      if ('lastKnownUidnext' in updates && (updates as { lastKnownUidnext: unknown }).lastKnownUidnext === null) {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      }
      return update(id, updates);
    });

    await expect(a.engine.syncAll()).resolves.not.toThrow();

    expect(logs.containing(`Could not mark ${LABEL} for a re-check after a failed sync: SQLITE_BUSY`)).toHaveLength(1);
    expect(logs.containing(`Failed to sync folder ${LABEL}`)).toHaveLength(1);
  });
});
