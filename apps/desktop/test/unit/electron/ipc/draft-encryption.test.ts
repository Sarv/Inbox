import { generateKeyPair, openStoredPgp, readAnyKey, readOpenedContent, readUnlockedPrivateKey } from '@sarvinbox/core/pgp';
import type * as openpgp from 'openpgp';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: a draft of an encrypted message is saved in
// the clear — in the local DB (and so in search), or in the server's Drafts
// folder, where anyone with the mailbox can read it. Nothing about that shows
// in the app: the draft reopens and sends encrypted as before. Only the copies
// at rest are wrong.

const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), keyring: null as unknown }));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {},
  shell: {},
  app: { getPath: () => '' },
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
vi.mock('../../../../electron/services/attachment-cache', () => ({ seedAttachmentCache: vi.fn() }));
vi.mock('../../../../electron/services/pgp-service', () => ({ getPgpKeyring: () => h.keyring }));

// eslint-disable-next-line import/order -- see local-mirror-content-hash.test.ts
import { newMigratedDb } from '../../../../../../packages/storage-node/src/test-support/test-db';

import { registerDraftHandlers, saveDraftToIMAP, writeLocalDraftRow } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';
import { seedAttachmentCache } from '../../../../electron/services/attachment-cache';
import { encryptDraftMime } from '../../../../electron/services/pgp-outgoing';

const DRAFTS = 'Drafts';
const ME = 'me@x.com';
const SECRET = 'the launch date is March 3';
const invoice = { filename: 'secret-plan.pdf', content: Buffer.from('%PDF plan').toString('base64'), contentType: 'application/pdf' };

let myPrivate: openpgp.PrivateKey;
let myPublic: openpgp.Key;
beforeAll(async () => {
  const pair = await generateKeyPair({ name: 'Me', email: ME });
  myPrivate = await readUnlockedPrivateKey(pair.armoredPrivateKey);
  myPublic = await readAnyKey(pair.armoredPublicKey);
});

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

const target = (db: unknown, appendMessage = vi.fn(async () => 7), connected = true) => {
  vi.mocked(resolveAccountTarget).mockResolvedValue({
    storage: storageOver(db),
    syncEngine: { isConnected: () => connected, getClient: () => ({ appendMessage }) },
  } as any);
  return appendMessage;
};

const rowOf = (db: any, messageId: string) =>
  db.prepare(`SELECT e.pgp_status AS pgpStatus, e.attachment_names AS attachmentNames, e.has_attachments AS hasAttachments,
                     COALESCE(b.clean_body, e.clean_body) AS cleanBody, COALESCE(b.raw_body, e.raw_body) AS rawBody
                FROM emails e LEFT JOIN email_bodies b ON b.email_id = e.id WHERE e.message_id = ?`).get(messageId);

const ftsHits = (db: any, term: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM emails_fts WHERE emails_fts MATCH ?`).get(`"${term}"`) as { n: number }).n;

const decrypt = async (raw: string | Buffer) =>
  readOpenedContent((await openStoredPgp(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'latin1'), {
    decryptionKeys: [myPrivate],
    verificationKeys: [],
  })).content);

const encryptedDraft = { to: 'rita@example.com', subject: 'plan', body: SECRET, htmlBody: `<p>${SECRET}</p>`, accountEmail: ME, attachments: [invoice], pgp: { encrypt: true } };

beforeEach(() => {
  vi.clearAllMocks();
  h.keyring = { ownPublicKeyFor: vi.fn(async (email: string) => (email === ME ? myPublic : null)) };
});

describe('encryptDraftMime', () => {
  // Breaks: a draft is encrypted to nobody — or to a key the user cannot open it with.
  it('encrypts to the sender’s own key, so only they can reopen it', async () => {
    const raw = Buffer.from(`From: ${ME}\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\n${SECRET}\r\n`);
    const encrypted = await encryptDraftMime(raw, ME, h.keyring as any);
    expect(encrypted.toString()).not.toContain(SECRET);
    expect((await decrypt(encrypted)).body).toContain(SECRET);
  });

  // Breaks: an account with no key gets its "encrypted" draft saved as plaintext.
  it('refuses when the address has no key of its own', async () => {
    await expect(encryptDraftMime(Buffer.from('x'), 'other@x.com', h.keyring as any)).rejects.toThrow('No OpenPGP key for other@x.com');
    await expect(encryptDraftMime(Buffer.from('x'), '', h.keyring as any)).rejects.toThrow('this account');
  });
});

describe('saveDraftToIMAP, encrypted', () => {
  // Breaks: the server's Drafts folder holds the plaintext of an encrypted message.
  it('appends only ciphertext to the server, and it opens with the user’s key', async () => {
    const append = target(draftsDb());
    const result = await saveDraftToIMAP(encryptedDraft);

    expect(result).toMatchObject({ success: true, folderPath: DRAFTS });
    const [, raw, flags] = append.mock.calls[0] as unknown as [string, Buffer, string[]];
    expect(flags).toEqual(['\\Draft', '\\Seen']);
    const text = raw.toString('latin1');
    expect(text).toContain('multipart/encrypted');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secret-plan.pdf');
    // The outer headers stay, so the server copy dedupes against the local row.
    expect(text).toContain(`Message-ID: ${result.messageId}`);

    const opened = await decrypt(raw);
    expect(opened.body).toContain(SECRET);
    expect(opened.attachments.map((file) => file.name)).toEqual(['secret-plan.pdf']);
  });

  // Breaks: the local row carries the plaintext — searchable, and fed to AI and snippets.
  it('stores the placeholder, the ciphertext as its source, and no file names', async () => {
    const db = draftsDb();
    target(db);
    const { messageId } = await saveDraftToIMAP(encryptedDraft);

    const row = rowOf(db, messageId!);
    expect(row).toMatchObject({ pgpStatus: 'encrypted', cleanBody: 'Encrypted message', hasAttachments: 0 });
    expect(row.attachmentNames ?? '').toBe('');
    expect(row.rawBody).toContain('-----BEGIN PGP MESSAGE-----');
    expect(row.rawBody).not.toContain(SECRET);
    expect(ftsHits(db, 'launch')).toBe(0);
    expect(ftsHits(db, 'secret')).toBe(0);
    // The files are not cached in the clear beside it either.
    expect(seedAttachmentCache).not.toHaveBeenCalled();
    // …and the ciphertext on the row is enough to reopen it offline.
    expect((await decrypt(row.rawBody)).body).toContain(SECRET);
  });

  // Breaks: offline, the encrypted draft is kept locally in the clear "until it syncs".
  it('stays encrypted when saved offline', async () => {
    const db = draftsDb();
    const append = target(db, vi.fn(async () => 7), false);
    const result = await saveDraftToIMAP(encryptedDraft);
    expect(result).toMatchObject({ success: true, error: 'IMAP offline (local-only)' });
    expect(append).not.toHaveBeenCalled();
    expect(rowOf(db, result.messageId!).pgpStatus).toBe('encrypted');
  });

  // Breaks: a draft that cannot be encrypted falls back to saving the plaintext — here or on the server.
  it('saves nothing at all when the draft cannot be encrypted', async () => {
    const db = draftsDb();
    const append = target(db);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n;

    h.keyring = { ownPublicKeyFor: vi.fn(async () => null) };
    expect(await saveDraftToIMAP(encryptedDraft)).toMatchObject({ success: false, error: expect.stringContaining('was not saved') });

    h.keyring = { ownPublicKeyFor: vi.fn(async () => { throw new Error('keyring unreadable'); }) };
    expect(await saveDraftToIMAP(encryptedDraft)).toMatchObject({ success: false, error: expect.stringContaining('keyring unreadable') });

    expect(append).not.toHaveBeenCalled();
    expect((db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n).toBe(before);
  });

  // Breaks: every ordinary draft now needs a key, or is marked encrypted.
  it('leaves an unencrypted draft exactly as before', async () => {
    const db = draftsDb();
    const append = target(db);
    const { messageId } = await saveDraftToIMAP({ ...encryptedDraft, pgp: undefined });
    expect(String((append.mock.calls[0] as unknown[])[1])).toContain(SECRET);
    expect(rowOf(db, messageId!)).toMatchObject({ pgpStatus: null, cleanBody: SECRET });
    expect((h.keyring as any).ownPublicKeyFor).not.toHaveBeenCalled();
  });

  // Breaks: the renderer's encrypt flag is dropped between the bridge and the save.
  it('carries the flag through the drafts:save channel', async () => {
    const db = draftsDb();
    const append = target(db);
    registerDraftHandlers();
    const result = await h.handlers.get('drafts:save')!(null, encryptedDraft);
    expect(result.success).toBe(true);
    expect(String((append.mock.calls[0] as unknown[])[1])).not.toContain(SECRET);
  });
});

describe('writeLocalDraftRow pgp_status', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    messageId: '<d1@x.com>', folderPath: DRAFTS, to: 'a@x.com', cc: '', bcc: '', subject: 's',
    bodyText: 'Encrypted message', bodyHtml: '', inReplyTo: '', fromAddress: ME, rawMessage: 'CIPHERTEXT',
    ...over,
  });

  // Breaks: a re-save under the same Message-ID flips an encrypted draft back to "plain" (or the reverse),
  // so the reader shows ciphertext or tries to decrypt plaintext.
  it('writes the status on insert and rewrites it on re-save', async () => {
    const db = draftsDb();
    const storage = storageOver(db) as any;
    await writeLocalDraftRow(storage, row({ pgpStatus: 'encrypted' }));
    expect(rowOf(db, '<d1@x.com>')).toMatchObject({ pgpStatus: 'encrypted', rawBody: 'CIPHERTEXT' });

    await writeLocalDraftRow(storage, row({ bodyText: 'plain now', bodyHtml: '<p>plain now</p>' }));
    expect(rowOf(db, '<d1@x.com>')).toMatchObject({ pgpStatus: null, cleanBody: 'plain now' });

    await writeLocalDraftRow(storage, row({ pgpStatus: 'encrypted' }));
    expect(rowOf(db, '<d1@x.com>').pgpStatus).toBe('encrypted');
  });
});

describe('drafts:find-for-thread', () => {
  // Breaks: a reply draft found by in_reply_to reopens as its placeholder instead of being decrypted.
  it('returns the draft’s pgp status', async () => {
    const db = draftsDb();
    await writeLocalDraftRow(storageOver(db) as any, {
      messageId: '<d2@x.com>', folderPath: DRAFTS, to: '', cc: '', bcc: '', subject: 'Re: plan',
      bodyText: 'Encrypted message', bodyHtml: '', inReplyTo: '<parent@x.com>', fromAddress: ME,
      rawMessage: 'CIPHERTEXT', pgpStatus: 'encrypted',
    });
    vi.mocked(resolveAccountTarget).mockResolvedValue({ storage: storageOver(db) } as any);
    registerDraftHandlers();
    const result = await h.handlers.get('drafts:find-for-thread')!(null, ['<parent@x.com>']);
    expect(result.data).toMatchObject({ messageId: '<d2@x.com>', pgpStatus: 'encrypted' });
  });
});
