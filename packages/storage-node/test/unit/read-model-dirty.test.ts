import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enqueueThreadsTaggedWith } from '../../src/read-model-dirty';
import { newMigratedDb } from '../../src/test-support/test-db';

// What breaks if this suite goes red: a category definition change (one added
// in the app, deleted, or seeded by a migration such as v99 Social) no longer
// reaches the inbox's read model. Such a change writes no `emails` row, so the
// triggers that normally queue threads never fire, and threads keep a stale
// has_category until something else happens to touch them.

let db: Database.Database;
let seq = 0;

/** One email in its own thread, carrying `tags`; returns the thread id. */
function mail(tags: string): string {
  seq += 1;
  const thread = `t-${seq}`;
  db.prepare("INSERT OR IGNORE INTO folders (id, name, path) VALUES ('f-inbox', 'INBOX', 'INBOX')").run();
  db.prepare(
    'INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date) VALUES (?, ?, ?, ?, ?)',
  ).run(thread, 's', `<${seq}@t>`, `<${seq}@t>`, 1_700_000_000);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address, date,
       clean_body, raw_body, content_type, content_hash)
     VALUES (?, ?, ?, 'f-inbox', ?, 's', 'a@b.test', 1700000000, 'b', 'r', 'text', ?)`,
  ).run(`e-${seq}`, `<${seq}@t>`, thread, tags, `h-${seq}`);
  return thread;
}

const queued = (): string[] =>
  (db.prepare('SELECT thread_id FROM read_model_dirty ORDER BY thread_id').all() as { thread_id: string }[])
    .map((r) => r.thread_id);

beforeEach(() => {
  db = newMigratedDb();
});

afterEach(() => db.close());

describe('enqueueThreadsTaggedWith', () => {
  // Breaks: the threads the definition change affects are not queued, or
  // unrelated ones are (a tag that merely STARTS with the slug is not it).
  it('queues exactly the threads carrying the whole tag', () => {
    const tagged = mail('|INBOX|social|');
    mail('|INBOX|');
    mail('|INBOX|socialmedia|');
    db.exec('DELETE FROM read_model_dirty');

    expect(enqueueThreadsTaggedWith(db, 'social')).toBe(1);
    expect(queued()).toEqual([tagged]);
  });

  // Breaks: a repeat call (the app saving the same definition twice) failing
  // or double-counting a thread that is already waiting.
  it('is idempotent: a thread already queued is not counted again', () => {
    mail('|INBOX|social|');
    db.exec('DELETE FROM read_model_dirty');
    enqueueThreadsTaggedWith(db, 'social');
    expect(enqueueThreadsTaggedWith(db, 'social')).toBe(0);
    expect(queued()).toHaveLength(1);
  });

  // Breaks: an empty slug matching every email's `||` and queueing the whole
  // mailbox for a rebuild.
  it('queues nothing for an empty tag', () => {
    mail('|INBOX||');
    db.exec('DELETE FROM read_model_dirty');
    expect(enqueueThreadsTaggedWith(db, '')).toBe(0);
    expect(queued()).toEqual([]);
  });
});
