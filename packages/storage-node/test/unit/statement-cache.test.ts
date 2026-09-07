import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepared } from '../../src/statement-cache';
import { openTestDb } from '../../src/test-support/test-db';

// The cache exists because `db.prepare()` re-compiles the SQL on every call, and
// the statements it holds run per-email — tens of thousands of times on a first
// sync. It is keyed on the DATABASE HANDLE, which is the part that must not
// regress: this app reopens the connection on an account switch and a re-key,
// and running a statement against a database that is no longer the one it was
// compiled for is a hard crash, not a wrong answer.

const SQL = 'SELECT 1 AS one';

describe('prepared', () => {
  let db: ReturnType<typeof openTestDb>;

  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { if (db.open) db.close(); });

  it('compiles a statement once per handle and reuses it', () => {
    const first = prepared(db, SQL);
    const second = prepared(db, SQL);

    expect(second).toBe(first);
    expect(first.get()).toEqual({ one: 1 });
  });

  it('keeps distinct SQL separate', () => {
    expect(prepared(db, SQL)).not.toBe(prepared(db, 'SELECT 2 AS two'));
    expect(prepared(db, 'SELECT 2 AS two').get()).toEqual({ two: 2 });
  });

  // Multi-account: two open databases must never share a statement. This is the
  // crash guard — B's queries running on A's compiled statement.
  it('gives each database handle its own statement', () => {
    const other = openTestDb();
    try {
      expect(prepared(other, SQL)).not.toBe(prepared(db, SQL));
    } finally {
      other.close();
    }
  });

  // Reopen (account switch, re-key): the new handle must compile fresh
  // statements rather than inherit the closed connection's, which would throw
  // "The database connection is not open" on the first query after a switch.
  it('does not hand a closed database’s statement to its replacement', () => {
    const before = prepared(db, SQL);
    db.close();

    db = openTestDb();
    const after = prepared(db, SQL);

    expect(after).not.toBe(before);
    expect(after.get()).toEqual({ one: 1 });
  });
});
