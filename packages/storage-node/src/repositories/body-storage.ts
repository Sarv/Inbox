/**
 * Where email bodies LIVE — the `email_bodies` side table, and the one SQL
 * surface every reader and writer must go through to touch a body.
 *
 * ## Why the bodies moved out of `emails`
 *
 * SQLite stores a row as ONE record and rewrites that whole record on any
 * UPDATE. `clean_body`/`raw_body` average ~330 KB on the live mailbox, so
 * flipping `agent_status` from 'pending' to 'done' — four bytes of string —
 * rewrote a third of a megabyte, which SQLCipher then encrypted and HMAC'd:
 * measured ~47 KB of WAL per status flip. The AI pipeline does that twice per
 * email, sync does it again for every flag change, and a 26k-row drain moved
 * over a gigabyte of WAL to write a few kilobytes of actual state.
 *
 * The second cost is the read side. A record too big for one page spills onto
 * overflow pages linked as a SINGLY-LINKED LIST, so a column sitting after the
 * bodies can only be reached by walking that chain — and every AI-pipeline
 * column arrived by a late `ALTER TABLE ADD COLUMN`, which appends. That is what
 * `body-metrics.ts` measured at 426 ms for a single `COUNT(*)`, and why its
 * covering indexes only rescued the aggregates: any query that has to open a
 * record still pays the walk.
 *
 * One body row per email, whole body in one cell — this is NOT a chunking
 * scheme. `emails` keeps only header-sized columns, so its records fit on a
 * page or two and every column is cheap to reach again.
 *
 * ## The read contract: always COALESCE, never a flag
 *
 * Relocation is incremental and runs in the background for minutes on a large
 * mailbox, so at any instant some rows have their body in `email_bodies` and
 * some still inline. Readers do NOT branch on a completion flag for this —
 * {@link cleanBodyExpression} coalesces the side table over the inline column,
 * which is correct in both states and stays correct if the backfill is
 * interrupted, resumed, or has to repair a row a decade later. A flag would add
 * a second way to be wrong for no gain: these queries are materialising the body
 * anyway, so there is no covering-index win to protect.
 *
 * The inline columns are EMPTIED, not dropped, and emptied to `''` rather than
 * NULL. `DROP COLUMN` rewrites the entire table, which is the multi-GB operation
 * this whole change exists to avoid; the freed overflow pages go on the freelist
 * and get reused by new mail, so the file does not shrink without a VACUUM, and
 * a VACUUM of an 8.3 GB encrypted database is not something to run behind the
 * user's back.
 *
 * `''` costs the same zero bytes as NULL and keeps the COALESCE below TOTAL,
 * which matters more than it looks: a header-only row already carried `''`, so
 * every existing predicate (`LIKE`, `length()`, `= ''`) keeps the behaviour it
 * had, instead of silently going three-valued the day the backfill ran.
 *
 * ## The write contract
 *
 * Every writer writes the body to `email_bodies` and `''` to the inline
 * columns, in ONE transaction with the `emails` row. There is no "write it both
 * places" mode: two copies of a body is exactly the bug this replaces.
 * `clean_body_len`/`raw_body_len` stay on `emails` — they are the whole point of
 * `body-metrics.ts`, and they are computed from the bound parameter, so moving
 * the body does not change how they are maintained.
 */

import type Database from 'better-sqlite3';

import { prepared } from '../statement-cache';

/** The side table holding every email's body. One row per email. */
export const EMAIL_BODIES_TABLE = 'email_bodies';

/**
 * One-row-per-key table recording which upkeep passes this database has
 * finished — the length backfill (v72) and the body relocation (v73).
 *
 * Declared here, and re-exported by `body-metrics.ts`, purely to keep the
 * dependency one-way: `body-metrics` needs the body EXPRESSIONS from this file
 * (its has-body test has to read through `email_bodies` or it reports every
 * relocated email as body-less), so this file must not import back.
 */
export const BODY_METRICS_STATE_TABLE = 'email_body_metrics_state';

/**
 * State key: '1' once no row in `emails` holds an inline body any more.
 *
 * Shares {@link BODY_METRICS_STATE_TABLE} with the length backfill because the
 * two are filled by the SAME pass — see `body-storage-backfill.ts`. Readers do
 * not consult this key (see the read contract above); it exists so the backfill
 * knows it is done, and so a future change can retire the inline fallback.
 */
export const BODIES_RELOCATED_KEY = 'bodies_relocated';

/** Qualify a column with an optional table alias (`e.id` vs `id`). */
const col = (alias: string, name: string): string => (alias ? `${alias}.${name}` : name);

/**
 * Read one body column for the row identified by `alias`.
 *
 * A correlated scalar subquery, deliberately, rather than a `LEFT JOIN`. Bodies
 * are read from two dozen query shapes — some already joining `threads`, some
 * aggregating, some with their own aliases — and a subquery drops into any of
 * them without changing row multiplicity, colliding with an alias, or needing
 * the surrounding query re-read to check. It costs one primary-key seek per row,
 * against a body we are about to materialise anyway.
 */
function bodyExpression(column: 'clean_body' | 'raw_body', alias: string): string {
  return (
    `COALESCE((SELECT b.${column} FROM ${EMAIL_BODIES_TABLE} b ` +
    `WHERE b.email_id = ${col(alias, 'id')}), ${col(alias, column)})`
  );
}

/** `clean_body` for a row, wherever it currently lives. */
export const cleanBodyExpression = (alias = 'emails'): string => bodyExpression('clean_body', alias);

/** `raw_body` for a row, wherever it currently lives. */
export const rawBodyExpression = (alias = 'emails'): string => bodyExpression('raw_body', alias);

/**
 * The two body columns, aliased back to the names the row mapper expects.
 *
 * Appended to an explicit column list to replace what `SELECT *` used to
 * deliver. `SELECT *` cannot be used any more: it would hand back the emptied
 * inline columns, which every reader would take as "this email's body was never
 * downloaded" — the body-reheal scheduler would then queue the entire mailbox
 * for re-download from IMAP. That is the failure mode this module's discipline
 * exists to prevent, and it is silent: mail still lists, still opens, just
 * renders empty.
 */
export function bodySelectColumns(alias = 'emails'): string {
  return (
    `${cleanBodyExpression(alias)} AS clean_body, ` +
    `${rawBodyExpression(alias)} AS raw_body`
  );
}

/**
 * A bounded preview of `clean_body` for LIST views, plus the full `raw_body`
 * suppressed to a presence flag by the caller.
 *
 * `SUBSTR` on the side table still reads the body page chain, but it no longer
 * ships the whole value into JS — which was 12 MB per 50-row page.
 */
export function cleanBodySnippetColumn(alias = 'emails', chars = 256): string {
  return `SUBSTR(${cleanBodyExpression(alias)}, 1, ${chars}) AS clean_body`;
}

/**
 * Upsert one email's body. Bound by name so it can share a parameter object
 * with the `emails` insert.
 *
 * `ON CONFLICT` rather than `INSERT OR REPLACE`: replace is a delete plus an
 * insert, which fires the FTS delete trigger and would drop the row's header
 * terms out of the search index for the instant between the two.
 */
export const UPSERT_BODY_SQL = `
  INSERT INTO ${EMAIL_BODIES_TABLE} (email_id, clean_body, raw_body)
  VALUES (@id, @cleanBody, @rawBody)
  ON CONFLICT(email_id) DO UPDATE SET
    clean_body = excluded.clean_body,
    raw_body = excluded.raw_body
`;

/**
 * Patch only the body columns a partial update actually supplies.
 *
 * An update that touches neither body must not create or blank a body row, and
 * an update that supplies only `cleanBody` must leave `raw_body` alone — the
 * body-reheal scheduler rebuilds `clean_body` from an already-stored `raw_body`
 * and would otherwise wipe the source it just read. Returns null when there is
 * nothing to write, so the caller can skip the statement entirely.
 */
export function upsertBodyPatchSql(patch: {
  cleanBody?: unknown;
  rawBody?: unknown;
}): string | null {
  const hasClean = patch.cleanBody !== undefined;
  const hasRaw = patch.rawBody !== undefined;
  if (!hasClean && !hasRaw) return null;

  // The INSERT half has to supply both columns; the one that was not passed is
  // seeded empty, which is only reachable when no body row exists yet.
  const insertClean = hasClean ? '@cleanBody' : "''";
  const insertRaw = hasRaw ? '@rawBody' : "''";
  const sets = [
    hasClean && 'clean_body = excluded.clean_body',
    hasRaw && 'raw_body = excluded.raw_body',
  ].filter((clause): clause is string => clause !== false);

  return `
    INSERT INTO ${EMAIL_BODIES_TABLE} (email_id, clean_body, raw_body)
    VALUES (@id, ${insertClean}, ${insertRaw})
    ON CONFLICT(email_id) DO UPDATE SET ${sets.join(', ')}
  `;
}

/** True once no `emails` row holds an inline body. */
export function areBodiesRelocated(db: Database.Database): boolean {
  try {
    const row = prepared(
      db,
      `SELECT value FROM ${BODY_METRICS_STATE_TABLE} WHERE key = ?`,
    ).get(BODIES_RELOCATED_KEY) as { value?: string } | undefined;
    return row?.value === '1';
  } catch {
    // Table absent on a DB that has not reached this migration yet. "Not
    // relocated" is the safe answer: it only ever selects the inline fallback,
    // which is where the bodies actually are.
    return false;
  }
}

/** Record that this DB's relocation pass has completed. */
export function markBodiesRelocated(db: Database.Database): void {
  db.prepare(
    `INSERT INTO ${BODY_METRICS_STATE_TABLE}(key, value) VALUES (?, '1') ` +
      'ON CONFLICT(key) DO UPDATE SET value = \'1\'',
  ).run(BODIES_RELOCATED_KEY);
}
