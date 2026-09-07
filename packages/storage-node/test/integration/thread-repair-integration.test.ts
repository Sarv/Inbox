import { normalizeSubject } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { repairThreading, resolveThreadId } from '../../src/thread-resolver';

// End-to-end regression for the reported bug: a realistic multi-party conversation
// ("Re: Integration between Email (SARV) and Acme SSO … Development Work") that
// fragmented into many separate threads and stayed that way. It reproduces every
// condition that broke it and proves repairThreading collapses it into ONE thread:
//   - same normalized subject, MANY different senders (branching)
//   - NO In-Reply-To/References (sarv webmail dropped them) → header paths miss
//   - spread over ~6 months → needs the 180-day window
//   - one mail where the OWNER isn't a direct participant (shares only a third
//     party) → needs owner-aware overlap
//   - a bulk newsletter + unrelated vendor mail with a similar subject that must
//     NOT be swept in.

const OWNER = 'advik.d@sarv.com';
const SUBJ = 'Integration between Email (SARV) and Acme SSO (Acme) - Development Work';
const DAY = 86400;

function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      in_reply_to TEXT,
      "references" TEXT,
      thread_id TEXT NOT NULL,
      subject TEXT,
      from_address TEXT,
      to_address TEXT,
      cc_address TEXT,
      date INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      tags TEXT NOT NULL DEFAULT '||'
    );
    CREATE INDEX idx_emails_thread_from ON emails(thread_id, from_address, date ASC);
    CREATE TABLE email_thread_keys (
      email_id TEXT PRIMARY KEY,
      subject_norm TEXT NOT NULL,
      date INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      subject TEXT,
      first_message_id TEXT,
      last_message_id TEXT,
      last_message_date INTEGER,
      message_count INTEGER
    );
  `);
  return db;
}

/** The resolver's lookup key, as `writeThreadKey` writes it in production. */
function addKey(db: Database.Database, id: string, subject: string, date: number, createdAt: number): void {
  db.prepare('INSERT INTO email_thread_keys (email_id, subject_norm, date, created_at) VALUES (?,?,?,?)')
    .run(id, normalizeSubject(subject || ''), date, createdAt);
}

let seq = 0;
function add(db: Database.Database, e: {
  subject: string; from: string; to: string; cc?: string; date: number; thread?: string; tags?: string;
  createdAt?: number;
}): string {
  const id = `e${++seq}`;
  db.prepare(
    'INSERT INTO emails (id, message_id, in_reply_to, "references", thread_id, subject, from_address, to_address, cc_address, date, created_at, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id, `<${id}>`, null, null, e.thread ?? `t-${id}`, e.subject,
    e.from, e.to, e.cc ?? null, e.date, e.createdAt ?? 1_000_000, e.tags ?? '|INBOX|',
  );
  // The key row is written exactly as production writes it (writeThreadKey):
  // the resolver seeks on `subject_norm` and the incremental repair windows on
  // this `created_at`, so a fixture without it would not be the mailbox the app
  // produces — the repair would find nothing and every test here would pass for
  // the wrong reason.
  addKey(db, id, e.subject, e.date, e.createdAt ?? 1_000_000);
  return id;
}

const threadOf = (db: Database.Database, id: string) =>
  (db.prepare('SELECT thread_id FROM emails WHERE id = ?').get(id) as { thread_id: string }).thread_id;
const distinctThreads = (db: Database.Database, ids: string[]) =>
  new Set(ids.map((id) => threadOf(db, id))).size;

describe('repairThreading — collapses a realistic fragmented multi-party thread into one', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); seq = 0; });

  it('merges 25 same-subject branch mails (no headers, 6 months, owner-aware) into ONE thread', async () => {
    const ids: string[] = [];
    // 24 mails from rotating senders, each on its OWN thread_id (fragmented), no
    // headers, spread a week apart across ~6 months. Every mail includes the group
    // (owner + advik@ + mitali) so branches share real correspondents.
    const senders = ['mitali@sarv.com', 'murtaza@sarv.com', 'hrishi@sarv.com'];
    for (let i = 0; i < 24; i++) {
      const from = senders[i % senders.length];
      ids.push(add(db, {
        subject: i === 0 ? SUBJ : `Re: ${SUBJ}`,
        from,
        to: `${OWNER}, advik@sarv.com`,
        cc: 'mitali@sarv.com',
        date: (100 + i * 7) * DAY, // week apart → all within 180d pairwise via transitivity
      }));
    }
    // The one mail that stayed separate: owner NOT a direct participant — it shares
    // only advik@ with the thread. Needs owner-aware overlap to merge.
    ids.push(add(db, { subject: `Re: ${SUBJ}`, from: 'dhruv@sarv.com', to: 'hrishi@sarv.com, advik@sarv.com', date: 268 * DAY }));

    // Decoys that must NOT be swept in:
    const bulk = add(db, { subject: `Re: ${SUBJ}`, from: 'news@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 150 * DAY, tags: '|INBOX|bulk|' });
    const vendorA = add(db, { subject: 'Monthly Invoice', from: 'a@vendor.com', to: OWNER, date: 150 * DAY });
    const vendorB = add(db, { subject: 'Monthly Invoice', from: 'b@vendor.com', to: OWNER, date: 151 * DAY });

    expect(distinctThreads(db, ids)).toBe(25); // fully fragmented before

    await repairThreading(db, { dryRun: false, selfAddresses: new Set([OWNER]) });

    // All 25 conversation mails now share ONE thread.
    expect(distinctThreads(db, ids)).toBe(1);
    // Decoys stayed out of it.
    const convThread = threadOf(db, ids[0]);
    expect(threadOf(db, bulk)).not.toBe(convThread);      // bulk excluded from subject fallback
    expect(threadOf(db, vendorA)).not.toBe(threadOf(db, vendorB)); // share only owner → separate
    expect(threadOf(db, vendorA)).not.toBe(convThread);
  });

  it('converges header-less mail inserted NEWEST-first (real backfill order) after a repair', async () => {
    // Backfill downloads new→old. Insert each mail in that order, assigning the
    // thread_id the resolver picks at INSERT time (mimicking resolveAndAttach, no
    // reattachOrphans since there are no headers). Because each arriving mail is the
    // OLDEST-so-far, it anchors to itself → they fragment at insert. repairThreading's
    // fixed-point pass then folds them into one, exactly as it does after a backfill.
    const self = new Set([OWNER]);
    const ids: string[] = [];
    for (const day of [200, 180, 160, 140, 120]) { // newest first
      const id = `e${++seq}`;
      const r = resolveThreadId(db, {
        id, messageId: `<${id}>`, threadId: `t-${id}`, subject: `Re: ${SUBJ}`,
        fromAddress: `p${seq}@sarv.com`, toAddress: `${OWNER}, advik@sarv.com`, ccAddress: null,
        date: day * DAY, inReplyTo: null, references: null,
      }, { selfAddresses: self });
      db.prepare(
        'INSERT INTO emails (id, message_id, in_reply_to, "references", thread_id, subject, from_address, to_address, cc_address, date, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(id, `<${id}>`, null, null, r.threadId, `Re: ${SUBJ}`, `p${seq}@sarv.com`, `${OWNER}, advik@sarv.com`, null, day * DAY, '|INBOX|');
      addKey(db, id, SUBJ, day * DAY, 1_000_000);
      ids.push(id);
    }
    expect(distinctThreads(db, ids)).toBeGreaterThan(1); // fragmented at insert (backfill order)

    await repairThreading(db, { dryRun: false, selfAddresses: self });
    expect(distinctThreads(db, ids)).toBe(1); // repair folds them into one
  });

  it('is idempotent — a second repair pass changes nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(add(db, { subject: `Re: ${SUBJ}`, from: `p${i}@sarv.com`, to: `${OWNER}, advik@sarv.com`, date: (100 + i * 3) * DAY }));
    }
    await repairThreading(db, { dryRun: false, selfAddresses: new Set([OWNER]) });
    const after1 = ids.map((id) => threadOf(db, id));
    await repairThreading(db, { dryRun: false, selfAddresses: new Set([OWNER]) });
    const after2 = ids.map((id) => threadOf(db, id));
    expect(after2).toEqual(after1);
    expect(new Set(after1).size).toBe(1);
  });
});

// The scheduler re-runs this repair every 10 minutes for as long as an account's
// history is still downloading — which on a large mailbox is "forever". Each
// re-run used to walk the WHOLE table again; combined with the per-row full scan
// that was a 25-second main-thread freeze on repeat. `sinceCreatedAt` bounds the
// re-run to what has actually arrived since the last pass. It may only bound the
// WORK, never the OUTCOME: newly-backfilled mail must still end up in the right
// thread, or the user sees split conversations that never heal.
describe('repairThreading — incremental re-run (sinceCreatedAt)', () => {
  let db: Database.Database;
  const self = new Set([OWNER]);
  beforeEach(() => { db = newDb(); seq = 0; });

  it('folds a newly-stored mail into an existing thread without walking old rows', async () => {
    const old = [
      add(db, { subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 100 * DAY, createdAt: 1_000 }),
      add(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 107 * DAY, createdAt: 1_000 }),
    ];
    await repairThreading(db, { dryRun: false, selfAddresses: self });
    expect(distinctThreads(db, old)).toBe(1);
    const settled = threadOf(db, old[0]);

    // A reply arrives (or backfills) later — stored AFTER the previous pass.
    const fresh = add(db, {
      subject: `Re: ${SUBJ}`, from: 'dhruv@sarv.com', to: `${OWNER}, advik@sarv.com`,
      date: 114 * DAY, createdAt: 5_000,
    });

    const result = await repairThreading(db, { dryRun: false, selfAddresses: self, sinceCreatedAt: 2_000 });

    // The new mail joined the existing conversation...
    expect(threadOf(db, fresh)).toBe(settled);
    // ...and the pass only ever retargeted the new row.
    expect(result.emailsRetargeted).toBe(1);
    expect(distinctThreads(db, [...old, fresh])).toBe(1);
  });

  it('leaves rows stored before the window untouched', async () => {
    // Two mails that WOULD merge, both stored long before the window: an
    // incremental pass must not touch them (that is the work it is skipping).
    const a = add(db, { subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 100 * DAY, createdAt: 1_000 });
    const b = add(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 107 * DAY, createdAt: 1_000 });

    const result = await repairThreading(db, { dryRun: false, selfAddresses: self, sinceCreatedAt: 9_000 });

    expect(result.emailsRetargeted).toBe(0);
    expect(distinctThreads(db, [a, b])).toBe(2); // still fragmented — by design
    // ...and a FULL pass still fixes them, so nothing is permanently stranded:
    // the scheduler runs one full pass per session before it goes incremental.
    await repairThreading(db, { dryRun: false, selfAddresses: self });
    expect(distinctThreads(db, [a, b])).toBe(1);
  });

  // Re-running the same incremental window must be a no-op, not a second round
  // of retargeting: the scheduler retries on failure, so a non-idempotent pass
  // would keep reshuffling threads under the user's open mailbox.
  it('is idempotent across repeated incremental runs', async () => {
    add(db, { subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 100 * DAY, createdAt: 1_000 });
    const fresh = [
      add(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 107 * DAY, createdAt: 5_000 }),
      add(db, { subject: `Re: ${SUBJ}`, from: 'dhruv@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 114 * DAY, createdAt: 5_000 }),
    ];

    await repairThreading(db, { dryRun: false, selfAddresses: self, sinceCreatedAt: 2_000 });
    const first = fresh.map((id) => threadOf(db, id));

    const second = await repairThreading(db, { dryRun: false, selfAddresses: self, sinceCreatedAt: 2_000 });
    expect(second.emailsRetargeted).toBe(0);
    expect(fresh.map((id) => threadOf(db, id))).toEqual(first);
  });

  // A window that matches nothing is the common case — every 10 minutes when no
  // mail has arrived. It must cost nothing and return cleanly rather than
  // treating "no rows" as "nothing is threaded".
  it('does no work when nothing was stored in the window', async () => {
    const ids = [
      add(db, { subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 100 * DAY, createdAt: 1_000 }),
      add(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 107 * DAY, createdAt: 1_000 }),
    ];
    await repairThreading(db, { dryRun: false, selfAddresses: self });
    const before = ids.map((id) => threadOf(db, id));

    const result = await repairThreading(db, { dryRun: false, selfAddresses: self, sinceCreatedAt: 8_000 });

    expect(result.emailsRetargeted).toBe(0);
    expect(result.iterations).toBe(1); // converged immediately, no wasted passes
    expect(result.totalEmails).toBe(2); // still reports the whole mailbox size
    expect(ids.map((id) => threadOf(db, id))).toEqual(before);
  });

  // The incremental query orders by created_at, so the loop re-sorts by date.
  // If that sort were dropped, a batch of backfilled mail would be processed
  // newest-first and need extra fixed-point iterations to converge (or, at the
  // 8-iteration ceiling, not converge at all).
  it('converges in one iteration on a batch stored out of date order', async () => {
    // Same created_at, deliberately inserted newest-date-first.
    const ids = [200, 180, 160, 140, 120].map((day, i) =>
      add(db, {
        subject: i === 4 ? SUBJ : `Re: ${SUBJ}`,
        from: `p${i}@sarv.com`, to: `${OWNER}, advik@sarv.com`,
        date: day * DAY, createdAt: 5_000,
      }),
    );

    const result = await repairThreading(db, { dryRun: false, selfAddresses: self, sinceCreatedAt: 2_000 });

    expect(distinctThreads(db, ids)).toBe(1);
    expect(result.iterations).toBe(2); // one pass to merge, one to confirm stable
  });
});

/**
 * How the repair READS the mailbox, which is a UI-freeze bug, not a correctness
 * one. The full pass selects every row including `in_reply_to` and `"references"`
 * — columns that sit AFTER the inline bodies in the record, so reading one walks
 * that row's overflow chain. Materialising all of them with `.all()` is a single
 * synchronous call that no `await` in the consuming loop can interrupt: measured
 * on a production mailbox as `Post-backfill thread repair: 0 email(s) retargeted,
 * 9940→9940 threads, 1 iter, 20360ms` against `main process blocked for 19342ms`
 * — 20 seconds of frozen UI to retarget nothing. `.iterate()` spreads the same
 * read across the loop's yields.
 *
 * The incremental pass stays buffered on purpose: it re-sorts by date in JS (see
 * the convergence test above) and its window is small.
 */
describe('repairThreading — how it reads the mailbox', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); seq = 0; });

  /** Record which cursor method each SELECT of the repair rows used. */
  function spyOnReads(target: Database.Database): { used: string[] } {
    const used: string[] = [];
    const realPrepare = target.prepare.bind(target);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (target as any).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      // Both passes select the same repair columns; the full pass reads `FROM
      // emails e`, the incremental one seeks `email_thread_keys` and joins.
      const isRepairRead = /in_reply_to/.test(sql) && /FROM (emails e|email_thread_keys k)/.test(sql);
      if (!isRepairRead) return stmt;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = stmt as any;
      const realAll = wrapped.all.bind(wrapped);
      const realIterate = wrapped.iterate.bind(wrapped);
      wrapped.all = (...args: unknown[]) => { used.push('all'); return realAll(...args); };
      wrapped.iterate = (...args: unknown[]) => { used.push('iterate'); return realIterate(...args); };
      return wrapped;
    };
    return { used };
  }

  const seed = (target: Database.Database) => [1, 2, 3].map((n) => add(target, {
    subject: n === 1 ? SUBJ : `Re: ${SUBJ}`,
    from: `p${n}@sarv.com`, to: `${OWNER}, advik@sarv.com`,
    date: n * DAY, createdAt: 5_000,
  }));

  // Regression: an `.all()` here is a whole-mailbox read the yielding loop cannot
  // break up — the 19-second beachball above.
  it('STREAMS the full pass instead of materialising the whole mailbox', async () => {
    const ids = seed(db);
    const spy = spyOnReads(db);

    const result = await repairThreading(db, { dryRun: false, selfAddresses: new Set([OWNER]) });

    expect(spy.used).toContain('iterate');
    expect(spy.used).not.toContain('all');
    // Streaming must not change the outcome — same merge as the buffered read.
    expect(distinctThreads(db, ids)).toBe(1);
    expect(result.totalEmails).toBe(3);
  });

  // Regression: the incremental pass must KEEP buffering — it sorts the window by
  // date in JS, which a lazy cursor cannot do.
  it('keeps the incremental pass buffered so it can re-sort by date', async () => {
    seed(db);
    const spy = spyOnReads(db);

    await repairThreading(db, { dryRun: false, selfAddresses: new Set([OWNER]), sinceCreatedAt: 2_000 });

    expect(spy.used).toContain('all');
    expect(spy.used).not.toContain('iterate');
  });
});
