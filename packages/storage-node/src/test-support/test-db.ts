// TEST-ONLY helper: opens a REAL SQLite database for the storage-node suite.
//
// Why this exists at all: the repo's postinstall recompiles better-sqlite3 for
// ELECTRON's ABI, so a plain `node` (and therefore vitest) cannot dlopen the
// packaged binding. When that happens we fall back to Node's BUILT-IN
// `node:sqlite` (SQLite 3.53, FTS5 included) behind a thin better-sqlite3-shaped
// facade. Both paths are real SQLite executing the real SQL under test — the
// facade only translates the handful of API shapes the storage layer uses
// (`prepare`, `exec`, `pragma`, `transaction`, `close`). Nothing is stubbed out,
// so a wrong SQL predicate still fails the test either way.
//
// Everything here is deliberately dependency-free (no vitest import) so it can
// be imported from any test file without registering suites.

import { createRequire } from 'node:module';

import type Database from 'better-sqlite3';

import { createMigrationManager } from '../migrations';

const requireFromHere = createRequire(import.meta.url);

type AnyRow = Record<string, unknown>;

/** Loaded lazily so a broken native binding costs one try/catch, not a crash. */
function loadNativeCtor(): unknown | null {
  try {
    const mod = requireFromHere('better-sqlite3');
    const ctor = (mod?.default ?? mod) as unknown;
    // Touch the binding — the ABI error only surfaces when a DB is opened.
    const probe = new (ctor as new (p: string) => { close: () => void })(':memory:');
    probe.close();
    return ctor;
  } catch {
    return null;
  }
}

/** better-sqlite3 statement facade over a node:sqlite StatementSync. */
class CompatStatement {
  constructor(private readonly stmt: AnyRow & Record<string, any>) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const res = this.stmt.run(...params);
    return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
  }

  get(...params: unknown[]): unknown {
    // node:sqlite returns undefined for "no row", same as better-sqlite3.
    return this.stmt.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...params);
  }

  iterate(...params: unknown[]): IterableIterator<unknown> {
    return this.stmt.iterate(...params);
  }

  columns(): unknown[] {
    return this.stmt.columns();
  }
}

/**
 * better-sqlite3 database facade over node:sqlite's DatabaseSync.
 *
 * `transaction()` reproduces better-sqlite3's semantics that the storage layer
 * relies on: the returned function commits on return, ROLLS BACK on throw and
 * rethrows, and nests via SAVEPOINTs when a transaction is already open (several
 * repositories call one transactional method from inside another).
 */
class CompatDatabase {
  private readonly inner: Record<string, any>;
  private txDepth = 0;
  private savepointSeq = 0;

  readonly name: string;
  readonly memory: boolean;
  readonly readonly: boolean;
  open = true;

  constructor(path: string, options: { readonly?: boolean } = {}) {
    const { DatabaseSync } = requireFromHere('node:sqlite');
    this.name = path;
    this.memory = path === ':memory:';
    this.readonly = !!options.readonly;
    this.inner = new DatabaseSync(path, { readOnly: !!options.readonly });
  }

  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatement(this.inner.prepare(sql));
  }

  exec(sql: string): this {
    this.inner.exec(sql);
    return this;
  }

  /**
   * `pragma('foo = bar')` executes and returns []; `pragma('foo')` reads rows —
   * matching how the storage layer uses it. Cipher pragmas (`key=`, `rekey=`)
   * are plain no-op pragmas on a vanilla SQLite build, so the encrypted-DB code
   * path runs but the file is NOT actually encrypted under the fallback.
   */
  pragma(statement: string): unknown[] {
    if (statement.includes('=')) {
      this.inner.exec(`PRAGMA ${statement}`);
      return [];
    }
    return this.inner.prepare(`PRAGMA ${statement}`).all();
  }

  function(name: string, fn: (...args: any[]) => unknown): this {
    this.inner.function(name, fn);
    return this;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) & {
    default: (...args: A) => R;
    deferred: (...args: A) => R;
    immediate: (...args: A) => R;
    exclusive: (...args: A) => R;
  } {
    const wrapped = (...args: A): R => {
      const nested = this.txDepth > 0;
      const point = `sp_compat_${++this.savepointSeq}`;
      this.inner.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN');
      this.txDepth += 1;
      try {
        const result = fn(...args);
        this.inner.exec(nested ? `RELEASE ${point}` : 'COMMIT');
        this.txDepth -= 1;
        return result;
      } catch (error) {
        // Undo only this level's work, exactly like better-sqlite3 does.
        this.inner.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK');
        this.txDepth -= 1;
        throw error;
      }
    };
    return Object.assign(wrapped, {
      default: wrapped,
      deferred: wrapped,
      immediate: wrapped,
      exclusive: wrapped,
    });
  }

  close(): void {
    this.open = false;
    this.inner.close();
  }
}

const nativeCtor = loadNativeCtor();

/** True when the tests are running against the packaged native better-sqlite3. */
export const usingNativeBinding = nativeCtor !== null;

/**
 * Constructor with better-sqlite3's `new Database(path, options)` shape. Pass
 * this to `vi.mock('better-sqlite3', ...)` when the code under test constructs
 * its own connection (SQLiteStorage does).
 */
export const TestDatabaseCtor = (nativeCtor ?? CompatDatabase) as unknown as typeof Database;

/** Open a real SQLite database (in-memory by default). */
export function openTestDb(
  path = ':memory:',
  options: { readonly?: boolean } = {},
): Database.Database {
  const Ctor = TestDatabaseCtor as unknown as new (p: string, o?: unknown) => Database.Database;
  return new Ctor(path, options);
}

/**
 * Open a database carrying the CURRENT production schema (schema.sql + every
 * incremental migration). Repositories tested against this cannot drift from the
 * real column set — a missing column or renamed table fails the test instead of
 * only failing in the app.
 */
export function newMigratedDb(path = ':memory:'): Database.Database {
  const db = openTestDb(path);
  createMigrationManager(db).migrate();
  return db;
}
