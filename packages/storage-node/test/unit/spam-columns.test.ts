import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Storage side of the spam filter (migration v86).
 *
 * What this protects: the processor scores every message at ingest and hands
 * the verdict to `insertEmailBatch`. If the INSERT drops a column, or the row
 * mapper forgets one, the score is computed and paid for and then lost — the
 * shield reads "not scored" for every message and the AI exclusion still
 * works only because the tag survives. Silent, and exactly the kind of gap
 * this repo's tests exist for.
 */
describe('emails spam columns (v86)', () => {
  it('exist after migration, nullable, on a fresh database', () => {
    const db = newMigratedDb();
    const cols = (db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string; notnull: number }>);
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ['spam_score', 'spam_reasons', 'origin_ip']) {
      expect(byName.has(name), name).toBe(true);
      // NULL is a real state — "never scored" — and must stay representable.
      expect(byName.get(name)!.notnull).toBe(0);
    }
  });
});

describe('SQLiteStorage round-trips the spam verdict', () => {
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
    fromAddress: 'sender@example.test',
    fromName: 'Sender',
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
    dir = mkdtempSync(join(tmpdir(), 'sarv-spam-cols-'));
    storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
    await storage.initialize();
    await storage.syncFolders([inbox]); // emails.folder_id is a foreign key
  });

  afterEach(async () => {
    // insertEmailBatch kicks off contact extraction fire-and-forget; let it
    // finish before the handle goes away so it cannot log against a closed DB.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // THE round trip: what the processor computed is what the shield reads.
  it('stores the score, the reasons JSON and the origin IP, and reads them back on the full row', async () => {
    const reasons = JSON.stringify([{ id: 'upstream-spam', points: 5, detail: 'Your mail server marked it as spam (X-Spam-Flag: YES)' }]);
    await storage.insertEmail(email({
      id: 's1', tags: '|INBOX|spam|', spamScore: 5, spamReasons: reasons, originIp: '209.85.220.41',
    }));

    const row = await storage.getEmail('s1');
    expect(row).toMatchObject({ spamScore: 5, spamReasons: reasons, originIp: '209.85.220.41' });
  });

  // A row the processor did not score (the user's own mail) must read back
  // as NULL, not 0: the shield says "not scored", and a later backfill
  // selects on NULL to find what still needs a verdict.
  it('keeps "not scored" as NULL, distinct from a score of 0', async () => {
    await storage.insertEmail(email({ id: 'own', spamScore: null, spamReasons: null, originIp: null }));
    await storage.insertEmail(email({ id: 'clean', spamScore: 0, spamReasons: '[]', originIp: null }));
    await storage.insertEmail(email({ id: 'legacy' })); // fields absent entirely, as an old caller would send

    expect(await storage.getEmail('own')).toMatchObject({ spamScore: null, spamReasons: null, originIp: null });
    expect(await storage.getEmail('clean')).toMatchObject({ spamScore: 0, spamReasons: '[]' });
    expect(await storage.getEmail('legacy')).toMatchObject({ spamScore: null, spamReasons: null, originIp: null });
  });

  // List rows are built from the live column list (every column but the two
  // bodies), so the verdict must ride along to the message list too — the
  // thread banner decides from list rows.
  it('carries the verdict on list rows as well', async () => {
    await storage.insertEmail(email({ id: 'l1', spamScore: 6, spamReasons: '[]', originIp: '8.8.8.8' }));
    const [row] = await storage.getEmailsByFolder('f-inbox', { limit: 10, offset: 0 });
    expect(row).toMatchObject({ id: 'l1', spamScore: 6, originIp: '8.8.8.8' });
  });
});
