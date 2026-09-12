// SQLiteStorage facade — the email surface: writes and dedupe, thread resolution
// on insert, list/section/search reads, snooze, AI categorization and the
// body-prefetch backlog queries.
//
// Real SQLite, full production schema. Lifecycle/folders/contacts live in
// sqlite-storage.test.ts; rollback + concurrency in sqlite-storage-tx.test.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ReadModelMaintainer } from '../../src/read-model-maintainer';
import * as emailRepoModule from '../../src/repositories/email-repository';
import { TestDatabaseCtor } from '../../src/test-support/test-db';

vi.mock('better-sqlite3', () => ({ default: TestDatabaseCtor }));

// See the note in sqlite-storage.test.ts: the facade lazily `require()`s its tag
// helpers, which Node cannot resolve from a .ts neighbour under vitest. Hand back
// the REAL module — no behaviour is stubbed.
const nodeModule = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const originalModuleLoad = nodeModule._load;
nodeModule._load = function (request, parent, isMain) {
  if (request === './repositories/email-repository') return emailRepoModule;
  return originalModuleLoad.call(this, request, parent, isMain);
};

import { SQLiteStorage } from '../../src/sqlite-storage';

const T0 = 1_700_000_000;

function makeFolder(id: string, path: string, over: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id, name: path.split('/').pop()!, path, parentId: null,
    uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
    totalCount: 0, unreadCount: 0, specialUse: null, subscribed: true,
    createdAt: T0, updatedAt: T0, ...over,
  };
}

function makeEmail(over: Partial<EmailRecord> & { id: string }): EmailRecord {
  return {
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
    cleanBody: 'clean body text',
    rawBody: '<p>raw body</p>',
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
  };
}

const STANDARD_FOLDERS = [
  makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox' }),
  makeFolder('f-sent', 'Sent', { specialUse: '\\Sent' }),
  makeFolder('f-trash', 'Trash', { specialUse: '\\Trash' }),
];

/** One temp dir + one initialized, folder-seeded storage per describe.
 *  NOTE: vitest runs the hooks of a single suite in PARALLEL, so a describe must
 *  never register a second beforeAll to seed rows — it would race the one that
 *  opens the DB (and FK-fail). Row seeding goes through `seed` instead. */
function withStorage(seed?: (storage: SQLiteStorage) => Promise<void>): { get: () => SQLiteStorage } {
  let dir = '';
  let storage: SQLiteStorage;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-emails-'));
    storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
    await storage.initialize();
    await storage.syncFolders(STANDARD_FOLDERS);
    if (seed) await seed(storage);
  });

  afterAll(async () => {
    // insertEmailBatch kicks off contact extraction fire-and-forget and yields
    // between chunks; let it finish before the handle goes away so it can't log
    // against a closed database.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return { get: () => storage };
}

/** Seed + drain the read-model synchronously. The live maintainer does this off
 *  the write path (async pump), which would make read-model reads
 *  timing-dependent here; backfillNow() is its documented shutdown/test entry. */
function flushReadModel(storage: SQLiteStorage): void {
  const db = (storage as unknown as { db: Database.Database }).db;
  new ReadModelMaintainer(() => db).backfillNow();
}

// ===========================================================================
// Write path
// ===========================================================================

// insertEmail is the single funnel every message arrives through. It has to be
// idempotent on Message-ID (the same mail arrives from the folder sync AND from
// our own SMTP send) and it must create the threads row BEFORE the email, since
// emails.thread_id is an enforced FK.
describe('SQLiteStorage insertEmail', () => {
  const ctx = withStorage();

  it('creates the thread row alongside the email and reads back the full record', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'w1', subject: 'Hello there', date: T0 + 5 }));

    const stored = await storage.getEmail('w1');
    expect(stored).toMatchObject({
      id: 'w1', messageId: '<w1@example.test>', threadId: 'thread-w1',
      folderId: 'f-inbox', subject: 'Hello there', rawBody: '<p>raw body</p>',
    });
    // The FK target exists and its metadata was computed from the email.
    expect(await storage.getThread('thread-w1')).toMatchObject({
      id: 'thread-w1', subject: 'Hello there', messageCount: 1, lastMessageDate: T0 + 5,
    });
    expect(await storage.getEmailByMessageId('<w1@example.test>')).toMatchObject({ id: 'w1' });
    expect(await storage.getEmailByMessageId('<never-seen@example.test>')).toBeNull();
    expect(await storage.getEmail('no-such-id')).toBeNull();
  });

  it('deduplicates on message_id and links the existing row to the new folder instead', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'w2', messageId: '<dup@example.test>', tags: '|Sent|', folderId: 'f-sent' }));

    // The IMAP copy of the same message shows up in INBOX under a different id.
    await storage.insertEmail(makeEmail({
      id: 'w2-copy', messageId: '<dup@example.test>', tags: '|INBOX|', folderId: 'f-inbox', threadId: 'thread-other',
    }));

    // No second row, no UNIQUE crash — the original just gained the folder tag.
    expect(await storage.getEmail('w2-copy')).toBeNull();
    expect((await storage.getEmail('w2'))!.tags).toContain('|INBOX|');
    expect(await storage.getThread('thread-other')).toBeNull();
  });

  it('re-linking a duplicate to a folder it already carries leaves the tags untouched', async () => {
    const storage = ctx.get();
    const before = (await storage.getEmail('w2'))!.tags;
    await storage.insertEmail(makeEmail({ id: 'w2-again', messageId: '<dup@example.test>', tags: '|INBOX|' }));
    expect((await storage.getEmail('w2'))!.tags).toBe(before);
  });

  it('a duplicate naming an unknown folder is still deduped without corrupting tags', async () => {
    const storage = ctx.get();
    const before = (await storage.getEmail('w2'))!.tags;
    await storage.insertEmail(makeEmail({ id: 'w2-ghost', messageId: '<dup@example.test>', folderId: 'f-nonexistent' }));
    expect((await storage.getEmail('w2'))!.tags).toBe(before);
    expect(await storage.getEmail('w2-ghost')).toBeNull();
  });

  it('updateEmail persists field changes, and unknown ids are a no-op', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'w3', tags: '|INBOX|' }));

    await storage.updateEmail('w3', { cleanBody: 'edited', subject: 'Edited subject' });
    expect(await storage.getEmail('w3')).toMatchObject({ cleanBody: 'edited', subject: 'Edited subject' });

    // A read transition also touches sender_stats — that must not fail the write.
    await storage.updateEmail('w3', { tags: '|INBOX|read|' });
    expect((await storage.getEmail('w3'))!.tags).toBe('|INBOX|read|');
    await storage.updateEmail('w3', { tags: '|INBOX|' });
    expect((await storage.getEmail('w3'))!.tags).toBe('|INBOX|');

    await expect(storage.updateEmail('no-such-id', { tags: '|INBOX|read|' })).resolves.toBeUndefined();
  });

  it('batch reads return only the ids that exist, and empty input yields empty output', async () => {
    const storage = ctx.get();
    expect((await storage.getEmailsByIds(['w1', 'w3', 'missing'])).map((e) => e.id).sort()).toEqual(['w1', 'w3']);
    expect(await storage.getEmailsByIds([])).toEqual([]);
    expect((await storage.getEmailsByMessageIds(['<w1@example.test>', '<nope@example.test>'])).map((e) => e.id))
      .toEqual(['w1']);
    expect(await storage.getEmailsByMessageIds([])).toEqual([]);
    expect(await storage.getEmailIdsByFolderAndUids('f-inbox', [])).toEqual([]);
  });

  it('getIncompleteEmails surfaces rows the header sync left half-populated', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'w4', subject: '' }));
    expect((await storage.getIncompleteEmails(50)).map((e) => e.id)).toContain('w4');
  });

  it('markSentEmailsAsRead flags unread Sent mail once and then reports nothing to do', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'w5', folderId: 'f-sent', tags: '|Sent|' }));

    expect(await storage.markSentEmailsAsRead()).toBeGreaterThanOrEqual(1);
    expect((await storage.getEmail('w5'))!.tags).toContain('|read|');
    expect(await storage.markSentEmailsAsRead()).toBe(0);
  });

  it('deleteEmail / deleteEmails remove rows, and an empty id list is a no-op', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'd1' }));
    await storage.insertEmail(makeEmail({ id: 'd2' }));

    await storage.deleteEmail('d1');
    expect(await storage.getEmail('d1')).toBeNull();

    await expect(storage.deleteEmails([])).resolves.toBeUndefined();
    await storage.deleteEmails(['d2', 'never-existed']);
    expect(await storage.getEmail('d2')).toBeNull();
    // Deleting an absent row must not throw.
    await expect(storage.deleteEmail('d1')).resolves.toBeUndefined();
  });
});

// Corporate webmail often puts only the immediate parent in References, so the
// hash-based thread id in core produces ONE THREAD PER REPLY. resolveThreadId
// re-attaches on the way in — if this regresses, conversations shatter into
// dozens of single-message threads (the "25 mails, no thread" bug).
describe('SQLiteStorage thread resolution on insert', () => {
  const ctx = withStorage();

  it('attaches a reply to its parent thread instead of starting a second one', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({
      id: 'p1', messageId: '<root@example.test>', threadId: 'th-root', subject: 'Quarterly plan', date: T0,
    }));
    await storage.insertEmail(makeEmail({
      id: 'p2', messageId: '<reply@example.test>', threadId: 'th-would-be-new',
      inReplyTo: '<root@example.test>', subject: 'Re: Quarterly plan', date: T0 + 60,
    }));

    const conversation = await storage.getEmailsByThread('th-root');
    expect(conversation.map((e) => e.id).sort()).toEqual(['p1', 'p2']);
    expect(await storage.getThread('th-would-be-new')).toBeNull(); // no husk thread left behind
    expect(await storage.getThread('th-root')).toMatchObject({
      messageCount: 2, lastMessageDate: T0 + 60, subject: 'Quarterly plan',
    });
  });

  it('pulls an orphan reply into its parent thread when the parent arrives LATER', async () => {
    const storage = ctx.get();
    // Newest-first backfill: the child lands before its parent exists.
    await storage.insertEmail(makeEmail({
      id: 'o-child', messageId: '<child@example.test>', threadId: 'th-child',
      inReplyTo: '<parent@example.test>', subject: 'Re: Invoice 42', date: T0 + 100,
    }));
    expect(await storage.getThread('th-child')).not.toBeNull();

    await storage.insertEmail(makeEmail({
      id: 'o-parent', messageId: '<parent@example.test>', threadId: 'th-parent',
      subject: 'Invoice 42', date: T0, fromAddress: 'billing@vendor.test',
    }));

    expect((await storage.getEmailsByThread('th-parent')).map((e) => e.id).sort()).toEqual(['o-child', 'o-parent']);
    // The drained standalone thread is deleted, not left as an empty husk that
    // would keep getting re-queued for AI extraction.
    expect(await storage.getThread('th-child')).toBeNull();
    expect(await storage.getThread('th-parent')).toMatchObject({ messageCount: 2, lastMessageDate: T0 + 100 });
  });

  it('unknown thread ids read back as empty rather than throwing', async () => {
    expect(await ctx.get().getEmailsByThread('no-such-thread')).toEqual([]);
  });

  it('repairThreading reports a dry run without changing anything, then applies it', async () => {
    const storage = ctx.get();
    const dry = await storage.repairThreading({ dryRun: true });
    expect(dry).toMatchObject({ totalEmails: expect.any(Number), threadsBefore: expect.any(Number) });
    expect(dry.emailsRetargeted).toBe(0); // an already-resolved DB has nothing to repair
    expect((await storage.getEmail('o-child'))!.threadId).toBe('th-parent');

    await storage.repairThreading({ dryRun: false });
    // The resolver is the same one the insert path used, so a repaired DB is
    // stable — mail must not be re-scattered by a second pass.
    expect((await storage.getEmail('o-child'))!.threadId).toBe('th-parent');
  });
});

// insertEmailBatch is the initial-sync path: thousands of messages, commits in
// chunks so the main-process event loop keeps breathing. It must sort
// chronologically (a reply resolved before its parent is inserted cannot find
// it) and tolerate duplicate Message-IDs without losing the whole chunk.
describe('SQLiteStorage insertEmailBatch', () => {
  const ctx = withStorage();

  it('is a no-op on an empty batch', async () => {
    const storage = ctx.get();
    await expect(storage.insertEmailBatch([])).resolves.toBeUndefined();
    expect(await storage.getAllEmails()).toEqual([]);
  });

  it('sorts by date so an in-batch reply joins its parent thread', async () => {
    const storage = ctx.get();
    // Deliberately passed newest-first, as an IMAP fetch returns it.
    await storage.insertEmailBatch([
      makeEmail({
        id: 'b-reply', messageId: '<b-reply@example.test>', threadId: 'th-b-reply',
        inReplyTo: '<b-root@example.test>', subject: 'Re: Roadmap', date: T0 + 200,
      }),
      makeEmail({
        id: 'b-root', messageId: '<b-root@example.test>', threadId: 'th-b-root',
        subject: 'Roadmap', date: T0,
      }),
    ]);

    expect((await storage.getEmailsByThread('th-b-root')).map((e) => e.id).sort()).toEqual(['b-reply', 'b-root']);
    expect(await storage.getThread('th-b-reply')).toBeNull();
  });

  it('collapses duplicate message_ids inside one batch to a single row', async () => {
    const storage = ctx.get();
    await storage.insertEmailBatch([
      makeEmail({ id: 'b-dup-1', messageId: '<same@example.test>', tags: '|INBOX|', date: T0 }),
      makeEmail({ id: 'b-dup-2', messageId: '<same@example.test>', tags: '|Sent|', folderId: 'f-sent', date: T0 + 1 }),
    ]);

    expect(await storage.getEmail('b-dup-1')).not.toBeNull();
    expect(await storage.getEmail('b-dup-2')).toBeNull();
    // The duplicate contributed its folder membership to the surviving row.
    expect((await storage.getEmail('b-dup-1'))!.tags).toContain('|Sent|');
  });

  it('pulls a previously-orphaned reply into a parent that arrives in a later BATCH', async () => {
    const storage = ctx.get();
    // The child landed on its own (a single push notification), then the historical
    // backfill delivers the parent as part of a batch. The batch path must run the
    // same orphan reattach and then RECOMPUTE the drained thread, or the child's
    // old husk thread survives with a stale message_count.
    await storage.insertEmail(makeEmail({
      id: 'ob-child', messageId: '<ob-child@example.test>', threadId: 'th-ob-child',
      inReplyTo: '<ob-parent@example.test>', subject: 'Re: Renewal notice', date: T0 + 900,
    }));

    await storage.insertEmailBatch([makeEmail({
      id: 'ob-parent', messageId: '<ob-parent@example.test>', threadId: 'th-ob-parent',
      subject: 'Renewal notice', date: T0 + 800,
    })]);

    expect((await storage.getEmailsByThread('th-ob-parent')).map((e) => e.id).sort())
      .toEqual(['ob-child', 'ob-parent']);
    expect(await storage.getThread('th-ob-child')).toBeNull();
    expect(await storage.getThread('th-ob-parent')).toMatchObject({ messageCount: 2, lastMessageDate: T0 + 900 });
  });

  it('derives sender signals from the batch: replies sent, mail read, mail trashed', async () => {
    const storage = ctx.get();
    // These counters feed every "is this sender important" heuristic. They are
    // derived once, at ingest, from the tags — so a missed signal is never
    // recomputed.
    await storage.insertEmailBatch([
      makeEmail({
        id: 'sig-sent', messageId: '<sig-sent@example.test>', threadId: 'th-sig-sent',
        folderId: 'f-sent', tags: '|Sent|', subject: 'Re: your question',
        fromAddress: 'me@example.test', toAddress: 'colleague@example.test', date: T0 + 700,
      }),
      makeEmail({
        id: 'sig-read', messageId: '<sig-read@example.test>', threadId: 'th-sig-read',
        tags: '|INBOX|read|', fromAddress: 'newsletter@news.test', date: T0 + 710,
      }),
      makeEmail({
        id: 'sig-trash', messageId: '<sig-trash@example.test>', threadId: 'th-sig-trash',
        folderId: 'f-trash', tags: '|Trash|', fromAddress: 'junkmail@news.test', date: T0 + 720,
      }),
    ]);
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));

    // A 'Re:' in a Sent message counts as a reply TO the recipient.
    expect(await storage.getSenderStats('colleague@example.test')).toMatchObject({ sentToCount: 1, repliedCount: 1 });
    expect(await storage.getSenderStats('newsletter@news.test')).toMatchObject({ receivedCount: 1, readCount: 1 });
    expect(await storage.getSenderStats('junkmail@news.test')).toMatchObject({ receivedCount: 1, deletedCount: 1 });
  });

  it('a message with no subject still gets a titled thread', async () => {
    const storage = ctx.get();
    await storage.insertEmailBatch([makeEmail({
      id: 'no-subj', messageId: '<no-subj@example.test>', threadId: 'th-no-subj',
      subject: null, date: T0 + 750,
    })]);
    expect(await storage.getThread('th-no-subj')).toMatchObject({ subject: '(No Subject)' });
  });

  it('bulk/list mail is kept OUT of the same-subject threading fallback', async () => {
    const storage = ctx.get();
    // Newsletters share an identical subject line; folding them together on
    // subject alone would collapse a year of digests into one giant thread.
    await storage.insertEmailBatch([
      makeEmail({
        id: 'bulk-a', messageId: '<bulk-a@example.test>', threadId: 'th-bulk-a',
        tags: '|INBOX|bulk|', subject: 'Your weekly digest is ready',
        fromAddress: 'digest@news.test', date: T0 + 760,
      }),
      makeEmail({
        id: 'bulk-b', messageId: '<bulk-b@example.test>', threadId: 'th-bulk-b',
        tags: '|INBOX|bulk|', subject: 'Your weekly digest is ready',
        fromAddress: 'digest@news.test', date: T0 + 770,
      }),
    ]);

    expect((await storage.getEmail('bulk-a'))!.threadId).toBe('th-bulk-a');
    expect((await storage.getEmail('bulk-b'))!.threadId).toBe('th-bulk-b');
  });

  it('commits across the 100-row chunk boundary and extracts contacts', async () => {
    const storage = ctx.get();
    const batch = Array.from({ length: 105 }, (_, i) => makeEmail({
      id: `bulk-${i}`,
      messageId: `<bulk-${i}@example.test>`,
      threadId: `th-bulk-${i}`,
      date: T0 + i,
      fromAddress: 'bulksender@example.test',
      subject: `Bulk ${i}`,
    }));
    await storage.insertEmailBatch(batch);

    expect((await storage.getEmailsByIds(['bulk-0', 'bulk-99', 'bulk-100', 'bulk-104'])).length).toBe(4);
    // Contact extraction is fire-and-forget; give its chunked pass a turn.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await storage.getContactByEmail('bulksender@example.test')).not.toBeNull();
  });
});

// The bulk mark-read/star handler routes through bulkUpdateTags: one transaction
// per 500 rows instead of N commits. If it skipped a row the badge and the list
// would disagree, which is exactly what users report as "it went unread again".
describe('SQLiteStorage bulkUpdateTags', () => {
  const ctx = withStorage();

  it('applies every row in one pass and returns early on an empty list', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'bt1', tags: '|INBOX|' }));
    await storage.insertEmail(makeEmail({ id: 'bt2', tags: '|INBOX|' }));

    await expect(storage.bulkUpdateTags([])).resolves.toBeUndefined();

    await storage.bulkUpdateTags([
      { id: 'bt1', tags: '|INBOX|read|', fromAddress: 'sender@example.test', wasRead: false, nowRead: true },
      { id: 'bt2', tags: '|INBOX|read|starred|', fromAddress: 'sender@example.test', wasRead: false, nowRead: true },
    ]);

    expect((await storage.getEmail('bt1'))!.tags).toBe('|INBOX|read|');
    expect((await storage.getEmail('bt2'))!.tags).toBe('|INBOX|read|starred|');
    // The aggregated read delta lands on the sender (best-effort, off the hot path).
    await new Promise((resolve) => setImmediate(resolve));
    expect((await storage.getSenderStats('sender@example.test'))?.readCount).toBeGreaterThan(0);
  });

  it('applies a selection larger than one 500-row chunk in full', async () => {
    const storage = ctx.get();
    // "Select all → mark read" on a big mailbox spans several chunks, each its own
    // transaction with an event-loop yield between them. Every row must still end
    // up updated — a dropped tail is what surfaces as "some mail went unread again".
    const many = Array.from({ length: 505 }, (_, i) => makeEmail({
      id: `chunk-${i}`, messageId: `<chunk-${i}@example.test>`, threadId: `th-chunk-${i}`,
      tags: '|INBOX|', date: T0 + 1000 + i,
    }));
    await storage.insertEmailBatch(many);

    await storage.bulkUpdateTags(many.map((e) => ({ id: e.id, tags: '|INBOX|read|' })));

    const stillUnread = (await storage.getEmailsByIds(many.map((e) => e.id)))
      .filter((e) => !e.tags.includes('|read|'));
    expect(stillUnread).toEqual([]);
  });

  it('ignores rows without read-transition metadata and nets out opposite flips', async () => {
    const storage = ctx.get();
    const before = (await storage.getSenderStats('sender@example.test'))?.readCount ?? 0;

    await storage.bulkUpdateTags([
      { id: 'bt1', tags: '|INBOX|' },                                                                  // no metadata
      { id: 'bt2', tags: '|INBOX|starred|', fromAddress: 'sender@example.test', wasRead: true, nowRead: false },
      { id: 'bt2', tags: '|INBOX|read|starred|', fromAddress: 'sender@example.test', wasRead: false, nowRead: true },
    ]);

    expect((await storage.getEmail('bt1'))!.tags).toBe('|INBOX|');
    await new Promise((resolve) => setImmediate(resolve));
    // +1 and -1 for the same sender cancel — no stats write at all.
    expect((await storage.getSenderStats('sender@example.test'))?.readCount).toBe(before);
  });
});

// ===========================================================================
// List / section / folder reads
// ===========================================================================

// The section split (Important-unread / Starred / Everything else) is the whole
// inbox UI. Sections are THREAD-level, and no thread may appear in two of them —
// a mail showing up twice, or vanishing from all three, is immediately visible.
describe('SQLiteStorage section and list queries', () => {
  const ctx = withStorage(async (storage) => {
    await storage.insertEmail(makeEmail({ id: 's-impunread', threadId: 'th-1', tags: '|INBOX|important|', date: T0 + 40 }));
    await storage.insertEmail(makeEmail({ id: 's-starred', threadId: 'th-2', tags: '|INBOX|starred|read|', date: T0 + 30 }));
    await storage.insertEmail(makeEmail({ id: 's-plain', threadId: 'th-3', tags: '|INBOX|', date: T0 + 20 }));
    await storage.insertEmail(makeEmail({ id: 's-read', threadId: 'th-4', tags: '|INBOX|read|', date: T0 + 10 }));
    await storage.insertEmail(makeEmail({ id: 's-trash', threadId: 'th-5', tags: '|Trash|', folderId: 'f-trash', date: T0 + 50 }));
  });

  const ids = (rows: EmailRecord[]) => rows.map((r) => r.id).sort();
  const page = { limit: 50, offset: 0 };

  it('splits threads across the three inbox sections without overlap or loss', async () => {
    const storage = ctx.get();
    const importantUnread = await storage.getEmailsBySection('important_unread', page);
    const starred = await storage.getEmailsBySection('starred', page);
    const rest = await storage.getEmailsBySection('everything_else', page);

    expect(ids(importantUnread)).toEqual(['s-impunread']);
    expect(ids(starred)).toEqual(['s-starred']);
    expect(ids(rest)).toEqual(['s-plain', 's-read']);
    // Trash never appears in any section.
    expect([...ids(importantUnread), ...ids(starred), ...ids(rest)]).not.toContain('s-trash');
  });

  it('serves the flat filters and returns nothing for an unknown section name', async () => {
    const storage = ctx.get();
    expect(ids(await storage.getEmailsBySection('important', page))).toEqual(['s-impunread']);
    expect(ids(await storage.getEmailsBySection('unread', page))).toEqual(['s-impunread', 's-plain']);
    expect(ids(await storage.getEmailsBySection('read', page))).toEqual(['s-read', 's-starred']);
    expect(ids(await storage.getEmailsBySection('not_important', page))).toEqual(['s-plain', 's-read', 's-starred']);
    expect(await storage.getEmailsBySection('no-such-section', page)).toEqual([]);
  });

  it('section counts match the section rows, one filter at a time and in a batch', async () => {
    const storage = ctx.get();
    expect(await storage.getSectionCount('important_unread')).toBe(1);
    expect(await storage.getSectionCount('everything_else')).toBe(2);
    expect(await storage.getSectionCount('no-such-section')).toBe(0);

    expect(await storage.getSectionCounts(['important_unread', 'starred', 'everything_else'])).toEqual({
      important_unread: 1, starred: 1, everything_else: 2,
    });
    expect(await storage.getSectionCounts([])).toEqual({});
  });

  it('a view filter narrows a section to the matching threads', async () => {
    const storage = ctx.get();
    expect(ids(await storage.getEmailsBySection('everything_else', { ...page, viewFilter: { isUnread: true } })))
      .toEqual(['s-plain']);
    expect(ids(await storage.getEmailsBySection('everything_else', { ...page, viewFilter: { isUnread: false } })))
      .toEqual(['s-read']);
  });

  it('the read-model fast path returns the same rows as the legacy scan', async () => {
    const storage = ctx.get();
    flushReadModel(storage); // make thread_folders current, deterministically

    // With a folderPath the facade takes the thread_folders indexed scan.
    expect(ids(await storage.getEmailsBySection('important_unread', { ...page, folderPath: 'INBOX' })))
      .toEqual(['s-impunread']);
    expect(ids(await storage.getEmailsBySection('unread', { ...page, folderPath: 'INBOX' })))
      .toEqual(['s-impunread', 's-plain']);
    expect(await storage.getSectionCount('unread', 'INBOX')).toBe(2);

    // Thread-grained "of N" denominator for the folder view.
    expect(await storage.getFolderThreadCount('INBOX')).toBe(4);
    expect(await storage.getFolderThreadCount('No/Such/Folder')).toBeNull();
    expect(await storage.getFolderThreadCount()).toBeNull();
  });

  it('getFolderThreadCount reports null while the read-model is switched off', async () => {
    const storage = ctx.get();
    // Kill-switch: the caller must fall back to the legacy message-count total
    // rather than showing "of 0".
    process.env.SARVINBOX_READMODEL_READS = '0';
    try {
      expect(await storage.getFolderThreadCount('INBOX')).toBeNull();
    } finally {
      delete process.env.SARVINBOX_READMODEL_READS;
    }
  });

  it('getEmailsByFolder pages a folder, honours collapseThreads, and filters by category tag', async () => {
    const storage = ctx.get();
    flushReadModel(storage);

    const first = await storage.getEmailsByFolder('f-inbox', { limit: 2, offset: 0 });
    expect(first.map((e) => e.id)).toEqual(['s-impunread', 's-starred']); // newest first
    expect((await storage.getEmailsByFolder('f-inbox', { limit: 2, offset: 2 })).map((e) => e.id))
      .toEqual(['s-plain', 's-read']);

    // Thread-collapsed page (the interactive view) comes off the read-model.
    const collapsed = await storage.getEmailsByFolder('f-inbox', { limit: 10, offset: 0, collapseThreads: true });
    expect(collapsed.map((e) => e.id)).toEqual(['s-impunread', 's-starred', 's-plain', 's-read']);

    expect(await storage.getEmailsByFolder('f-nonexistent', { limit: 10, offset: 0 })).toEqual([]);
    expect(await storage.getEmailsByFolder('f-inbox', { limit: 10, offset: 0, categoryTag: 'invoice' })).toEqual([]);
  });

  it('getAllEmails paginates and skips Trash/Sent, and the star/important lists agree with their counts', async () => {
    const storage = ctx.get();
    expect(ids(await storage.getAllEmails())).toEqual(['s-impunread', 's-plain', 's-read', 's-starred']);
    expect((await storage.getAllEmails({ limit: 1, offset: 0 })).map((e) => e.id)).toEqual(['s-impunread']);
    expect((await storage.getAllEmails({ limit: 1, offset: 1 })).map((e) => e.id)).toEqual(['s-starred']);

    expect(ids(await storage.getImportantEmails())).toEqual(['s-impunread']);
    expect(await storage.getImportantCount()).toBe(1);
    expect(ids(await storage.getStarredEmails())).toEqual(['s-starred']);
    expect(await storage.getStarredCount()).toBe(1);
    expect(await storage.getUnreadImportantCount()).toBe(1);
  });

  // The "of N" that heads the All Email list. If this count and getAllEmails
  // ever disagree about what "all mail" means, the paginator promises pages the
  // list can't show (or hides mail the user has).
  it('getAllCount counts exactly what getAllEmails lists', async () => {
    const storage = ctx.get();
    const listed = await storage.getAllEmails({ limit: 500, offset: 0 });
    expect(await storage.getAllCount()).toBe(listed.length);
    expect(await storage.getAllCount()).toBe(4); // Trash is excluded from both
  });

  // The "of N" for a per-message folder listing (All Inboxes counts each
  // account's INBOX this way). Message-level, filter-aware, and it must match
  // what getEmailsByFolder returns under the same filter.
  it('countEmailsInFolder matches the folder listing under the same filter', async () => {
    const storage = ctx.get();
    const all = await storage.getEmailsByFolder('f-inbox', { limit: 100, offset: 0 });
    expect(await storage.countEmailsInFolder('f-inbox')).toBe(all.length);

    const unread = await storage.getEmailsByFolder('f-inbox', { limit: 100, offset: 0, filter: { isUnread: true } });
    expect(await storage.countEmailsInFolder('f-inbox', { filter: { isUnread: true } })).toBe(unread.length);

    const starred = await storage.getEmailsByFolder('f-inbox', { limit: 100, offset: 0, filter: { isFlagged: true } });
    expect(await storage.countEmailsInFolder('f-inbox', { filter: { isFlagged: true } })).toBe(starred.length);

    // An unknown folder counts 0 rather than throwing — a missing mailbox must
    // read as "nothing to page", not crash the view that heads it.
    expect(await storage.countEmailsInFolder('f-nonexistent')).toBe(0);
    expect(await storage.countEmailsInFolder('f-inbox', { categoryTag: 'invoice' })).toBe(0);
  });

  it('getRecentEmails windows by timestamp', async () => {
    const storage = ctx.get();
    expect(ids(await storage.getRecentEmails({ sinceTimestamp: T0 + 35 }))).toEqual(['s-impunread', 's-trash']);
    expect(await storage.getRecentEmails({ sinceTimestamp: T0 + 10_000 })).toEqual([]);
  });
});

// ===========================================================================
// Search
// ===========================================================================

// Search is FTS5-backed with a LIKE fallback. The index is kept current by
// triggers, so a stale/missing index means the user's own mail is unfindable.
describe('SQLiteStorage search', () => {
  const ctx = withStorage(async (storage) => {
    await storage.insertEmail(makeEmail({
      id: 'q1', subject: 'Invoice for pelican supplies', cleanBody: 'total due 400',
      fromAddress: 'billing@vendor.test', date: T0 + 10, tags: '|INBOX|',
    }));
    await storage.insertEmail(makeEmail({
      id: 'q2', subject: 'Lunch plans', cleanBody: 'pelican cafe at noon',
      fromAddress: 'friend@example.test', date: T0 + 20, tags: '|INBOX|starred|',
    }));
    await storage.insertEmail(makeEmail({
      id: 'q3', subject: 'Invoice reminder', cleanBody: 'still unpaid',
      fromAddress: 'billing@vendor.test', date: T0 + 30, tags: '|Trash|', folderId: 'f-trash',
    }));
  });

  it('finds matches in subject and body, and counts the full result set', async () => {
    const storage = ctx.get();
    const hits = await storage.searchEmails({ query: 'pelican', limit: 10 });
    expect(hits.map((e) => e.id).sort()).toEqual(['q1', 'q2']);
    expect(await storage.searchEmailsCount({ query: 'pelican' })).toBe(2);
    expect(await storage.searchEmails({ query: 'zzzznomatch' })).toEqual([]);
    expect(await storage.searchEmailsCount({ query: 'zzzznomatch' })).toBe(0);
  });

  it('narrows by sender and by folder scope', async () => {
    const storage = ctx.get();
    expect((await storage.searchEmails({ query: 'invoice', from: 'billing@vendor.test', limit: 10 })).map((e) => e.id))
      .toContain('q1');
    const inTrash = await storage.searchEmails({ query: 'invoice', scope: 'folder', folderPath: 'Trash', limit: 10 });
    expect(inTrash.map((e) => e.id)).toEqual(['q3']);
  });

  it('an empty query returns rows (metadata-only search) rather than failing', async () => {
    const storage = ctx.get();
    const starred = await storage.searchEmails({ query: '', isFlagged: true, limit: 10 });
    expect(starred.map((e) => e.id)).toEqual(['q2']);
  });

  it('fullTextSearch is the same path with a default page size', async () => {
    const storage = ctx.get();
    expect((await storage.fullTextSearch('pelican')).map((e) => e.id).sort()).toEqual(['q1', 'q2']);
    // The options bag repeats `query` (SearchQuery requires it); the positional
    // argument is the one that actually drives the match.
    expect((await storage.fullTextSearch('pelican', { query: 'pelican', limit: 1 })).length).toBe(1);
  });

  it('rebuildSearchIndex repopulates the index so results survive it', async () => {
    const storage = ctx.get();
    await storage.rebuildSearchIndex();
    expect((await storage.searchEmails({ query: 'pelican', limit: 10 })).map((e) => e.id).sort()).toEqual(['q1', 'q2']);
  });

  it('suggests indexed terms for a prefix and ignores too-short input', async () => {
    const storage = ctx.get();
    expect(storage.getSearchSuggestions('pel')).toContain('pelican');
    expect(storage.getSearchSuggestions('p')).toEqual([]);
    expect(storage.getSearchSuggestions('zzzzq')).toEqual([]);
  });
});

// ===========================================================================
// Snooze
// ===========================================================================

// Snooze is tag-based: the original tags are stashed on the row so unsnoozing can
// restore the mail. Losing snoozeOriginalTags would strand the message outside
// every folder view — it would look deleted.
describe('SQLiteStorage snooze', () => {
  const ctx = withStorage();

  it('snoozes, lists, unsnoozes and counts', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'z1', tags: '|INBOX|read|', threadId: 'th-z1' }));

    const record = await storage.snoozeEmail('z1', T0 + 3600);
    expect(record).toMatchObject({
      id: 'snooze-z1', emailId: 'z1', threadId: 'th-z1', snoozeUntil: T0 + 3600, originalFolderId: 'f-inbox',
    });

    const stored = (await storage.getEmail('z1'))!;
    expect(stored.tags).toContain('|snoozed|');
    expect(stored.snoozeUntil).toBe(T0 + 3600);
    expect(stored.snoozeOriginalTags).toBe('|INBOX|read|');

    expect((await storage.getSnoozedEmails()).map((s) => s.emailId)).toEqual(['z1']);
    expect(await storage.getSnoozedCount()).toBe(1);
    expect(await storage.getSnoozeRecord('z1')).toMatchObject({ emailId: 'z1', snoozeUntil: T0 + 3600 });

    await storage.unsnoozeEmail('z1');
    const woken = (await storage.getEmail('z1'))!;
    expect(woken.tags).not.toContain('|snoozed|');
    expect(woken.tags).toContain('|was_snoozed|');
    expect(woken.tags).not.toContain('|read|'); // resurfaces as unread by default
    expect(woken.snoozeUntil).toBeNull();
    expect(await storage.getSnoozedCount()).toBe(0);
    expect(await storage.getSnoozeRecord('z1')).toBeNull();
  });

  it('unsnoozing with markUnread=false keeps the read flag', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'z2', tags: '|INBOX|read|' }));
    await storage.snoozeEmail('z2', T0 + 10);
    await storage.unsnoozeEmail('z2', false);
    expect((await storage.getEmail('z2'))!.tags).toContain('|read|');
  });

  it('getDueSnoozedEmails only returns snoozes whose time has passed', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'z3', tags: '|INBOX|' }));
    await storage.snoozeEmail('z3', 1); // epoch+1s — long past
    await storage.insertEmail(makeEmail({ id: 'z4', tags: '|INBOX|' }));
    await storage.snoozeEmail('z4', 4_000_000_000); // far future

    const due = await storage.getDueSnoozedEmails();
    expect(due.map((s) => s.emailId)).toEqual(['z3']);
  });

  it('snoozing an unknown email throws, unsnoozing one is a silent no-op', async () => {
    const storage = ctx.get();
    await expect(storage.snoozeEmail('no-such-id', T0)).rejects.toThrow('Email not found: no-such-id');
    await expect(storage.unsnoozeEmail('no-such-id')).resolves.toBeUndefined();
  });
});

// Its own storage: the assertions are about the WHOLE snoozed set (its count and
// how it pages), so a leftover snooze from another test would move every number.
describe('SQLiteStorage snooze listings are thread-grained', () => {
  const ctx = withStorage();

  // The Snoozed VIEW pages by conversation, and both listings must agree with
  // getSnoozedCount — a limit that meant messages would cut a thread in half and
  // leave the header counting pages the list can't turn to.
  it('lists snoozed mail a conversation at a time, as records and as emails', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'zt1a', threadId: 'th-zt1', tags: '|INBOX|', date: T0 + 1 }));
    await storage.insertEmail(makeEmail({ id: 'zt1b', threadId: 'th-zt1', tags: '|INBOX|', date: T0 + 2 }));
    await storage.insertEmail(makeEmail({ id: 'zt2a', threadId: 'th-zt2', tags: '|INBOX|', date: T0 + 3 }));
    await storage.snoozeEmail('zt1a', T0 + 100);
    await storage.snoozeEmail('zt1b', T0 + 900);
    await storage.snoozeEmail('zt2a', T0 + 500);

    expect(await storage.getSnoozedCount()).toBe(2); // two conversations, three messages

    // One conversation asked for, every snoozed message of it handed back.
    const firstPage = await storage.getSnoozedEmails({ limit: 1, offset: 0 });
    expect(firstPage.map((s) => s.emailId)).toEqual(['zt1a', 'zt1b']);
    expect(firstPage.every((s) => typeof s.snoozeUntil === 'number')).toBe(true);

    // The emails form of the same page — what the view renders, in one call
    // instead of one IPC round trip per message.
    const rows = await storage.getSnoozedEmailRecords({ limit: 1, offset: 1 });
    expect(rows.map((e) => e.id)).toEqual(['zt2a']);
  });

});

// ===========================================================================
// AI categorization, categories, spammers, summaries, conversations
// ===========================================================================

// AI categories are stored as tags on the email plus ai_* metadata columns — no
// side table. Saving a category set must REPLACE the previous slugs (not append),
// or an email accumulates contradictory labels forever.
describe('SQLiteStorage AI categorization', () => {
  const ctx = withStorage(async (storage) => {
    await storage.insertEmail(makeEmail({ id: 'ai1', threadId: 'th-ai1', tags: '|INBOX|', date: T0 + 10 }));
    await storage.insertEmail(makeEmail({ id: 'ai2', threadId: 'th-ai2', tags: '|INBOX|', date: T0 + 20 }));
  });

  it('stores importance and auth status on the email row', async () => {
    const storage = ctx.get();
    await storage.updateEmailImportance('ai1', 80, 'ai');
    expect(await storage.getEmail('ai1')).toMatchObject({ importanceScore: 80, importanceSource: 'ai' });

    await storage.updateEmailAuthStatus('ai1', '{"spf":"pass"}');
    expect((await storage.getEmail('ai1'))!.authStatus).toBe('{"spf":"pass"}');
  });

  it('upsert → read → remove an AI category round-trips through tags', async () => {
    const storage = ctx.get();
    await storage.upsertEmailAICategory({
      emailId: 'ai1', isImportant: true, isSpam: false, isReminder: false, isWaitingReply: false,
      isNeedsResponse: true, isMeetingRelated: false, isInvoiceBilling: false,
      reasoning: 'asks a direct question', confidence: 0.9, processedAt: T0 + 100,
    });

    expect(await storage.getEmailAICategory('ai1')).toMatchObject({
      emailId: 'ai1', isImportant: true, isNeedsResponse: true, isSpam: false,
      reasoning: 'asks a direct question', processedAt: T0 + 100,
    });
    const tagged = (await storage.getEmail('ai1'))!.tags;
    expect(tagged).toContain('|important|');
    expect(tagged).toContain('|needs_response|');

    // A never-categorized email has no category (not a zeroed one).
    expect(await storage.getEmailAICategory('ai2')).toBeNull();

    await storage.removeEmailAICategory('ai1');
    expect(await storage.getEmailAICategory('ai1')).toBeNull();
    expect((await storage.getEmail('ai1'))!.tags).not.toContain('|needs_response|');
    // deleteEmailAICategory is the same operation under another name.
    await expect(storage.deleteEmailAICategory('ai1')).resolves.toBeUndefined();
    await expect(storage.removeEmailAICategory('no-such-id')).resolves.toBeUndefined();
  });

  it('saveEmailCategories REPLACES the previous slug set instead of appending', async () => {
    const storage = ctx.get();
    storage.saveEmailCategories('ai2', [{ slug: 'meeting', confidence: 0.8 }], false, 'invite', T0 + 200, 0.8);
    expect((await storage.getEmail('ai2'))!.tags).toContain('|meeting|');

    storage.saveEmailCategories('ai2', [{ slug: 'invoice', confidence: 0.7 }], false, 'bill', T0 + 300, 0.7);
    const tags = (await storage.getEmail('ai2'))!.tags;
    expect(tags).toContain('|invoice|');
    expect(tags).not.toContain('|meeting|');

    // An unknown email id is skipped, not an error.
    expect(() => storage.saveEmailCategories('no-such-id', [], false, '', T0, 0)).not.toThrow();
  });

  it('the batch writers report how many rows they touched', async () => {
    const storage = ctx.get();
    expect(storage.saveEmailCategoriesBatch([])).toBe(0);
    expect(storage.saveEmailCategoriesBatch([
      { emailId: 'ai1', categories: [{ slug: 'reminders', confidence: 0.6 }], isSpam: false, reasoning: '', processedAt: T0 + 400, confidence: 0.6 },
      { emailId: 'missing', categories: [], isSpam: false, reasoning: '', processedAt: T0 + 400, confidence: 0 },
    ])).toBe(1);
    expect((await storage.getEmail('ai1'))!.tags).toContain('|reminders|');

    expect(storage.upsertCategoryBatch([{
      emailId: 'ai1', isImportant: true, isSpam: false, isReminder: false, isWaitingReply: false,
      isNeedsResponse: false, isMeetingRelated: true, isInvoiceBilling: false,
      confidence: 0.5, processedAt: T0 + 500,
    }])).toBe(1);
    const tags = (await storage.getEmail('ai1'))!.tags;
    expect(tags).toContain('|meeting|');
    expect(tags).not.toContain('|reminders|');
  });

  it('lists and counts emails by category, and by dynamic slug', async () => {
    const storage = ctx.get();
    expect((await storage.getEmailsByAICategory('meeting')).map((e) => e.id)).toEqual(['ai1']);
    expect(await storage.getEmailsByAICategory('no-such-slug')).toEqual([]);

    expect(await storage.getAICategoryCounts()).toMatchObject({ meeting: 1, invoice: 1 });
    expect((await storage.getEmailsByDynamicCategory('invoice')).map((e) => e.id)).toEqual(['ai2']);
    expect((await storage.getEmailsByDynamicCategory('invoice', { folderId: 'f-inbox' })).map((e) => e.id)).toEqual(['ai2']);
    expect(await storage.getEmailsByDynamicCategory('invoice', { folderId: 'f-nonexistent' })).toEqual([]);
    expect(await storage.getEmailsByDynamicCategory('uncategorized', { folderId: 'f-nonexistent' })).toEqual([]);
    expect(Array.isArray(await storage.getEmailsByDynamicCategory('uncategorized'))).toBe(true);

    expect(storage.getDynamicCategoryCounts()['invoice']).toBe(1);
    expect(storage.getDynamicCategoryCounts('f-inbox')['invoice']).toBe(1);

    const batch = storage.getEmailCategoriesBatch(['ai1', 'ai2']);
    expect([...batch.ai1].sort()).toEqual(['important', 'meeting']);
    expect(batch.ai2).toEqual(['invoice']);
    expect(storage.getEmailCategoriesBatch([])).toEqual({});
  });

  it('category definitions can be added, toggled and deleted (system ones are protected)', async () => {
    const storage = ctx.get();
    const systemSlugs = storage.getCategoryDefinitions().filter((d) => d.isSystem).map((d) => d.slug);

    storage.upsertCategoryDefinition({ slug: 'travel', name: 'Travel', prompt: 'flights and hotels' });
    expect(storage.getCategoryDefinitions().map((d) => d.slug)).toContain('travel');
    expect(storage.getEnabledCategoryDefinitions().map((d) => d.slug)).toContain('travel');

    storage.toggleCategoryDefinition('travel', false);
    expect(storage.getEnabledCategoryDefinitions().map((d) => d.slug)).not.toContain('travel');
    // A disabled definition is still defined (its badge still renders).
    expect(storage.getCategoryDefinitions().map((d) => d.slug)).toContain('travel');

    expect(storage.deleteCategoryDefinition('travel')).toBe(true);
    expect(storage.getCategoryDefinitions().map((d) => d.slug)).not.toContain('travel');
    expect(storage.deleteCategoryDefinition('travel')).toBe(false);
    expect(storage.deleteCategoryDefinition('')).toBe(false); // empty slug is a no-op

    if (systemSlugs.length > 0) {
      // A built-in category must never be deletable — the pipeline depends on it.
      expect(storage.deleteCategoryDefinition(systemSlugs[0])).toBe(false);
      expect(storage.getCategoryDefinitions().map((d) => d.slug)).toContain(systemSlugs[0]);
    }
  });

  it('the AI work queue only offers unprocessed, unread mail that has a body', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'ai-fresh', threadId: 'th-ai-fresh', tags: '|INBOX|', date: T0 + 600 }));
    await storage.insertEmail(makeEmail({ id: 'ai-read', threadId: 'th-ai-read', tags: '|INBOX|read|', date: T0 + 610 }));
    await storage.insertEmail(makeEmail({
      id: 'ai-nobody', threadId: 'th-ai-nobody', tags: '|INBOX|', cleanBody: '', rawBody: '', date: T0 + 620,
    }));

    const eligible = storage.getEligibleEmailsForAI(50).map((e) => e.id);
    expect(eligible).toContain('ai-fresh');
    expect(eligible).not.toContain('ai-read');   // already triaged by the user
    expect(eligible).not.toContain('ai-nobody'); // nothing to classify yet
    expect(eligible).not.toContain('ai1');       // already processed

    expect(await storage.getUnprocessedEmailCount()).toBe(eligible.length);
    expect((await storage.getEmailsNeedingProcessing(50)).map((e) => e.id)).toContain('ai-fresh');
    expect((await storage.getEmailsWithoutAICategory(50)).map((e) => e.id)).toContain('ai-fresh');
  });

  it('parse-failure counters survive restarts and split pending-retry from given-up', async () => {
    const storage = ctx.get();
    expect(storage.incrementParseFailureCount('ai-fresh')).toBe(1);
    expect(storage.incrementParseFailureCount('ai-fresh')).toBe(2);
    // An unknown id must report 0, not crash the categorization loop.
    expect(storage.incrementParseFailureCount('no-such-id')).toBe(0);

    expect(storage.getParseFailureCounts(2)).toMatchObject({ pendingRetry: 1 });
    storage.resetParseFailureCount('ai-fresh');
    expect(storage.getParseFailureCounts(2).pendingRetry).toBe(0);
  });

  it('spammer list adds, queries by address and domain, and removes', async () => {
    const storage = ctx.get();
    await storage.addSpammer({ email: 'bad@spam.test', reason: 'phishing' });

    expect(await storage.isSpammer('bad@spam.test')).toBe(true);
    expect(await storage.isSpammer('good@example.test')).toBe(false);
    // ONE report must never condemn a whole domain — the rule is 3+ addresses.
    expect(await storage.isSpammerDomain('spam.test')).toBe(false);
    await storage.addSpammer({ email: 'bad2@spam.test' });
    await storage.addSpammer({ email: 'bad3@spam.test' });
    expect(await storage.isSpammerDomain('spam.test')).toBe(true);
    expect(await storage.isSpammerDomain('example.test')).toBe(false);

    expect((await storage.getSpammers()).map((sp) => sp.email).sort())
      .toEqual(['bad2@spam.test', 'bad3@spam.test', 'bad@spam.test']);
    expect(await storage.getSpammerCount()).toBe(3);
    expect(await storage.getSpammerCount('bad2')).toBe(1);
    expect(await storage.getSpammerCount('nomatch')).toBe(0);

    await storage.removeSpammer('bad@spam.test');
    expect(await storage.isSpammer('bad@spam.test')).toBe(false);
  });

  it('thread summaries and conversation extractions round-trip and clear', async () => {
    const storage = ctx.get();
    await storage.upsertThreadSummary({
      threadId: 'th-ai1', summary: 'Two people agreeing', keyPoints: ['ship friday'],
      participants: ['a@example.test'], lastEmailDate: T0 + 10, emailCount: 2, processedAt: T0 + 20,
    });
    expect(await storage.getThreadSummary('th-ai1')).toMatchObject({
      summary: 'Two people agreeing', keyPoints: ['ship friday'], emailCount: 2,
    });
    expect(await storage.getThreadSummary('th-nope')).toBeNull();

    const messages = JSON.stringify([{ sourceEmailId: 'ai1', isExtracted: false, body: '<p>my own words</p>' }]);
    await storage.upsertConversation({
      threadId: 'th-ai1', messages, emailCount: 2, processedEmailIds: JSON.stringify(['ai1']), processedAt: T0 + 30,
    });
    expect(await storage.getConversation('th-ai1')).toMatchObject({ threadId: 'th-ai1', emailCount: 2 });
    expect(await storage.getConversation('th-nope')).toBeNull();

    // The chat-view cache is the cheap source of "just this sender's new words".
    expect(storage.getChatViewBodyForEmail('th-ai1', 'ai1')).toBe('<p>my own words</p>');
    expect(storage.getChatViewBodyForEmail('th-ai1', 'ai2')).toBeNull();
    expect(storage.getChatViewBodyForEmail('th-nope', 'ai1')).toBeNull();

    await storage.deleteThreadSummary('th-ai1');
    expect(await storage.getThreadSummary('th-ai1')).toBeNull();
    await storage.deleteConversation('th-ai1');
    expect(await storage.getConversation('th-ai1')).toBeNull();

    await storage.upsertConversation({
      threadId: 'th-ai2', messages: '[]', emailCount: 1, processedEmailIds: '[]', processedAt: T0 + 40,
    });
    expect(await storage.clearAllConversations()).toBe(1);
    expect(await storage.clearAllConversations()).toBe(0);
  });

  it('a malformed conversation cache degrades to null instead of throwing', async () => {
    const storage = ctx.get();
    await storage.upsertConversation({
      threadId: 'th-ai1', messages: 'not json at all', emailCount: 1, processedEmailIds: '[]', processedAt: T0,
    });
    expect(storage.getChatViewBodyForEmail('th-ai1', 'ai1')).toBeNull();

    // An entry whose body is only markup has no words to show.
    await storage.upsertConversation({
      threadId: 'th-ai1',
      messages: JSON.stringify([{ sourceEmailId: 'ai1', isExtracted: false, body: '<br>' }]),
      emailCount: 1, processedEmailIds: '[]', processedAt: T0,
    });
    expect(storage.getChatViewBodyForEmail('th-ai1', 'ai1')).toBeNull();
  });
});

// ===========================================================================
// Body-prefetch backlog + remote-image allowlist
// ===========================================================================

// The body-prefetch scheduler re-runs these queries every 60s. If a permanently
// dead row (expunged UID) kept coming back, the app would churn IMAP connections
// forever and never drain the backlog — that is what |nobody| exists to stop.
describe('SQLiteStorage body-prefetch backlog queries', () => {
  const ctx = withStorage(async (storage) => {
    const bodyless = { cleanBody: '', rawBody: '' };
    await storage.insertEmail(makeEmail({ id: 'nb-unread', threadId: 'th-nb', tags: '|INBOX|', date: T0 + 10, ...bodyless }));
    await storage.insertEmail(makeEmail({ id: 'nb-read', threadId: 'th-nb', tags: '|INBOX|read|', date: T0 + 20, ...bodyless }));
    await storage.insertEmail(makeEmail({
      id: 'nb-trash', threadId: 'th-nb-trash', tags: '|Trash|', folderId: 'f-trash', date: T0 + 30, ...bodyless,
    }));
    await storage.insertEmail(makeEmail({ id: 'nb-hasbody', threadId: 'th-nb-body', tags: '|INBOX|', date: T0 + 40 }));
  });

  it('separates "any bodyless mail" from "unread bodyless mail" and excludes Trash', async () => {
    const storage = ctx.get();
    expect(storage.getEmailIdsWithoutBody(50).sort()).toEqual(['nb-read', 'nb-trash', 'nb-unread']);
    expect(storage.getUnreadEmailIdsWithoutBody(50)).toEqual(['nb-unread']);
    expect(storage.getSeedEmailIdsWithoutBody(50).sort()).toEqual(['nb-read', 'nb-unread']);
    expect(storage.countUnreadEmailsWithoutBody()).toBe(1);
    expect(storage.countEmailsWithoutBody()).toBe(2);
    expect(storage.getEmailIdsWithoutBody(1).length).toBe(1);
  });

  it('thread siblings fan out from the seeds without repeating them', async () => {
    const storage = ctx.get();
    expect(storage.getThreadSiblingsWithoutBody(['nb-unread'])).toEqual(['nb-read']);
    expect(storage.getThreadSiblingsWithoutBody([])).toEqual([]);
    expect(storage.getThreadSiblingsWithoutBody(['no-such-email'])).toEqual([]);
    // A thread whose only bodyless member IS the seed contributes nothing.
    expect(storage.getThreadSiblingsWithoutBody(['nb-unread', 'nb-read'])).toEqual([]);
  });

  // The seed window is newest-first, so without an offset a stuck head is asked
  // for again on every tick and the backlog behind it is never attempted. The
  // scheduler rotates past a starved head using this offset — if it stopped
  // paging, thousands of older emails would stay at header-only forever.
  it('pages the newest-first seed window with an offset, and runs out cleanly past the end', async () => {
    const storage = ctx.get();
    expect(storage.getSeedEmailIdsWithoutBody(50, 0)).toEqual(['nb-read', 'nb-unread']);
    expect(storage.getSeedEmailIdsWithoutBody(1, 0)).toEqual(['nb-read']);

    // Rotating past the head hands back the NEXT rows, not the same ones again.
    expect(storage.getSeedEmailIdsWithoutBody(1, 1)).toEqual(['nb-unread']);
    expect(storage.getSeedEmailIdsWithoutBody(50, 1)).toEqual(['nb-unread']);

    // Past the end is an empty window (the caller wraps back to 0), never an error.
    expect(storage.getSeedEmailIdsWithoutBody(50, 2)).toEqual([]);
    expect(storage.getSeedEmailIdsWithoutBody(50, 9999)).toEqual([]);

    // A negative offset is clamped rather than passed to SQLite, which would
    // treat it as "no offset" on some builds and silently re-serve the head.
    expect(storage.getSeedEmailIdsWithoutBody(50, -5)).toEqual(['nb-read', 'nb-unread']);

    // Omitting the offset must keep behaving exactly as it did before.
    expect(storage.getSeedEmailIdsWithoutBody(50)).toEqual(['nb-read', 'nb-unread']);
  });

  it('markBodiesUnfetchable retires dead rows from every backlog query, idempotently', async () => {
    const storage = ctx.get();
    storage.markBodiesUnfetchable([]); // empty is a no-op
    storage.markBodiesUnfetchable(['nb-unread', 'no-such-email']);

    const tags = (await storage.getEmail('nb-unread'))!.tags;
    expect(tags).toContain('|nobody|');
    expect(storage.getUnreadEmailIdsWithoutBody(50)).toEqual([]);
    expect(storage.getSeedEmailIdsWithoutBody(50)).toEqual(['nb-read']);
    expect(storage.countUnreadEmailsWithoutBody()).toBe(0);

    // Retire the rest too — the counters must read a clean zero, not NULL.
    storage.markBodiesUnfetchable(['nb-read']);
    expect(storage.countEmailsWithoutBody()).toBe(0);
    expect(storage.getSeedEmailIdsWithoutBody(10)).toEqual([]);

    // Re-marking must not append a second marker (guarded by the instr() check).
    storage.markBodiesUnfetchable(['nb-unread']);
    expect((await storage.getEmail('nb-unread'))!.tags).toBe(tags);
  });

  // The marker records a VERDICT, and a verdict reached during a bad IMAP
  // session (flapping connection, rate limit, expired token) is simply wrong —
  // the mail is on the server and downloads fine on a healthy connection. So the
  // app clears the markers each launch. Before this existed, one bad session left
  // mail permanently body-less with no way back short of editing the database.
  it('clearBodiesUnfetchable puts retired rows back in the backlog without touching other tags', async () => {
    const storage = ctx.get();
    // Start from a known-clean state: this suite shares one DB, so an earlier
    // test may already have retired these rows.
    storage.clearBodiesUnfetchable();
    const before = (await storage.getEmail('nb-unread'))!.tags;
    expect(before).not.toContain('|nobody|');

    storage.markBodiesUnfetchable(['nb-unread', 'nb-read']);
    expect(storage.getSeedEmailIdsWithoutBody(50)).toEqual([]);

    expect(storage.clearBodiesUnfetchable()).toBe(2);      // rows actually cleared

    // Back in every backlog query, and the surrounding tags survived intact —
    // the marker is spliced out, not the whole tag string rewritten.
    expect(storage.getSeedEmailIdsWithoutBody(50).sort()).toEqual(['nb-read', 'nb-unread']);
    expect((await storage.getEmail('nb-unread'))!.tags).toBe(before);
    expect((await storage.getEmail('nb-unread'))!.tags).not.toContain('|nobody|');
    expect(storage.countEmailsWithoutBody()).toBe(2);

    // Idempotent: nothing left to clear reports zero rather than throwing.
    expect(storage.clearBodiesUnfetchable()).toBe(0);
  });

  it('the remote-image sender allowlist normalizes and dedupes addresses', async () => {
    const storage = ctx.get();
    await storage.allowSenderImages('  Trusted@Example.TEST ');
    await storage.allowSenderImages('trusted@example.test');
    await storage.allowSenderImages('');

    expect(await storage.getImageAllowedSenders()).toEqual(['trusted@example.test']);
  });
});
