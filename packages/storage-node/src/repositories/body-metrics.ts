/**
 * Body-size metrics — the two scalar columns that let every "does this email
 * have a body?" and "how big is it?" question be answered WITHOUT reading the
 * body.
 *
 * ## Why this exists
 *
 * `clean_body`/`raw_body` are stored inline in `emails` and average ~330 KB on a
 * real mailbox, so a row spills across dozens of overflow pages. SQLite stores a
 * row as ONE record and the overflow chain is a singly-linked list, so any
 * column that sits after the bodies can only be reached by walking that chain.
 * Every AI-pipeline column was added by a late `ALTER TABLE ADD COLUMN`
 * (`extraction_status`, `agent_status`, `label_status`, `ai_parse_failure_count`)
 * and `ALTER TABLE` appends — so all of them are behind the bodies.
 *
 * Measured 2026-08-27 on a synthetic table with this schema's column order and
 * the live mailbox's body sizes (293 KB avg, 10k rows):
 *
 *   - `COUNT(*) WHERE extraction_status='pending'`      426 ms   (1 ms split out)
 *   - full eligibility clause                          474 ms   (1 ms split out)
 *   - predicate on `uid` (column 5, ahead of bodies)      4 ms
 *
 * With NO body test at all the scan still cost 60 ms of an 81 ms total, so the
 * `LENGTH(TRIM(clean_body))` predicate was never the main cost — reaching the
 * status column was. That is why no rewrite of the predicate helps: `<> ''`,
 * dropping `TRIM`, and `LENGTH(CAST(… AS BLOB))` all measured within noise of
 * each other (66–82 ms).
 *
 * The fix is to answer the question from an integer that a covering index can
 * hold, so the row is never visited at all. Same measurement, with
 * `(extraction_status, agent_status, date)` indexed: 426 ms -> under 1 ms,
 * `SEARCH … USING COVERING INDEX`.
 *
 * ## The NULL contract
 *
 * `clean_body_len`/`raw_body_len` are NULL on every pre-existing row until the
 * background backfill reaches it. A NULL must NEVER be read as "no body": that
 * would silently drop the row out of AI eligibility, and mail that quietly stops
 * being categorized is invisible for days. So the fast form of the predicate is
 * used ONLY once the backfill has proven no NULL remains — see
 * `areBodyLengthsReady`. Until then callers get the original body-reading
 * expression: correct and slow, rather than fast and wrong.
 */

import type Database from 'better-sqlite3';

import { prepared } from '../statement-cache';

import { BODY_METRICS_STATE_TABLE, cleanBodyExpression, rawBodyExpression } from './body-storage';

/** Qualify a column with an optional table alias (`e.tags` vs `tags`). */
const col = (alias: string, name: string): string => (alias ? `${alias}.${name}` : name);

/** Key/value table holding this DB's backfill progress. Defined in `body-storage`. */
export { BODY_METRICS_STATE_TABLE };

/** State key: '1' once every row has non-NULL length columns. */
export const LENGTHS_BACKFILLED_KEY = 'lengths_backfilled';

/**
 * SQL that computes a stored length from a BOUND body parameter.
 *
 * Deliberately computed in SQL rather than in JS so the stored value cannot
 * drift from what `LENGTH(TRIM(...))` would have returned:
 *
 *  - SQLite's one-argument `TRIM(X)` strips U+0020 ONLY. JavaScript's
 *    `String.prototype.trim()` also strips tabs, newlines and other Unicode
 *    whitespace, so a body of "\n\n" is non-empty to SQLite and empty to JS.
 *    Computing it here keeps the migration behaviour-preserving: no row changes
 *    its has-body verdict just because the value moved into a column.
 *  - SQLite's `LENGTH()` on TEXT counts characters; JS `.length` counts UTF-16
 *    code units, so any astral character (emoji) would disagree.
 *
 * The value is already bound in memory, so this costs nothing extra.
 */
export const bodyLengthFromParam = (param: string): string => `LENGTH(TRIM(${param}))`;

/**
 * The extra `SET` fragments that keep the length columns in step with a body
 * write. Returned for exactly the body fields present in the patch, so a patch
 * that touches neither body adds nothing.
 *
 * Pure and parameter-name-driven so it can be unit-tested without a DB.
 */
export function bodyLengthSetClauses(patch: {
  cleanBody?: unknown;
  rawBody?: unknown;
}): string[] {
  const clauses: string[] = [];
  if (patch.cleanBody !== undefined) {
    clauses.push(`clean_body_len = ${bodyLengthFromParam('@cleanBody')}`);
  }
  if (patch.rawBody !== undefined) {
    clauses.push(`raw_body_len = ${bodyLengthFromParam('@rawBody')}`);
  }
  return clauses;
}

/**
 * The original, body-reading has-body expression. Kept verbatim as the fallback
 * for a DB whose backfill has not finished, and as the definition the fast form
 * must agree with.
 *
 * Categorization runs off cleanBody OR rawBody: an HTML-only mail (empty
 * clean_body, common for marketing sends) carries its content in raw_body, so
 * gating on clean_body alone strands such mail.
 */
export function legacyHasBodyExpression(alias = ''): string {
  // Reads through `email_bodies` (migration 73), not the inline columns. The
  // inline form was the single most dangerous line in this change: on a relocated
  // row it evaluates NULL, so `hasBodyClause` says no body — the AI pipeline
  // silently stops picking mail up — and its inverse `missingBodyClause` says
  // EVERY row is missing one, which points the body-reheal scheduler at the whole
  // mailbox and has it re-download it from IMAP.
  const clean = cleanBodyExpression(alias);
  const raw = rawBodyExpression(alias);
  return (
    `((${clean} IS NOT NULL AND LENGTH(TRIM(${clean})) > 0)` +
    ` OR (${raw} IS NOT NULL AND LENGTH(TRIM(${raw})) > 0))`
  );
}

/**
 * The index-servable has-body expression.
 *
 * Must not reference `clean_body`/`raw_body` even in an untaken branch: SQLite
 * decides index coverage from the columns a query MENTIONS, not the ones it ends
 * up reading, so a single textual reference to a body column disqualifies every
 * covering index and puts the overflow-chain walk straight back.
 */
export function fastHasBodyExpression(alias = ''): string {
  return `(${col(alias, 'clean_body_len')} > 0 OR ${col(alias, 'raw_body_len')} > 0)`;
}

/**
 * Size of the raw body, for the search size filter.
 *
 * `ready === false` yields the original `length(raw_body)` so results are
 * identical while the backfill runs.
 *
 * One deliberate difference in the ready form: the stored value is
 * `LENGTH(TRIM(raw_body))`, so it is smaller than `length(raw_body)` by however
 * many leading/trailing spaces the raw MIME carries. A size filter is a
 * user-facing "bigger/smaller than N" threshold, not an exact byte accounting
 * (both forms count CHARACTERS, not bytes, and always did), so a handful of
 * spaces cannot move a row across a threshold that matters. Storing an
 * untrimmed second length purely for this filter would cost another column and
 * another write on every body.
 */
export function rawBodyLengthExpression(alias = '', ready = false): string {
  // The slow form reads through `email_bodies` for the same reason
  // `legacyHasBodyExpression` does: the inline column is NULL after relocation,
  // and `length(NULL)` is NULL, which would drop every row out of a size filter.
  return ready ? col(alias, 'raw_body_len') : `length(${rawBodyExpression(alias)})`;
}

/**
 * Has this DB finished computing the length columns for every row?
 *
 * Per-DB, not global: each account has its own database and its own backfill
 * progress, so a module-level flag would let a freshly-added account borrow a
 * long-running account's "ready" and read NULLs as "no body".
 *
 * Cheap enough to call per query build — a primary-key lookup on a one-row
 * table, through the statement cache so the SQL is parsed once per connection.
 * Returns `false` on any error (including a DB predating v72, where the table
 * does not exist), which is the safe direction: `false` only costs speed, while
 * `true` on an unbackfilled DB drops mail out of the pipeline.
 */
export function areBodyLengthsReady(db: Database.Database): boolean {
  try {
    const row = prepared(db, `SELECT value FROM ${BODY_METRICS_STATE_TABLE} WHERE key = ?`)
      .get(LENGTHS_BACKFILLED_KEY) as { value: string } | undefined;
    return row?.value === '1';
  } catch {
    return false;
  }
}

/** Flip the flag once the backfill has proven no row has NULL lengths. */
export function markBodyLengthsReady(db: Database.Database): void {
  prepared(
    db,
    `INSERT INTO ${BODY_METRICS_STATE_TABLE}(key, value) VALUES (?, '1') ` +
      "ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run(LENGTHS_BACKFILLED_KEY);
}
