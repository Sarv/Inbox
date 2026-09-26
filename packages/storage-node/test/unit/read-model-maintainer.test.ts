import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadModelMaintainer } from '../../src/read-model-maintainer';
import { insertReadModelEmail, openReadModelTestDb } from '../../src/test-support/read-model-test-db';

// A DB with the read-model tables + the emails dirty triggers (the same DDL the
// v64/v65 migrations install), so we exercise trigger -> queue -> drain end to
// end. The fixture is shared with the folder-badge suite so the two can never
// test different schemas.
const newDb = (): Database.Database => openReadModelTestDb();
const insertEmail = insertReadModelEmail;

const dirtyCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) c FROM read_model_dirty').get() as any).c;
const tfCount = (db: Database.Database) => (db.prepare('SELECT COUNT(*) c FROM thread_folders').get() as any).c;
const state = (db: Database.Database, k: string) => (db.prepare('SELECT value v FROM read_model_state WHERE key=?').get(k) as any)?.v ?? null;

// start() and schedule() drain on later ticks: every step is a setImmediate, and
// a step that did work queues the next one. A fixed sleep bets those steps beat
// its timer; under load they lose, stop() cancels them, and the hook reads as
// "never ran". So the async tests fake ONLY setImmediate and run every deferred
// step to completion with vi.runAllTimers(). setInterval stays real: faked, the
// 5s safety pump re-arms forever and runAllTimers() aborts at its loop limit.
const fakeDeferredSteps = () => vi.useFakeTimers({ toFake: ['setImmediate', 'clearImmediate'] });
afterEach(() => { vi.useRealTimers(); });

describe('ReadModelMaintainer', () => {
  let db: Database.Database;
  let m: ReadModelMaintainer;
  beforeEach(() => { db = newDb(); m = new ReadModelMaintainer(() => db); });

  it('triggers enqueue changed threads on insert', () => {
    insertEmail(db, 't1', 'INBOX');
    insertEmail(db, 't1', 'INBOX|read');
    insertEmail(db, 't2', 'INBOX');
    expect(dirtyCount(db)).toBe(2); // deduped to two distinct threads
  });

  it('drains the queue into thread_folders and clears it', () => {
    insertEmail(db, 't1', 'INBOX|important');
    insertEmail(db, 't2', 'INBOX|read');
    const done = m.drainChunk();
    expect(done).toBe(2);
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(2);
    const t1 = db.prepare('SELECT * FROM threads WHERE id=?').get('t1') as any;
    expect(t1.has_important_unread).toBe(1);
  });

  it('backfillNow seeds all threads and marks status complete', () => {
    insertEmail(db, 't1', 'INBOX');
    insertEmail(db, 't2', 'INBOX|reminders');
    db.prepare('DELETE FROM read_model_dirty').run(); // simulate a pre-trigger existing DB
    expect(dirtyCount(db)).toBe(0);

    m.backfillNow();
    expect(state(db, 'status')).toBe('complete');
    expect(state(db, 'threads_total')).toBe('2');
    expect(tfCount(db)).toBe(2);
    expect((db.prepare('SELECT COUNT(*) c FROM thread_categories').get() as any).c).toBe(1); // t2/reminders
  });

  it('is resumable — a partial drain leaves the rest queued, a later drain finishes', () => {
    for (let i = 0; i < 5; i++) insertEmail(db, `t${i}`, 'INBOX');
    m.backfillNow();               // seed sets status=running/total, then drains all
    expect(state(db, 'status')).toBe('complete');
    expect(Number(state(db, 'threads_done'))).toBe(5);
  });

  it('keeps the read-model current on tag change and delete after backfill', () => {
    insertEmail(db, 't1', 'INBOX', { id: 'x1' });
    m.backfillNow();
    expect((db.prepare('SELECT has_unread FROM thread_folders WHERE thread_id=?').get('t1') as any).has_unread).toBe(1);

    // Tag change via ad-hoc UPDATE (a path that does NOT go through repo methods) —
    // the trigger still captures it.
    db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run('|INBOX|read|', 'x1');
    expect(dirtyCount(db)).toBe(1);
    m.flushNow();
    expect((db.prepare('SELECT has_unread FROM thread_folders WHERE thread_id=?').get('t1') as any).has_unread).toBe(0);

    // Delete the last email -> thread's read-model rows are cleared.
    db.prepare('DELETE FROM emails WHERE id = ?').run('x1');
    m.flushNow();
    expect(tfCount(db)).toBe(0);
  });

  it('flips has_category off when a category is undefined and the thread re-dirtied', () => {
    insertEmail(db, 't1', 'INBOX|reminders|read', { id: 'c1' });
    m.backfillNow();
    expect((db.prepare('SELECT has_category FROM threads WHERE id=?').get('t1') as any).has_category).toBe(1);

    // Category deleted from definitions (the |reminders| tag is left stale on the
    // email) + the affected thread re-enqueued — what dirtyThreadsForCategorySlug does.
    db.prepare("DELETE FROM ai_category_definitions WHERE slug='reminders'").run();
    db.prepare("INSERT OR IGNORE INTO read_model_dirty(thread_id) SELECT DISTINCT thread_id FROM emails WHERE instr(tags,'|reminders|')>0").run();
    m.flushNow();

    expect((db.prepare('SELECT has_category FROM threads WHERE id=?').get('t1') as any).has_category).toBe(0);
    expect((db.prepare('SELECT has_category FROM thread_folders WHERE thread_id=?').get('t1') as any).has_category).toBe(0);
  });

  // --- chunk pacing ------------------------------------------------------
  //
  // The drain's stall bound used to be a ROW COUNT (100 threads per synchronous
  // transaction), which bounds nothing: a chunk's cost is the sum of its threads'
  // costs and those differ by orders of magnitude. These pin the time budget that
  // replaced it — if they fail, one chunk can hold the main thread for as long as
  // its heaviest 100 threads take, and the UI freezes for exactly that long.

  it('stops a chunk once the time budget is spent and leaves the rest queued', () => {
    for (let i = 0; i < 12; i++) insertEmail(db, `tb${i}`, 'INBOX');
    expect(dirtyCount(db)).toBe(12);

    // A zero budget: the deadline is already past when the first thread finishes,
    // so exactly one thread is rebuilt and the other eleven stay queued.
    const processed = m.drainChunk(100, 0);
    expect(processed).toBe(1);
    expect(dirtyCount(db)).toBe(11);
    expect(tfCount(db)).toBe(1);
  });

  it('makes progress on every chunk even with a zero budget (no livelock)', () => {
    // The deadline is checked AFTER a thread is written, never before. Checking it
    // first would make a zero/elapsed budget return 0 forever: pump() reads 0 as
    // "queue empty", stops, and the read model never rebuilds at all.
    for (let i = 0; i < 5; i++) insertEmail(db, `tz${i}`, 'INBOX');
    let guard = 0;
    while (m.drainChunk(100, 0) > 0 && guard++ < 50) { /* drain one at a time */ }
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(5);
    expect(guard).toBe(5); // one thread per chunk, five chunks — not an early stop
  });

  it('dequeues only the threads it actually rebuilt', () => {
    // The dangerous half of an early stop: a dirty row deleted without its rollup
    // committing is a rebuild lost for good, because nothing re-dirties it. The
    // thread would serve stale counts/flags forever.
    for (let i = 0; i < 4; i++) insertEmail(db, `tq${i}`, 'INBOX|important');
    m.drainChunk(100, 0);

    const remaining = (db.prepare('SELECT thread_id FROM read_model_dirty ORDER BY thread_id').all() as any[])
      .map((r) => r.thread_id);
    const built = (db.prepare('SELECT id FROM threads ORDER BY id').all() as any[]).map((r) => r.id);
    expect(built).toHaveLength(1);
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain(built[0]); // the one built is the one dequeued

    m.flushNow();
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(4);
  });

  it('flushNow drains to empty in one pass, unpaced', () => {
    // Shutdown and tests ask for an EMPTY queue on return; pacing it would either
    // leave rows behind or turn the flush into a long loop of tiny transactions.
    for (let i = 0; i < 40; i++) insertEmail(db, `tf${i}`, 'INBOX');
    m.flushNow();
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(40);
  });

  it('drainChunk is unpaced by default', () => {
    // Every existing caller (and the public API) keeps run-to-completion semantics;
    // only the background pump opts into a budget.
    for (let i = 0; i < 7; i++) insertEmail(db, `td${i}`, 'INBOX');
    expect(m.drainChunk()).toBe(7);
    expect(dirtyCount(db)).toBe(0);
  });

  it('seeding is idempotent (no duplicate thread_folders rows)', () => {
    insertEmail(db, 't1', 'INBOX|Sarv Inbox/Reminders|read');
    db.prepare("INSERT INTO folders (id, path) VALUES ('f-rem','Sarv Inbox/Reminders')").run();
    m.backfillNow();
    m.backfillNow();
    expect(tfCount(db)).toBe(2); // INBOX + the label, once each
  });
});

// The drained hook is how DERIVED state (today: the folders' unread badges) is
// kept honest without every write site remembering to update it. The triggers
// dirty a thread on any tag write, so the drain is the one choke point every
// read/unread change must pass through — these pin that contract.
describe('ReadModelMaintainer — drained hook', () => {
  let db: Database.Database;

  beforeEach(() => { db = newDb(); });

  it('fires once after a drain that did work, with the queue already empty', () => {
    // If it fired mid-drain the hook would read a HALF-rebuilt projection and
    // store a badge that was never true.
    const seen: number[] = [];
    const m = new ReadModelMaintainer(() => db, () => seen.push(dirtyCount(db)));
    insertEmail(db, 't1', 'INBOX');
    insertEmail(db, 't2', 'INBOX');
    m.flushNow();
    expect(seen).toEqual([0]);
  });

  it('does NOT fire when the queue was already empty', () => {
    // The safety pump ticks every 5s forever; firing on it would rewrite every
    // folder's badge on a timer for the life of the process.
    let calls = 0;
    const m = new ReadModelMaintainer(() => db, () => { calls += 1; });
    m.flushNow();
    expect(calls).toBe(0);
  });

  it('fires from the async pump too, not just the synchronous flush', () => {
    // start() is the path the app actually uses; a hook wired only into flushNow
    // would never run outside shutdown and tests.
    fakeDeferredSteps();
    let calls = 0;
    const m = new ReadModelMaintainer(() => db, () => { calls += 1; });
    insertEmail(db, 't1', 'INBOX');
    m.start();
    vi.runAllTimers();   // every step start() deferred, and every step those queued
    m.stop();
    expect(calls).toBeGreaterThan(0);
    expect(dirtyCount(db)).toBe(0);
  });

  it('a throwing hook does not wedge the maintainer or lose the rebuild', () => {
    // A derived-value failure is not a reason to stop maintaining the read model
    // itself — the rows are already committed when the hook runs.
    const m = new ReadModelMaintainer(() => db, () => { throw new Error('badge refresh exploded'); });
    insertEmail(db, 't1', 'INBOX');
    expect(() => m.flushNow()).not.toThrow();
    expect(dirtyCount(db)).toBe(0);
    expect(tfCount(db)).toBe(1);

    // And the next drain still works (the failure left no latch behind).
    insertEmail(db, 't2', 'INBOX');
    expect(() => m.flushNow()).not.toThrow();
    expect(tfCount(db)).toBe(2);
  });

  it('is optional — a maintainer built without a hook drains normally', () => {
    // Production wires one; tests and any future caller may not.
    const m = new ReadModelMaintainer(() => db);
    insertEmail(db, 't1', 'INBOX');
    expect(() => m.flushNow()).not.toThrow();
    expect(tfCount(db)).toBe(1);
  });
});

// Launch-time repair. A badge can be wrong before this process even starts —
// left drifted by an older build, or by a write made while no hook was wired.
// Nothing will ever re-dirty those threads (the mail is already read), so the
// drain alone would wait forever on unrelated activity.
describe('ReadModelMaintainer — startup refresh', () => {
  beforeEach(() => { fakeDeferredSteps(); });

  it('runs the hook once on start() even with an empty queue', () => {
    // If this fails, a badge that was already wrong at launch stays wrong:
    // nothing re-dirties mail that is already read.
    const db = newDb();
    insertEmail(db, 't1', 'INBOX');
    // backfillNow, not flushNow: flushNow leaves the backfill un-run, so start()
    // re-seeds it and the drain's own call would cover for a missing refresh.
    new ReadModelMaintainer(() => db).backfillNow();
    expect(dirtyCount(db)).toBe(0);
    expect(state(db, 'status')).toBe('complete');   // start() has nothing to seed or drain

    let calls = 0;
    const m = new ReadModelMaintainer(() => db, () => { calls += 1; });
    m.start();
    vi.runAllTimers();
    m.stop();
    expect(calls).toBe(1);
  });

  it('runs it once, not twice, when start() also has a backfill to drain', () => {
    // If this fails, a first launch (or one after a ROLLUP_VERSION bump) rewrites
    // every folder's badge twice: once for the drain, once for the refresh.
    const db = newDb();
    insertEmail(db, 't1', 'INBOX');
    new ReadModelMaintainer(() => db).flushNow();   // built, but never backfilled
    expect(dirtyCount(db)).toBe(0);
    expect(state(db, 'status')).toBeNull();         // so start() re-seeds and drains t1

    let calls = 0;
    const m = new ReadModelMaintainer(() => db, () => { calls += 1; });
    m.start();
    vi.runAllTimers();
    m.stop();
    expect(calls).toBe(1);
  });

  it('does not repeat it — later empty safety pumps stay silent', () => {
    // Otherwise every 5s tick would rewrite every folder's badge forever.
    const db = newDb();
    let calls = 0;
    const m = new ReadModelMaintainer(() => db, () => { calls += 1; });
    m.start();
    vi.runAllTimers();
    expect(calls).toBe(1);   // the launch refresh, done before any later pump
    m.schedule();            // one safety tick, run to completion...
    vi.runAllTimers();
    m.schedule();            // ...and a second
    vi.runAllTimers();
    m.stop();
    expect(calls).toBe(1);
  });
});
