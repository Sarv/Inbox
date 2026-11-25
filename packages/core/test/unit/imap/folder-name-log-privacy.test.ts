import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';
import { OperationQueue } from '../../../src/imap/operation-queue';
import { RealtimeManager } from '../../../src/imap/realtime-manager';
import { SyncEngine } from '../../../src/imap/sync-engine';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import { captureLogs, type CapturedLogs } from '../../../src/test-support/log-capture';
import { IMAPError, type IMAPFolder } from '../../../src/types/imap';
import type { IEmailStorage } from '../../../src/types/storage';
import { accountIdFor } from '../../../src/utils/id';
import { folderLogLabel, labelLogLabel } from '../../../src/utils/log-labels';
import { getLogLevel, setLogLevel, setLogSink } from '../../../src/utils/logger';

// app.log ships with bug reports and crash reports carry its recent lines. A
// folder's name is text the user typed (a client, a person, a project), so the
// IMAP layer writes it as `folder#<hash>`; a custom keyword or label the same
// way as `label#<hash>`. These tests drive the real classes against the
// in-memory server with a user-named folder and fail on any line that spells
// the name, the owner's address or the account id — and on a run that stops
// writing the lines altogether, which would pass a "nothing leaked" check by
// saying nothing.

const FOLDER = 'Clients/Acme-Sentinel-7f3';
const OTHER = 'Clients/Beta-Acme-Sentinel-7f3';
const OWNER = 'owner.sentinel@example.com';
// No class under src/imap takes an account id (the desktop layer owns it), so
// it cannot be handed to them; it is still checked for, with the address it is
// built from, in case a line ever starts writing either.
const ACCOUNT_ID = accountIdFor(OWNER, 'imap.example.com');
const SENTINELS = ['Acme-Sentinel-7f3', 'owner-sentinel', 'owner.sentinel', ACCOUNT_ID];
const FOLDER_LABEL = folderLogLabel(FOLDER);

const imapFolder = (path: string): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children: [],
});

/** The lines that spell anything the user named. Empty is the pass. */
const leaks = (logs: CapturedLogs): string[] =>
  logs.lines.filter((line) => SENTINELS.some((sentinel) => line.includes(sentinel)));

/** What an ImapFlow command failure looks like once toImapError has wrapped it:
 *  the server's text and the command we sent, both quoting the mailbox. */
const serverError = (code: string) =>
  new IMAPError(
    `Command failed: NO [UNAVAILABLE] Mailbox ${FOLDER} is busy (cmd: SELECT "${FOLDER}")`,
    code,
    `[UNAVAILABLE] Mailbox ${FOLDER} is busy`,
    `SELECT "${FOLDER}"`,
    'NO',
  );

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

function engineSetup() {
  const server = new FakeImapServer({ condstore: true, host: 'imap.example.com' });
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
  const mail = (subject: string) => ({ subject, from: 'sender@example.org', to: [OWNER] });
  return { server, db, engine, mail };
}

describe('SyncEngine — a user-named folder never reaches app.log', () => {
  // Regression: a user-named folder's name reaches app.log on every sync line
  // (full sync, incremental sync, flag reconcile, deletion reconcile).
  it('labels the folder through a full sync and an incremental sync', async () => {
    const { server, db, engine, mail } = engineSetup();
    const [first] = server.addMessages(FOLDER, 3, mail('Quarterly numbers'));

    await engine.syncAll();
    expect(db.rowsTaggedWith(FOLDER)).toHaveLength(3); // the sync really ran

    // Another client reads one, deletes one, and two new ones arrive.
    server.setFlagsOnServer(FOLDER, first, ['\\Seen']);
    server.expungeOnServer(FOLDER, first + 1);
    server.addMessages(FOLDER, 2, mail('Follow-up'));
    await engine.syncAll();
    expect(db.rowsTaggedWith(FOLDER)).toHaveLength(4);

    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`Full sync ${FOLDER_LABEL}`)).not.toEqual([]);
    expect(logs.containing(`Incremental sync ${FOLDER_LABEL}`)).not.toEqual([]);
    // System folders stay readable: the label only replaces what the user named.
    expect(logs.containing('Syncing 2 folders: INBOX, ' + FOLDER_LABEL)).not.toEqual([]);
  });

  // Regression (transient): a timed-out batch logs the server's text, which
  // names the mailbox, on its way to "continuing".
  it('labels the folder and drops the error text when a full-sync batch fails', async () => {
    const { server, engine, mail } = engineSetup();
    server.addMessages(FOLDER, 3, mail('Retainer'));
    vi.spyOn(server, 'fetchMessages').mockRejectedValueOnce(
      Object.assign(new Error(`IMAP FETCH timed out in ${FOLDER}`), { code: 'ETIMEDOUT' }),
    );

    await engine.syncAll();

    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`Full sync ${FOLDER_LABEL}: batch`).join('\n')).toContain('failed: ETIMEDOUT; continuing');
  });

  // Regression (permanent): the folder-level failure logs the whole IMAPError,
  // whose message, server response and command all quote the mailbox.
  it('logs a failed folder sync by label and error code only', async () => {
    const { server, engine, mail } = engineSetup();
    server.addMessages(FOLDER, 2, mail('Contract'));
    const select = server.selectFolder.bind(server);
    vi.spyOn(server, 'selectFolder').mockImplementation(async (path: string) => {
      if (path === FOLDER) throw serverError('SELECT_FOLDER_ERROR');
      return select(path);
    });

    await engine.syncAll();

    expect(leaks(logs)).toEqual([]);
    const failed = logs.containing(`Failed to sync folder ${FOLDER_LABEL}`);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("code: 'SELECT_FOLDER_ERROR'");
  });

  // Regression (partial run + re-run): an incremental fetch that fails, then
  // succeeds on the next pass, must not write the name on either pass.
  it('labels the folder when an incremental fetch fails and the re-run recovers', async () => {
    const { server, db, engine, mail } = engineSetup();
    server.addMessages(FOLDER, 2, mail('Invoice'));
    await engine.syncAll();
    server.addMessages(FOLDER, 2, mail('Invoice, again'));
    vi.spyOn(server, 'fetchMessagesByUidRange').mockRejectedValueOnce(serverError('FETCH_ERROR'));

    await engine.syncAll(); // the failing pass
    // The default re-run (skipUnchanged): a failed pass leaves the folder to be
    // checked again (see skip-unchanged-after-failure.test.ts).
    await engine.syncAll();

    expect(db.rowsTaggedWith(FOLDER)).toHaveLength(4);
    expect(leaks(logs)).toEqual([]);
    const failed = logs.containing(`Failed to sync folder ${FOLDER_LABEL}`);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("code: 'FETCH_ERROR'");
  });

  // Regression (multi-account): two accounts syncing side by side each write
  // their own folder by label; one engine's lines never carry the other's name.
  it('labels each account\'s folders when two accounts sync side by side', async () => {
    const first = engineSetup();
    const second = engineSetup();
    second.server.addFolder(OTHER, { uidValidity: 9 });
    second.db.addFolder(OTHER, { uidValidity: 9 });
    vi.spyOn(second.server, 'listFolders').mockResolvedValue([imapFolder('INBOX'), imapFolder(OTHER)]);
    first.server.addMessages(FOLDER, 2, first.mail('Ledger'));
    second.server.addMessages(OTHER, 2, second.mail('Ledger'));

    await Promise.all([first.engine.syncAll(), second.engine.syncAll()]);

    expect(second.db.rowsTaggedWith(OTHER)).toHaveLength(2);
    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`Full sync ${FOLDER_LABEL}`)).toHaveLength(1);
    expect(logs.containing(`Full sync ${folderLogLabel(OTHER)}`)).toHaveLength(1);
  });
});

/** The pending-operation rows the queue persists before it sends a command. */
function queueStorage(db: FakeEmailStorage): IEmailStorage {
  const ops = new Map<number, { id: number; type: string; folderPath: string; uid: number; data?: unknown; status: string; retryCount: number }>();
  let seq = 0;
  const save = (op: { type: string; folderPath: string; uid: number; data?: unknown; retryCount: number }) => {
    const id = ++seq;
    ops.set(id, { ...op, id, status: 'pending' });
    return id;
  };
  const storage = {
    getFolderByPath: (path: string) => db.getFolderByPath(path),
    getFolders: () => db.getFolders(),
    getEmail: (id: string) => db.getEmail(id),
    updateEmail: (id: string, updates: Record<string, unknown>) => db.updateEmail(id, updates),
    getEmailByFolderAndUid: async () => null,
    savePendingOperation: async (op: Parameters<typeof save>[0]) => save(op),
    savePendingOperationsBatch: async (list: Array<Parameters<typeof save>[0]>) => list.map(save),
    getPendingOperations: async () => [...ops.values()].filter((op) => op.status !== 'failed'),
    getFailedOperations: async () => [...ops.values()].filter((op) => op.status === 'failed'),
    getPendingOperationUidsByFolder: async () => [],
    updatePendingOperationStatus: async (id: number, status: string) => { const op = ops.get(id); if (op) op.status = status; },
    updatePendingOperationRetry: async () => {},
    deletePendingOperation: async (id: number) => { ops.delete(id); },
    deletePendingOperationsBatch: async (ids: number[]) => { for (const id of ids) ops.delete(id); },
    markPendingOperationFailed: async (id: number) => { const op = ops.get(id); if (op) op.status = 'failed'; },
  };
  return storage as unknown as IEmailStorage;
}

describe('OperationQueue — a user-named folder never reaches app.log', () => {
  async function queueSetup() {
    const server = new FakeImapServer({ host: 'imap.example.com' });
    await server.connect();
    server.addFolder('INBOX');
    server.addFolder(FOLDER);
    server.addFolder(OTHER);
    const db = new FakeEmailStorage();
    db.addFolder(FOLDER);
    // OTHER is deliberately missing locally, so the move's UID writeback takes
    // its "destination folder not found" line.
    const queue = new OperationQueue();
    queue.initialize({ client: server, storage: queueStorage(db), isConnected: () => true, isSyncing: () => false });
    const uids = server.addMessages(FOLDER, 3, { from: 'sender@example.org', to: [OWNER] });
    return { server, queue, uids };
  }

  // Regression: a mark-read, a move between two user folders and a server
  // label each write the folder or label name on their command line.
  it('labels the folder on mark-read, move and server-label lines', async () => {
    const { server, queue, uids } = await queueSetup();

    await queue.markAsRead(FOLDER, uids[0]);
    await queue.move(FOLDER, uids[1], OTHER);
    await queue.createServerLabel('Acme-Sentinel-7f3 retainers');

    expect(server.flagsOf(FOLDER, uids[0])).toContain('\\Seen'); // the ops really ran
    expect(server.messageCount(OTHER)).toBe(1);
    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`mark-read folder="${FOLDER_LABEL}"`)).toHaveLength(1);
    expect(logs.containing(`remapMovedUids: destination folder not found for "${folderLogLabel(OTHER)}"`)).toHaveLength(1);
    expect(logs.containing(`CREATE "${labelLogLabel('Acme-Sentinel-7f3 retainers')}"`)).toHaveLength(1);
  });

  // Regression (permanent): a dead-lettered move logs the whole IMAPError,
  // whose text and command name both folders.
  it('logs a dead-lettered move by error code, not by its text', async () => {
    const { server, queue, uids } = await queueSetup();
    vi.spyOn(server, 'moveMessages').mockRejectedValueOnce(serverError('MOVE_ERROR'));

    await expect(queue.move(FOLDER, uids[2], OTHER)).rejects.toThrow();

    expect(leaks(logs)).toEqual([]);
    const failed = logs.containing('failed (dead-lettered)');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("code: 'MOVE_ERROR'");
  });
});

describe('RealtimeManager — a user-named folder never reaches app.log', () => {
  // Regression: IDLE start, the polling fallback and its failure line write the
  // monitored folder's name.
  it('labels the monitored folder on IDLE start and on the polling fallback', async () => {
    const server = new FakeImapServer({ idle: true, host: 'imap.example.com' });
    await server.connect();
    server.addFolder(FOLDER);
    const db = new FakeEmailStorage();
    db.addFolder(FOLDER);
    const realtime = new RealtimeManager({ periodicSyncIntervalMs: 0 });
    realtime.initialize({ client: server, storage: db.asStorage() });
    try {
      expect(await realtime.start(FOLDER)).toBe('idle');
      await realtime.stop();

      // IDLE refused (the server's text names the mailbox): polling takes over.
      vi.spyOn(server, 'startIdle').mockRejectedValueOnce(serverError('IDLE_ERROR'));
      expect(await realtime.start(FOLDER)).toBe('polling');
    } finally {
      await realtime.stop();
    }

    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`IDLE started for ${FOLDER_LABEL}`)).toHaveLength(1);
    expect(logs.containing(`Polling started for ${FOLDER_LABEL}`)).toHaveLength(1);
    expect(logs.containing('Failed to start IDLE').join('\n')).toContain("code: 'IDLE_ERROR'");
  });
});

describe('ImapFlowClient keyword STORE line', () => {
  /** A client whose ImapFlow connection is a stub, selected on `mailbox`. */
  function storeClient(mailbox: string | undefined) {
    const client = new ImapFlowClient();
    const inner = {
      usable: true,
      mailbox: mailbox === undefined ? false : { path: mailbox },
      messageFlagsAdd: vi.fn(async () => true),
      fetchAll: vi.fn(async () => [{ uid: 4, flags: new Set(['\\Seen', 'Acme-Sentinel-7f3', '$Finance']) }]),
      stats: () => ({ sent: 0, received: 0 }),
    };
    Object.assign(client as unknown as Record<string, unknown>, {
      client: inner, connectionState: 'selected', currentFolder: mailbox ?? null, capabilities: [], connectedHost: 'imap.example.com',
    });
    return { client, inner };
  }

  // Regression: the category-label STORE line writes the user's keyword and the
  // folder it was stored in, as typed.
  it('labels custom keywords and the folder, and still sends them as typed', async () => {
    const { client, inner } = storeClient(FOLDER);

    await client.addFlags([4], ['\\Seen', 'Acme-Sentinel-7f3']);

    expect(inner.messageFlagsAdd).toHaveBeenCalledWith([4], ['\\Seen', 'Acme-Sentinel-7f3'], { uid: true });
    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`+FLAGS (${labelLogLabel('Acme-Sentinel-7f3')}) in "${FOLDER_LABEL}" → matched=true`)).toHaveLength(1);
  });

  // Regression: the SARV_DEBUG_KEYWORDS read-back writes every keyword the
  // server holds; system flags must stay readable.
  it('labels keywords in the SARV_DEBUG_KEYWORDS read-back but keeps system flags', async () => {
    vi.stubEnv('SARV_DEBUG_KEYWORDS', '1');
    try {
      const { client } = storeClient(FOLDER);
      await client.addFlags([4], ['Acme-Sentinel-7f3']);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(leaks(logs)).toEqual([]);
    expect(logs.containing(`uid 4: [\\Seen ${labelLogLabel('Acme-Sentinel-7f3')} ${labelLogLabel('$Finance')}]`)).toHaveLength(1);
  });

  // A STORE with no mailbox reported still says so, as before.
  it('writes "?" when the connection reports no mailbox', async () => {
    const { client } = storeClient(undefined);
    await client.addFlags([4], ['Acme-Sentinel-7f3']);
    expect(logs.containing('in "?" → matched=true')).toHaveLength(1);
  });

  // System-flag STOREs (the sync hot path) stay silent.
  it('writes no line for a system-flag STORE', async () => {
    const { client } = storeClient(FOLDER);
    await client.addFlags([4], ['\\Seen']);
    expect(logs.containing('UID STORE')).toEqual([]);
  });
});
