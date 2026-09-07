import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestDb } from '../../src/test-support/test-db';
import { writeThreadKey } from '../../src/thread-keys';

// `writeThreadKey` is the ONLY writer of the resolver's lookup key, and three
// separate paths call it: EmailRepository.insertSync, the sent-mail mirror and
// the local draft save. A bug here does not crash anything — it makes an email
// unfindable by subject, so replies quietly start their own conversations. That
// is invisible until someone notices a thread has split, days later.

function keysDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE email_thread_keys (
      email_id TEXT PRIMARY KEY,
      subject_norm TEXT NOT NULL,
      date INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

const keyOf = (db: Database.Database, id: string) =>
  db.prepare('SELECT subject_norm, date, created_at FROM email_thread_keys WHERE email_id = ?').get(id) as
    | { subject_norm: string; date: number; created_at: number }
    | undefined;

describe('writeThreadKey', () => {
  let db: Database.Database;

  beforeEach(() => { db = keysDb(); });
  afterEach(() => db.close());

  // The reply and its parent must land on the SAME key — that identity is the
  // whole point, since the resolver matches them with an equality seek.
  it('stores the normalized subject and the email date', () => {
    writeThreadKey(db, { id: 'e1', subject: 'RE: Fwd: Quarterly report', date: 1_700_000_000 });

    expect(keyOf(db, 'e1')?.subject_norm).toBe('quarterly report');
    expect(keyOf(db, 'e1')?.date).toBe(1_700_000_000);
  });

  // A missing subject is normal (drafts, rows stored before their envelope
  // arrives). '' is a real, seekable value; NULL would violate NOT NULL and a
  // skipped write would drop the row out of the index entirely.
  it('stores an empty key for a null, undefined or empty subject', () => {
    writeThreadKey(db, { id: 'e1', subject: null, date: 1 });
    writeThreadKey(db, { id: 'e2', subject: undefined, date: 2 });
    writeThreadKey(db, { id: 'e3', subject: '', date: 3 });

    expect(keyOf(db, 'e1')?.subject_norm).toBe('');
    expect(keyOf(db, 'e2')?.subject_norm).toBe('');
    expect(keyOf(db, 'e3')?.subject_norm).toBe('');
  });

  // The envelope-repair path rewrites subjects after the fact. An INSERT that
  // threw on conflict would abort that repair; an insert that was IGNOREd would
  // leave the row indexed under its OLD subject. Neither is acceptable, so this
  // must be an upsert.
  it('overwrites an existing key rather than throwing or ignoring', () => {
    writeThreadKey(db, { id: 'e1', subject: 'Placeholder', date: 1 });
    writeThreadKey(db, { id: 'e1', subject: 'Re: Invoice 42', date: 2 });

    expect(keyOf(db, 'e1')).toMatchObject({ subject_norm: 'invoice 42', date: 2 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM email_thread_keys').get()).toEqual({ c: 1 });
  });

  // `created_at` drives the incremental repair window, so a re-keyed email must
  // move INTO that window: its threading answer may have changed, and the next
  // pass is the thing that would act on it.
  it('moves created_at forward on a re-key so the next repair pass re-examines it', () => {
    db.prepare('INSERT INTO email_thread_keys (email_id, subject_norm, date, created_at) VALUES (?,?,?,0)')
      .run('e1', '', 1);

    writeThreadKey(db, { id: 'e1', subject: 'Re: Invoice 42', date: 1 });

    expect(keyOf(db, 'e1')!.created_at).toBeGreaterThan(0);
  });

  // Idempotent re-run: the same email written twice with the same values (a
  // retried insert, a re-synced message) must leave exactly one unchanged key.
  it('is idempotent for an unchanged email', () => {
    writeThreadKey(db, { id: 'e1', subject: 'Weekly sync', date: 5 });
    const first = keyOf(db, 'e1');
    writeThreadKey(db, { id: 'e1', subject: 'Weekly sync', date: 5 });

    expect(keyOf(db, 'e1')).toMatchObject({ subject_norm: first!.subject_norm, date: 5 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM email_thread_keys').get()).toEqual({ c: 1 });
  });

  // Multi-account: each account has its OWN database handle, and the statement
  // behind this helper is cached. A cache that ignored the handle would run
  // account A's compiled statement against account B's database — at best wrong
  // rows, at worst a crash once A's connection closes.
  it('writes to the right database when several accounts are open', () => {
    const other = keysDb();
    try {
      writeThreadKey(db, { id: 'e1', subject: 'Account A', date: 1 });
      writeThreadKey(other, { id: 'e1', subject: 'Account B', date: 2 });

      expect(keyOf(db, 'e1')?.subject_norm).toBe('account a');
      expect(keyOf(other, 'e1')?.subject_norm).toBe('account b');
    } finally {
      other.close();
    }
  });
});
