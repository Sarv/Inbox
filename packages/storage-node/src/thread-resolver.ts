// DB-aware thread resolver.
//
// generateThreadId() (in @sarvinbox/core) hashes the FIRST entry of a
// References header — which is the RFC 5322 root message-id under
// well-behaved senders. Many corporate webmail clients (sarv.com's own
// included) only put the immediate PARENT in References, or omit it
// entirely. The result is one new thread_id per reply.
//
// This module fixes that by going to the DB:
//
//   1. Look up the parent via in_reply_to. If found, inherit its thread_id.
//   2. Walk the references chain and inherit from any known ancestor.
//   3. Fall back to Gmail-style "same normalized subject + participant
//      overlap" matching, either within a 48-hour window (weak) or, for a
//      conversation that shares real third-party participants AND carries
//      reply evidence, without one (strong). Catches replies that arrive
//      with broken or empty headers.
//   4. If nothing matches, keep the email's own pre-computed thread_id
//      (this is a genuine new conversation).
//
// We also handle out-of-order arrival: when a parent shows up AFTER a
// child has already been threaded standalone, the child's thread_id is
// merged into the parent's via reattachOrphans().

import { normalizeSubject, createLogger, createLoopYielder, hasReplyPrefix, yieldToEventLoop } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { prepared } from './statement-cache';
const logger = createLogger('thread-resolver');

/** Thread lookup by exact message-id — used by both the parent and ancestor paths. */
const SQL_THREAD_BY_MESSAGE_ID = 'SELECT thread_id FROM emails WHERE message_id = ? AND id != ? LIMIT 1';

/**
 * Same-subject candidates for the Path-3 fallback.
 *
 * Equality on `email_thread_keys.subject_norm` plus a date RANGE, both served by
 * idx_email_thread_keys_lookup, so the planner SEEKs to the handful of real
 * candidates and only then touches `emails` (by primary key, ≤50 rows). The
 * predecessor of this query was `LOWER(subject) LIKE '%norm%' AND ABS(date - ?)
 * <= ?` — a function on the column, a leading wildcard and an expression
 * comparison, none of which any index can serve — over a table with no index on
 * `subject` at all. It therefore scanned all 26k rows once per email. That
 * single statement was 94.5% of main-thread CPU when profiled (2026-08-26) and
 * is what froze the UI for 25s at a time.
 *
 * Semantics are unchanged, because the caller ALREADY discarded every candidate
 * whose `normalizeSubject(subject)` differed from `norm`: the rows this returns
 * are exactly the rows that used to survive that check. Recall actually
 * improves — `LIMIT 50` now bounds the genuine matches rather than a superset
 * of substring hits that could crowd them out (a real merge could be lost when
 * 50 unrelated subjects merely CONTAINED the normalised one).
 *
 * Exported so a test can assert its QUERY PLAN against the REAL SQL: "does the
 * planner still SEEK here?" is the regression worth pinning, and a copy of the
 * statement in the test would drift from this one.
 */
export const SQL_SUBJECT_CANDIDATES = `
      SELECT e.id, e.thread_id, e.subject, e.from_address, e.to_address, e.cc_address, e.date
      FROM email_thread_keys k
      JOIN emails e ON e.id = k.email_id
      WHERE k.subject_norm = ?
        AND k.date >= ? AND k.date <= ?
        AND k.email_id != ?
      ORDER BY ABS(k.date - ?) ASC
      LIMIT 50
    `;

const REPAIR_ROW_COLUMNS = `e.id, e.message_id, e.thread_id, e.subject, e.from_address,
             e.to_address, e.cc_address, e.date, e.in_reply_to, e."references", e.tags`;

/** One row as both repair queries below select it. */
type RepairRow = {
  id: string;
  message_id: string;
  thread_id: string;
  subject: string | null;
  from_address: string;
  to_address: string | null;
  cc_address: string | null;
  date: number;
  in_reply_to: string | null;
  references: string | null;
  tags: string | null;
};

/**
 * Full-mailbox repair pass: every row, oldest first.
 *
 * STREAMED with `.iterate()`, never `.all()` — that distinction is the whole
 * difference between a responsive app and a 20-second beachball. `in_reply_to`
 * and `"references"` sit immediately after `raw_body` in the record, so on a
 * mailbox with inline bodies every row read walks that row's overflow chain;
 * `.all()` does all 26,184 of them inside ONE synchronous call, which no amount
 * of yielding in the consuming loop can interrupt. Measured on a production-sized mailbox:
 * `[Backfill] Post-backfill thread repair … 1 iter, 20360ms` against a 19,342ms
 * event-loop block — i.e. the entire freeze was this fetch, before the loop it
 * feeds had run a single iteration.
 *
 * Ordered in SQL so the consumer never has to buffer to sort. Rows arrive on a
 * read snapshot, so concurrent sync writes cannot corrupt the pass; a row that
 * changes underneath it is simply picked up by the next run, which is safe
 * because the repair is idempotent.
 */
const SQL_REPAIR_ROWS_ALL = `SELECT ${REPAIR_ROW_COLUMNS} FROM emails e ORDER BY e.date ASC`;

/**
 * Incremental repair pass. Driven from `email_thread_keys` rather than
 * `emails.created_at`: that column was added by a late ALTER, so on rows whose
 * bodies spill it lives in the overflow pages, and both indexing and scanning it
 * mean walking the entire multi-GB table. Here the window is a seek into a
 * narrow index. Exported so a test can pin the plan.
 */
export const SQL_REPAIR_ROWS_SINCE = `SELECT ${REPAIR_ROW_COLUMNS}
      FROM email_thread_keys k
      JOIN emails e ON e.id = k.email_id
      WHERE k.created_at >= ?
      ORDER BY k.created_at ASC`;

/**
 * Subset of EmailRecord fields the resolver needs. Decoupled from the
 * full type so the resolver can also operate on raw DB rows during
 * backfill.
 */
export interface ResolverEmail {
  id: string;
  messageId: string;
  threadId: string;
  subject: string | null;
  fromAddress: string;
  toAddress: string | null;
  ccAddress?: string | null;
  date: number;
  inReplyTo: string | null;
  references: string | null;
  // Mailing-list / bulk mail (List-Id / List-Unsubscribe / Precedence). When set,
  // the subject-based fallback (Path 3) is SKIPPED so recurring same-subject
  // newsletters/digests don't collapse into one thread — they still thread via
  // real In-Reply-To/References (Paths 1-2) when a genuine chain exists.
  isBulk?: boolean;
}

// Same-subject fallback only groups mails within 48 HOURS of each other (the
// window is applied against each candidate's date, so a continuously-active
// same-subject conversation keeps extending while a gap > 48h starts a fresh
// thread — a mail arriving on the 49th hour after the last same-subject mail
// gets its own thread). This bounds over-grouping of recurring same-subject
// senders (system/HR notifications, digests) that Paths 1–2 don't cover.
// Real replies carrying In-Reply-To/References still thread with NO time limit.
const SUBJECT_FALLBACK_WINDOW_SEC = 48 * 3600;
const SUBJECT_FALLBACK_MIN_LENGTH = 5;
// Candidate FETCH window for the subject fallback. Wide (180 days) so a long-
// running same-subject conversation whose References root isn't in the local DB
// (sarv webmail only carries the immediate parent, and its replies often drop
// In-Reply-To entirely) still finds its earlier branches — real multi-month work
// threads fragment otherwise. Over-grouping is held back by the STRONG-overlap
// requirement (shared real participants) and by bulk mail being excluded from the
// fallback entirely, so widening the window can't collapse newsletters/digests.
// A silence gap larger than this starts a fresh thread; within it, transitive
// convergence + repairThreading's fixed-point pass merge even longer spans.
const SUBJECT_CANDIDATE_WINDOW_SEC = 180 * 86400;
// Evidence that a mail is part of a CONVERSATION and not one issue of a
// recurring notification stream: it carries In-Reply-To/References, or its
// subject arrived with a reply/forward prefix. Required for the STRONG merge
// below, which ignores the 48h window.
//
// Why the strong path needs it: a system notification ("OverTime Request is
// approved.", "X | Leave Request | Approved") repeats ONE subject from ONE
// sender to the SAME recipient list forever. That constant CC is a shared third
// party, so every issue matched strongly and the 48h guard never applied — 24
// months-apart notifications collapsed into a single 24-message thread. The
// strong path exists for a branching multi-party conversation whose References
// root isn't in the local DB; such a conversation always leaves this trace,
// while a notification stream never does. With no trace, the mail falls back to
// the WEAK path and groups per burst (48h) instead of forever.
//
// Pair-level on purpose — either side counts. A webmail reply that drops both
// the prefix and the headers still joins a thread whose other branch has them,
// which is the fragmentation the strong path was added to fix.
function hasConversationEvidence(
  email: Pick<ResolverEmail, 'subject' | 'inReplyTo' | 'references'>,
): boolean {
  if ((email.inReplyTo || '').trim()) return true;
  if ((email.references || '').trim()) return true;
  return hasReplyPrefix(email.subject);
}

// A "strong" same-subject match shares at least this many participants BEYOND the
// two senders. The mailbox owner is on both mails, so >=2 means owner + at least
// one real shared third party (a common recipient across branches of a group
// thread) — enough to merge a branching multi-party conversation, while unrelated
// same-subject mail (vendor A vs vendor B invoice, sharing ONLY the owner) is 1
// and stays separate. Strong matches merge regardless of the 48h weak window.
const STRONG_SHARED_PARTICIPANTS = 2;
// Gmail-parity hard ceiling: a thread holds at most this many messages. The
// (cap+1)th message that would otherwise join a full thread starts a fresh thread
// with the same subject instead. Applied only at INSERT-time resolution — never
// during repairThreading, which would otherwise shatter an existing >100 thread.
const THREAD_MESSAGE_CAP = 100;

/** Count messages already in a thread (indexed by idx_emails_thread_from). */
function threadSize(db: Database.Database, threadId: string): number {
  const row = prepared(db, 'SELECT COUNT(*) AS c FROM emails WHERE thread_id = ?').get(threadId) as { c: number } | undefined;
  return row?.c ?? 0;
}

function normalizeMessageId(id: string | null | undefined): string {
  if (!id) return '';
  const trimmed = id.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, '')}>`;
}

function parseAddressList(list: string | null | undefined): string[] {
  if (!list) return [];
  return list
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(entry => {
      const m = entry.match(/<([^>]+)>/);
      return (m ? m[1] : entry).toLowerCase();
    });
}

function participants(email: Pick<ResolverEmail, 'fromAddress' | 'toAddress' | 'ccAddress'>): Set<string> {
  const set = new Set<string>();
  if (email.fromAddress) set.add(email.fromAddress.toLowerCase());
  for (const a of parseAddressList(email.toAddress)) set.add(a);
  for (const a of parseAddressList(email.ccAddress)) set.add(a);
  return set;
}

/**
 * Compute the correct thread_id for an email by consulting the DB.
 * Returns the email's own threadId unchanged if no better match exists.
 *
 * Pure read — does not mutate the DB.
 */
export function resolveThreadId(
  db: Database.Database,
  email: ResolverEmail,
  opts?: { applyCap?: boolean; selfAddresses?: Set<string> },
): {
  threadId: string;
  via: 'in_reply_to' | 'references' | 'subject+participants' | 'unchanged' | 'capped';
} {
  // Join a matched thread UNLESS it's already at the message cap — then the new
  // message starts a fresh thread (Gmail's 100-message ceiling). Skipped during
  // repairThreading (applyCap:false) so it never fragments an existing big thread.
  const applyCap = opts?.applyCap !== false;
  const join = (threadId: string, via: 'in_reply_to' | 'references' | 'subject+participants') => {
    if (applyCap && threadId !== email.threadId && threadSize(db, threadId) >= THREAD_MESSAGE_CAP) {
      return { threadId: email.threadId, via: 'capped' as const };
    }
    return { threadId, via };
  };

  // Path 1: direct parent lookup
  if (email.inReplyTo) {
    const parentId = normalizeMessageId(email.inReplyTo);
    if (parentId) {
      const row = prepared(db, SQL_THREAD_BY_MESSAGE_ID)
        .get(parentId, email.id) as { thread_id?: string } | undefined;
      if (row?.thread_id) {
        return join(row.thread_id, 'in_reply_to');
      }
    }
  }

  // Path 2: any ancestor in references chain
  if (email.references) {
    const refs = email.references
      .split(/\s+/)
      .map(r => r.trim())
      .filter(r => r.startsWith('<') && r.endsWith('>'));
    for (const ref of refs) {
      const row = prepared(db, SQL_THREAD_BY_MESSAGE_ID)
        .get(ref, email.id) as { thread_id?: string } | undefined;
      if (row?.thread_id) {
        return join(row.thread_id, 'references');
      }
    }
  }

  // Path 3: Gmail-style subject + participant + time-window match. Applies to
  // ALL subjects (not just Re:/Fwd:) so standalone same-subject emails — e.g.
  // repeated system/HR notifications like "X | Leave Request | Approved" —
  // group into one thread like Gmail. Over-grouping is prevented by the
  // directional sender-overlap check below (unrelated same-subject emails from
  // different senders never merge), the exact normalized-subject match, a
  // minimum subject length, and the time window.
  const subject = email.subject || '';
  const norm = normalizeSubject(subject);
  // Suppress the subject fallback for bulk/list mail (Gmail parity): newsletters
  // and digests share identical subjects and would otherwise collapse into one
  // giant thread. They still thread via genuine In-Reply-To/References above.
  if (!email.isBulk && norm.length >= SUBJECT_FALLBACK_MIN_LENGTH) {
    const myParts = participants(email);
    const candidates = prepared(db, SQL_SUBJECT_CANDIDATES).all(
      norm,
      email.date - SUBJECT_CANDIDATE_WINDOW_SEC,
      email.date + SUBJECT_CANDIDATE_WINDOW_SEC,
      email.id,
      email.date,
    ) as Array<{
      id: string;
      thread_id: string;
      subject: string | null;
      from_address: string;
      to_address: string | null;
      cc_address: string | null;
      date: number;
    }>;

    // Raw participant overlap is too weak — the account owner is a participant of
    // nearly every email, so ANY two same-subject emails would merge (vendor A's
    // "Invoice" with vendor B's). Two match kinds are accepted instead:
    //   - WEAK (directional sender overlap, time-bounded): one side's SENDER
    //     appears among the other side's participants, within 48h. Covers 2-party
    //     back-and-forth and recurring digests without runaway grouping.
    //   - STRONG (shared third-party participants PLUS conversation evidence,
    //     NOT time-bounded within the fetch window): they share >=2 participants
    //     beyond the two senders —
    //     owner + a real common recipient — which is the signature of a branching
    //     multi-party conversation (the reported bug: one subject split into many
    //     threads because the References root isn't in the local DB). Merges those
    //     branches while vendor-A/vendor-B (sharing only the owner) stays split,
    //     and — via the evidence requirement — while a recurring notification
    //     with a permanent CC list groups only per 48h burst.
    const mySender = (email.fromAddress || '').toLowerCase();
    // Computed once: it depends only on the arriving mail. See
    // hasConversationEvidence — this is what separates a real conversation from
    // a notification stream that repeats one subject.
    const myEvidence = hasConversationEvidence(email);
    // Anchor the group on its OLDEST member (tie-broken by id) and adopt that
    // member's thread. That's a total order over the group, so every member
    // converges to ONE thread. (Anchoring on the smallest thread_id instead
    // oscillated for a 2-email group — each kept adopting the other's thread and
    // never settled.) "Oldest" also means a freshly-arrived email — always the
    // newest — reliably joins the existing conversation instead of starting its
    // own.
    let anchorThread = email.threadId;
    let anchorDate = email.date;
    let anchorId = email.id;
    for (const c of candidates) {
      // Redundant against the indexed `subject_norm = ?` above, and kept
      // deliberately: it is the backstop if a row's stored `subject_norm` ever
      // drifts from its `subject` (a write path added without maintaining the
      // column). Costs one normalise over at most 50 rows, and turns a
      // would-be wrong MERGE into a missed one.
      if (normalizeSubject(c.subject || '') !== norm) continue;
      const cParts = participants({
        fromAddress: c.from_address,
        toAddress: c.to_address,
        ccAddress: c.cc_address,
      });
      const cSender = (c.from_address || '').toLowerCase();
      const directional = (cSender && myParts.has(cSender)) || (mySender && cParts.has(mySender));
      // Count shared participants that are NOT either sender. `sharedReal` also
      // excludes the mailbox owner (self), leaving only genuine common third
      // parties. When self is known we require >=1 real shared party (owner + 1
      // isn't needed, so a mail where the owner isn't a direct participant — only
      // one shared correspondent, e.g. Hrishi — still merges); when self is
      // unknown we fall back to >=2 (owner + 1). Vendor-A/vendor-B, which share
      // ONLY the owner, are 0 real either way and stay split.
      const self = opts?.selfAddresses;
      let sharedBeyondSenders = 0;
      let sharedReal = 0;
      for (const p of myParts) {
        if (p === mySender || p === cSender) continue;
        if (!cParts.has(p)) continue;
        sharedBeyondSenders++;
        if (!self || !self.has(p)) sharedReal++;
      }
      // Shared-participant test AND conversation evidence. Only the candidate's
      // stored `subject` is available here (the fetch deliberately doesn't read
      // in_reply_to/"references": those columns sit after the bodies in the
      // record, so on a mailbox whose relocation hasn't finished reading them
      // would walk up to 50 overflow chains per arriving mail). The arriving
      // side's headers carry that signal already.
      const evidence = myEvidence || hasReplyPrefix(c.subject);
      const sharedEnough = self && self.size > 0
        ? sharedReal >= 1
        : sharedBeyondSenders >= STRONG_SHARED_PARTICIPANTS;
      const strong = sharedEnough && evidence;
      const withinWeakWindow = Math.abs(c.date - email.date) <= SUBJECT_FALLBACK_WINDOW_SEC;
      const mergeable = strong || (directional && withinWeakWindow);
      if (!mergeable) continue;
      if (c.date < anchorDate || (c.date === anchorDate && c.id < anchorId)) {
        anchorThread = c.thread_id;
        anchorDate = c.date;
        anchorId = c.id;
      }
    }
    if (anchorThread !== email.threadId) {
      return join(anchorThread, 'subject+participants');
    }
  }

  // Path 4: keep the pre-computed thread_id (new conversation)
  return { threadId: email.threadId, via: 'unchanged' };
}

/**
 * After inserting an email with message_id M, find any other emails
 * whose in_reply_to == M but whose thread_id != mine, and merge them
 * into mine. Handles the out-of-order arrival case where a child was
 * threaded as its own standalone conversation before the parent landed.
 *
 * Returns the number of orphan emails reattached plus the thread_ids
 * they were pulled OUT of, so the caller can recompute (or delete)
 * those threads — otherwise husk rows with phantom message_count
 * linger and get re-queued by getPendingExtractionThreads forever.
 */
export function reattachOrphans(
  db: Database.Database,
  myMessageId: string,
  myThreadId: string,
): { changes: number; previousThreadIds: string[] } {
  if (!myMessageId) return { changes: 0, previousThreadIds: [] };

  // Pull the ENTIRE descendant reply tree into myThreadId, not just the direct
  // children. A fresh account backfills older parents AFTER their recent replies
  // (child-before-parent), so when a parent finally lands its subtree can be
  // several levels deep. A one-level pull left grandchildren stranded in their
  // own threads and the conversation stayed fragmented (the reported "25 mails →
  // no thread" on reconnect). BFS down in_reply_to, moving each level into
  // myThreadId and enqueuing the moved children so THEIR descendants are pulled
  // too. Bounded by the thread's own size (not the whole table); `seen` guards a
  // pathological cycle. Common case (no orphans) is one SELECT that returns none.
  const childrenStmt = db.prepare(
    'SELECT id, message_id, thread_id FROM emails WHERE in_reply_to = ? AND thread_id != ?',
  );
  const moveStmt = db.prepare(
    'UPDATE emails SET thread_id = ? WHERE in_reply_to = ? AND thread_id != ?',
  );

  const previousThreadIds = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [myMessageId];
  let changes = 0;

  while (queue.length > 0) {
    const parentMid = queue.shift()!;
    if (seen.has(parentMid)) continue;
    seen.add(parentMid);

    const children = childrenStmt.all(parentMid, myThreadId) as Array<{
      id: string;
      message_id: string;
      thread_id: string;
    }>;
    if (children.length === 0) continue;

    for (const c of children) {
      previousThreadIds.add(c.thread_id); // record the thread we're draining
      if (c.message_id) queue.push(c.message_id); // cascade to this child's own replies
    }
    changes += moveStmt.run(myThreadId, parentMid, myThreadId).changes;
  }

  return { changes, previousThreadIds: [...previousThreadIds] };
}

/**
 * Walk the entire emails table and fix broken thread_id values using
 * the same logic as resolveThreadId. Iterates to fixed-point so a chain
 * of N broken replies collapses in one call.
 *
 * `dryRun: true` returns the planned updates without writing anything.
 */
export async function repairThreading(
  db: Database.Database,
  options: {
    dryRun: boolean;
    logEvery?: number;
    selfAddresses?: Set<string>;
    /**
     * Only reconsider emails stored at or after this `created_at` (unix
     * seconds). Omit for the full-mailbox pass.
     *
     * A re-run exists to fold NEWLY-backfilled mail into existing threads, and
     * the resolver only ever JOINS, so rows already examined by an earlier pass
     * cannot change their answer unless a new row appeared — and a new row is
     * itself in this set, pulling its thread together from its own side. Before
     * this bound, every 10-minute re-run walked all 26k emails again forever
     * (the version stamp only lands once backfill completes, which on a big
     * account is never), which is what kept the freeze permanent rather than
     * one-time.
     */
    sinceCreatedAt?: number;
  } = { dryRun: true },
): Promise<{
  totalEmails: number;
  iterations: number;
  emailsRetargeted: number;
  threadsBefore: number;
  threadsAfter: number;
  sample: Array<{ id: string; from: string; subject: string | null; oldThread: string; newThread: string; via: string }>;
}> {
  const { dryRun, logEvery = 1000, sinceCreatedAt } = options;
  // This walks every candidate email × up to 8 iterations, each row running the
  // (DB-querying) resolver, so it is inherently minutes of work on a large
  // mailbox. Yield on a TIME budget so it can never freeze the main thread (the
  // beachball + IMAP/AI timeouts): the per-row loop is read-only, so yielding
  // mid-loop is safe, and the apply() transaction below stays atomic.
  //
  // It used to yield every 500 ROWS, which was the actual beachball bug rather
  // than a fix for it. That count silently assumed a cheap row; once the
  // resolver's per-row subject lookup degraded to a full table scan, 500 rows
  // was 25 SECONDS of uninterruptible work and the yield bought nothing. A time
  // budget holds regardless of what one row costs.
  const breathe = createLoopYielder();
  const totalEmails = (prepared(db, 'SELECT COUNT(*) as c FROM emails').get() as any).c as number;
  const threadsBefore = (prepared(db, 'SELECT COUNT(DISTINCT thread_id) as c FROM emails').get() as any).c as number;

  const sample: Array<{ id: string; from: string; subject: string | null; oldThread: string; newThread: string; via: string }> = [];
  let totalChanges = 0;
  let iterations = 0;
  const maxIterations = 8;

  // Take a working snapshot of the current state. We'll compute updates
  // against this, then either apply or print them. For dry-run we never
  // touch the real DB. For apply, we wrap in a transaction.
  const apply = (callback: () => number): number => {
    if (dryRun) return callback();
    const tx = db.transaction(callback);
    return tx();
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    let changesThisIter = 0;

    // Two statements rather than one with an optional WHERE, because the ORDER
    // BY has to differ: `WHERE created_at >= ? ORDER BY date` makes SQLite walk
    // the DATE index over the whole table (cheaper than sorting, from its point
    // of view) and the created_at bound then buys nothing. Ordering by the same
    // column the window filters on is what lets it seek; the rows are re-sorted
    // by date in JS below, which is free on a window this small.
    // Oldest-first is load-bearing either way: the group anchor is its oldest
    // member, so processing in date order lets a chain collapse in fewer
    // iterations. The full pass gets that order from SQL and is STREAMED, so the
    // multi-GB read is spread across the loop's yields instead of happening in
    // one uninterruptible call. The incremental window is small and ordered by
    // created_at, so it can afford to be buffered and re-sorted in JS.
    const rows: Iterable<RepairRow> = sinceCreatedAt === undefined
      ? (prepared(db, SQL_REPAIR_ROWS_ALL).iterate() as Iterable<RepairRow>)
      : (prepared(db, SQL_REPAIR_ROWS_SINCE).all(sinceCreatedAt) as RepairRow[])
        .sort((a, b) => a.date - b.date);

    const updates: Array<{ id: string; newThread: string; via: string }> = [];
    for (const r of rows) {
      await breathe(); // hands the thread back once the time budget is spent
      const result = resolveThreadId(db, {
        id: r.id,
        messageId: r.message_id,
        threadId: r.thread_id,
        subject: r.subject,
        fromAddress: r.from_address,
        toAddress: r.to_address,
        ccAddress: r.cc_address,
        date: r.date,
        inReplyTo: r.in_reply_to,
        references: r.references,
        isBulk: (r.tags || '').includes('|bulk|'),
      }, { applyCap: false, selfAddresses: options.selfAddresses });
      if (result.via !== 'unchanged' && result.threadId !== r.thread_id) {
        updates.push({ id: r.id, newThread: result.threadId, via: result.via });
        if (sample.length < 30) {
          sample.push({
            id: r.id,
            from: r.from_address,
            subject: r.subject,
            oldThread: r.thread_id,
            newThread: result.threadId,
            via: result.via,
          });
        }
      }
    }

    if (updates.length === 0) break;

    changesThisIter = apply(() => {
      const stmt = db.prepare('UPDATE emails SET thread_id = ? WHERE id = ?');
      let n = 0;
      for (const u of updates) {
        if (!dryRun) stmt.run(u.newThread, u.id);
        n++;
        if (n % logEvery === 0) {
          // eslint-disable-next-line no-console
          logger.info(`[repairThreading] iter ${iter + 1}: ${n}/${updates.length} updates ${dryRun ? 'planned' : 'applied'}`);
        }
      }
      return n;
    });

    totalChanges += changesThisIter;

    // For dry-run we don't actually write, so re-running the same loop
    // would just re-find the same updates forever. Bail after one pass.
    if (dryRun) break;
    await yieldToEventLoop(); // breathe between iterations too, unconditionally
  }

  // Rebuild the threads table to match — only when applying.
  if (!dryRun && totalChanges > 0) {
    const tx = db.transaction(() => {
      // Drop threads that have no emails left
      db.prepare(`
        DELETE FROM threads WHERE id NOT IN (SELECT DISTINCT thread_id FROM emails)
      `).run();
      // Insert any newly-collapsed thread_ids that aren't yet in threads
      db.prepare(`
        INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date, message_count)
        SELECT
          e.thread_id,
          (SELECT subject FROM emails WHERE thread_id = e.thread_id ORDER BY date ASC LIMIT 1),
          (SELECT id FROM emails WHERE thread_id = e.thread_id ORDER BY date ASC LIMIT 1),
          (SELECT id FROM emails WHERE thread_id = e.thread_id ORDER BY date DESC LIMIT 1),
          (SELECT MAX(date) FROM emails WHERE thread_id = e.thread_id),
          (SELECT COUNT(*) FROM emails WHERE thread_id = e.thread_id)
        FROM (SELECT DISTINCT thread_id FROM emails) e
      `).run();
      // Recompute stats on every thread (counts may have changed)
      db.prepare(`
        UPDATE threads SET
          last_message_date = (SELECT MAX(date) FROM emails WHERE emails.thread_id = threads.id),
          message_count = (SELECT COUNT(*) FROM emails WHERE emails.thread_id = threads.id),
          first_message_id = (SELECT id FROM emails WHERE emails.thread_id = threads.id ORDER BY date ASC LIMIT 1),
          last_message_id = (SELECT id FROM emails WHERE emails.thread_id = threads.id ORDER BY date DESC LIMIT 1),
          subject = (SELECT subject FROM emails WHERE emails.thread_id = threads.id ORDER BY date ASC LIMIT 1)
      `).run();
    });
    tx();
  }

  const threadsAfter = (db.prepare('SELECT COUNT(DISTINCT thread_id) as c FROM emails').get() as any).c as number;
  return {
    totalEmails,
    iterations,
    emailsRetargeted: totalChanges,
    threadsBefore,
    threadsAfter,
    sample,
  };
}
