import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: a message the user sent never reaches their
// Sent folder ON THE SERVER — so it is gone from every other device and from a
// reinstall — and the app wedges an IMAP connection every minute trying.
//
// The live failure, 2026-09-27: the dedupe scan ahead of the APPEND fetched an
// envelope for all 1,718 messages in Sent, ran past the client's 60s op
// timeout, and the client recycled the connection as wedged. The scan's own
// error was swallowed ("will still append") and the APPEND then ran on the
// socket that had just been dropped — failing with "Not connected to IMAP
// server" every single time, for as long as the app stayed open.
//
// Two rules come out of that: ask for a bounded window, and never append over a
// connection the scan just killed.

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  shell: {},
  app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: vi.fn(),
  getStorage: vi.fn(),
  getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(),
  getSyncEngineFor: vi.fn(),
  getSmtpClient: vi.fn(),
  getSmtpClientFor: vi.fn(),
  setSmtpClient: vi.fn(),
  setSmtpClientFor: vi.fn(),
  getMainWindow: vi.fn(),
  getCurrentAccountId: vi.fn(() => 'acct-1'),
  getAllAccountIds: vi.fn(() => []),
  sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserName: vi.fn(() => 'Me'),
}));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(),
  drainOutbox: vi.fn(),
  getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(),
  notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));

import { appendSentCopy } from '../../../../electron/ipc/smtp-handlers';
import { getStorage, getSyncEngine } from '../../../../electron/shared';

const RAW = 'Message-ID: <m@x>\r\n\r\nbody';
const MESSAGE_ID = '<m@x>';
const PAYLOAD = { to: ['them@test.example'], subject: 'hi' } as never;

/** A connection that answers the dedupe scan however the test wants. */
function makeConnection(over: Record<string, unknown> = {}) {
  return {
    selectFolder: vi.fn(async () => {}),
    fetchMessageIdToUidMap: vi.fn(
      async (_path?: string, _options?: { recent?: number }) => new Map<string, number>(),
    ),
    appendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ...over,
  };
}

function wire(conn: ReturnType<typeof makeConnection>) {
  vi.mocked(getStorage).mockReturnValue({
    getFolders: async () => [{ id: 'f-sent', name: 'Sent', path: 'Sent', specialUse: '\\Sent' }],
  } as never);
  vi.mocked(getSyncEngine).mockReturnValue({
    isConnected: () => true,
    getClient: () => conn,
  } as never);
}

describe('appendSentCopy — the dedupe scan ahead of the upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // THE fix: a bounded window, not the whole mailbox. The question is only
  // whether the server filed its own copy of what SMTP just took, and such a
  // copy is among the newest messages there are.
  it('asks for a bounded window of the newest messages, not the whole mailbox', async () => {
    const conn = makeConnection();
    wire(conn);

    await appendSentCopy(RAW, MESSAGE_ID, PAYLOAD);

    const [, options] = conn.fetchMessageIdToUidMap.mock.calls[0];
    expect(options?.recent).toBeGreaterThan(0);
    expect(conn.appendMessage).toHaveBeenCalledWith('Sent', RAW, ['\\Seen']);
  });

  // The server already has it — appending again gives the user two copies of
  // every message they send.
  it('does not upload a copy the server already filed', async () => {
    const conn = makeConnection({
      fetchMessageIdToUidMap: vi.fn(async () => new Map([['m@x', 42]])),
    });
    wire(conn);

    await appendSentCopy(RAW, MESSAGE_ID, PAYLOAD);

    expect(conn.appendMessage).not.toHaveBeenCalled();
  });

  // THE regression: the scan's timeout recycles the connection, so the APPEND
  // that followed it could not possibly succeed. Deferring keeps the marker and
  // starts the next attempt on a live connection instead of guaranteeing a
  // failure — and burning a connection — once a minute forever.
  it('defers instead of appending when the scan killed the connection', async () => {
    const conn = makeConnection({
      fetchMessageIdToUidMap: vi.fn(async () => {
        throw new Error('IMAP FETCH msgid-map timed out after 60000ms');
      }),
      isConnected: vi.fn(() => false),
    });
    wire(conn);

    await expect(appendSentCopy(RAW, MESSAGE_ID, PAYLOAD)).rejects.toThrow(/recycled/i);
    expect(conn.appendMessage).not.toHaveBeenCalled();
  });

  // A scan that failed for its own reasons on a connection that is still fine
  // leaves the question unanswered — and an unanswered question is not a reason
  // to skip the upload. A duplicate in Sent beats a message that isn't there.
  it('still appends when the scan fails but the connection is alive', async () => {
    const conn = makeConnection({
      fetchMessageIdToUidMap: vi.fn(async () => {
        throw new Error('NO [SERVERBUG] internal error');
      }),
    });
    wire(conn);

    await appendSentCopy(RAW, MESSAGE_ID, PAYLOAD);

    expect(conn.appendMessage).toHaveBeenCalledWith('Sent', RAW, ['\\Seen']);
  });

  // An older/pooled connection with no isConnected probe must not become a
  // reason to stop appending.
  it('appends after a failed scan on a connection that cannot be probed', async () => {
    const conn = makeConnection({
      fetchMessageIdToUidMap: vi.fn(async () => {
        throw new Error('NO [SERVERBUG] internal error');
      }),
      isConnected: undefined,
    });
    wire(conn);

    await appendSentCopy(RAW, MESSAGE_ID, PAYLOAD);

    expect(conn.appendMessage).toHaveBeenCalled();
  });

  // Transient by design: IMAP being down must keep the marker (the caller
  // retries), never drop the Sent copy on the floor.
  it('defers while IMAP is offline', async () => {
    const conn = makeConnection();
    vi.mocked(getStorage).mockReturnValue({ getFolders: async () => [] } as never);
    vi.mocked(getSyncEngine).mockReturnValue({ isConnected: () => false, getClient: () => conn } as never);

    await expect(appendSentCopy(RAW, MESSAGE_ID, PAYLOAD)).rejects.toThrow(/deferred/i);
  });

  // No Sent folder at all is permanent, not transient: returning (not throwing)
  // is what lets the caller clear the marker instead of retrying forever.
  it('gives up quietly when the account has no Sent folder', async () => {
    const conn = makeConnection();
    vi.mocked(getStorage).mockReturnValue({ getFolders: async () => [] } as never);
    vi.mocked(getSyncEngine).mockReturnValue({ isConnected: () => true, getClient: () => conn } as never);

    await expect(appendSentCopy(RAW, MESSAGE_ID, PAYLOAD)).resolves.toBeUndefined();
    expect(conn.appendMessage).not.toHaveBeenCalled();
  });
});
