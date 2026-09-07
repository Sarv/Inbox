import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openTestDb } from '../../src/test-support/test-db';
import { reattachOrphans } from '../../src/thread-resolver';

// Proves reattachOrphans collapses a DEEP reply chain that arrived child-before-
// parent (a fresh account backfills older parents after their recent replies).
// The one-level version left grandchildren stranded — the "25 mails → no thread
// on reconnect" bug. The cascade pulls the whole descendant subtree.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      in_reply_to TEXT,
      thread_id TEXT NOT NULL
    );
  `);
  return db;
}

// Insert an email as if resolveAndAttach found no parent in the DB (so it kept
// its OWN standalone thread), then run the post-insert reattach like the storage
// layer does.
function insertThenReattach(
  db: Database.Database,
  id: string,
  messageId: string,
  inReplyTo: string | null,
  ownThread: string,
): void {
  db.prepare('INSERT INTO emails (id, message_id, in_reply_to, thread_id) VALUES (?,?,?,?)')
    .run(id, messageId, inReplyTo, ownThread);
  reattachOrphans(db, messageId, ownThread);
}

const distinctThreads = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(DISTINCT thread_id) AS c FROM emails').get() as { c: number }).c;

describe('reattachOrphans cascade', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); });

  it('collapses a 4-deep chain inserted in REVERSE (child-before-parent) into one thread', () => {
    // Chain: root <- a <- b <- c. Arrives newest-first (c, b, a, root) — each
    // lands standalone (parent not yet in DB), then reattach runs.
    insertThenReattach(db, 'c', '<c>', '<b>', 't-c');
    insertThenReattach(db, 'b', '<b>', '<a>', 't-b');   // pulls c
    insertThenReattach(db, 'a', '<a>', '<root>', 't-a'); // pulls b, and (cascade) c
    insertThenReattach(db, 'root', '<root>', null, 't-root'); // pulls a, b, c

    expect(distinctThreads(db)).toBe(1);
    const threads = new Set(
      (db.prepare('SELECT thread_id FROM emails').all() as { thread_id: string }[]).map((r) => r.thread_id),
    );
    expect([...threads]).toEqual(['t-root']); // everything joined the root's thread
  });

  it('collapses a wide+deep tree (two branches) into the root thread', () => {
    // root <- a <- {b1, b2};  b1 <- c
    insertThenReattach(db, 'c', '<c>', '<b1>', 't-c');
    insertThenReattach(db, 'b2', '<b2>', '<a>', 't-b2');
    insertThenReattach(db, 'b1', '<b1>', '<a>', 't-b1'); // pulls c
    insertThenReattach(db, 'a', '<a>', '<root>', 't-a'); // pulls b1(+c cascade), b2
    insertThenReattach(db, 'root', '<root>', null, 't-root');

    expect(distinctThreads(db)).toBe(1);
    expect(
      (db.prepare("SELECT thread_id FROM emails WHERE id = 'c'").get() as { thread_id: string }).thread_id,
    ).toBe('t-root');
  });

  it('leaves unrelated mail alone and reports drained threads', () => {
    db.prepare('INSERT INTO emails (id, message_id, in_reply_to, thread_id) VALUES (?,?,?,?)')
      .run('x', '<x>', null, 't-x'); // unrelated standalone
    db.prepare('INSERT INTO emails (id, message_id, in_reply_to, thread_id) VALUES (?,?,?,?)')
      .run('child', '<child>', '<parent>', 't-child');

    const res = reattachOrphans(db, '<parent>', 't-parent');
    expect(res.changes).toBe(1);
    expect(res.previousThreadIds).toEqual(['t-child']);
    // Unrelated 'x' untouched.
    expect((db.prepare("SELECT thread_id FROM emails WHERE id='x'").get() as { thread_id: string }).thread_id).toBe('t-x');
  });

  it('is a no-op when the inserted message has no orphan children', () => {
    db.prepare('INSERT INTO emails (id, message_id, in_reply_to, thread_id) VALUES (?,?,?,?)')
      .run('solo', '<solo>', null, 't-solo');
    const res = reattachOrphans(db, '<solo>', 't-solo');
    expect(res).toEqual({ changes: 0, previousThreadIds: [] });
  });
});
