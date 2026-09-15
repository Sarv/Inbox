import type { ThreadRecord } from '@sarvinbox/core';
import { generateThreadId, normalizeSubject } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThreadRepository } from '../../../src/repositories/thread-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';


// The threads table is the read model the list views render, and emails.thread_id
// is ON DELETE CASCADE — so a careless thread write is an email-deleting write.
// These tests run against the FULL production schema with foreign keys ENFORCED,
// so any regression that would take real mail with it fails here.

const thread = (over: Partial<ThreadRecord> & Pick<ThreadRecord, 'id'>): ThreadRecord => ({
  subject: 'Quarterly plan',
  firstMessageId: `<first-${over.id}>`,
  lastMessageId: `<last-${over.id}>`,
  lastMessageDate: 1_700_000_000,
  messageCount: 1,
  participants: 'alice@example.com',
  hasUnread: false,
  hasFlagged: false,
  labels: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

function newDb(): Database.Database {
  const db = newMigratedDb();
  db.pragma('foreign_keys = ON'); // deterministic: cascades are part of the contract
  db.prepare("INSERT INTO folders (id, name, path) VALUES ('f-inbox', 'INBOX', 'INBOX')").run();
  return db;
}

type EmailSeed = {
  id: string;
  threadId: string;
  from: string;
  date: number;
  subject?: string;
  inReplyTo?: string | null;
  references?: string | null;
  messageId?: string;
};

const addEmail = (db: Database.Database, seed: EmailSeed): void => {
  db.prepare(`
    INSERT INTO emails (
      id, message_id, thread_id, folder_id, tags, subject,
      from_address, from_name, date, clean_body, raw_body, content_type, content_hash,
      in_reply_to, "references"
    ) VALUES (?, ?, ?, 'f-inbox', '|INBOX|', ?, ?, NULL, ?, '', '', 'text', 'hash', ?, ?)
  `).run(
    seed.id,
    seed.messageId ?? `<${seed.id}@example.com>`,
    seed.threadId,
    seed.subject ?? 'Quarterly plan',
    seed.from,
    seed.date,
    seed.inReplyTo ?? null,
    seed.references ?? null,
  );
};

const threadIdsInDb = (db: Database.Database): string[] =>
  (db.prepare('SELECT id FROM threads ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);

const emailIdsInDb = (db: Database.Database): string[] =>
  (db.prepare('SELECT id FROM emails ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);

// ---------------------------------------------------------------------------
// upsert / get
// ---------------------------------------------------------------------------

describe('upsert and get', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(() => { db = newDb(); repo = new ThreadRepository(() => db); });
  afterEach(() => { db.close(); });

  // Every list row is drawn from these fields; the booleans are stored as 0/1
  // and the labels as JSON, so the mapping back has to be exact or a thread
  // renders as read/unstarred when it isn't.
  it('inserts a thread and reads it back with booleans and labels decoded', async () => {
    await repo.upsert(thread({
      id: 't1', hasUnread: true, hasFlagged: true, labels: ['work', 'urgent'],
      participants: 'alice@example.com,bob@example.com',
    }));

    expect(await repo.get('t1')).toMatchObject({
      id: 't1',
      subject: 'Quarterly plan',
      firstMessageId: '<first-t1>',
      lastMessageId: '<last-t1>',
      lastMessageDate: 1_700_000_000,
      messageCount: 1,
      participants: 'alice@example.com,bob@example.com',
      hasUnread: true,
      hasFlagged: true,
      labels: ['work', 'urgent'],
    });
  });

  // A new message in an existing conversation re-upserts the thread. Everything
  // that describes the NEWEST message must advance, while first_message_id is
  // deliberately left alone — the conversation's oldest message never changes,
  // and overwriting it would reorder the thread view.
  it('re-upserting advances the last-message fields but never the first', async () => {
    await repo.upsert(thread({ id: 't1', messageCount: 1, lastMessageDate: 100 }));
    await repo.upsert(thread({
      id: 't1',
      subject: 'Quarterly plan (rev 2)',
      firstMessageId: '<someone-elses-idea>',
      lastMessageId: '<newest>',
      lastMessageDate: 900,
      messageCount: 4,
      hasUnread: true,
      labels: ['work'],
    }));

    expect(await repo.get('t1')).toMatchObject({
      subject: 'Quarterly plan (rev 2)',
      firstMessageId: '<first-t1>',   // unchanged on conflict
      lastMessageId: '<newest>',
      lastMessageDate: 900,
      messageCount: 4,
      hasUnread: true,
      labels: ['work'],
    });
  });

  it('returns null for an unknown thread id', async () => {
    expect(await repo.get('t-missing')).toBeNull();
  });

  // Corrupt/legacy label JSON must degrade to "no labels" instead of throwing —
  // one bad row would otherwise break the whole list query's mapping.
  it('falls back to an empty label list when the stored JSON is unparseable', async () => {
    await repo.upsert(thread({ id: 't1', labels: ['work'] }));
    db.prepare('UPDATE threads SET labels = ? WHERE id = ?').run('{not json', 't1');
    expect((await repo.get('t1'))!.labels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getAll — pagination + sort whitelist
// ---------------------------------------------------------------------------

describe('getAll pagination and sort whitelist', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(async () => {
    db = newDb();
    repo = new ThreadRepository(() => db);
    await repo.upsert(thread({ id: 'a', subject: 'Alpha', lastMessageDate: 300, messageCount: 1 }));
    await repo.upsert(thread({ id: 'b', subject: 'Bravo', lastMessageDate: 100, messageCount: 9 }));
    await repo.upsert(thread({ id: 'c', subject: 'Charlie', lastMessageDate: 200, messageCount: 5 }));
  });
  afterEach(() => { db.close(); });

  const ids = (rows: ThreadRecord[]): string[] => rows.map((r) => r.id);

  it('defaults to newest-first by last message date', async () => {
    expect(ids(await repo.getAll({ limit: 10, offset: 0 }))).toEqual(['a', 'c', 'b']);
  });

  it('accepts camelCase sort keys and both directions', async () => {
    expect(ids(await repo.getAll({ limit: 10, offset: 0, sortBy: 'lastMessageDate', sortOrder: 'asc' })))
      .toEqual(['b', 'c', 'a']);
    expect(ids(await repo.getAll({ limit: 10, offset: 0, sortBy: 'messageCount', sortOrder: 'desc' })))
      .toEqual(['b', 'c', 'a']);
    expect(ids(await repo.getAll({ limit: 10, offset: 0, sortBy: 'subject', sortOrder: 'asc' })))
      .toEqual(['a', 'b', 'c']);
  });

  // sortBy/sortOrder are INTERPOLATED into the SQL, so anything off the
  // whitelist must silently fall back rather than reach the parser.
  it('ignores a non-whitelisted (or injected) sort column and order', async () => {
    expect(ids(await repo.getAll({
      limit: 10, offset: 0,
      sortBy: 'created_at; DROP TABLE threads--',
      sortOrder: 'sideways' as unknown as 'asc',
    }))).toEqual(['a', 'c', 'b']); // default column, default DESC
    expect(threadIdsInDb(db)).toEqual(['a', 'b', 'c']); // table intact
  });

  it('pages with limit and offset', async () => {
    expect(ids(await repo.getAll({ limit: 2, offset: 0 }))).toEqual(['a', 'c']);
    expect(ids(await repo.getAll({ limit: 2, offset: 2 }))).toEqual(['b']);
    expect(await repo.getAll({ limit: 2, offset: 99 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// update / delete
// ---------------------------------------------------------------------------

describe('update and delete', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(async () => {
    db = newDb();
    repo = new ThreadRepository(() => db);
    await repo.upsert(thread({ id: 't1' }));
  });
  afterEach(() => { db.close(); });

  it('applies a partial update, encoding labels as JSON and flags as 0/1', async () => {
    await repo.update('t1', { hasUnread: true, hasFlagged: false, labels: ['a', 'b'], messageCount: 3 });
    expect(await repo.get('t1')).toMatchObject({
      hasUnread: true, hasFlagged: false, labels: ['a', 'b'], messageCount: 3,
      subject: 'Quarterly plan', // untouched
    });
  });

  it('an update with nothing defined is a no-op rather than invalid SQL', async () => {
    await repo.update('t1', {});
    await repo.update('t1', { subject: undefined });
    expect((await repo.get('t1'))!.subject).toBe('Quarterly plan');
  });

  it('updating an unknown thread changes nothing', async () => {
    await repo.update('t-missing', { subject: 'ghost' });
    expect((await repo.get('t1'))!.subject).toBe('Quarterly plan');
  });

  // DATA LOSS: deleting a thread row takes every email in it. This is exactly why
  // rebuild() upserts first and prunes last, and why nothing may bulk-delete
  // threads while emails still point at them.
  it('deleting a thread CASCADES its emails away', async () => {
    addEmail(db, { id: 'e1', threadId: 't1', from: 'alice@example.com', date: 100 });
    await repo.delete('t1');
    expect(await repo.get('t1')).toBeNull();
    expect(emailIdsInDb(db)).toEqual([]);
  });

  it('deleting an unknown thread is harmless', async () => {
    await repo.delete('t-missing');
    expect(threadIdsInDb(db)).toEqual(['t1']);
  });
});

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

describe('rebuild', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(async () => {
    db = newDb();
    repo = new ThreadRepository(() => db);
  });
  afterEach(() => { db.close(); });

  const seedBogusThread = async (id: string): Promise<void> => {
    await repo.upsert(thread({ id, subject: 'stale grouping' }));
  };

  // Re-threading regroups messages by In-Reply-To/References. The critical part
  // is that NO email is lost doing it: threads must be created before emails are
  // repointed, and only then may the orphaned old thread rows be pruned.
  it('regroups replies with their root and keeps every email row', async () => {
    await seedBogusThread('t-bogus');
    addEmail(db, { id: 'root', threadId: 't-bogus', from: 'alice@example.com', date: 100 });
    addEmail(db, {
      id: 'reply', threadId: 't-bogus', from: 'bob@example.com', date: 200,
      subject: 'Re: Quarterly plan', inReplyTo: '<root@example.com>',
    });
    addEmail(db, { id: 'other', threadId: 't-bogus', from: 'carol@example.com', date: 300, subject: 'Unrelated' });

    const result = await repo.rebuild();

    expect(result).toEqual({ emailsUpdated: 3, threadsCreated: 2 });
    expect(emailIdsInDb(db)).toEqual(['other', 'reply', 'root']); // nothing lost

    const threadOf = (id: string): string =>
      (db.prepare('SELECT thread_id AS t FROM emails WHERE id = ?').get(id) as { t: string }).t;
    expect(threadOf('reply')).toBe(threadOf('root'));
    expect(threadOf('other')).not.toBe(threadOf('root'));

    // The stale grouping row is gone, and only the two real threads remain.
    expect(threadIdsInDb(db)).not.toContain('t-bogus');
    expect(threadIdsInDb(db)).toHaveLength(2);

    // Thread ids are the shared derivation, not an ad-hoc one.
    expect(threadOf('root')).toBe(generateThreadId(normalizeSubject('Quarterly plan'), '<root@example.com>', null, null));
  });

  // References wins over In-Reply-To: the ROOT of the chain is its first entry,
  // so a deep reply lands in the original conversation rather than starting a
  // sub-thread per hop.
  it('threads a deep reply onto the first References entry, not its direct parent', async () => {
    await seedBogusThread('t-bogus');
    addEmail(db, { id: 'root', threadId: 't-bogus', from: 'alice@example.com', date: 100 });
    addEmail(db, {
      id: 'deep', threadId: 't-bogus', from: 'bob@example.com', date: 300,
      inReplyTo: '<middle@example.com>',
      references: '<root@example.com> <middle@example.com>',
    });

    await repo.rebuild();

    const rows = db.prepare('SELECT id, thread_id AS t FROM emails ORDER BY id').all() as Array<{ id: string; t: string }>;
    expect(new Set(rows.map((r) => r.t)).size).toBe(1);
  });

  // The thread row's own summary must match the messages it now owns, or the
  // list shows the wrong preview/date/size after a rebuild.
  it('writes message_count and first/last message from the regrouped emails', async () => {
    await seedBogusThread('t-bogus');
    addEmail(db, { id: 'root', threadId: 't-bogus', from: 'alice@example.com', date: 100 });
    addEmail(db, { id: 'r1', threadId: 't-bogus', from: 'bob@example.com', date: 250, inReplyTo: '<root@example.com>' });
    addEmail(db, { id: 'r2', threadId: 't-bogus', from: 'alice@example.com', date: 150, inReplyTo: '<root@example.com>' });

    await repo.rebuild();

    const row = db.prepare(`
      SELECT message_count AS n, first_message_id AS first, last_message_id AS last, last_message_date AS date
      FROM threads WHERE id = (SELECT thread_id FROM emails WHERE id = 'r1')
    `).get() as { n: number; first: string; last: string; date: number };

    // Root + both replies are one thread, and the summary is ordered by DATE,
    // not by insertion order (r2 arrived last but is the older message).
    expect(row.n).toBe(3);
    expect(row.first).toBe('root'); // oldest message in the group
    expect(row.last).toBe('r1');    // newest
    expect(row.date).toBe(250);
  });

  // A headerless message must not collapse into everyone else's conversation.
  it('gives messages with no threading headers their own threads', async () => {
    await seedBogusThread('t-bogus');
    addEmail(db, { id: 'a', threadId: 't-bogus', from: 'alice@example.com', date: 100, subject: 'One' });
    addEmail(db, { id: 'b', threadId: 't-bogus', from: 'bob@example.com', date: 200, subject: 'Two' });

    expect(await repo.rebuild()).toEqual({ emailsUpdated: 2, threadsCreated: 2 });
  });

  // With no mail at all, every thread row is by definition unreferenced. Pinned
  // because it is the one case where rebuild() empties the table — safe only
  // because there are no emails left to cascade.
  it('prunes orphan threads when there are no emails', async () => {
    await seedBogusThread('t-orphan');
    expect(await repo.rebuild()).toEqual({ emailsUpdated: 0, threadsCreated: 0 });
    expect(threadIdsInDb(db)).toEqual([]);
  });

  it('tolerates a NULL subject when deriving the thread', async () => {
    await seedBogusThread('t-bogus');
    addEmail(db, { id: 'a', threadId: 't-bogus', from: 'alice@example.com', date: 100 });
    db.prepare('UPDATE emails SET subject = NULL WHERE id = ?').run('a');

    await repo.rebuild();

    const row = db.prepare('SELECT subject FROM threads').get() as { subject: string };
    expect(row.subject).toBe('(No Subject)');
    expect(emailIdsInDb(db)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// chat extraction tracking
// ---------------------------------------------------------------------------

describe('getPendingExtractionThreads', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(() => { db = newDb(); repo = new ThreadRepository(() => db); });
  afterEach(() => { db.close(); });

  /** A thread plus `senders.length` emails, one per sender. */
  const conversation = async (id: string, senders: string[], lastDate: number): Promise<void> => {
    await repo.upsert(thread({ id, messageCount: senders.length, lastMessageDate: lastDate }));
    senders.forEach((from, i) => addEmail(db, { id: `${id}-e${i}`, threadId: id, from, date: lastDate - i }));
  };

  // AI extraction is expensive: only real back-and-forth conversations (2+
  // messages from 2+ DISTINCT senders) may be auto-queued. A newsletter blast
  // from one sender, or a single message, must never burn a request.
  it('queues only multi-message threads with at least two distinct senders', async () => {
    await conversation('real', ['alice@example.com', 'bob@example.com'], 500);
    await conversation('solo', ['alice@example.com'], 400);
    await conversation('monologue', ['news@example.com', 'news@example.com'], 300);

    const pending = await repo.getPendingExtractionThreads();
    expect(pending).toEqual([{ id: 'real', messageCount: 2 }]);
  });

  // Sender identity is case-insensitive: 'Alice@' and 'alice@' are one person, so
  // a self-thread with mixed-case headers must still be skipped.
  it('treats sender addresses case-insensitively when counting participants', async () => {
    await conversation('mixedcase', ['Alice@Example.com', 'alice@example.com'], 500);
    expect(await repo.getPendingExtractionThreads()).toEqual([]);
  });

  // Already-extracted threads must not be re-processed until NEW mail arrives —
  // that's the chat_email_count < message_count condition.
  it('skips extracted threads until their message count grows', async () => {
    await conversation('real', ['alice@example.com', 'bob@example.com'], 500);
    await repo.updateChatExtraction('real', 2);
    expect(await repo.getPendingExtractionThreads()).toEqual([]);

    // A third message lands.
    await repo.update('real', { messageCount: 3 });
    addEmail(db, { id: 'real-e2', threadId: 'real', from: 'carol@example.com', date: 600 });
    expect(await repo.getPendingExtractionThreads()).toEqual([{ id: 'real', messageCount: 3 }]);
  });

  it('returns the newest conversations first and honours the limit (default 5)', async () => {
    for (let i = 0; i < 6; i++) {
      await conversation(`c${i}`, ['alice@example.com', 'bob@example.com'], 1000 + i * 10);
    }

    const defaulted = await repo.getPendingExtractionThreads();
    expect(defaulted.map((t) => t.id)).toEqual(['c5', 'c4', 'c3', 'c2', 'c1']);

    const limited = await repo.getPendingExtractionThreads(2);
    expect(limited.map((t) => t.id)).toEqual(['c5', 'c4']);
  });

  it('returns an empty list when nothing qualifies', async () => {
    expect(await repo.getPendingExtractionThreads()).toEqual([]);
  });
});

describe('updateChatExtraction', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(() => { db = newDb(); repo = new ThreadRepository(() => db); });
  afterEach(() => { db.close(); });

  // Both columns must be stamped: the timestamp is what makes the thread "seen"
  // and the count is what makes a LATER message re-queue it.
  it('stamps the extraction time and the email count it was extracted at', async () => {
    await repo.upsert(thread({ id: 't1', messageCount: 4 }));

    const before = db.prepare('SELECT chat_extracted_at AS at, chat_email_count AS n FROM threads WHERE id = ?').get('t1') as { at: number | null; n: number };
    expect(before).toEqual({ at: null, n: 0 });

    await repo.updateChatExtraction('t1', 4);

    const after = db.prepare('SELECT chat_extracted_at AS at, chat_email_count AS n FROM threads WHERE id = ?').get('t1') as { at: number | null; n: number };
    expect(after.n).toBe(4);
    expect(after.at).toBeGreaterThan(0);
  });

  it('is a no-op for an unknown thread', async () => {
    await repo.updateChatExtraction('t-missing', 2);
    expect(threadIdsInDb(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

describe('attachments', () => {
  let db: Database.Database;
  let repo: ThreadRepository;
  beforeEach(async () => {
    db = newDb();
    repo = new ThreadRepository(() => db);
    await repo.upsert(thread({ id: 't1' }));
    addEmail(db, { id: 'e1', threadId: 't1', from: 'alice@example.com', date: 100 });
    addEmail(db, { id: 'e2', threadId: 't1', from: 'bob@example.com', date: 200 });
  });
  afterEach(() => { db.close(); });

  const attachment = (id: string, emailId: string, filename: string) => ({
    id, emailId, filename,
    contentType: 'application/pdf',
    size: 2048,
    filePath: `/var/attachments/${id}.pdf`,
    createdAt: 0,
  });

  // filePath is the only pointer to the bytes on disk; a lost mapping makes the
  // attachment unopenable even though the file is still there.
  it('stores attachments per email and reads them back intact', async () => {
    await repo.insertAttachment(attachment('a1', 'e1', 'invoice.pdf'));
    await repo.insertAttachment(attachment('a2', 'e1', 'contract.pdf'));
    await repo.insertAttachment(attachment('a3', 'e2', 'other.pdf'));

    const forE1 = await repo.getAttachments('e1');
    expect(forE1.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(forE1.find((a) => a.id === 'a1')).toMatchObject({
      emailId: 'e1', filename: 'invoice.pdf', contentType: 'application/pdf',
      size: 2048, filePath: '/var/attachments/a1.pdf',
    });
    expect((await repo.getAttachments('e2')).map((a) => a.id)).toEqual(['a3']);
  });

  it('returns an empty list for an email with no attachments', async () => {
    expect(await repo.getAttachments('e2')).toEqual([]);
    expect(await repo.getAttachments('e-missing')).toEqual([]);
  });

  it('deletes one attachment without touching its siblings', async () => {
    await repo.insertAttachment(attachment('a1', 'e1', 'invoice.pdf'));
    await repo.insertAttachment(attachment('a2', 'e1', 'contract.pdf'));

    await repo.deleteAttachment('a1');
    expect((await repo.getAttachments('e1')).map((a) => a.id)).toEqual(['a2']);

    await repo.deleteAttachment('a-missing'); // harmless
    expect((await repo.getAttachments('e1')).map((a) => a.id)).toEqual(['a2']);
  });

  // Deleting the mail must not leave attachment rows pointing at a gone email.
  it('cascades attachment rows away when the email is deleted', async () => {
    await repo.insertAttachment(attachment('a1', 'e1', 'invoice.pdf'));
    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');
    expect(await repo.getAttachments('e1')).toEqual([]);
  });
});

describe('repository initialisation', () => {
  // Callers must get the explicit "not initialised" error, not a TypeError, when
  // a thread query races the storage bootstrap.
  it('throws a clear error when storage is not initialised', async () => {
    const repo = new ThreadRepository(() => undefined as unknown as Database.Database);
    await expect(repo.get('t1')).rejects.toThrow('Storage not initialized');
  });
});
