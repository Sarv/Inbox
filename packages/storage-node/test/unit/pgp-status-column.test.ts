import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteStorage } from '../../src/sqlite-storage';

/**
 * Storage side of OpenPGP (migration v100).
 *
 * What this protects: `pgp_status` is the only thing telling the reader that a
 * row's body is a placeholder and the message must be decrypted from its
 * source. Dropped by the INSERT, the update or the row mapper, an encrypted
 * message shows the words "Encrypted message" and nothing else, forever.
 */
describe('SQLiteStorage round-trips pgp_status (v100)', () => {
  const T0 = 1_760_000_000;
  let dir: string;
  let storage: SQLiteStorage;

  const email = (over: Partial<EmailRecord> & { id: string }): EmailRecord => ({
    messageId: `<${over.id}@example.test>`,
    threadId: `thread-${over.id}`,
    folderId: 'f-inbox',
    uid: 1,
    tags: '|INBOX|',
    subject: `Subject ${over.id}`,
    fromAddress: 'news@brand.example',
    fromName: 'Brand',
    toAddress: 'me@example.test',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: T0,
    receivedDate: T0,
    cleanBody: 'clean',
    rawBody: '<p>raw</p>',
    contentType: 'html',
    contentHash: `hash-${over.id}`,
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });

  const inbox: FolderRecord = {
    id: 'f-inbox', name: 'INBOX', path: 'INBOX', parentId: null,
    uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
    totalCount: 0, unreadCount: 0, specialUse: '\\Inbox', subscribed: true,
    createdAt: T0, updatedAt: T0,
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sarv-unsub-cols-'));
    storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
    await storage.initialize();
    await storage.syncFolders([inbox]); // emails.folder_id is a foreign key
  });

  afterEach(async () => {
    // insertEmail kicks off contact extraction fire-and-forget; let it finish
    // before the handle goes away so it cannot log against a closed DB.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Breaks: an encrypted row reads as ordinary mail and is never decrypted.
  it('stores the status on insert and reads it back on full and list rows', async () => {
    await storage.insertEmail(email({ id: 'enc', pgpStatus: 'encrypted' }));
    await storage.insertEmail(email({ id: 'legacy' })); // an old caller sends no field

    expect(await storage.getEmail('enc')).toMatchObject({ pgpStatus: 'encrypted' });
    expect(await storage.getEmail('legacy')).toMatchObject({ pgpStatus: null });
    const rows = await storage.getEmailsByFolder('f-inbox', { limit: 10, offset: 0 });
    expect(rows.find((row) => row.id === 'enc')).toMatchObject({ pgpStatus: 'encrypted' });
  });

  // Breaks: headers-first sync inserts with no status, and the body download
  // is when the shape becomes known — the update must land it.
  it('lands the status through an update, as the body download writes it', async () => {
    await storage.insertEmail(email({ id: 'late' }));
    await storage.updateEmail('late', { pgpStatus: 'signed' });
    expect(await storage.getEmail('late')).toMatchObject({ pgpStatus: 'signed' });
  });
});
