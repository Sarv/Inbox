import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compact } from '../../../../electron/workers/db-compact.worker';

/**
 * The VACUUM worker against the REAL addon and real encrypted files.
 *
 * What breaks if this file fails: VACUUM rewrites every page of a mailbox through
 * the settings its connection holds, and the original file is gone once it
 * finishes. A rebuild under different settings loses the whole account. The
 * sequence itself is covered by db-compact-worker.test.ts; this file is about what
 * comes out the other end.
 */

const h = vi.hoisted(() => ({
  /** Simulate a later library whose compiled-in cipher defaults have moved. */
  laterLibrary: false,
  /** Simulate a library that quietly ignores one of the pinned settings. */
  ignoresPin: false,
}));

interface PragmaHandle {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (...args: unknown[]) => PragmaHandle }>()).default;
  class SimulatedLibrary extends Real {
    constructor(...args: unknown[]) {
      super(...args);
      if (h.laterLibrary) {
        // Pragmas, not `SELECT sqlite3mc_config(…)`: a SELECT would read the
        // encrypted file before the key is set, and fail.
        super.pragma('kdf_iter=12345');
        super.pragma(`cipher='aes256cbc'`);
      }
    }
    pragma(source: string, options?: { simple?: boolean }): unknown {
      if (h.ignoresPin && source === 'kdf_iter') return '12345';
      return super.pragma(source, options);
    }
  }
  return { default: SimulatedLibrary };
});

const KEY = 'a'.repeat(32) + 'b'.repeat(32);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-compact-cipher-'));
  h.laterLibrary = false;
  h.ignoresPin = false;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** An account database the way every release before the pin wrote one: `key`, no cipher pragma. */
function createBeforeThePin(path: string, rows = 200): void {
  const db = new Database(path);
  db.pragma(`key='${KEY}'`);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE emails (id INTEGER PRIMARY KEY, body TEXT)');
  const insert = db.prepare('INSERT INTO emails (body) VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run(`message ${i}`.repeat(50));
  db.prepare('DELETE FROM emails WHERE id % 2 = 0').run();
  db.close();
}

/** Read the file the way a connection that knows nothing of the pin would. */
function rowsReadWithOldSequence(path: string): number {
  h.laterLibrary = false;
  const db = new Database(path);
  try {
    db.pragma(`key='${KEY}'`);
    return (db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

describe('compact() on a real encrypted database', () => {
  // Breaks an existing user's mailbox: the first compaction after the pin ships
  // runs on a file written without it.
  it('rebuilds a database created before the pin, losing nothing', () => {
    const path = join(dir, 'a.db');
    createBeforeThePin(path);

    const result = compact({ dbPath: path, key: KEY });

    expect(result).toMatchObject({ ok: true, rowsBefore: 100, rowsAfter: 100, autoVacuum: 2 });
    expect(rowsReadWithOldSequence(path)).toBe(100);
  });

  // Breaks if the worker stops pinning: a later library's defaults would either
  // refuse the file or, worse, be what the rebuild is written with.
  it('rebuilds the original format under a later library', () => {
    const path = join(dir, 'a.db');
    createBeforeThePin(path);

    h.laterLibrary = true;
    const result = compact({ dbPath: path, key: KEY });

    expect(result).toMatchObject({ ok: true, rowsAfter: 100 });
    expect(rowsReadWithOldSequence(path)).toBe(100);
  });

  // Breaks the rule that an unreadable database is not an empty one. A wrong key has
  // to come back as a failed rebuild with the file untouched, or the app would report
  // a compacted account that it can no longer open.
  it('reports a wrong key as a failure, unchanged file, no key in the message', () => {
    const path = join(dir, 'a.db');
    createBeforeThePin(path);
    const before = sha256(path);
    const wrongKey = 'c'.repeat(64);

    const result = compact({ dbPath: path, key: wrongKey });

    expect(result).toEqual({ ok: false, error: 'file is not a database' });
    expect(JSON.stringify(result)).not.toContain(wrongKey);
    expect(sha256(path)).toBe(before);
  });

  // Breaks recovery from that failure: a locked keychain is transient, so the same
  // file has to compact on the next attempt, with the right key.
  it('compacts on the retry after a failed attempt', () => {
    const path = join(dir, 'a.db');
    createBeforeThePin(path);

    expect(compact({ dbPath: path, key: 'c'.repeat(64) }).ok).toBe(false);
    expect(compact({ dbPath: path, key: KEY })).toMatchObject({ ok: true, rowsAfter: 100 });
  });

  // Breaks if a pin the library ignored is treated as a pin. Nothing is rewritten
  // under settings nobody chose, and the worker answers instead of throwing.
  it('refuses to rebuild when the settings cannot be pinned, leaving the file', () => {
    const path = join(dir, 'a.db');
    createBeforeThePin(path);
    const before = sha256(path);

    h.ignoresPin = true;
    const result = compact({ dbPath: path, key: KEY });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('Could not pin') });
    expect(sha256(path)).toBe(before);
  });

  // Breaks the app's repeat-compaction offer: an already-rebuilt file has to rebuild.
  it('is safe to run twice', () => {
    const path = join(dir, 'a.db');
    createBeforeThePin(path);

    expect(compact({ dbPath: path, key: KEY }).ok).toBe(true);
    expect(compact({ dbPath: path, key: KEY })).toMatchObject({ ok: true, rowsBefore: 100, rowsAfter: 100 });
    expect(rowsReadWithOldSequence(path)).toBe(100);
  });

  // Breaks multi-account: every account shares one key, and compacting one must
  // neither touch nor depend on another.
  it('leaves other accounts alone', () => {
    const first = join(dir, 'acct1.db');
    const second = join(dir, 'acct2.db');
    createBeforeThePin(first);
    createBeforeThePin(second, 40);
    const secondBefore = sha256(second);

    expect(compact({ dbPath: first, key: KEY }).ok).toBe(true);

    expect(sha256(second)).toBe(secondBefore);
    expect(rowsReadWithOldSequence(second)).toBe(20);
  });
});
