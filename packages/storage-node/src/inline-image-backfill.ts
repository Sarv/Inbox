// Inline-image backfill — the background pass that takes the base64 images out
// of the bodies an existing database already holds (migration 74).
//
// The migration only builds the destination. It cannot do the work: on the
// measured mailbox this pass rewrites 8.83 GB of body text, and doing that on
// the startup path would hang the app for minutes behind a splash screen.
//
// ## What one row costs, and why the chunk is measured in BYTES
//
// Per-row cost here spans four orders of magnitude: the smallest body with an
// image is ~1 KB, the largest is 21 MB. A row-counted chunk (`LIMIT 50`) is
// therefore meaningless — the same 50 could be 50 KB or half a gigabyte, and
// the half-gigabyte case holds the transaction, the WAL and the main thread for
// as long as it takes. So the chunk fills to a BYTE budget instead (see
// CHUNK_BYTES for the size and the measurement behind it), and always takes at
// least one row so an oversized body can still make progress. This is the same
// lesson as time-budgeted yielding (see `createLoopYielder`), applied to
// transaction size: budget the thing that actually varies, never the count of
// things. The budget itself is `createByteBudget`, shared with the
// body-relocation pass, which had the row-counted version of this bug.
//
// Yielding between chunks is on a TIME budget for exactly that reason.
//
// ## A keyset walk, not "drain until the cursor is empty"
//
// `idx_email_bodies_image_pending` is a partial index over `email_bodies` where
// `raw_body LIKE '%;base64,%'`, and it is what makes finding work an index seek
// instead of a scan of a multi-gigabyte table. But it is deliberately WIDER than
// what this pass rewrites, and it has to be: SQL cannot express "holds an image
// URI of at least 1 KB", which is the actual relocation rule.
//
// So some rows match the cursor and are legitimately left alone — a body whose
// only inline image is a 43-byte tracking pixel (below `MIN_INLINE_IMAGE_CHARS`,
// see `inline-images.ts`), a `data:application/pdf;base64,` link, a payload too
// short to be an image at all. Those rows stay in the index forever, by design.
//
// Which means "loop until the cursor is empty" would never terminate: the same
// pixel-only body would be selected, found to have nothing to relocate, and
// selected again on the next chunk, forever. So the pass WALKS the cursor
// instead, keyed on `email_id`, and each chunk resumes strictly after the last id
// it saw. That terminates whether or not a row changed, and the partial index
// serves both the range and the ordering.
//
// Crash-resumable with nothing to persist: an interrupted walk restarts from the
// beginning of the cursor, whose already-processed rows have dropped out of it,
// and `relocateBodyImages` is idempotent so a row that was half committed cannot
// be double-stored. Restarting costs a re-read of the rows deliberately left
// behind, which is why they are counted and reported rather than ignored.
//
// ## The search index is not touched, and that is by construction
//
// FTS5 indexes `clean_body`; the trigger that would re-tokenize on a body write
// is guarded by `WHEN new.clean_body IS NOT old.clean_body`. This pass writes
// `raw_body` only, so the guard is false on every row and no re-tokenization
// happens. A pass that touched `clean_body` would re-index the entire mailbox on
// top of everything above.

import { createByteBudget, createLogger, createPacer } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { areBodiesRelocated, rawBodyExpression } from './repositories/body-storage';
import {
  areInlineImagesExtracted,
  inlineImageStats,
  markInlineImagesExtracted,
  relocateBodyImages,
  writeImageLinks,
} from './repositories/inline-image-store';

// No module-level logger: each instance makes its own, named after the account
// database it works on (see the constructor).

/**
 * Body bytes per transaction. One commit is then bounded regardless of which
 * rows it caught, and a crash discards at most this much work.
 *
 * 1 MB, not 8: a chunk cannot yield (it is one transaction), so its whole cost
 * lands on the main thread in one go. Measured at ~90 ms per MB of body rewritten
 * — decode, hash, blob write, body write — which put an 8 MB chunk at ~700 ms of
 * frozen UI, and the event-loop monitor logged exactly that. At 2 MB the monitor
 * still logged 250–500 ms blocks, so this is 1 MB: ~90 ms, one long frame. The
 * chunk size bounds how long a single freeze lasts; DUTY_CYCLE bounds how often
 * one happens. Both are needed — a small chunk repeated back-to-back is still an
 * unusable app.
 */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Share of the main thread this pass may take.
 *
 * At ~90 ms/MB the measured mailbox (8.83 GB of base64) is ~13 minutes of pure
 * CPU. Unpaced, that is 13 minutes of a frozen app, dropped IMAP connections and
 * a beachball — which is what the profile found. At 25% it is closer to an hour
 * of background work nobody notices, and a ~90 ms chunk is followed by ~270 ms of
 * rest, so mail keeps syncing and the UI keeps drawing throughout.
 *
 * The relocation pass uses the same share; the two overlap by design (extraction
 * can only work on rows relocation has already moved), so together they take
 * about half the thread while both are running.
 */
const DUTY_CYCLE = 0.25;

/** How often a long paced pass reports progress. Never per chunk. */
const PROGRESS_LOG_MS = 30_000;

/** Hard row cap per chunk, for the mailbox of 1 KB signature images. */
const CHUNK_ROWS_MAX = 100;

/** Delay before the first chunk, so a launch never competes with this. */
const START_DELAY_MS = 20_000;

/** Re-check cadence when work remains but a chunk made no progress. */
const IDLE_RECHECK_MS = 60_000;

/**
 * A body that still holds base64 image data.
 *
 * Matches `idx_email_bodies_image_pending` TEXTUALLY. A predicate that differs
 * from the index's by even a character loses the partial index and turns every
 * chunk into a scan of a multi-gigabyte table.
 */
const IMAGE_PENDING_SQL = "raw_body LIKE '%;base64,%'";

/**
 * One chunk's worth of candidate ids from the cursor.
 *
 * Exported ONLY so a test can assert what this select list may contain, which is
 * the whole point of the statement: `email_id` and nothing else. The index carries
 * that one column, so the walk stays inside it. The moment anything outside the
 * index is added — `LENGTH(raw_body)` being the tempting one — SQLite fetches each
 * candidate's row and decrypts a multi-megabyte body to answer it, and this pass
 * goes from 0.3% of the main thread to 90% of it. Measured on plain SQLite with
 * 200 KB bodies: 7.11 ms with the length, 0.02 ms without.
 *
 * Do not expect `EXPLAIN QUERY PLAN` to say COVERING INDEX here. SQLite never
 * labels a PARTIAL index covering when the query repeats the partial predicate,
 * yet it still reads no rows — 0.02 ms across 600 MB of bodies proves it. The
 * label is missing by design; the select list is the thing to protect. See the
 * long comment in {@link InlineImageBackfill.runChunk}.
 */
export const IMAGE_CANDIDATES_SQL = `SELECT email_id FROM email_bodies
          WHERE ${IMAGE_PENDING_SQL} AND email_id > ?
          ORDER BY email_id LIMIT ?`;

type DbAccessor = () => Database.Database | null;

export class InlineImageBackfill {
  private running = false;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `label` names the account database in every line this pass logs. Without it
   * a multi-account install produces several interleaved copies of the same
   * message with nothing to tell them apart — which is exactly the state that
   * made a false "a writer bypassed rawBodyForStorage" hard to attribute.
   */
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(
    private getDb: DbAccessor,
    label?: string,
  ) {
    this.logger = createLogger(label ? `inline-image-backfill:${label}` : 'inline-image-backfill');
  }

  /**
   * Begin extracting, after a delay. Idempotent, and near-free on a database
   * with nothing to do — the pending check is a seek of an empty partial index,
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

  /** Stop. Progress is in the data, so a later start() just resumes. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Walk the cursor once, pacing between chunks.
   *
   * There is deliberately NO early return on the completion flag. Every writer
   * of a body is supposed to relocate its images (the repository, the drafts
   * mirror, the sent mirror), but "supposed to" is exactly the invariant a
   * future write path will break, and the breakage is silent — a body that keeps
   * its base64 simply makes the database grow again, with nothing to notice it.
   * Walking the cursor once per launch makes that class of bug self-correcting.
   *
   * On a healthy database the walk visits only the rows deliberately left behind
   * (pixel-only bodies — see the header), which are small by definition, and it
   * changes none of them. A row that DOES change on a DB already marked complete
   * is the signal worth logging — not the cursor being non-empty, which is the
   * normal steady state and would otherwise cry wolf on every launch forever.
   * Whether that signal means a BROKEN writer depends on the relocation pass
   * still running; see the two-cause comment at the bottom of this method.
   */
  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    const db = this.getDb();
    if (!db) return;

    this.running = true;
    const startedAt = Date.now();
    const alreadyComplete = areInlineImagesExtracted(db);
    let visited = 0;
    let changed = 0;
    let savedChars = 0;
    // A pacer, NOT a yielder. A yielder hands the thread back for one turn and
    // this loop takes it straight back, which a CPU profile measured as 79% of
    // wall clock in JS on the main thread — the app beachballed for the whole
    // migration even after the wasteful query was gone. See DUTY_CYCLE.
    const pace = createPacer({ dutyCycle: DUTY_CYCLE });

    try {
      const pending = this.countPending(db);
      if (pending === 0) {
        // Nothing even to walk. Only log on the transition, so the common case (a
        // fresh install, or any launch after this finished) is silent.
        if (!alreadyComplete) this.finish(db, 0, 0, 0, startedAt);
        return;
      }
      if (!alreadyComplete) {
        this.logger.info(`Inline-image extraction starting: ${pending} candidate body/bodies`);
      }

      // Strictly ascending, so the walk terminates whether or not a row changed.
      let after = '';
      let lastProgressAt = startedAt;
      for (;;) {
        if (this.stopped) return;
        const chunk = this.runChunk(db, CHUNK_BYTES, after);
        if (chunk.visited === 0) break;
        visited += chunk.visited;
        changed += chunk.changed;
        savedChars += chunk.savedChars;
        after = chunk.lastId;

        // Rest BEFORE the next chunk, in proportion to what this one cost.
        await pace.rest();

        // A paced pass over a big mailbox runs for tens of minutes. Silence for
        // that long is indistinguishable from a wedged pass, so say something
        // occasionally — on a timer, never per chunk (that would be thousands of
        // lines, and each logger.debug write is a synchronous main-thread cost).
        if (Date.now() - lastProgressAt >= PROGRESS_LOG_MS) {
          lastProgressAt = Date.now();
          this.logger.info(
            `Inline-image extraction: ${visited}/${pending} visited, ${changed} rewritten, ` +
              `${Math.round(savedChars / 1024 / 1024)} MB saved so far`,
          );
        }
      }

      if (alreadyComplete) {
        if (changed > 0) {
          // There are two ways base64 shows up on a DB this pass already
          // finished, and only one of them is a bug.
          //
          // The innocent one is the body-relocation pass (Phase 2) still
          // running: it moves bodies out of `emails` into `email_bodies` with
          // plain SQL — `INSERT INTO email_bodies SELECT clean_body, raw_body
          // FROM emails` — which by design does not pass through
          // rawBodyForStorage. Every row it feeds in arrives with its base64
          // intact, so this pass legitimately finds work again. That is
          // relocation and extraction interleaving on a big mailbox, and it
          // resolves itself; warning about it cried wolf on 112 bodies.
          //
          // The real bug is base64 appearing once relocation is DONE, because
          // then the only writers left are the ingest paths, all of which are
          // supposed to go through rawBodyForStorage.
          const message =
            `Inline-image extraction: extracted ${changed} body/bodies on a DB already ` +
            'marked complete';
          if (areBodiesRelocated(db)) {
            this.logger.warn(`${message} — a writer bypassed rawBodyForStorage`);
          } else {
            this.logger.info(`${message} — body relocation is still feeding rows in (expected)`);
          }
        }
      } else {
        this.finish(db, visited, changed, savedChars, startedAt);
      }
    } catch (error) {
      // Never wedge the app over a storage upgrade. Un-extracted bodies still
      // render — they are exactly what shipped before this change.
      this.logger.error('Inline-image extraction failed:', error);
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
   * Process one byte-budgeted chunk of the walk, in a single transaction.
   *
   * `afterId` resumes strictly after the last id the previous chunk saw — pass
   * `''` to start. Returns how many rows were VISITED (0 = the walk is over),
   * how many actually changed, the characters removed, and the id to resume
   * after. Public so tests and {@link backfillNow} can drive it synchronously.
   */
  runChunk(
    db: Database.Database,
    byteBudget = CHUNK_BYTES,
    afterId = '',
  ): { visited: number; changed: number; savedChars: number; lastId: string } {
    // IDS ONLY. Not `LENGTH(raw_body)` beside them, and this is the single most
    // important line in the file.
    //
    // The obvious version selects the length too, so the byte budget can be
    // filled from real sizes instead of an assumed average. It is a disaster,
    // and a V8 CPU profile of the running app named it: 90% of all main-thread
    // time, 21.7 seconds out of 30, inside this one statement — against 0.3% for
    // the transaction that does the actual work.
    //
    // The reason is that the partial index covers `email_id` and nothing else. A
    // `LENGTH(raw_body)` in the select list therefore cannot be answered from the
    // index: SQLite has to fetch each candidate's row and read the body in full,
    // decrypting every overflow page through SQLCipher on the way. These rows are
    // precisely the big ones — the mailbox scan found 87% of all body bytes in
    // 13.5% of rows, averaging ~2.4 MB each — so measuring 100 candidates reads
    // and decrypts ~240 MB to authorize 2 MB of work. A 120x read amplification
    // to answer a question the work itself answers for free.
    //
    // So the sizes come from the bodies as they are read inside the transaction
    // below, which was going to read them anyway. Selecting `email_id` alone
    // makes this an index-only scan that never touches the table.
    //
    // The LIKE is repeated verbatim from IMAGE_PENDING_SQL so SQLite can match it
    // against the partial index's predicate; with `email_id` as the index key,
    // the same index serves the range and the ORDER BY.
    const candidates = (
      db.prepare(IMAGE_CANDIDATES_SQL).all(afterId, CHUNK_ROWS_MAX) as Array<{ email_id: string }>
    ).map((row) => row.email_id);
    if (candidates.length === 0) {
      return { visited: 0, changed: 0, savedChars: 0, lastId: afterId };
    }

    // Spent from the body once it is in hand, then checked at the end of the
    // iteration — so the first row is always processed however large it is, and a
    // 21 MB body makes progress instead of parking in the cursor and stalling the
    // pass behind it. Same rule and same helper as the body-relocation pass.
    const budget = createByteBudget(byteBudget);

    const readBody = db.prepare('SELECT raw_body FROM email_bodies WHERE email_id = ?');
    // `raw_body` only. Writing `clean_body` too would trip the FTS update
    // trigger's guard and re-tokenize every body in the mailbox for nothing —
    // `clean_body` is plain text and has never held an image.
    const writeBody = db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?');
    // The length column has to follow the body it describes. Left stale, it
    // reports the pre-extraction size, and every size-based read — the AI
    // eligibility test, the search size filter, the storage report — is then
    // answering from a number about bytes that are no longer there. Computed in
    // SQL through the shared expression so it cannot disagree with what the
    // repository's own writes produce (see body-metrics.ts).
    const settleLength = db.prepare(
      `UPDATE emails SET raw_body_len = LENGTH(TRIM(${rawBodyExpression('emails')})) WHERE id = ?`,
    );

    let savedChars = 0;
    let changed = 0;
    // The walk must resume after the last row VISITED, not the last row changed:
    // the rows deliberately left alone (pixel-only bodies — see the header) stay
    // in the cursor forever, so resuming from the last change would select them
    // again on every chunk and the pass would never terminate.
    let lastId = afterId;
    const relocateAll = db.transaction((ids: string[]) => {
      for (const id of ids) {
        const row = readBody.get(id) as { raw_body: string | null } | undefined;
        lastId = id;
        if (!row || typeof row.raw_body !== 'string') {
          // Gone or empty between the select and here. Still counts as visited,
          // still costs nothing.
          budget.spend(0);
          continue;
        }
        // The read is the expensive half of the row, and it has just happened, so
        // this is where the cost is known and where it gets charged.
        budget.spend(row.raw_body.length);
        const result = relocateBodyImages(db, row.raw_body);
        // Unchanged bodies are written back NOT AT ALL — the walk has already
        // moved past them, and a no-op UPDATE would still rewrite the record,
        // grow the WAL and (on a healthy DB re-walked at every launch) rewrite
        // the same rows forever. This is the pixel-only case from the header.
        if (result.html !== row.raw_body) {
          writeBody.run(result.html, id);
          writeImageLinks(db, id, result.hashes);
          settleLength.run(id);
          savedChars += result.savedChars;
          changed += 1;
        }
        if (budget.isExhausted()) break;
      }
    });
    relocateAll(candidates);
    return { visited: budget.items, changed, savedChars, lastId };
  }

  /** Bodies still holding base64. An index seek, not a table scan. */
  private countPending(db: Database.Database): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM email_bodies WHERE ${IMAGE_PENDING_SQL}`)
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private finish(
    db: Database.Database,
    visited: number,
    changed: number,
    savedChars: number,
    startedAt: number,
  ): void {
    markInlineImagesExtracted(db);
    // The partial index has done its job and is now permanently empty, but it is
    // NOT dropped: it is what makes the self-repair check above an index seek,
    // and it is how a body written by a future path that skips extraction gets
    // noticed at all.
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const stats = inlineImageStats(db);
    // `visited` and `changed` differ by the bodies the cursor matches but the
    // rule deliberately leaves alone (tracking pixels, non-image data: URIs).
    // Logging both is what tells the next reader that a permanently non-empty
    // cursor is by design, not a stalled pass.
    this.logger.info(
      `Inline-image extraction complete: ${changed} of ${visited} body/bodies in ${seconds}s, ` +
        `${Math.round(savedChars / 1024 / 1024)} MB of base64 removed; ` +
        `${stats.images} distinct image(s) holding ${Math.round(stats.bytes / 1024 / 1024)} MB ` +
        `across ${stats.links} reference(s)`,
    );
    // Note what this does NOT do: reclaim the file. Freed pages go on SQLite's
    // freelist and are reused by later writes, so an extracted database stops
    // growing and absorbs new mail into the space it already owns — but the file
    // on disk keeps its current size.
    //
    // Shrinking it needs a VACUUM, and `SQLiteStorage.vacuum()` is a synchronous
    // `exec` on the main thread: on a 10 GB file that is minutes of a frozen app,
    // dropped IMAP connections and a beachball. So it is deliberately NOT wired
    // to a button yet. Doing that properly needs the VACUUM off the main thread
    // (a utility process opening the file while the app's own connection is
    // closed), a free-disk check first — it transiently needs about as much space
    // again — and sync quiesced for the duration. Until then the growth is
    // stopped, which is the part that mattered.
  }

  /**
   * Drain synchronously to completion. For tests, and for a caller that wants
   * the pass finished now; blocking, so never call it on the startup path.
   */
  backfillNow(): { visited: number; changed: number; savedChars: number } {
    const db = this.getDb();
    if (!db) return { visited: 0, changed: 0, savedChars: 0 };
    const startedAt = Date.now();
    const alreadyComplete = areInlineImagesExtracted(db);
    let visited = 0;
    let changed = 0;
    let savedChars = 0;
    let after = '';
    let guard = 0;
    for (;;) {
      const chunk = this.runChunk(db, CHUNK_BYTES, after);
      if (chunk.visited === 0 || guard++ > 1_000_000) break;
      visited += chunk.visited;
      changed += chunk.changed;
      savedChars += chunk.savedChars;
      after = chunk.lastId;
    }
    if (!alreadyComplete) this.finish(db, visited, changed, savedChars, startedAt);
    return { visited, changed, savedChars };
  }
}
