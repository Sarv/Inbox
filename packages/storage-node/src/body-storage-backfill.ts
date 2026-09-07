// Body-storage backfill — the one background pass that brings an existing
// database up to the current body layout: it moves each row's body out to
// `email_bodies` (migration 73) AND stamps `clean_body_len`/`raw_body_len`
// (migration 72), per row, in a single record rewrite.
//
// ONE pass for both on purpose. SQLite stores a row as one record and rewrites
// the whole record on any UPDATE, so at the live mailbox's ~330 KB average body
// a single scalar UPDATE costs ~47 KB of WAL once SQLCipher has encrypted and
// HMAC'd it — measured 2026-08-27. A 26k-row mailbox is therefore on the order
// of a gigabyte of WAL PER SWEEP. Running the length stamp and the relocation as
// two passes would pay that twice for no benefit, since a row being moved has
// its body in hand anyway and can compute its own lengths on the way past.
//
// That cost is paid once and buys: every pipeline query answering has-body from
// an index, and every subsequent status flip rewriting a header-sized record
// instead of a third of a megabyte. It absolutely cannot run on the startup
// path, which is why both migrations leave the work undone and this runs
// afterwards.
//
// Design mirrors ReadModelMaintainer: chunked, paced between chunks, and
// crash-resumable with no cursor to persist — the rows that still need work ARE
// the cursor, and two partial indexes (`idx_emails_body_inline_pending`,
// `idx_emails_body_len_pending`) make selecting them index seeks rather than
// scans of a multi-GB table. Both drain to empty as work completes, so steady
// state costs nothing.
//
// The two cursors are drained in sequence rather than OR'd into one query: an OR
// across two partial indexes is not something SQLite can serve from either of
// them, and it would put a full table scan on the one code path that must never
// have one. Relocation runs first because it also stamps the lengths, so a row
// needing both is rewritten once, by that pass.
//
// Both bounds are budgeted, and NEITHER is a row count. Per-row cost here varies
// by three orders of magnitude (a 200-byte notification vs a 2 MB newsletter with
// inline images), so a count bounds nothing:
//
//   * BETWEEN chunks, a DUTY CYCLE (see DUTY_CYCLE) — rest in proportion to the
//     chunk just committed. This was a time-budgeted yielder, which bounds how
//     long one freeze lasts but not how much of the clock the pass owns; a
//     profile measured the sibling pass keeping 79% of it.
//   * WITHIN a chunk, a BYTE budget (see CHUNK_BYTES). A chunk is one
//     transaction and runs to completion, so nothing outside it can bound it;
//     this was a row count until the event-loop monitor caught it freezing the UI
//     for 851 ms per commit.

import { createByteBudget, createLogger, createPacer } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { areBodyLengthsReady, markBodyLengthsReady } from './repositories/body-metrics';
import {
  areBodiesRelocated,
  cleanBodyExpression,
  markBodiesRelocated,
  rawBodyExpression,
} from './repositories/body-storage';

// No module-level logger: each instance makes its own, named after the account
// database it works on (see the constructor).

/**
 * Body bytes per transaction.
 *
 * This used to be `CHUNK_ROWS = 50`, on the reasoning that "the time budget
 * between chunks is what actually bounds responsiveness". That reasoning is
 * wrong, and the log said so: a chunk is ONE transaction and runs to completion,
 * so a time budget between chunks cannot bound it. At 50 rows and a measured
 * mean body of ~356 KB, each transaction moved ~18 MB and the event-loop monitor
 * logged the freeze —
 *
 *   [16:05:04] WARN [EventLoop] main process blocked for 851ms
 *
 * — 524 times over the 193 s the pass took. Budgeting the bytes instead bounds
 * the transaction on the thing that actually varies: measured at ~21 ms per MB
 * moved, 4 MB is ~85 ms of main thread, a hitch rather than a beachball. The
 * pass takes more commits and longer wall-clock, which is the right trade for
 * work nobody is waiting on.
 *
 * See `createByteBudget` for why the first row of a chunk is always admitted.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Hard ceiling on rows per transaction, whatever the budget says.
 *
 * The byte budget is the real bound; this only keeps a chunk of tiny rows (a
 * mailbox of 200-byte notifications, or the LENGTHS cursor, whose rows mostly
 * have no body at all and would never fill 4 MB) from becoming one enormous
 * transaction of statements instead of one enormous transaction of bytes.
 */
const CHUNK_ROWS_MAX = 200;

/**
 * Share of the wall clock this pass may spend on the main thread.
 *
 * The byte budget above bounds how long ONE freeze lasts; it does nothing about
 * how often one happens. A CPU profile of the running app measured the sibling
 * inline-image pass holding 79% of wall-clock in JS with a yielder in this exact
 * position: `setImmediate` hands the thread back for one turn and the loop takes
 * it straight back, so IMAP reads, IPC replies and the renderer never get a look
 * in and the app beachballs for the whole migration. Resting in proportion to
 * each committed chunk bounds the SHARE — see `createPacer`.
 *
 * At the measured ~21 ms per MB moved, 25% turns a ~4-minute relocation of a
 * 10 GB mailbox into ~16 minutes of work nobody is waiting on. That is the right
 * trade: a fast migration that makes the app unusable is worse than a slow one
 * nobody notices.
 */
const DUTY_CYCLE = 0.25;

/** Progress cadence. NEVER per chunk — there are thousands of them, and
 *  `logger.debug` is not level-gated, so a per-chunk line is itself a stall. */
const PROGRESS_LOG_MS = 30_000;

/** Delay before the first chunk, so a launch is never competing with this. */
const START_DELAY_MS = 15_000;

/** Re-check cadence while work remains but a chunk found nothing (see pump). */
const IDLE_RECHECK_MS = 60_000;

/** A row still holds a body inline that is worth moving. Matches the partial
 *  index `idx_emails_body_inline_pending` TEXTUALLY — a predicate that differs
 *  by so much as a `<>` vs `!=` loses the index and scans the table. */
const INLINE_PENDING_SQL =
  "(clean_body IS NOT NULL AND clean_body <> '') OR (raw_body IS NOT NULL AND raw_body <> '')";

/** A row's length columns have never been computed. Matches
 *  `idx_emails_body_len_pending`. */
const LENGTHS_PENDING_SQL = 'clean_body_len IS NULL';

type DbAccessor = () => Database.Database | null;

/** What one sweep still has left to do, per cursor. */
interface Remaining {
  inline: number;
  lengths: number;
}

export class BodyStorageBackfill {
  private running = false;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `label` names the account DB in every line — see InlineImageBackfill. */
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private getDb: DbAccessor,
    label?: string,
  ) {
    this.logger = createLogger(label ? `body-storage-backfill:${label}` : 'body-storage-backfill');
  }

  /**
   * Begin backfilling, after a delay. Idempotent, and a no-op on a database that
   * is already complete (every fresh install, and every upgraded one after the
   * first successful drain) — that check is two seeks of empty partial indexes,
   * so calling this on every launch costs nothing.
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, START_DELAY_MS);
    this.timer.unref?.();
  }

  /** Stop. Progress is in the data, so a later start() resumes from where this
   *  left off with nothing to reconcile. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drain both cursors to empty, pacing between chunks.
   *
   * A chunk that returns 0 while the DB is not yet marked complete means every
   * remaining row failed (a body that cannot be read at all). Rather than spin,
   * it re-checks on a slow timer — those rows are harmless, they just keep the
   * body-reading expressions in use.
   */
  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    const db = this.getDb();
    if (!db) return;

    // Note there is NO early return on the completion flags. Every writer of a
    // body is supposed to write it to the side table and stamp its lengths (the
    // repository, the drafts mirror, the sent-copy mirror), but "supposed to" is
    // exactly the invariant that a future insert path will break, and either
    // stray state is silent: a NULL length on a DB marked ready is read as
    // body-less, so that mail drops out of AI categorization, and a stray inline
    // body is a row paying full write amplification again. On a healthy DB the
    // checks below are seeks of EMPTY partial indexes, so paying them every
    // launch costs nothing and makes that class of bug self-correcting.
    this.running = true;
    const startedAt = Date.now();
    let total = 0;
    const pace = createPacer({ dutyCycle: DUTY_CYCLE });

    try {
      const before = this.countRemaining(db);
      if (before.inline === 0 && before.lengths === 0) {
        // Already complete. Only log/ANALYZE on the transition, so the common
        // case (a fresh DB, or a launch after the backfill finished) is silent.
        if (!this.isComplete(db)) this.finish(db, 0, startedAt);
        return;
      }
      if (this.isComplete(db)) {
        this.logger.warn(
          `Body-storage backfill: ${before.inline} inline body row(s) and ${before.lengths} ` +
            'unmeasured row(s) on a DB already marked complete — a writer bypassed ' +
            'the repository; repairing',
        );
      } else {
        this.logger.info(
          `Body-storage backfill starting: ${before.inline} bodies to move, ` +
            `${before.lengths} rows to measure`,
        );
      }

      // Relocation first: it stamps the lengths too, so a row needing both is
      // rewritten once rather than twice.
      const totalPending = before.inline + before.lengths;
      let lastProgressAt = startedAt;
      for (const pending of [INLINE_PENDING_SQL, LENGTHS_PENDING_SQL]) {
        for (;;) {
          if (this.stopped) return;
          const done = this.runChunk(db, CHUNK_BYTES, pending);
          if (done === 0) break;
          total += done;
          // Rest in proportion to the chunk just committed — see DUTY_CYCLE. A
          // yielder here handed the thread back for one turn and this loop took
          // it straight back, which kept the app frozen for the whole pass.
          await pace.rest();
          if (Date.now() - lastProgressAt >= PROGRESS_LOG_MS) {
            lastProgressAt = Date.now();
            this.logger.info(`Body-storage backfill: ${total}/${totalPending} row(s) processed`);
          }
        }
      }

      const after = this.countRemaining(db);
      if (after.inline === 0 && after.lengths === 0) {
        this.finish(db, total, startedAt);
      } else {
        // Rows we could not process. Leave the flags off (the body-reading
        // expressions stay correct) and look again later.
        this.logger.warn(
          `Body-storage backfill stalled with ${after.inline} inline / ${after.lengths} ` +
            `unmeasured row(s) after ${total} processed; will retry`,
        );
        this.scheduleRecheck();
      }
    } catch (error) {
      // Never wedge the app over a storage-layout upgrade: the rows stay as they
      // are, every query keeps reading the body through the COALESCE, and the
      // next tick retries.
      this.logger.error('Body-storage backfill failed:', error);
      this.scheduleRecheck();
    } finally {
      this.running = false;
    }
  }

  private scheduleRecheck(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, IDLE_RECHECK_MS);
    this.timer.unref?.();
  }

  /**
   * Process one chunk of rows in a single transaction. Returns rows written
   * (0 = nothing left for this cursor).
   *
   * `pending` is the WHERE fragment naming the cursor — see the two constants.
   * Public so tests and a shutdown flush can drive it synchronously.
   */
  runChunk(
    db: Database.Database,
    byteBudget = CHUNK_BYTES,
    pending = INLINE_PENDING_SQL,
  ): number {
    // Ids only, and deliberately no `LENGTH(clean_body)` beside them: the length
    // of a TEXT column is not free, SQLite has to read the value to count it, and
    // reading 200 candidate bodies to then move 12 of them would cost more than
    // the move. So the sizes are learned from the write itself, below.
    const ids = (
      db
        .prepare(`SELECT id FROM emails WHERE ${pending} LIMIT ?`)
        .all(CHUNK_ROWS_MAX) as Array<{ id: string }>
    ).map((row) => row.id);
    if (ids.length === 0) return 0;

    // Copy the body across. `DO NOTHING`, never `DO UPDATE`: if a side row
    // already exists it is the authoritative copy (every writer writes it first
    // and empties the inline column in the same transaction), so overwriting it
    // from a leftover inline value would replace a current body with a stale one.
    //
    // The guard repeats the cursor predicate rather than trusting the caller's:
    // this statement also runs for the LENGTHS cursor, whose rows mostly have no
    // body at all, and a side row holding two empty strings is pure overhead —
    // one row per email in the mailbox, achieving nothing.
    const copyBody = db.prepare(`
      INSERT INTO email_bodies (email_id, clean_body, raw_body)
      SELECT id, clean_body, raw_body FROM emails
      WHERE id = ? AND (${INLINE_PENDING_SQL})
      ON CONFLICT(email_id) DO NOTHING
    `);

    // Then empty the inline columns and stamp the lengths, in ONE statement so
    // the row's record is rewritten once.
    //
    // The lengths read the EFFECTIVE body (through `email_bodies`), not the inline
    // column, so a row whose side copy already existed is measured from the copy
    // that readers will actually see rather than from a leftover inline value.
    // SQLite evaluates every SET expression against the pre-UPDATE row, so the
    // `clean_body = ''` in the same statement cannot zero the length beside it.
    //
    // LENGTH(TRIM(...)) computed in SQL, matching what the columns replace
    // exactly — see body-metrics.ts on why deriving this in JS would drift.
    // `RETURNING` is what makes the byte budget free. The lengths this statement
    // stamps ARE the size of the body it just moved, so the chunk learns what a
    // row cost from the write itself — no second read of the body, and no
    // `LENGTH()` pass over candidates that may not even be taken. (Character
    // count, not octets; close enough for a budget, and it is the same number
    // every size-based read in the app already uses.)
    const settle = db.prepare(`
      UPDATE emails SET
        clean_body = '',
        raw_body = '',
        clean_body_len = LENGTH(TRIM(${cleanBodyExpression('emails')})),
        raw_body_len = LENGTH(TRIM(${rawBodyExpression('emails')}))
      WHERE id = ?
      RETURNING COALESCE(clean_body_len, 0) + COALESCE(raw_body_len, 0) AS moved
    `);

    const budget = createByteBudget(byteBudget);
    const writeAll = db.transaction((rowIds: string[]) => {
      for (const id of rowIds) {
        // Body row before header row: the FTS trigger on `emails` re-indexes a
        // changed `clean_body` only while no side row exists, so emptying the
        // inline column first would re-tokenize the email with an EMPTY body and
        // leave the correction to the body trigger — two full tokenizations of
        // every body in the mailbox, on top of the move itself.
        copyBody.run(id);
        const settled = settle.get(id) as { moved: number } | undefined;
        // Spend AFTER the row, then stop: a body larger than the whole budget
        // still gets moved rather than parking at the head of the cursor forever.
        budget.spend(settled?.moved ?? 0);
        if (budget.isExhausted()) break;
      }
      return budget.items;
    });
    return writeAll(ids);
  }

  /** Rows still awaiting each kind of work. Index seeks, not table scans. */
  private countRemaining(db: Database.Database): Remaining {
    const count = (pending: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE ${pending}`).get() as
        | { n: number }
        | undefined;
      return row?.n ?? 0;
    };
    return { inline: count(INLINE_PENDING_SQL), lengths: count(LENGTHS_PENDING_SQL) };
  }

  /** Both completion flags set. */
  private isComplete(db: Database.Database): boolean {
    return areBodyLengthsReady(db) && areBodiesRelocated(db);
  }

  private finish(db: Database.Database, processed: number, startedAt: number): void {
    markBodyLengthsReady(db);
    markBodiesRelocated(db);
    // Refresh the planner's stats so it actually picks the new covering indexes
    // — without them SQLite can prefer a full table scan over an index it has no
    // size estimate for, which would leave the whole change unrealised.
    try {
      db.exec('ANALYZE');
    } catch {
      /* stats refresh is best-effort */
    }
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    this.logger.info(
      `Body-storage backfill complete: ${processed} rows processed in ${seconds}s — ` +
        'bodies live in email_bodies and has-body answers from an index',
    );
  }

  /**
   * Drain synchronously to completion. For tests and for a caller that wants the
   * move finished now; blocking, so never call it on the startup path.
   */
  backfillNow(): void {
    const db = this.getDb();
    if (!db) return;
    const startedAt = Date.now();
    let total = 0;
    let guard = 0;
    for (const pending of [INLINE_PENDING_SQL, LENGTHS_PENDING_SQL]) {
      for (;;) {
        const done = this.runChunk(db, CHUNK_BYTES, pending);
        if (done === 0 || guard++ > 1_000_000) break;
        total += done;
      }
    }
    const after = this.countRemaining(db);
    if (after.inline === 0 && after.lengths === 0 && (total > 0 || !this.isComplete(db))) {
      this.finish(db, total, startedAt);
    }
  }
}
