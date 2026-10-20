import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isSealedBytes, type SendEmailOptions } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ userData: '', storageAccounts: new WeakMap<object, string>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: {},
  app: { getPath: () => h.userData },
}));
vi.mock('../../../../electron/shared', () => ({
  getStorage: vi.fn(), getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(), getSyncEngineFor: vi.fn(),
  getSmtpClient: vi.fn(), getSmtpClientFor: vi.fn(),
  setSmtpClient: vi.fn(), setSmtpClientFor: vi.fn(),
  getMainWindow: vi.fn(), getCurrentAccountId: () => 'account-a',
  getAccountIdForStorage: vi.fn((storage: object | null) => storage ? h.storageAccounts.get(storage) ?? null : null),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));
// The real encrypted attachment store derives its own keys from the database
// key; these tests use a deterministic fixture instead of the OS keychain.
vi.mock('../../../../electron/services/db-key-store', () => ({ getDbEncryptionKey: vi.fn(() => 'k'.repeat(64)) }));
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(), drainOutbox: vi.fn(),
  getOutboxQueueForAccount: vi.fn(), drainOutboxForAccount: vi.fn(), notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/pgp-service', () => ({ sendTransformFor: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ getPipelineUserName: () => 'Sender' }));
vi.mock('../../../../electron/ipc/draft-handlers', () => ({ deleteDraftsForThread: vi.fn() }));
vi.mock('../../../../electron/ipc/follow-up-handlers', () => ({ recordFollowUpForSend: vi.fn() }));

import { newMigratedDb } from '../../../../../../packages/storage-node/src/test-support/test-db';
import { sendEmailFromMain } from '../../../../electron/ipc/smtp-handlers';
import { accountAttachmentDir, getOrCacheAttachment, readCachedAttachment, resetAttachmentStoreKeys } from '../../../../electron/services/attachment-cache';
import { getAccountIdForStorage, getSmtpClient, getSmtpClientFor, getStorage, getStorageFor } from '../../../../electron/shared';
import { parseAttachments } from '../../../../src/components/email-detail/utils';

type Db = ReturnType<typeof newMigratedDb>;
const databases: Db[] = [];
const MESSAGE_ID = '<sent-forward@example.test>';
const SENT_ID = 'sent-forward@example.test';
const FILENAME = 'Letter Format-MSME Declaration.docx';
const DOCUMENT = Buffer.alloc(14 * 1024, 42);
const options = (extra: Partial<SendEmailOptions> = {}): SendEmailOptions => ({
  to: ['recipient@example.test'], subject: 'Fwd: Letter required',
  body: 'Please see the attached letter.', htmlBody: '<p>Please see the attached letter.</p>',
  attachments: [{ filename: FILENAME, content: DOCUMENT.toString('base64'), encoding: 'base64' }],
  ...extra,
});

function newStorage(accountId = 'account-a') {
  const db = newMigratedDb();
  databases.push(db);
  db.prepare('INSERT INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('sent-folder', 'Sent', 'Sent', '\\Sent');
  const storage = {
    db,
    getFolders: async () => [{ id: 'sent-folder', name: 'Sent', path: 'Sent', specialUse: '\\Sent' }],
    getEmailsByMessageIds: async () => [],
  };
  h.storageAccounts.set(storage, accountId);
  return storage;
}

/** Read the UID-0 Sent mirror through the same sealed cache API as the reader. */
async function mirroredFile(accountId: string, emailId = SENT_ID, filename = FILENAME) {
  const path = await getOrCacheAttachment(accountId, emailId, 'Sent', 0, filename, null);
  return { path, content: await readCachedAttachment(path) };
}

function client() {
  return {
    config: { from: 'sender@example.test', host: 'smtp.example.test' },
    getConfig: () => ({}), isConnected: () => true,
    sendEmail: vi.fn(async () => ({ success: true, messageId: MESSAGE_ID })),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.storageAccounts = new WeakMap<object, string>();
  h.userData = await mkdtemp(join(tmpdir(), 'sent-attachments-'));
  resetAttachmentStoreKeys();
  vi.mocked(getSmtpClient).mockReturnValue(client() as never);
});
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await rm(h.userData, { recursive: true, force: true });
});

describe('sent attachment mirror before the Sent folder sync', () => {
  it('persists the filenames and decoded sizes used by both message views and serves their bytes with UID 0', async () => {
    const storage = newStorage();
    vi.mocked(getStorage).mockReturnValue(storage as never);
    const outgoing = options({ attachments: [
      ...options().attachments!,
      { filename: 'notes.txt', content: 'café' },
      { filename: 'binary.dat', content: Buffer.from([0, 255, 3]) },
    ] });

    await expect(sendEmailFromMain(outgoing)).resolves.toMatchObject({ success: true });

    const row = storage.db.prepare(`SELECT uid, has_attachments, attachment_count,
      attachment_names, attachment_sizes FROM emails WHERE id = ?`).get(SENT_ID) as any;
    expect(row).toMatchObject({ uid: 0, has_attachments: 1, attachment_count: 3 });
    // Classic cards and chat bubbles consume this same metadata parser.
    expect(parseAttachments(row.attachment_names, row.attachment_sizes)).toEqual([
      { name: FILENAME, size: DOCUMENT.length },
      { name: 'notes.txt', size: Buffer.byteLength('café') },
      { name: 'binary.dat', size: 3 },
    ]);
    const file = await mirroredFile('account-a');
    expect(file.content).toEqual(DOCUMENT);
    expect(dirname(dirname(file.path))).toBe(accountAttachmentDir('account-a'));
    const sealed = await readFile(file.path);
    expect(isSealedBytes(sealed)).toBe(true);
    expect(sealed.includes(DOCUMENT)).toBe(false);
    expect((await mirroredFile('account-a', SENT_ID, 'notes.txt')).content.toString('utf8')).toBe('café');
    expect((await mirroredFile('account-a', SENT_ID, 'binary.dat')).content).toEqual(Buffer.from([0, 255, 3]));
  });

  it('writes attachment metadata to the sending account when that account is not active', async () => {
    const active = newStorage();
    const sending = newStorage('account-b');
    vi.mocked(getStorage).mockReturnValue(active as never);
    vi.mocked(getStorageFor).mockReturnValue(sending as never);
    vi.mocked(getSmtpClientFor).mockReturnValue(client() as never);

    await sendEmailFromMain(options({ accountId: 'account-b' }));

    expect(active.db.prepare('SELECT COUNT(*) AS count FROM emails').get()).toEqual({ count: 0 });
    expect(sending.db.prepare('SELECT has_attachments, attachment_names FROM emails').get())
      .toEqual({ has_attachments: 1, attachment_names: JSON.stringify([FILENAME]) });
    expect(getStorageFor).toHaveBeenCalledWith('account-b');
    expect(getAccountIdForStorage).toHaveBeenCalledWith(sending);
    expect((await mirroredFile('account-b')).content).toEqual(DOCUMENT);
    await expect(mirroredFile('account-a')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps identical Sent message ids and filenames isolated between sending accounts', async () => {
    const active = newStorage('account-a');
    const other = newStorage('account-b');
    vi.mocked(getStorage).mockReturnValue(active as never);
    vi.mocked(getStorageFor).mockReturnValue(other as never);
    vi.mocked(getSmtpClientFor).mockReturnValue(client() as never);
    const first = Buffer.from('Forwarded document for mailbox A');
    const second = Buffer.from('A different forwarded document for mailbox B');

    await sendEmailFromMain(options({ attachments: [{ filename: FILENAME, content: first }] }));
    await sendEmailFromMain(options({ accountId: 'account-b', attachments: [{ filename: FILENAME, content: second }] }));

    const a = await mirroredFile('account-a');
    const b = await mirroredFile('account-b');
    expect(a.content).toEqual(first);
    expect(b.content).toEqual(second);
    expect(a.path).not.toBe(b.path);
    expect(dirname(dirname(a.path))).toBe(accountAttachmentDir('account-a'));
    expect(dirname(dirname(b.path))).toBe(accountAttachmentDir('account-b'));
    for (const [storage, bytes] of [[active, first], [other, second]] as const) {
      const row = storage.db.prepare('SELECT attachment_names, attachment_sizes FROM emails WHERE id = ?').get(SENT_ID) as { attachment_names: string; attachment_sizes: string };
      expect(parseAttachments(row.attachment_names, row.attachment_sizes)).toEqual([{ name: FILENAME, size: bytes.length }]);
    }
    expect(isSealedBytes(await readFile(a.path))).toBe(true);
    expect(isSealedBytes(await readFile(b.path))).toBe(true);
  });

  it('hydrates an existing server row without replacing its body, thread or assigned UID', async () => {
    const storage = newStorage();
    vi.mocked(getStorage).mockReturnValue(storage as never);
    storage.db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
      VALUES ('server-thread', 'Letter required', @messageId, @messageId, 1000)`).run({ messageId: MESSAGE_ID });
    storage.db.prepare(`INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags,
      subject, from_address, to_address, date, clean_body, raw_body, content_type, content_hash)
      VALUES ('server-copy', ?, 'server-thread', 'sent-folder', 212, '|Sent|read|',
      'Letter required', 'sender@example.test', 'recipient@example.test', 1000,
      'server body', '<p>server body</p>', 'html', 'server-hash')`).run(MESSAGE_ID);

    await sendEmailFromMain(options());

    expect(storage.db.prepare(`SELECT id, thread_id, uid, raw_body, attachment_names, attachment_sizes
      FROM emails WHERE message_id = ?`).get(MESSAGE_ID)).toEqual({
      id: 'server-copy', thread_id: 'server-thread', uid: 212, raw_body: '<p>server body</p>',
      attachment_names: JSON.stringify([FILENAME]), attachment_sizes: JSON.stringify([DOCUMENT.length]),
    });
    expect((await mirroredFile('account-a', 'server-copy')).content).toEqual(DOCUMENT);
    expect(storage.db.prepare('SELECT COUNT(*) AS count FROM emails').get()).toEqual({ count: 1 });
  });

  it('keeps encrypted attachment names and plaintext bytes out of the local mirror and cache', async () => {
    const storage = newStorage();
    vi.mocked(getStorage).mockReturnValue(storage as never);

    await sendEmailFromMain(options({ pgp: { encrypt: true, sign: true } }));

    expect(storage.db.prepare('SELECT has_attachments, attachment_count, attachment_names FROM emails').get())
      .toEqual({ has_attachments: 0, attachment_count: 0, attachment_names: '' });
    await expect(mirroredFile('account-a')).rejects.toMatchObject({ status: 404 });
  });

  it('keeps an ordinary message without attachments free of attachment metadata', async () => {
    const storage = newStorage();
    vi.mocked(getStorage).mockReturnValue(storage as never);

    await sendEmailFromMain(options({ attachments: [] }));

    expect(storage.db.prepare('SELECT has_attachments, attachment_count, attachment_names, attachment_sizes FROM emails').get())
      .toEqual({ has_attachments: 0, attachment_count: 0, attachment_names: '', attachment_sizes: '[]' });
  });
});
