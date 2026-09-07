// SQLiteStorage facade — transactional integrity.
//
// This is the file that protects against SILENT DATA LOSS: every batch path here
// writes several rows per transaction, and a failure halfway through must leave
// the database exactly as it was rather than half-applied. A partially-applied
// batch is invisible at runtime (no error surfaces to the user) but leaves
// orphan threads, phantom folders and mail that can never be found again.
//
// It also pins what happens when several facade writes are in flight at once:
// better-sqlite3 is synchronous, but the chunked batch paths DO yield the event
// loop between chunks, so two callers really can interleave.

import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as emailRepoModule from '../../src/repositories/email-repository';
import { TestDatabaseCtor } from '../../src/test-support/test-db';

vi.mock('better-sqlite3', () => ({ default: TestDatabaseCtor }));

// See the note in sqlite-storage.test.ts — the facade lazily CJS-`require()`s its
// tag helpers, which vitest cannot resolve from the .ts neighbour. The REAL module
// is handed back; nothing is stubbed.
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
  };
}

/** Raw row access, used only to prove nothing survived a rollback. */
function rawDb(storage: SQLiteStorage): Database.Database {
  return (storage as unknown as { db: Database.Database }).db;
}

const countRows = (storage: SQLiteStorage, table: string): number =>
  (rawDb(storage).prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

// A fresh DB per test: rollback assertions are about ABSENCE, which only means
// something when the starting state is known.
let dir: string;
let storage: SQLiteStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-tx-'));
  storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
  await storage.initialize();
  await storage.syncFolders([
    makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox' }),
    makeFolder('f-arch', 'Archive'),
  ]);
});

afterEach(async () => {
  // insertEmailBatch kicks off contact extraction fire-and-forget and yields
  // between its chunks; let it finish before the handle goes away so it can't log
  // against a closed database.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// Rollback on error
// ===========================================================================

describe('SQLiteStorage rolls back a failed write completely', () => {
  // A row with no id. The facade inserts the `threads` row (whose
  // first_message_id/last_message_id are the email id and are NOT NULL) BEFORE
  // the email, so this fails on a SYNCHRONOUS statement inside the transaction —
  // exactly where a real constraint violation lands. Its `date` stays valid so
  // the batch's chronological sort remains deterministic.
  const unwritable = (label: string, date: number): EmailRecord => makeEmail({
    id: null as unknown as string,
    messageId: `<${label}@example.test>`,
    threadId: `th-${label}`,
    subject: `Unwritable ${label}`,
    date,
  });

  it('insertEmail propagates the error and leaves neither an email nor a thread row', async () => {
    // An un-rolled-back thread would be a husk the AI extraction queue keeps
    // picking up forever, and the read-model would advertise a conversation with
    // no messages in it.
    await expect(storage.insertEmail(unwritable('x1', T0))).rejects.toThrow(/NOT NULL/i);

    expect(await storage.getEmailByMessageId('<x1@example.test>')).toBeNull();
    expect(countRows(storage, 'threads')).toBe(0);
    expect(countRows(storage, 'emails')).toBe(0);
  });

  it('a later insert still works after a rolled-back one (the connection is not wedged)', async () => {
    await expect(storage.insertEmail(unwritable('x1', T0))).rejects.toThrow();

    await storage.insertEmail(makeEmail({ id: 'x2' }));
    expect((await storage.getEmail('x2'))?.id).toBe('x2');
    expect(countRows(storage, 'emails')).toBe(1);
  });

  it('insertEmailBatch discards the WHOLE chunk when one message fails mid-flight', async () => {
    // THE test: two messages are already written inside the transaction when the
    // third fails. Both must disappear with it — a half-applied chunk leaves mail
    // and threads that no later sync will ever revisit.
    await expect(storage.insertEmailBatch([
      makeEmail({ id: 'b1', threadId: 'th-b1', date: T0 }),
      makeEmail({ id: 'b2', threadId: 'th-b2', date: T0 + 1 }),
      unwritable('b3', T0 + 2),
      makeEmail({ id: 'b4', threadId: 'th-b4', date: T0 + 3 }),
    ])).rejects.toThrow(/NOT NULL/i);

    expect(await storage.getEmailsByIds(['b1', 'b2', 'b3', 'b4'])).toEqual([]);
    expect(countRows(storage, 'emails')).toBe(0);
    expect(countRows(storage, 'threads')).toBe(0);
  });

  it('an ALREADY-COMMITTED earlier chunk survives a later chunk failing (resumable ingest)', async () => {
    // Deliberate design: each 100-row chunk is its own transaction so a huge sync
    // does not hold the event loop, and ingest is idempotent on Message-ID. So a
    // failure in chunk 2 KEEPS chunk 1 — the sync resumes instead of restarting.
    const good = Array.from({ length: 100 }, (_, i) => makeEmail({
      id: `c${i}`, threadId: `th-c${i}`, date: T0 + i,
    }));

    await expect(storage.insertEmailBatch([...good, unwritable('c-bad', T0 + 500)]))
      .rejects.toThrow(/NOT NULL/i);

    expect(countRows(storage, 'emails')).toBe(100);
    expect(await storage.getEmail('c0')).not.toBeNull();
    expect(await storage.getEmail('c99')).not.toBeNull();
    expect(await storage.getEmail('c-bad')).toBeNull();
  });

  it('bulkUpdateTags applies nothing when one row in the chunk is invalid', async () => {
    // The bulk mark-read handler sends the whole selection in one call. If a
    // rejected row let the others through, the list and the folder badge would
    // disagree with each other AND with the server.
    await storage.insertEmail(makeEmail({ id: 'u1', threadId: 'th-u1', tags: '|INBOX|' }));
    await storage.insertEmail(makeEmail({ id: 'u2', threadId: 'th-u2', tags: '|INBOX|' }));

    await expect(storage.bulkUpdateTags([
      { id: 'u1', tags: '|INBOX|read|' },
      { id: 'u2', tags: null as unknown as string }, // NOT NULL violation
    ])).rejects.toThrow();

    expect((await storage.getEmail('u1'))!.tags).toBe('|INBOX|');
    expect((await storage.getEmail('u2'))!.tags).toBe('|INBOX|');
  });

  it('syncFolders creates no folder at all when the server list contains a duplicate path', async () => {
    // folders.path is UNIQUE. A LIST reply with two ids for one path must not
    // leave the sidebar half-rebuilt — the whole sync has to be retried.
    const before = (await storage.getFolders()).map((f) => f.id).sort();

    await expect(storage.syncFolders([
      makeFolder('f-inbox', 'INBOX'),
      makeFolder('f-arch', 'Archive'),
      makeFolder('f-new', 'Labels/Work'),
      makeFolder('f-clash', 'Labels/Work'), // same path, different id
    ])).rejects.toThrow(/UNIQUE/i);

    expect((await storage.getFolders()).map((f) => f.id).sort()).toEqual(before);
    expect(await storage.getFolderByPath('Labels/Work')).toBeNull();
  });

  it('savePendingOperationsBatch enqueues nothing when one operation is malformed', async () => {
    // A half-enqueued batch means some optimistic UI changes have a queued IMAP
    // op and some silently never will — those revert on the next reconcile.
    await expect(storage.savePendingOperationsBatch([
      { type: 'markRead', folderPath: 'INBOX', uid: 1, retryCount: 0 },
      { type: null as unknown as string, folderPath: 'INBOX', uid: 2, retryCount: 0 }, // NOT NULL violation
    ])).rejects.toThrow();

    expect(await storage.getPendingOperations()).toEqual([]);
    expect(countRows(storage, 'pending_operations')).toBe(0);
  });

  it('a failed batch does not leave the read-model dirty queue claiming work that never landed', async () => {
    // The emails triggers enqueue read_model_dirty rows INSIDE the write
    // transaction, so a rollback must take them with it — otherwise the
    // maintainer rebuilds a thread that does not exist.
    await expect(storage.insertEmailBatch([
      makeEmail({ id: 'r1', threadId: 'th-r1', date: T0 }),
      unwritable('r2', T0 + 1),
    ])).rejects.toThrow();

    const queued = (rawDb(storage).prepare('SELECT thread_id FROM read_model_dirty').all() as Array<{ thread_id: string }>)
      .map((q) => q.thread_id);
    expect(queued).not.toContain('th-r1');
    expect(queued).not.toContain('th-r2');
  });

  // A failed emails INSERT must SURFACE, not be swallowed. sqlite-storage runs
  // its inserts inside better-sqlite3's SYNCHRONOUS `db.transaction()`, so it
  // calls `insertSync` — an async `insert()` there would reject a promise nobody
  // holds: the transaction would see no throw and COMMIT, the caller would be
  // told the message was stored, and the mail would be silently absent forever
  // because sync had already advanced its UID watermark past it.
  it('propagates a failing emails INSERT and rolls the write back', async () => {
    // A folder that vanished between the folder LIST and the fetch → FK failure.
    await expect(
      storage.insertEmail(makeEmail({ id: 'lost', threadId: 'th-lost', folderId: 'f-ghost' })),
    ).rejects.toThrow(/FOREIGN KEY/i);

    expect(await storage.getEmail('lost')).toBeNull();   // nothing half-written
    expect(countRows(storage, 'threads')).toBe(0);        // no husk thread either
  });
});

// ===========================================================================
// Concurrent writes
// ===========================================================================

describe('SQLiteStorage keeps state consistent under concurrent writes', () => {
  it('racing inserts of the SAME message_id produce exactly one row', async () => {
    // Two folder syncs (or a sync racing our own SMTP send) can present the same
    // message at once. The dedupe must hold, or the user sees the mail twice and
    // the UNIQUE index eventually explodes.
    const copies = Array.from({ length: 6 }, (_, i) => makeEmail({
      id: `same-${i}`, messageId: '<race@example.test>', threadId: `th-same-${i}`,
      folderId: i % 2 === 0 ? 'f-inbox' : 'f-arch',
      tags: i % 2 === 0 ? '|INBOX|' : '|Archive|',
    }));

    await Promise.all(copies.map((e) => storage.insertEmail(e)));

    expect(countRows(storage, 'emails')).toBe(1);
    const survivor = await storage.getEmailByMessageId('<race@example.test>');
    expect(survivor).not.toBeNull();
    // The losing copies contributed their folder membership, not duplicate rows.
    expect(survivor!.tags).toContain('|INBOX|');
    expect(survivor!.tags).toContain('|Archive|');
    expect(countRows(storage, 'threads')).toBe(1);
  });

  it('racing inserts into ONE thread leave message_count equal to the rows actually present', async () => {
    const replies = Array.from({ length: 8 }, (_, i) => makeEmail({
      id: `p${i}`,
      messageId: `<p${i}@example.test>`,
      threadId: 'th-shared',
      subject: 'Re: shared conversation',
      date: T0 + i,
    }));

    await Promise.all(replies.map((e) => storage.insertEmail(e)));

    const rows = await storage.getEmailsByThread('th-shared');
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.id)).size).toBe(8); // no duplicate ids
    const thread = await storage.getThread('th-shared');
    expect(thread!.messageCount).toBe(rows.length);
    expect(thread!.lastMessageDate).toBe(T0 + 7);
    expect(countRows(storage, 'threads')).toBe(1);
  });

  it('two interleaving insertEmailBatch calls with overlapping message ids converge on one row each', async () => {
    // insertEmailBatch yields the event loop between its 100-row chunks, so two
    // concurrent batches genuinely interleave. Each Message-ID must end up as
    // exactly ONE row no matter how the chunks braid together.
    const total = 120;
    const batchA = Array.from({ length: total }, (_, i) => makeEmail({
      id: `a${i}`, messageId: `<shared-${i}@example.test>`, threadId: `th-s${i}`, date: T0 + i,
    }));
    const batchB = Array.from({ length: total }, (_, i) => makeEmail({
      id: `b${i}`, messageId: `<shared-${i}@example.test>`, threadId: `th-s${i}`, date: T0 + i,
      folderId: 'f-arch', tags: '|Archive|',
    }));

    await Promise.all([storage.insertEmailBatch(batchA), storage.insertEmailBatch(batchB)]);

    expect(countRows(storage, 'emails')).toBe(total);
    const distinctMessageIds = (rawDb(storage)
      .prepare('SELECT COUNT(DISTINCT message_id) AS c FROM emails').get() as { c: number }).c;
    expect(distinctMessageIds).toBe(total);
    expect(countRows(storage, 'threads')).toBe(total);

    // Every thread's cached message_count matches its real row count.
    const drift = rawDb(storage).prepare(`
      SELECT COUNT(*) AS c FROM threads t
      WHERE t.message_count != (SELECT COUNT(*) FROM emails e WHERE e.thread_id = t.id)
    `).get() as { c: number };
    expect(drift.c).toBe(0);
  });

  it('concurrent tag writes on one email leave a single coherent value, never a merge', async () => {
    await storage.insertEmail(makeEmail({ id: 'w1', threadId: 'th-w1', tags: '|INBOX|' }));

    await Promise.all([
      storage.updateEmail('w1', { tags: '|INBOX|read|' }),
      storage.bulkUpdateTags([{ id: 'w1', tags: '|INBOX|starred|' }]),
      storage.updateEmail('w1', { tags: '|INBOX|important|' }),
    ]);

    const tags = (await storage.getEmail('w1'))!.tags;
    expect(['|INBOX|read|', '|INBOX|starred|', '|INBOX|important|']).toContain(tags);
    expect(countRows(storage, 'emails')).toBe(1);
  });

  it('concurrent unread-count deltas agree with a full recount afterwards', async () => {
    // The scan-free ±1 delta is only safe if a burst of flips lands on the same
    // total a full recalculation would produce — otherwise the folder badge
    // drifts and never self-heals.
    const emails = Array.from({ length: 6 }, (_, i) => makeEmail({
      id: `f${i}`, messageId: `<f${i}@example.test>`, threadId: `th-f${i}`, date: T0 + i,
    }));
    for (const email of emails) await storage.insertEmail(email);
    await storage.recalculateFolderCounts();
    expect((await storage.getFolder('f-inbox'))!.unreadCount).toBe(6);

    // Mark half read through the same two-step the handler uses, concurrently.
    await Promise.all([0, 1, 2].map(async (i) => {
      await storage.updateEmail(`f${i}`, { tags: '|INBOX|read|' });
      await storage.applyReadFlagToFolderCounts(`f${i}`, true);
    }));

    const afterDeltas = (await storage.getFolder('f-inbox'))!.unreadCount;
    await storage.recalculateFolderCounts();
    expect(afterDeltas).toBe((await storage.getFolder('f-inbox'))!.unreadCount);
    expect(afterDeltas).toBe(3);
  });

  it('concurrent pending-operation saves for the same (type, folder, uid) collapse to one row', async () => {
    await Promise.all([0, 1, 2, 3].map((retryCount) => storage.savePendingOperation({
      type: 'markRead', folderPath: 'INBOX', uid: 42, retryCount,
    })));

    const ops = await storage.getPendingOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0].uid).toBe(42);
    expect(countRows(storage, 'pending_operations')).toBe(1);
  });

  it('concurrent outbox saves each get their own id and are all readable', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => storage.savePendingSend({ to: `user${i}@example.test` })),
    );

    expect(new Set(ids).size).toBe(5);
    const all = await storage.getAllSends();
    expect(all.map((s) => s.id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    expect(await storage.getPendingSendCounts()).toEqual({ pending: 5, failed: 0 });
  });
});

// A failing INSERT inside the transaction must REJECT and leave nothing behind.
// The repository's `insert` is declared async, so calling it un-awaited inside
// better-sqlite3's SYNCHRONOUS transaction turned a constraint failure into an
// unhandled rejection: the transaction committed, the caller was told the mail
// was stored, and sync advanced its UID watermark past a row that is not there.
// `insertSync` keeps the throw on the caller's stack so the rollback happens.
describe('insert failures roll back instead of silently losing mail', () => {
  // An un-bindable value (an object) fails at the driver, inside the transaction.
  const unbindable = (id: string) => ({ ...makeEmail({ id }), date: {} as unknown as number });

  it('rejects and stores nothing when one row in the batch cannot be inserted', async () => {
    await expect(
      storage.insertEmailBatch([makeEmail({ id: 'good-1' }), unbindable('bad-1')]),
    ).rejects.toThrow();

    expect(await storage.getEmail('good-1')).toBeNull();   // rolled back with it
    expect(await storage.getEmail('bad-1')).toBeNull();
  });

  it('rejects a single bad insert rather than reporting success', async () => {
    await expect(storage.insertEmail(unbindable('solo-bad'))).rejects.toThrow();
    expect(await storage.getEmail('solo-bad')).toBeNull();
  });

  it('still stores a healthy batch', async () => {
    await storage.insertEmailBatch([makeEmail({ id: 'ok-1' }), makeEmail({ id: 'ok-2' })]);
    expect(await storage.getEmail('ok-1')).not.toBeNull();
    expect(await storage.getEmail('ok-2')).not.toBeNull();
  });
});
