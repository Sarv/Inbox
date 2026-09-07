/**
 * Prepared-statement cache, keyed by the database handle.
 *
 * `db.prepare(sql)` COMPILES the SQL every time it is called. Statements on the
 * per-email hot paths (the thread resolver, the insert path) run tens of
 * thousands of times during a first sync or a repair pass, so re-parsing them is
 * pure waste — it showed up as `sqlite3RunParser` in the 2026-08-26 CPU profile
 * of the main process, on top of the query cost itself.
 *
 * A WeakMap keyed on the HANDLE rather than a plain module-level Map is the
 * important part: a statement outliving its database is a hard crash, and this
 * app reopens the connection (account switch, re-key). Each handle gets its own
 * statements and they become collectable with it, so a closed or replaced
 * database can never hand back a stale statement.
 */
import type Database from 'better-sqlite3';

const statementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Compile `sql` once per database handle and reuse it thereafter. */
export function prepared(db: Database.Database, sql: string): Database.Statement {
  let forDb = statementCache.get(db);
  if (!forDb) {
    forDb = new Map();
    statementCache.set(db, forDb);
  }
  let stmt = forDb.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    forDb.set(sql, stmt);
  }
  return stmt;
}
