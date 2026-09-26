/**
 * The ONE definition of "this email carries this tag", in SQL.
 *
 * Tags are stored on `emails.tags` as a `|a|b|c|` string (see
 * `@sarvinbox/core` `utils/tags`), and the membership test that reads them was
 * `instr(tags, '|' || ? || '|') > 0`. That is a FUNCTION applied to a column:
 * no index can ever serve it, so every one of those queries was a full scan of
 * `emails` — a table whose rows carry the message bodies inline and average
 * ~88 KB each on a real mailbox. Measured on a 2.46 GB / 27,785-email store:
 * one `getMembersOutsideUidSpace` per folder cost ~90 ms, and a single
 * `syncFlags` pass across 22 folders spent **1,922 ms** on nothing but those
 * scans, on the main thread, where it delays the IPC reply for whatever the
 * user just clicked.
 *
 * `email_tags(email_id, tag)` (migration 91) is the same membership expressed
 * as rows, maintained by triggers on `emails` so no write path can forget it.
 * With `idx_email_tags_tag` the scan becomes a covering-index seek: the same
 * 22-folder pass measured **119 ms**, returning byte-identical rows.
 *
 * Everything here is a pure string builder so it can be unit-tested without a
 * database, and so the migration, the triggers and the query sites can never
 * disagree about how a tag string is split.
 */

/** The join table that makes tag membership indexable. */
export const EMAIL_TAGS_TABLE = 'email_tags';

/** Covering index for "who carries this tag" — the seek every rewrite relies on. */
export const EMAIL_TAGS_TAG_INDEX = 'idx_email_tags_tag';

/**
 * Rows `(id, tag)` obtained by splitting a `|a|b|` tag string into its tokens.
 *
 * A recursive CTE rather than JS because it has to run inside a TRIGGER, where
 * there is no host language: that is what makes the derived table impossible to
 * desynchronise from an ad-hoc `UPDATE emails SET tags = ...`, exactly as the
 * read-model dirty queue (migration 65) does for thread ids.
 *
 * `length(...) > 2` skips the empty-tag sentinel `'||'` that `buildTags` writes
 * for a message with no tags, and `tag <> ''` drops the empty token a stray
 * `||` run would otherwise contribute — without it, the sentinel would become a
 * real row matching every probe.
 *
 * @param idExpr   expression yielding the email id (`'id'`, or `'NEW.id'` in a trigger)
 * @param tagsExpr expression yielding the tag string (`'tags'`, or `'NEW.tags'`)
 * @param fromSql  the source clause (`'FROM emails'`), empty inside a trigger
 */
export function tagSplitRowsSql(idExpr: string, tagsExpr: string, fromSql = ''): string {
  const from = fromSql ? ` ${fromSql}` : '';
  return `WITH RECURSIVE split(id, rest, tag) AS (
      SELECT ${idExpr}, substr(${tagsExpr}, 2), ''${from}
        WHERE ${tagsExpr} IS NOT NULL AND length(${tagsExpr}) > 2
      UNION ALL
      SELECT id, substr(rest, instr(rest, '|') + 1), substr(rest, 1, instr(rest, '|') - 1)
        FROM split WHERE instr(rest, '|') > 0
    )
    SELECT id, tag FROM split WHERE tag <> ''`;
}

/**
 * Sub-select of every email id carrying the bound tag. ONE bound parameter.
 *
 * Use it in place of `instr(tags, '|' || ? || '|') > 0` — the parameter and its
 * position are identical, so a rewrite never has to re-order bindings.
 */
function tagMemberIdsSql(): string {
  return `SELECT email_id FROM ${EMAIL_TAGS_TABLE} WHERE tag = ?`;
}

/**
 * Membership predicate for a row of `emails`. ONE bound parameter, the tag.
 *
 * `id IN (...)` and not a JOIN: it is a drop-in replacement inside an existing
 * WHERE clause, which is what keeps each rewrite reviewable as "the same query
 * with a sargable membership test" rather than a new query.
 */
export function hasTagClause(alias = ''): string {
  const id = alias ? `${alias}.id` : 'id';
  return `${id} IN (${tagMemberIdsSql()})`;
}
