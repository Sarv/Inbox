// Read-model maintainer — drains the `read_model_dirty` queue (populated by the
// emails triggers) by rebuilding each affected thread's rollup, and doubles as
// the one-time backfill: seeding the queue with every existing thread and
// draining it to empty IS the backfill (see docs/READ_MODEL_PLAN.md).
//
// Everything runs OFF the synchronous write path: work is chunked and yields the
// event loop between chunks (setImmediate) so the UI and IDLE sync interleave.
// The queue's persistence makes it crash-resumable — a dirty row is deleted only
// after its rebuild commits, so an interrupted drain simply resumes from what's
// left.

import { createLogger } from '@sarvinbox/core';
import type Database from 'better-sqlite3';


import { buildRollupContext, rebuildThreads, withImmediateTxn } from './repositories/thread-rollup';

const logger = createLogger('read-model-maintainer');

/** Bump when the rollup DERIVATION logic changes so existing DBs re-derive their
 *  whole read-model on next launch (a full re-seed of the dirty queue). History:
 *  1 = initial · 2 = |deleted| no longer suppresses flag state (parity fix). */
const ROLLUP_VERSION = '2';

/** Threads rebuilt per transaction. Small enough to keep each synchronous chunk
 *  short; the loop yields between chunks. */
const DRAIN_CHUNK = 100;
/** Periodic safety pump — catches rows the triggers add without an explicit
 *  schedule() (e.g. an ad-hoc UPDATE from some code path). unref'd so it never
 *  keeps the process alive. */
const SAFETY_PUMP_MS = 5000;

type DbAccessor = () => Database.Database | null;

export class ReadModelMaintainer {
  private pumping = false;
  private scheduled = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(private getDb: DbAccessor) {}

  /** Begin maintaining: seed the backfill if needed, drain, and install a
   *  periodic safety pump. Non-blocking — the first seed/drain runs on the next
   *  tick so it never stalls DB initialization. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.timer) {
      this.timer = setInterval(() => this.schedule(), SAFETY_PUMP_MS);
      this.timer.unref?.();
    }
    setImmediate(() => {
      if (this.stopped) return;
      this.seedBackfillIfNeeded();
      this.pump();
    });
  }

  /** Stop the periodic pump. The dirty queue persists, so a later start() resumes
   *  exactly where this left off. */
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Schedule an async drain if one isn't already running/queued. Cheap and
   *  order-independent — callers may fire it after a mutation for snappiness, but
   *  correctness never depends on it (the triggers + safety pump guarantee
   *  eventual drain). */
  schedule(): void {
    if (this.scheduled || this.pumping || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.pump(); });
  }

  /** One-time backfill: enqueue every existing thread. The queue's persistence
   *  makes it resumable, so this only needs to run until the queue drains empty
   *  once (status -> 'complete'). No-op after that. */
  private seedBackfillIfNeeded(): void {
    const db = this.getDb();
    if (!db) return;
    try {
      // Re-seed when the derivation version changed (existing rows are stale) OR
      // the first backfill hasn't finished. A bumped ROLLUP_VERSION forces a full
      // re-derive even if a prior run marked status='complete'.
      const upToDate = this.getState(db, 'rollup_version') === ROLLUP_VERSION;
      if (upToDate && this.getState(db, 'status') === 'complete') return;
      withImmediateTxn(db, () => {
        db.prepare('INSERT OR IGNORE INTO read_model_dirty(thread_id) SELECT DISTINCT thread_id FROM emails').run();
        const total = (db.prepare('SELECT COUNT(*) c FROM read_model_dirty').get() as { c: number }).c;
        this.setState(db, 'status', 'running');
        this.setState(db, 'threads_total', String(total));
        this.setState(db, 'rollup_version', ROLLUP_VERSION);
        this.setState(db, 'threads_done', '0');
      });
      logger.info(`Read-model backfill seeded (rollup v${ROLLUP_VERSION})`);
    } catch (error) {
      logger.error('Read-model backfill seed failed:', error);
    }
  }

  /** Drain the queue in chunks, yielding between chunks. Guarded against
   *  concurrent pumps. */
  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    const step = (): void => {
      if (this.stopped) { this.pumping = false; return; }
      let processed = 0;
      try {
        processed = this.drainChunk(DRAIN_CHUNK);
      } catch (error) {
        // A derived-state failure must never wedge the app — log and back off;
        // the rows stay queued and the next pump/safety-tick retries them.
        logger.error('Read-model drain chunk failed:', error);
        this.pumping = false;
        return;
      }
      if (processed > 0) setImmediate(step);   // more to do — yield first
      else this.pumping = false;
    };
    step();
  }

  /**
   * Rebuild up to `limit` dirty threads in ONE immediate transaction, deleting
   * each from the queue only after its rollup commits. Returns rows processed
   * (0 = queue empty). Public so shutdown/tests can drive it directly.
   */
  drainChunk(limit = DRAIN_CHUNK): number {
    const db = this.getDb();
    if (!db) return 0;
    const ids = (db.prepare('SELECT thread_id FROM read_model_dirty LIMIT ?').all(limit) as { thread_id: string }[])
      .map((r) => r.thread_id);
    if (ids.length === 0) {
      this.markCompleteIfRunning(db);
      return 0;
    }
    const ctx = buildRollupContext(db);
    const del = db.prepare('DELETE FROM read_model_dirty WHERE thread_id = ?');
    withImmediateTxn(db, () => {
      rebuildThreads(db, ids, ctx);           // nested savepoint (already in a txn)
      for (const id of ids) del.run(id);
      this.bumpDoneIfRunning(db, ids.length);
    });
    return ids.length;
  }

  /** Seed the backfill and drain the whole queue synchronously. Blocking — for
   *  tests or a caller that explicitly wants the read-model fully built now. */
  backfillNow(): void {
    this.seedBackfillIfNeeded();
    this.flushNow();
  }

  /** Drain the entire queue synchronously. For shutdown / tests. */
  flushNow(): void {
    let guard = 0;
    while (this.drainChunk(DRAIN_CHUNK) > 0 && guard++ < 1_000_000) { /* keep draining */ }
  }

  // --- read_model_state helpers -------------------------------------------

  private getState(db: Database.Database, key: string): string | null {
    const row = db.prepare('SELECT value FROM read_model_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setState(db: Database.Database, key: string, value: string): void {
    db.prepare('INSERT INTO read_model_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  private bumpDoneIfRunning(db: Database.Database, n: number): void {
    if (this.getState(db, 'status') !== 'running') return; // progress is only meaningful during backfill
    const cur = Number(this.getState(db, 'threads_done') ?? '0');
    this.setState(db, 'threads_done', String(cur + n));
  }

  private markCompleteIfRunning(db: Database.Database): void {
    if (this.getState(db, 'status') !== 'running') return;
    this.setState(db, 'status', 'complete');
    this.setState(db, 'updated_at', String(Math.floor(Date.now() / 1000)));
    try { db.exec('ANALYZE'); } catch { /* stats refresh is best-effort */ }
    logger.info('Read-model backfill complete');
  }
}
