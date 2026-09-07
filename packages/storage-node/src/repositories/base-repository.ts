// Base Repository - Common utilities for all repositories

import { createLogger } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { reportSlowQuery } from '../slow-query-reporter';

import { areBodyLengthsReady } from './body-metrics';
import { bodySelectColumns } from './body-storage';

const logger = createLogger('base-repository');

/**
 * Database accessor type - provides access to the database instance
 */
export type DatabaseAccessor = () => Database.Database;

/**
 * Base class for all repositories
 * Provides common utilities and database access
 */
export abstract class BaseRepository {
  constructor(protected getDb: DatabaseAccessor) {}

  /**
   * Get the database instance
   * @throws Error if database is not initialized
   */
  protected get db(): Database.Database {
    const database = this.getDb();
    if (!database) {
      throw new Error('Storage not initialized');
    }
    return database;
  }

  /**
   * Whether THIS database's `clean_body_len`/`raw_body_len` columns are fully
   * populated, so a has-body test may be answered from an index instead of by
   * reading the body.
   *
   * Lives on the base class because every repository that asks the question
   * needs the same answer for the same database — and because the answer is
   * per-database (each account has its own file and its own backfill progress),
   * so it can never be cached in a module-level flag. Pass the result into the
   * eligibility clause builders as `bodyLengthsReady`; never pass a literal.
   */
  protected bodyLengthsReady(): boolean {
    return areBodyLengthsReady(this.db);
  }

  /** Per-database, per-alias cache for {@link emailSelect}. */
  private _emailSelectDb: Database.Database | null = null;
  private readonly _emailSelectCache = new Map<string, string>();

  /**
   * Every column of `emails`, with the two body columns read through
   * `email_bodies` and aliased back to their own names.
   *
   * This is the replacement for `SELECT *` / `SELECT emails.*` in every query
   * that builds a whole `EmailRecord`. `SELECT *` is no longer usable: since
   * migration 73 the inline `clean_body`/`raw_body` columns are NULL on a
   * relocated row, and a star would hand those NULLs straight to `rowToRecord`.
   * Nothing throws — the mail lists, the thread opens, the body renders blank —
   * and the body-reheal scheduler reads the same NULL as "never downloaded" and
   * queues the entire mailbox for re-fetch from IMAP. Loud consequences, silent
   * cause; hence one helper, used everywhere, rather than 24 hand-written lists.
   *
   * Built from the LIVE schema (like `listSelect`) so a later `ADD COLUMN` is
   * picked up without touching this, and cached per database because each account
   * has its own file. `alias` must name the table as the query refers to it —
   * qualified names keep the correlated body lookup from resolving `id` against a
   * joined table, which would return another row's body.
   */
  protected emailSelect(alias = 'emails'): string {
    const db = this.db;
    if (this._emailSelectDb !== db) {
      this._emailSelectDb = db;
      this._emailSelectCache.clear();
    }
    const cached = this._emailSelectCache.get(alias);
    if (cached !== undefined) return cached;

    // Double-quote every column: some (e.g. `references`) are SQLite reserved
    // words. Quoting keeps the OUTPUT name the bare identifier, so `row.references`
    // still resolves in the row mappers.
    const cols = (db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n !== 'clean_body' && n !== 'raw_body')
      .map((n) => (alias ? `${alias}."${n}"` : `"${n}"`));
    const sql = `${cols.join(', ')}, ${bodySelectColumns(alias)}`;
    this._emailSelectCache.set(alias, sql);
    return sql;
  }

  /**
   * Convert camelCase string to snake_case
   * Used for column name mapping
   */
  protected camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  /**
   * The canonical form of an email address used as a KEY (contacts.email,
   * sender_stats.email, contact_notes.email, spammers.email, …).
   *
   * The repositories disagreed on this: ContactRepository stored and read
   * `.toLowerCase().trim()`, while AgentRepository and AiRepository looked up
   * `.toLowerCase()` alone. An address that arrived with surrounding whitespace
   * — routine from a header parse — was therefore written under the trimmed key
   * and searched for under the untrimmed one, so sender stats, contact notes and
   * the spammer check all silently missed that contact. One normalizer, used by
   * every read and write of an address key, is the only way these stay in sync.
   */
  protected normalizeEmailKey(email: string): string {
    return String(email ?? '').trim().toLowerCase();
  }

  /**
   * A LIKE pattern for a "contains" match, with the caller's OWN wildcards
   * neutralised.
   *
   * `%${value}%` treats `%` and `_` inside the user's text as wildcards, so
   * searching for `50%` matched "50" followed by anything, `a_b` matched "axb",
   * and a query of just `%` matched the whole mailbox. Escapes `\`, `%` and `_`
   * with a backslash — SQLite's LIKE has NO default escape character, so the SQL
   * must say `LIKE ? ESCAPE '\'` for this to mean anything.
   */
  protected likeContains(value: string): string {
    return `%${String(value).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  }

  /**
   * The sort keys the PUBLIC query types expose that aren't column names.
   *
   * `SearchQuery.sortBy` offers `'from'`, which snake_cases to `from` — not in
   * any whitelist, so it fell through to the default and "sort by sender"
   * silently sorted by date instead. Aliases are resolved before the whitelist
   * check, so the whitelist stays a whitelist of real columns.
   */
  private static readonly SORT_ALIASES: Readonly<Record<string, string>> = {
    from: 'from_address',
    sender: 'from_address',
    to: 'to_address',
    recipient: 'to_address',
  };

  /**
   * Validate caller-supplied sort inputs before SQL interpolation.
   * Returns a whitelisted snake_case column and 'ASC' | 'DESC' —
   * anything not in `allowedColumns` falls back to `defaultColumn`.
   */
  protected safeOrderBy(
    sortBy: string | undefined,
    sortOrder: string | undefined,
    allowedColumns: ReadonlySet<string>,
    defaultColumn: string,
  ): { column: string; direction: 'ASC' | 'DESC' } {
    const requested = this.camelToSnake(sortBy || defaultColumn);
    let column = BaseRepository.SORT_ALIASES[requested] ?? requested;
    if (!allowedColumns.has(column)) column = defaultColumn;
    const direction = (sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    return { column, direction };
  }

  /**
   * Convert snake_case object keys to camelCase
   */
  protected snakeToCamelObject<T>(obj: Record<string, any>): T {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      result[camelKey] = value;
    }
    return result as T;
  }

  /**
   * Build dynamic UPDATE SET clauses
   * Returns [setClauses, params] for use in prepared statements
   */
  protected buildUpdateClauses(
    updates: Record<string, any>,
    options: {
      jsonFields?: string[];
      boolFields?: string[];
    } = {}
  ): { setClauses: string[]; params: Record<string, any> } {
    const setClauses: string[] = [];
    const params: Record<string, any> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const snakeKey = this.camelToSnake(key);
        setClauses.push(`${snakeKey} = @${key}`);

        if (options.jsonFields?.includes(key)) {
          params[key] = JSON.stringify(value);
        } else if (options.boolFields?.includes(key)) {
          params[key] = value ? 1 : 0;
        } else {
          params[key] = value;
        }
      }
    }

    return { setClauses, params };
  }

  /**
   * Parse JSON field safely with default value
   */
  protected parseJsonField<T>(value: string | null | undefined, defaultValue: T): T {
    if (!value) return defaultValue;
    try {
      return JSON.parse(value) as T;
    } catch {
      return defaultValue;
    }
  }

  /**
   * Get current Unix timestamp in seconds
   */
  protected now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Time a SYNCHRONOUS query and log it ONLY when it's slow (≥ SLOW_QUERY_MS),
   * so normal fast queries stay silent and real stalls surface in the app logs.
   * This is the instrumentation for the "does the base instr(tags) full-table
   * scan actually dominate list-load time at scale?" question — the slow line
   * reports duration, rows returned, and (computed only on the slow path, so no
   * per-query cost) the total mailbox size, so we can correlate ms with email
   * count before committing to the bigger folder-membership-index change.
   */
  protected timed<T>(
    label: string,
    run: () => T,
    meta?: Record<string, unknown>,
  ): T {
    const t0 = Date.now();
    const result = run();
    const ms = Date.now() - t0;
    if (ms >= BaseRepository.SLOW_QUERY_MS) {
      const rows = Array.isArray(result) ? (result as unknown[]).length : undefined;
      let totalEmails: number | undefined;
      try {
        totalEmails = (this.db.prepare('SELECT COUNT(*) AS c FROM emails').get() as { c: number }).c;
      } catch { /* diagnostic only */ }
      logger.warn(`[SlowQuery] ${label} ${ms}ms ${JSON.stringify({ rows, totalEmails, ...meta })}`);
      // Field telemetry: the host app forwards this to Sentry (throttled) so we
      // learn about real users' big-mailbox stalls, not just our own logs.
      reportSlowQuery({ label, ms, rows, totalEmails, meta });
    }
    return result;
  }

  /** Queries slower than this (ms) get a one-line log; fast ones stay silent. */
  private static readonly SLOW_QUERY_MS = 40;
}
