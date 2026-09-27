import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Storage side of one-click unsubscribe (migration v93).
 *
 * What this protects: these two headers are read ONCE, at ingest, and the raw
 * block is not kept. If the INSERT drops a column or the row mapper forgets
 * one, the value is parsed and paid for and then lost — and the only symptom
 * is an Unsubscribe button that never appears on mail that carries a perfectly
 * good unsubscribe address. Nobody reports a button they have never seen.
 */
describe('emails unsubscribe columns (v93)', () => {
  it('exist after migration, nullable, on a fresh database', () => {
    const db = newMigratedDb();
    const cols = db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(cols.map((col) => [col.name, col]));
    for (const name of ['list_unsubscribe', 'list_unsubscribe_post']) {
      expect(byName.has(name), name).toBe(true);
      // NULL is a real state — "this sender published no way off a list".
      expect(byName.get(name)!.notnull).toBe(0);
    }
  });
});

describe('SQLiteStorage round-trips the unsubscribe headers', () => {
  const T0 = 1_760_000_000;
  const ONE_CLICK = '<https://brand.example/u/abc>, <mailto:u@brand.example>';
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

  // THE round trip: what ingest read off the wire is what the banner acts on.
  it('stores both headers verbatim and reads them back on the full row', async () => {
    await storage.insertEmail(email({
      id: 'u1', tags: '|INBOX|bulk|',
      listUnsubscribe: ONE_CLICK,
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    }));

    expect(await storage.getEmail('u1')).toMatchObject({
      listUnsubscribe: ONE_CLICK,
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
  });

  // Ordinary mail, and mail synced before v93 (a caller that sends neither
  // field), must both read back NULL — the banner renders nothing for it.
  it('keeps "no unsubscribe published" as NULL, for an explicit null and for an absent field', async () => {
    await storage.insertEmail(email({ id: 'plain', listUnsubscribe: null, listUnsubscribePost: null }));
    await storage.insertEmail(email({ id: 'legacy' })); // fields absent entirely, as an old caller would send

    expect(await storage.getEmail('plain')).toMatchObject({ listUnsubscribe: null, listUnsubscribePost: null });
    expect(await storage.getEmail('legacy')).toMatchObject({ listUnsubscribe: null, listUnsubscribePost: null });
  });

  // A sender who declares one-click but publishes no address, and one who
  // publishes an address without declaring one-click, are stored independently
  // — the route is decided at read time, never normalised into the column.
  it('stores each header independently of the other', async () => {
    await storage.insertEmail(email({ id: 'addr', listUnsubscribe: '<https://brand.example/u/abc>' }));
    await storage.insertEmail(email({ id: 'post', listUnsubscribePost: 'List-Unsubscribe=One-Click' }));

    expect(await storage.getEmail('addr')).toMatchObject({
      listUnsubscribe: '<https://brand.example/u/abc>', listUnsubscribePost: null,
    });
    expect(await storage.getEmail('post')).toMatchObject({
      listUnsubscribe: null, listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
  });

  // List rows are built from the live column list, and the detail pane the
  // banner sits in is rendered from whichever row the list handed over — so
  // the headers must ride along there too, not only on the full row read.
  it('carries both headers on list rows as well', async () => {
    await storage.insertEmail(email({
      id: 'l1', listUnsubscribe: ONE_CLICK, listUnsubscribePost: 'List-Unsubscribe=One-Click',
    }));

    const [row] = await storage.getEmailsByFolder('f-inbox', { limit: 10, offset: 0 });
    expect(row).toMatchObject({
      id: 'l1', listUnsubscribe: ONE_CLICK, listUnsubscribePost: 'List-Unsubscribe=One-Click',
    });
  });
});
