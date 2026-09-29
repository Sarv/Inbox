// First-email split repository — the chat view's AI-mode cache (migration v97).
//
// One row per thread holding the AI split of the thread's FIRST email. The
// rules for what a row means — its key, when it may be shown, when a result may
// replace it, how failures back off — live in core (`utils/first-split.ts`) so
// main and the renderer cannot disagree; this file only reads and writes rows
// by those rules. The facade (`SQLiteStorage.saveFirstSplit`) wraps the guarded
// write in one transaction with the key check against the live thread.

import {
  FIRST_SPLIT_VERSION,
  nextFailureState,
  parseFirstSplitParts,
  shouldReplace,
  type FirstSplitClearCounts,
  type FirstSplitErrorKind,
  type FirstSplitKey,
  type FirstSplitPart,
  type FirstSplitRow,
  type FirstSplitSaveRequest,
  type FirstSplitSaveResult,
  type FirstSplitStatus,
} from '@sarvinbox/core';

import { FIRST_EMAIL_SPLITS_TABLE } from '../migrations';
import { prepared } from '../statement-cache';

import { BaseRepository } from './base-repository';

const STATUSES: ReadonlySet<string> = new Set<FirstSplitStatus>(['ok', 'partial', 'skipped', 'transient', 'failed']);

/** A save request that passed {@link validateFirstSplitSave}: parts serialised, fields typed. */
export interface FirstSplitWriteInput {
  status: FirstSplitStatus;
  /** JSON of the parts, exactly when the status is `ok`/`partial`. */
  parts: string | null;
  errorKind: string | null;
  quoteCount: number | null;
  modelUsed: string | null;
}

/** Why the scheduler's scan picked a thread. */
export type FirstSplitCandidateReason = 'no-row' | 'version' | 'due' | 'first-changed';

/** A thread the background job should look at (it re-checks each one precisely). */
export interface FirstSplitCandidate {
  threadId: string;
  /** The first MEMBER's subject (the thread's, when that is empty). */
  subject: string;
  /** The first member's In-Reply-To / References — the scheduler's "is this a reply or forward" evidence. */
  inReplyTo: string | null;
  references: string | null;
  lastMessageDate: number;
  reason: FirstSplitCandidateReason;
}

/**
 * A thread's first conversation MEMBER, as the scan needs it: its row id and
 * its key (core `firstMemberKeyOf`). The facade computes it with core's
 * membership predicate; null when the thread has no member (only drafts).
 */
export interface FirstSplitFirstMember {
  id: string;
  key: string;
}

/**
 * How many rows the scan may examine per candidate it can return. Rows the
 * SQL pre-selects but the membership check then rejects do not use up a
 * candidate slot; this bounds what they cost per tick instead.
 */
export const FIRST_SPLIT_SCAN_ROWS_PER_SLOT = 10;

export interface FirstSplitCandidateOptions {
  /** Unix seconds: threads whose newest message is older are not looked at. */
  since: number;
  /**
   * How many candidates the scan returns at most, newest first. It examines
   * up to {@link FIRST_SPLIT_SCAN_ROWS_PER_SLOT} times as many pre-selected
   * threads to find them.
   */
  scanLimit: number;
  /** The split version current rows must carry (core `FIRST_SPLIT_VERSION`). */
  version: number;
  /** Unix seconds, for the transient-retry due check. */
  now: number;
  /** Transient rows with this many attempts are no longer retried automatically. */
  maxAttempts: number;
  /**
   * The caller's own filter, applied to each CONFIRMED candidate (newest
   * first) before it counts: only candidates it accepts are returned and take
   * a `scanLimit` slot. Without it, threads the caller will never act on (the
   * scheduler's "no reply/forward evidence") would fill every slot and hide
   * the older threads it wants. Called at most once per candidate; omitted,
   * every confirmed candidate is accepted.
   */
  accept?: (candidate: FirstSplitCandidate) => boolean;
}

type FirstSplitDbRow = {
  thread_id: string;
  first_key: string;
  first_email_id: string;
  source_fingerprint: string;
  split_version: number;
  status: FirstSplitStatus;
  quote_count: number | null;
  parts: string | null;
  error_kind: string | null;
  attempts: number;
  next_retry_at: number | null;
  model_used: string | null;
  updated_at: number;
};

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Only the part fields the cache stores — a payload's extra properties never reach the row. */
function storedPart(part: FirstSplitPart): FirstSplitPart {
  return {
    role: part.role,
    fromAddress: part.fromAddress,
    fromName: part.fromName,
    date: part.date,
    dateApprox: part.dateApprox,
    body: part.body,
    fallback: part.fallback,
  };
}

/**
 * Check and normalise a save request from the renderer, or return null when it
 * cannot be stored: an unknown status, or a SUCCESS whose parts would not read
 * back as a usable split (none, a blank body, two own parts…) — the row would
 * otherwise be "ok" and unshowable, and block a real retry.
 *
 * Parts are dropped for every non-success status (the table's CHECK demands
 * it), a non-integer or negative quote count is recorded as unknown, and
 * blank strings become null.
 */
export function validateFirstSplitSave(request: FirstSplitSaveRequest | null | undefined): FirstSplitWriteInput | null {
  if (!request || typeof request !== 'object' || !STATUSES.has(request.status)) return null;
  let parts: string | null = null;
  if (request.status === 'ok' || request.status === 'partial') {
    if (!Array.isArray(request.parts)) return null;
    const candidate = JSON.stringify(request.parts.map((part) => (part && typeof part === 'object' ? storedPart(part) : part)));
    if (parseFirstSplitParts(candidate) === null) return null;
    parts = candidate;
  }
  const quoteCount = typeof request.quoteCount === 'number' && Number.isInteger(request.quoteCount) && request.quoteCount >= 0
    ? request.quoteCount
    : null;
  return {
    status: request.status,
    parts,
    errorKind: optionalString(request.errorKind),
    quoteCount,
    modelUsed: optionalString(request.modelUsed),
  };
}

export class FirstSplitRepository extends BaseRepository {
  private toRow(row: FirstSplitDbRow): FirstSplitRow {
    return {
      threadId: row.thread_id,
      firstKey: row.first_key,
      firstEmailId: row.first_email_id,
      sourceFingerprint: row.source_fingerprint,
      splitVersion: row.split_version,
      status: row.status,
      quoteCount: row.quote_count,
      parts: row.parts,
      errorKind: row.error_kind,
      attempts: row.attempts,
      nextRetryAt: row.next_retry_at,
      modelUsed: row.model_used,
      updatedAt: row.updated_at,
    };
  }

  /** The stored row for a thread, whatever key it was computed for, or null. */
  getSync(threadId: string): FirstSplitRow | null {
    const row = prepared(this.db, `SELECT * FROM ${FIRST_EMAIL_SPLITS_TABLE} WHERE thread_id = ?`)
      .get(threadId) as FirstSplitDbRow | undefined;
    return row ? this.toRow(row) : null;
  }

  /**
   * Write a validated result for `key`, by core's rules, and say what happened.
   *
   *   * {@link shouldReplace} decides whether it may overwrite the stored row —
   *     a failure or a skip never replaces a usable split for the same key
   *     (`kept`);
   *   * a `transient`/`failed` result takes its attempt count and retry time
   *     from {@link nextFailureState} (a second `unparseable` in a row is
   *     stored as `failed`);
   *   * the write replaces the WHOLE row — nothing is merged from the old one.
   *
   * `key` must be the thread's CURRENT key: the caller (the facade's
   * transaction) has already refused a stale one. Not a transaction itself.
   */
  saveSync(key: FirstSplitKey, input: FirstSplitWriteInput, now: number): FirstSplitSaveResult {
    const existing = this.getSync(key.threadId);
    if (!shouldReplace(existing, key, input.status)) return { applied: false, reason: 'kept' };

    let status = input.status;
    let attempts = 0;
    let nextRetryAt: number | null = null;
    if (status === 'transient' || status === 'failed') {
      const failure = nextFailureState(existing, key, {
        status,
        errorKind: input.errorKind as FirstSplitErrorKind | null,
      }, now);
      status = failure.status;
      attempts = failure.attempts;
      nextRetryAt = failure.nextRetryAt;
    }

    prepared(this.db, `
      INSERT INTO ${FIRST_EMAIL_SPLITS_TABLE} (
        thread_id, first_key, first_email_id, source_fingerprint, split_version, status,
        quote_count, parts, error_kind, attempts, next_retry_at, model_used, updated_at
      ) VALUES (
        @threadId, @firstKey, @firstEmailId, @fingerprint, @version, @status,
        @quoteCount, @parts, @errorKind, @attempts, @nextRetryAt, @modelUsed, @now
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        first_key = excluded.first_key,
        first_email_id = excluded.first_email_id,
        source_fingerprint = excluded.source_fingerprint,
        split_version = excluded.split_version,
        status = excluded.status,
        quote_count = excluded.quote_count,
        parts = excluded.parts,
        error_kind = excluded.error_kind,
        attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at,
        model_used = excluded.model_used,
        updated_at = excluded.updated_at
    `).run({
      threadId: key.threadId,
      firstKey: key.firstKey,
      firstEmailId: key.firstEmailId,
      fingerprint: key.fingerprint,
      version: FIRST_SPLIT_VERSION,
      status,
      quoteCount: input.quoteCount,
      parts: input.parts,
      errorKind: input.errorKind,
      attempts,
      nextRetryAt,
      modelUsed: input.modelUsed,
      now,
    });
    return { applied: true, status };
  }

  /** Drop one thread's row (its first email's body was re-healed, say). True when a row went. */
  deleteSync(threadId: string): boolean {
    return prepared(this.db, `DELETE FROM ${FIRST_EMAIL_SPLITS_TABLE} WHERE thread_id = ?`).run(threadId).changes > 0;
  }

  /**
   * Drop every row in this account's database. Returns how many rows went and
   * how many of them were saved splits (`ok`/`partial`) — the bookkeeping rows
   * (`skipped`, `transient`, `failed`) are not splits. The count and the
   * DELETE run in one transaction so a row written between them cannot be
   * removed uncounted.
   */
  clearAll(): FirstSplitClearCounts {
    return this.db.transaction((): FirstSplitClearCounts => {
      const { splits } = this.db.prepare(
        `SELECT COUNT(*) AS splits FROM ${FIRST_EMAIL_SPLITS_TABLE} WHERE status IN ('ok', 'partial')`,
      ).get() as { splits: number };
      const removed = this.db.prepare(`DELETE FROM ${FIRST_EMAIL_SPLITS_TABLE}`).run().changes;
      return { removed, splits };
    })();
  }

  /**
   * Threads the background job should look at, newest first — a coarse,
   * cheap pre-selection the job re-checks precisely (the job reads main's key
   * and the first email itself). Nominated:
   *
   *   * `no-row` — never looked at;
   *   * `version` — computed by another split version;
   *   * `due` — a transient failure whose retry time has come, with attempts
   *     left;
   *   * `first-changed` — the row's first email is gone from the thread, or the
   *     thread's first MEMBER is now another email (an earlier message
   *     arrived).
   *
   * NOT nominated: a current `ok`/`partial`/`skipped`/`failed` row, a
   * transient one still backing off or out of attempts, a thread with no
   * member at all (only drafts: nothing to split, and main's key is null, so
   * the job could never settle it), and threads whose newest message is older
   * than `since`.
   *
   * The SQL is loose: the thread row's `first_message_id` comes from an SQL
   * date order over EVERY row (drafts, Trash copies, undated rows first, ties
   * in any order), and a resync can re-create the first email under a new row
   * id with the same Message-ID. So every pre-selected thread is confirmed
   * against `firstMember` (core's membership predicate) before it counts, and
   * `scanLimit` counts CONFIRMED candidates only — and, with
   * `options.accept`, only those the caller accepts: a rejected thread must
   * not take a slot, or enough of them — they come back every tick — would
   * starve real candidates for good. Rejections are bounded instead, by
   * examining at most `scanLimit × FIRST_SPLIT_SCAN_ROWS_PER_SLOT` threads.
   *
   * Self-heal: when the check finds the row's message unchanged but its row
   * id gone (the resync case), the row's `first_email_id` is pointed at the
   * current first member, so that thread stops re-matching.
   *
   * The evidence (subject, In-Reply-To, References) is the first MEMBER's —
   * not the thread row's `first_message_id`, which can be a draft or a Trash
   * copy.
   */
  listCandidates(
    options: FirstSplitCandidateOptions,
    firstMember: (threadId: string) => FirstSplitFirstMember | null,
  ): FirstSplitCandidate[] {
    const scanLimit = Math.max(0, Math.floor(options.scanLimit));
    if (scanLimit === 0) return [];
    // Read (bounded) before walking: better-sqlite3 cannot run the membership
    // queries or the self-heal write while an iterator holds the connection.
    const rows = this.db.prepare(`
      SELECT t.id AS thread_id,
             t.subject AS thread_subject,
             t.last_message_date AS last_message_date,
             s.thread_id AS row_thread_id,
             s.first_key AS first_key,
             s.first_email_id AS first_email_id,
             s.split_version AS split_version,
             s.status AS status,
             s.attempts AS attempts,
             s.next_retry_at AS next_retry_at
        FROM threads t
        LEFT JOIN ${FIRST_EMAIL_SPLITS_TABLE} s ON s.thread_id = t.id
       WHERE t.last_message_date >= @since
         AND (
           s.thread_id IS NULL
           OR s.split_version IS NOT @version
           OR (s.status = 'transient' AND s.attempts < @maxAttempts
               AND (s.next_retry_at IS NULL OR s.next_retry_at <= @now))
           OR NOT EXISTS (SELECT 1 FROM emails x WHERE x.id = s.first_email_id AND x.thread_id = t.id)
           OR t.first_message_id IS NOT s.first_email_id
         )
       ORDER BY t.last_message_date DESC, t.id
       LIMIT @rowCap
    `).all({
      since: options.since,
      version: options.version,
      maxAttempts: options.maxAttempts,
      now: options.now,
      rowCap: scanLimit * FIRST_SPLIT_SCAN_ROWS_PER_SLOT,
    }) as Array<{
      thread_id: string; thread_subject: string | null; last_message_date: number;
      row_thread_id: string | null; first_key: string | null; first_email_id: string | null;
      split_version: number | null; status: string | null; attempts: number | null;
      next_retry_at: number | null;
    }>;

    const out: FirstSplitCandidate[] = [];
    for (const row of rows) {
      if (out.length >= scanLimit) break;
      const member = firstMember(row.thread_id);
      if (!member) continue; // only drafts: nothing to split
      let reason: FirstSplitCandidateReason;
      if (row.row_thread_id === null) {
        reason = 'no-row';
      } else if (row.split_version !== options.version) {
        reason = 'version';
      } else if (
        row.status === 'transient' && (row.attempts ?? 0) < options.maxAttempts
        && (row.next_retry_at === null || row.next_retry_at <= options.now)
      ) {
        reason = 'due';
      } else if (member.key !== row.first_key) {
        reason = 'first-changed';
      } else {
        // Only the loose "first email moved" test matched, and the first
        // member is still the row's message: not a candidate. Point the row at
        // the member's current row id when a resync re-created it.
        if (member.id !== row.first_email_id) this.repointFirstEmail(row.thread_id, row.first_key, member.id);
        continue;
      }
      const evidence = prepared(
        this.db,
        'SELECT subject, in_reply_to, "references" AS refs FROM emails WHERE id = ?',
      ).get(member.id) as { subject: string | null; in_reply_to: string | null; refs: string | null } | undefined;
      const candidate: FirstSplitCandidate = {
        threadId: row.thread_id,
        subject: evidence?.subject || row.thread_subject || '',
        inReplyTo: evidence?.in_reply_to ?? null,
        references: evidence?.refs ?? null,
        lastMessageDate: row.last_message_date,
        reason,
      };
      if (options.accept && !options.accept(candidate)) continue;
      out.push(candidate);
    }
    return out;
  }

  /**
   * Self-heal for {@link listCandidates}: the row's message is still the
   * thread's first member, under a new row id. Guarded on the key, so a row
   * rewritten meanwhile is left alone. The split itself stays valid — its key
   * is the Message-ID and the stored body's fingerprint, not the row id.
   */
  private repointFirstEmail(threadId: string, firstKey: string | null, firstEmailId: string): void {
    prepared(
      this.db,
      `UPDATE ${FIRST_EMAIL_SPLITS_TABLE} SET first_email_id = ? WHERE thread_id = ? AND first_key IS ?`,
    ).run(firstEmailId, threadId, firstKey);
  }
}
