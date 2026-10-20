import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: a draft loses its attachments. The user
// attaches a file (or forwards a mail with one), closes into Drafts, reopens it
// — and the file is gone, so the mail they finally send is missing it. Nothing
// errors; the draft just quietly comes back lighter.

const h = vi.hoisted(() => ({ userData: '', handlers: new Map<string, (...args: any[]) => any>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {},
  shell: {},
  app: { getPath: () => h.userData },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: vi.fn(),
  getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(),
  getSyncEngineFor: vi.fn(),
  getMainWindow: vi.fn(),
  getCurrentAccountId: vi.fn(() => 'acct-1'),
  getAllAccountIds: vi.fn(() => ['acct-1']),
  sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));
// The attachment cache seals with a key derived from the DB key (CASA M-7);
// the real store would reach for the OS keychain.
vi.mock('../../../../electron/services/db-key-store', () => ({ getDbEncryptionKey: vi.fn(() => 'k'.repeat(64)) }));

// eslint-disable-next-line import/order -- see local-mirror-content-hash.test.ts
import { newMigratedDb } from '../../../../../../packages/storage-node/src/test-support/test-db';
import {
  decodeDraftAttachments,
  draftAttachmentColumns,
  draftMimeAttachments,
} from '../../../../electron/ipc/draft-attachments';
import { registerDraftHandlers, saveDraftToIMAP, writeLocalDraftRow } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';
import {
  accountAttachmentDir,
  getOrCacheAttachment,
  readCachedAttachment,
  resetAttachmentStoreKeys,
} from '../../../../electron/services/attachment-cache';
import { getDbEncryptionKey } from '../../../../electron/services/db-key-store';

const TMP = mkdtempSync(join(tmpdir(), 'draft-attachments-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DRAFTS = 'Drafts';
const PDF = Buffer.from('%PDF-1.7 invoice');
const invoice = { filename: 'invoice.pdf', content: PDF.toString('base64'), contentType: 'application/pdf' };

function draftsDb() {
  const db = newMigratedDb();
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-drafts', DRAFTS, DRAFTS, '\\Drafts');
  return db;
}

const storageOver = (db: unknown) => ({
  db,
  getFolders: async () => [{ id: 'f-drafts', name: DRAFTS, path: DRAFTS, specialUse: '\\Drafts', type: 'drafts' }],
});

const attachmentColumnsOf = (db: any, messageId: string) =>
  db.prepare(`SELECT id, has_attachments AS hasAttachments, attachment_count AS attachmentCount,
                     attachment_names AS attachmentNames, attachment_sizes AS attachmentSizes
                FROM emails WHERE message_id = ?`).get(messageId);

beforeEach(() => {
  h.userData = mkdtempSync(join(TMP, 'ud-'));
  vi.clearAllMocks();
  // The store memoizes its derived keys; a test that makes the key store fail
  // must not be masked by keys an earlier test derived.
  resetAttachmentStoreKeys();
});

/**
 * What the reopen path gets for a draft row's file: the row has no UID yet, so
 * only the copy the save seeded can answer (a miss is a 404).
 */
async function reopenedFile(accountId: string, rowId: string, filename: string): Promise<{ path: string; content: Buffer }> {
  const path = await getOrCacheAttachment(accountId, rowId, DRAFTS, 0, filename, null);
  return { path, content: await readCachedAttachment(path) };
}

describe('decodeDraftAttachments', () => {
  // Breaks: the file's bytes are stored as their base64 text, so the reopened
  // draft attaches a garbage file four-thirds the size.
  it('decodes the base64 content', () => {
    const [file] = decodeDraftAttachments([invoice]);
    expect(file.content.equals(PDF)).toBe(true);
    expect(file.contentType).toBe('application/pdf');
  });

  // Breaks: one malformed entry from the renderer throws and the whole draft
  // is not saved — the note typed around it is lost too.
  it('drops malformed entries instead of failing the save', () => {
    const decoded = decodeDraftAttachments([
      null, { filename: '', content: 'x' }, { filename: 'a.txt' }, { filename: 5, content: 'x' }, invoice,
    ]);
    expect(decoded.map((file) => file.filename)).toEqual(['invoice.pdf']);
  });

  // Breaks: a save without attachments (every plain draft) crashes on `.filter`.
  it('treats a missing or non-array list as no attachments', () => {
    expect(decodeDraftAttachments(undefined)).toEqual([]);
    expect(decodeDraftAttachments('nope')).toEqual([]);
  });
});

describe('draftAttachmentColumns', () => {
  // Breaks: the row's names are not the JSON list the attachment path authorizes
  // against, so every request for the draft's own file is refused.
  it('writes names and sizes in the shapes the sync path uses', () => {
    expect(draftAttachmentColumns(decodeDraftAttachments([invoice]))).toEqual({
      hasAttachments: 1,
      attachmentCount: 1,
      attachmentNames: '["invoice.pdf"]',
      attachmentSizes: `[${PDF.length}]`,
    });
  });

  // Breaks: a plain draft is flagged as having attachments (a phantom paperclip).
  it('marks a draft without files as having none', () => {
    expect(draftAttachmentColumns([])).toEqual({
      hasAttachments: 0, attachmentCount: 0, attachmentNames: '', attachmentSizes: null,
    });
  });
});

describe('draftMimeAttachments', () => {
  // Breaks: an absent content type is sent as `undefined`, overriding the type
  // nodemailer would otherwise infer from the filename.
  it('omits a missing content type', () => {
    const [part] = draftMimeAttachments(decodeDraftAttachments([{ filename: 'a.txt', content: 'YQ==' }]));
    expect(part).toEqual({ filename: 'a.txt', content: Buffer.from('a') });
  });
});

describe('saveDraftToIMAP with attachments', () => {
  // Breaks: the draft on the SERVER lacks the file, so it is gone on another
  // device, and gone here once the sync replaces the local row.
  it('puts the files in the appended MIME message', async () => {
    const appendMessage = vi.fn(async () => 11);
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(draftsDb()),
      syncEngine: { isConnected: () => true, getClient: () => ({ appendMessage }) },
    } as any);

    await saveDraftToIMAP({ to: 'a@x.com', htmlBody: '<p>see attached</p>', accountEmail: 'me@x.com', attachments: [invoice] });

    const raw = String((appendMessage.mock.calls[0] as unknown[])[1]);
    expect(raw).toContain('filename=invoice.pdf');
    expect(raw).toContain(PDF.toString('base64'));
  });

  // Breaks: the Drafts list shows no paperclip, and the reopen path finds no
  // names to load — the draft reopens without its files.
  it('records the files on the local draft row', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false },
    } as any);

    const res = await saveDraftToIMAP({ to: 'a@x.com', htmlBody: '<p>x</p>', accountEmail: 'me@x.com', attachments: [invoice] });

    expect(attachmentColumnsOf(db, res.messageId!)).toMatchObject({
      hasAttachments: 1, attachmentCount: 1, attachmentNames: '["invoice.pdf"]', attachmentSizes: `[${PDF.length}]`,
    });
  });

  // Breaks: OFFLINE. The row has no UID, so nothing can be fetched from the
  // server — the cache is the only copy of the file the reopen can reach.
  // Changed deliberately (CASA M-7): the cache is sealed and per account, so the
  // seed is checked through the reopen path (the owning account + the row id)
  // instead of as a plaintext file under the row id; and it must be sealed at rest.
  it('seeds the files into the cache under the local row id', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false }, accountId: 'acct-1',
    } as any);

    const res = await saveDraftToIMAP({ to: 'a@x.com', htmlBody: '<p>x</p>', accountEmail: 'me@x.com', attachments: [invoice] });

    const { id } = attachmentColumnsOf(db, res.messageId!);
    const reopened = await reopenedFile('acct-1', id, 'invoice.pdf');
    expect(reopened.content.equals(PDF)).toBe(true);
    expect(reopened.path.startsWith(accountAttachmentDir('acct-1') + sep)).toBe(true);
    expect(readFileSync(reopened.path).includes(PDF)).toBe(false);
  });

  // Breaks: a draft saved from a NON-active account (unified view, or a reply
  // from another mailbox) seeds its files under the active account, so its own
  // reopen misses them and the other account can open them; or removing that
  // account leaves them behind.
  it("seeds a non-active account's draft into that account's store only", async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false }, accountId: 'acct-2',
    } as any);

    const res = await saveDraftToIMAP({
      accountId: 'acct-2', to: 'a@x.com', htmlBody: '<p>x</p>', accountEmail: 'me2@x.com', attachments: [invoice],
    });

    expect(resolveAccountTarget).toHaveBeenCalledWith('acct-2');
    const { id } = attachmentColumnsOf(db, res.messageId!);
    expect((await reopenedFile('acct-2', id, 'invoice.pdf')).content.equals(PDF)).toBe(true);
    await expect(reopenedFile('acct-1', id, 'invoice.pdf')).rejects.toMatchObject({ status: 404 });
    expect(existsSync(accountAttachmentDir('acct-1'))).toBe(false);
  });

  // Breaks: a cache that cannot be written (key store locked) fails the whole
  // save, losing the draft text along with the files it could not cache.
  it('still saves the draft when its files cannot be cached', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false }, accountId: 'acct-1',
    } as any);
    vi.mocked(getDbEncryptionKey).mockImplementationOnce(() => {
      throw new Error('DB key is encrypted but safeStorage is unavailable');
    });

    const res = await saveDraftToIMAP({ to: 'a@x.com', htmlBody: '<p>x</p>', accountEmail: 'me@x.com', attachments: [invoice] });

    expect(res.success).toBe(true);
    expect(attachmentColumnsOf(db, res.messageId!)).toMatchObject({ hasAttachments: 1, attachmentNames: '["invoice.pdf"]' });
    // Nothing half-written: no entry the reopen would trust.
    await expect(reopenedFile('acct-1', attachmentColumnsOf(db, res.messageId!).id, 'invoice.pdf'))
      .rejects.toMatchObject({ status: 404 });
  });

  // Breaks: a plain draft creates an empty cache dir per autosave, piling up.
  // Changed deliberately (CASA M-7): the per-email folder name is a keyed hash
  // now, so "no folder" is checked at the owning account's folder.
  it('writes nothing to the cache for a draft without files', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false }, accountId: 'acct-1',
    } as any);

    const res = await saveDraftToIMAP({ to: 'a@x.com', htmlBody: '<p>x</p>', accountEmail: 'me@x.com' });

    const { hasAttachments } = attachmentColumnsOf(db, res.messageId!);
    expect(hasAttachments).toBe(0);
    expect(existsSync(accountAttachmentDir('acct-1'))).toBe(false);
  });
});

describe('writeLocalDraftRow re-save', () => {
  // Breaks: removing the file and re-saving under the same message-id keeps
  // the old names, so the draft keeps offering a file the user took off.
  it('replaces the attachment columns of an existing row', async () => {
    const db = draftsDb();
    const row = {
      messageId: '<d1@x>', folderPath: DRAFTS, to: 'a@x.com', cc: '', bcc: '', subject: 's',
      bodyText: 'x', bodyHtml: '<p>x</p>', inReplyTo: '', fromAddress: 'me@x.com', rawMessage: '',
    };
    const storage = storageOver(db) as any;

    await writeLocalDraftRow(storage, { ...row, attachments: decodeDraftAttachments([invoice]) });
    const id = await writeLocalDraftRow(storage, { ...row, attachments: [] });

    expect(id).toBe(attachmentColumnsOf(db, '<d1@x>').id);
    expect(attachmentColumnsOf(db, '<d1@x>')).toMatchObject({ hasAttachments: 0, attachmentCount: 0, attachmentNames: '' });
  });
});

describe('drafts:find-for-thread', () => {
  // Breaks: a reply draft reopened in its thread gets no file list, so it
  // reopens without the attachments it was saved with.
  it('returns the draft\'s attachment names and sizes', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({ storage: storageOver(db), syncEngine: null } as any);
    await writeLocalDraftRow(storageOver(db) as any, {
      messageId: '<r1@x>', folderPath: DRAFTS, to: 'a@x.com', cc: '', bcc: '', subject: 'Re: s',
      bodyText: 'x', bodyHtml: '<p>x</p>', inReplyTo: '<parent@x>', fromAddress: 'me@x.com', rawMessage: '',
      attachments: decodeDraftAttachments([invoice]),
    });
    registerDraftHandlers();

    const res = await h.handlers.get('drafts:find-for-thread')!({}, ['<parent@x>'], 'acct-1');

    expect(res.data).toMatchObject({ attachmentNames: '["invoice.pdf"]', attachmentSizes: `[${PDF.length}]` });
  });
});
