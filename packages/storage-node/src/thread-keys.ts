/**
 * `email_thread_keys` — the narrow lookup table behind the thread resolver's
 * subject fallback.
 *
 * WHY A SIDE TABLE AND NOT A COLUMN ON `emails`
 *
 * The resolver needs to find "other mail with this normalised subject, near this
 * date" cheaply. That needs an indexed, seekable key. The obvious shape is a
 * `subject_norm` column on `emails` — and it is the wrong one, measurably:
 * `emails` stores `clean_body` and `raw_body` inline, so on a real mailbox its
 * rows average ~250 KB (26k emails = 6.5 GB). SQLite cannot update one field of
 * a spilled record in place; adding a column and backfilling it rewrites every
 * row, overflow chains included. Tried on 2026-08-26: the backfill was still
 * running after five minutes at 100% CPU with a 700 MB WAL and climbing — a
 * worse startup freeze than the bug it was fixing.
 *
 * Keeping the key in its own table makes the same backfill ~26k narrow rows
 * (single-digit MB), and the index it feeds stays small enough to stay in page
 * cache. `emails` is never rewritten.
 *
 * `created_at` lives here for the same reason. The incremental repair pass asks
 * "what was stored since the last pass?" every ten minutes forever; answering it
 * from `emails.created_at` is worse than it looks, because that column was added
 * by a late ALTER and therefore sits at the END of the record — past the bodies,
 * out in the overflow pages. Both indexing it and scanning it would have to walk
 * the whole 6.5 GB. Here it is two columns into a narrow row.
 *
 * Normalisation is a regex, so this cannot be a GENERATED column and cannot be
 * maintained by a trigger — every writer of `emails` must call `writeThreadKey`.
 */
import { normalizeSubject } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { prepared } from './statement-cache';

/**
 * Upsert, not insert: a subject can be rewritten after the fact (the
 * incomplete-envelope repair pass fills in subjects on rows stored without
 * one), and a stale key is invisible — the row stays findable only under its OLD
 * subject, so the thread silently splits.
 *
 * `created_at` moves forward on a subject/date change ON PURPOSE: the next
 * incremental repair pass scopes itself by `created_at`, so bumping it is what
 * makes that row get re-examined now that its threading answer may have changed.
 */
export const SQL_UPSERT_THREAD_KEY = `
  INSERT INTO email_thread_keys (email_id, subject_norm, date, created_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT(email_id) DO UPDATE SET
    subject_norm = excluded.subject_norm,
    date = excluded.date,
    created_at = excluded.created_at
`;

/**
 * Record (or refresh) the resolver's lookup key for one email.
 *
 * Call this from EVERY path that writes a row into `emails` — the main insert,
 * the sent-mail append and the draft save all thread, and an email with no key
 * row is unfindable by subject: its replies start new conversations instead of
 * joining it.
 *
 * `subject` is normalised with the same helper the resolver looks the key up
 * with, so a NULL or empty subject becomes '' — a real, seekable value — rather
 * than dropping the row out of the index.
 */
export function writeThreadKey(
  db: Database.Database,
  email: { id: string; subject: string | null | undefined; date: number },
): void {
  prepared(db, SQL_UPSERT_THREAD_KEY).run(
    email.id,
    normalizeSubject(email.subject || ''),
    email.date,
  );
}
