import { normalizeSubject } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openTestDb } from '../../src/test-support/test-db';
import { resolveThreadId } from '../../src/thread-resolver';

// Regression: a branching multi-party conversation was splitting into many
// threads (one per sender) because sarv webmail only carries the immediate parent
// in References and the thread's root wasn't in the local DB, so Paths 1-2 (In-
// Reply-To/References) missed and Path 3 (subject fallback) under-merged. Path 3
// now merges same-subject mail that shares a real third-party participant (owner +
// a common recipient), while still keeping unrelated same-subject mail apart.

const DAY = 86400;
const OWNER = 'advik.d@sarv.com';

function newDb(): Database.Database {
  const db = openTestDb();
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
      date INTEGER
    );
    CREATE TABLE email_thread_keys (
      email_id TEXT PRIMARY KEY,
      subject_norm TEXT NOT NULL,
      date INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

let idSeq = 0;
function addEmail(db: Database.Database, e: {
  thread: string; subject: string; from: string; to: string; cc?: string; date: number;
}): string {
  const id = `e${++idSeq}`;
  db.prepare(
    'INSERT INTO emails (id, message_id, in_reply_to, "references", thread_id, subject, from_address, to_address, cc_address, date) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(id, `<${id}>`, null, null, e.thread, e.subject, e.from, e.to, e.cc ?? null, e.date);
  // The lookup key is written here exactly as every production insert path
  // writes it (writeThreadKey) — the resolver SEEKS on it, so a fixture without
  // it would test a mailbox no real insert can produce.
  db.prepare('INSERT INTO email_thread_keys (email_id, subject_norm, date) VALUES (?,?,?)')
    .run(id, normalizeSubject(e.subject || ''), e.date);
  return id;
}

// Resolve the thread for a NEW (not-yet-inserted) email — no In-Reply-To/References
// so it exercises Path 3 (subject fallback) directly (unless inReplyTo is given).
function resolveNew(db: Database.Database, e: {
  subject: string; from: string; to: string; cc?: string; date: number;
  isBulk?: boolean; inReplyTo?: string;
}) {
  return resolveThreadId(db, {
    id: `new${++idSeq}`,
    messageId: `<new${idSeq}>`,
    threadId: `t-own-${idSeq}`,
    subject: e.subject,
    fromAddress: e.from,
    toAddress: e.to,
    ccAddress: e.cc ?? null,
    date: e.date,
    inReplyTo: e.inReplyTo ?? null,
    references: null,
    isBulk: e.isBulk,
  });
}

const SUBJ = 'Integration between Email (SARV) and Acme SSO (Acme) - Development Work';

describe('resolveThreadId — subject fallback merges branching group threads', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); idSeq = 0; });

  it('merges two branches that share third-party participants but never email each other', () => {
    // Branch A: Dhruv -> owner + Mitali + Advik (advik@) (day 0).
    addEmail(db, { thread: 't-A', subject: `Re: ${SUBJ}`, from: 'dhruv@sarv.com', to: `${OWNER}, mitali@sarv.com, advik@sarv.com`, date: 100 * DAY });
    // Branch B: Hrishi -> owner + Mitali + Advik (advik@), 5 DAYS later (> 48h weak window).
    // Dhruv and Hrishi never email each other → no directional overlap — but they
    // share owner + Mitali + Advik (advik@), so the STRONG rule merges them into t-A.
    const r = resolveNew(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, mitali@sarv.com, advik@sarv.com`, date: 105 * DAY });
    expect(r.threadId).toBe('t-A');
    expect(r.via).toBe('subject+participants');
  });

  it('anchors on the OLDEST branch so every message converges to one thread', () => {
    addEmail(db, { thread: 't-old', subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 100 * DAY });
    addEmail(db, { thread: 't-mid', subject: `Re: ${SUBJ}`, from: 'murtaza@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 108 * DAY });
    const r = resolveNew(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, advik@sarv.com`, date: 112 * DAY });
    expect(r.threadId).toBe('t-old'); // oldest wins
  });

  it('does NOT merge unrelated same-subject mail that shares only the owner (vendor A vs vendor B)', () => {
    addEmail(db, { thread: 't-A', subject: 'Monthly Invoice', from: 'billing@vendor-a.com', to: OWNER, date: 100 * DAY });
    const r = resolveNew(db, { subject: 'Monthly Invoice', from: 'billing@vendor-b.com', to: OWNER, date: 100 * DAY + 3600 });
    expect(r.via).toBe('unchanged'); // shares only the owner → 1 → not strong, not directional
  });

  it('still merges a 2-party back-and-forth within 48h via directional overlap (unchanged)', () => {
    addEmail(db, { thread: 't-A', subject: 'Project Falcon status', from: 'alice@corp.com', to: OWNER, date: 100 * DAY });
    const r = resolveNew(db, { subject: 'Re: Project Falcon status', from: OWNER, to: 'alice@corp.com', date: 100 * DAY + 3600 });
    expect(r.threadId).toBe('t-A');
  });

  it('does NOT merge a 2-party pair >48h apart (weak window still bounds directional-only)', () => {
    addEmail(db, { thread: 't-A', subject: 'Project Falcon status', from: 'alice@corp.com', to: OWNER, date: 100 * DAY });
    const r = resolveNew(db, { subject: 'Re: Project Falcon status', from: OWNER, to: 'alice@corp.com', date: 104 * DAY });
    expect(r.via).toBe('unchanged'); // directional but 4 days apart, no shared third party
  });

  it('merges a strong match months apart (a multi-month work thread within the 180-day window)', () => {
    // The reported bug: branches spanning Feb->Aug. 100 days apart, shared parties.
    addEmail(db, { thread: 't-A', subject: SUBJ, from: 'dhruv@sarv.com', to: `${OWNER}, mitali@sarv.com`, date: 100 * DAY });
    const r = resolveNew(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, mitali@sarv.com`, date: 200 * DAY });
    expect(r.threadId).toBe('t-A');
    expect(r.via).toBe('subject+participants');
  });

  it('does NOT merge a strong match beyond the 180-day candidate window', () => {
    addEmail(db, { thread: 't-A', subject: SUBJ, from: 'dhruv@sarv.com', to: `${OWNER}, mitali@sarv.com`, date: 100 * DAY });
    const r = resolveNew(db, { subject: `Re: ${SUBJ}`, from: 'hrishi@sarv.com', to: `${OWNER}, mitali@sarv.com`, date: 300 * DAY });
    expect(r.via).toBe('unchanged'); // 200 days apart → outside fetch window
  });

  // --- Gmail-parity bulk exclusion: newsletters/digests never subject-merge ---

  it('does NOT subject-merge BULK mail even with identical subject + shared participants', () => {
    // A recurring digest to owner + a shared team list — WITHOUT bulk exclusion the
    // strong rule would merge these across weeks into one giant thread.
    addEmail(db, { thread: 't-A', subject: 'Weekly Product Digest', from: 'news@vendor.com', to: `${OWNER}, team@corp.com`, date: 100 * DAY });
    const r = resolveNew(db, {
      subject: 'Weekly Product Digest', from: 'news@vendor.com', to: `${OWNER}, team@corp.com`,
      date: 107 * DAY, isBulk: true,
    });
    expect(r.via).toBe('unchanged'); // bulk → subject fallback suppressed
  });

  it('bulk mail STILL threads via a genuine In-Reply-To chain (header threading is unaffected)', () => {
    // Bulk exclusion only suppresses the SUBJECT fallback, not real RFC threading.
    addEmail(db, { thread: 't-A', subject: 'Weekly Product Digest', from: 'news@vendor.com', to: OWNER, date: 100 * DAY });
    const parentMid = (db.prepare("SELECT message_id AS m FROM emails WHERE thread_id='t-A'").get() as { m: string }).m;
    const r = resolveNew(db, {
      subject: 'Re: Weekly Product Digest', from: OWNER, to: 'news@vendor.com',
      date: 100 * DAY + 3600, isBulk: true, inReplyTo: parentMid,
    });
    expect(r.threadId).toBe('t-A');
    expect(r.via).toBe('in_reply_to');
  });
});

describe('resolveThreadId — 100-message-per-thread cap (Gmail parity)', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); idSeq = 0; });

  // Fill a thread with `n` same-subject messages; returns the first message-id.
  function fillThread(thread: string, n: number): string {
    let firstMid = '';
    for (let i = 0; i < n; i++) {
      const id = addEmail(db, { thread, subject: SUBJ, from: 'a@corp.com', to: OWNER, date: (100 + i) * 3600 });
      if (i === 0) firstMid = `<${id}>`;
    }
    return firstMid;
  }

  it('a reply into a FULL (100-message) thread starts a fresh thread', () => {
    const parentMid = fillThread('t-full', 100);
    const r = resolveNew(db, { subject: `Re: ${SUBJ}`, from: OWNER, to: 'a@corp.com', date: 300 * 3600, inReplyTo: parentMid });
    expect(r.via).toBe('capped');
    expect(r.threadId).not.toBe('t-full'); // starts its own new thread
  });

  it('a reply into a 99-message thread still joins (under the cap)', () => {
    const parentMid = fillThread('t-A', 99);
    const r = resolveNew(db, { subject: `Re: ${SUBJ}`, from: OWNER, to: 'a@corp.com', date: 300 * 3600, inReplyTo: parentMid });
    expect(r.threadId).toBe('t-A');
    expect(r.via).toBe('in_reply_to');
  });

  it('repairThreading (applyCap:false) joins even a full thread — never shatters an existing >100 thread', () => {
    const parentMid = fillThread('t-full', 100);
    const r = resolveThreadId(db, {
      id: 'x', messageId: '<x>', threadId: 't-own', subject: `Re: ${SUBJ}`,
      fromAddress: OWNER, toAddress: 'a@corp.com', ccAddress: null, date: 300 * 3600,
      inReplyTo: parentMid, references: null,
    }, { applyCap: false });
    expect(r.threadId).toBe('t-full');
    expect(r.via).toBe('in_reply_to');
  });
});

describe('resolveThreadId — owner-aware overlap merges a mail sharing ONE real correspondent', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); idSeq = 0; });

  // The reported "one mail still separate": a reply where the owner ISN'T a direct
  // participant, so it shares only ONE real party (Hrishi) with the thread — below
  // the owner-inclusive >=2 bar, but a genuine continuation.
  const resolve = (e: { from: string; to: string; date: number }, selfAddresses?: Set<string>) =>
    resolveThreadId(db, {
      id: `new${++idSeq}`, messageId: `<new${idSeq}>`, threadId: `t-own-${idSeq}`,
      subject: `Re: ${SUBJ}`, fromAddress: e.from, toAddress: e.to, ccAddress: null,
      date: e.date, inReplyTo: null, references: null,
    }, { selfAddresses });

  it('merges when self (owner) is known — one shared non-self party is enough', () => {
    addEmail(db, { thread: 't-A', subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, hrishi@sarv.com`, date: 100 * DAY });
    const r = resolve({ from: 'dhruv@sarv.com', to: 'hrishi@sarv.com', date: 170 * DAY }, new Set([OWNER]));
    expect(r.threadId).toBe('t-A');
    expect(r.via).toBe('subject+participants');
  });

  it('does NOT merge the same mail WITHOUT self — only one shared party is below the >=2 fallback', () => {
    addEmail(db, { thread: 't-A', subject: SUBJ, from: 'mitali@sarv.com', to: `${OWNER}, hrishi@sarv.com`, date: 100 * DAY });
    const r = resolve({ from: 'dhruv@sarv.com', to: 'hrishi@sarv.com', date: 170 * DAY });
    expect(r.via).toBe('unchanged');
  });

  it('still keeps vendor-A vs vendor-B apart even with self known (they share only the owner)', () => {
    addEmail(db, { thread: 't-A', subject: 'Monthly Invoice', from: 'billing@vendor-a.com', to: OWNER, date: 100 * DAY });
    const r = resolveThreadId(db, {
      id: 'vb', messageId: '<vb>', threadId: 't-vb', subject: 'Monthly Invoice',
      fromAddress: 'billing@vendor-b.com', toAddress: OWNER, ccAddress: null,
      date: 100 * DAY + 3600, inReplyTo: null, references: null,
    }, { selfAddresses: new Set([OWNER]) });
    expect(r.via).toBe('unchanged');
  });
});

// Regression: a recurring NOTIFICATION stream was collapsing into one giant
// thread. "OverTime Request is approved." arrives from one sender to the same
// recipient list forever; that permanent CC is a shared third party, so every
// issue satisfied the STRONG test — which is deliberately NOT time-bounded — and
// the 48h window never applied. Two years of monthly approvals became a single
// 24-message thread. The strong path now also demands conversation evidence
// (In-Reply-To/References, or a Re:/Fwd: subject), which a notification stream
// never carries and a real branching conversation always does.
describe('resolveThreadId — a recurring notification stream groups per burst, not forever', () => {
  let db: Database.Database;
  beforeEach(() => { db = newDb(); idSeq = 0; });

  const OT = 'OverTime Request is approved.';
  const SENDER = 'noreply@sarv.com';
  const CC = 'hr@sarv.com, manager@sarv.com';
  // One issue of the stream: same subject, same sender, same permanent CC list.
  const notify = (date: number) => ({ thread: `t-ot-${date}`, subject: OT, from: SENDER, to: OWNER, cc: CC, date });

  it('does NOT merge two issues months apart (the 24-message thread bug)', () => {
    addEmail(db, notify(100 * DAY));
    const r = resolveNew(db, { subject: OT, from: SENDER, to: OWNER, cc: CC, date: 160 * DAY });
    expect(r.via).toBe('unchanged');
  });

  it('does NOT merge months apart with self known either — the owner-aware strong path needs evidence too', () => {
    // Production always passes selfAddresses, so the >=1-real-shared-party branch
    // is the one that actually ran for the reported thread. Guarding only the
    // self-unknown branch would leave the bug in place where it happened.
    addEmail(db, notify(100 * DAY));
    const r = resolveThreadId(db, {
      id: 'ot-self', messageId: '<ot-self>', threadId: 't-ot-self', subject: OT,
      fromAddress: SENDER, toAddress: OWNER, ccAddress: CC,
      date: 160 * DAY, inReplyTo: null, references: null,
    }, { selfAddresses: new Set([OWNER]) });
    expect(r.via).toBe('unchanged');
  });

  it('STILL merges two issues inside the 48h window (weak path intact)', () => {
    // The window rule the product promises must keep working: a burst of
    // notifications about one event is one thread.
    addEmail(db, notify(100 * DAY));
    const r = resolveNew(db, { subject: OT, from: SENDER, to: OWNER, cc: CC, date: 100 * DAY + 36 * 3600 });
    expect(r.threadId).toBe(`t-ot-${100 * DAY}`);
    expect(r.via).toBe('subject+participants');
  });

  it('groups each burst separately — burst 2 does not adopt burst 1s thread', () => {
    // The end state the user should see: many small per-burst threads instead of
    // one thread spanning two years.
    addEmail(db, notify(100 * DAY));
    const burst1 = resolveNew(db, { subject: OT, from: SENDER, to: OWNER, cc: CC, date: 100 * DAY + 3600 });
    expect(burst1.threadId).toBe(`t-ot-${100 * DAY}`);

    addEmail(db, notify(200 * DAY));
    const burst2 = resolveNew(db, { subject: OT, from: SENDER, to: OWNER, cc: CC, date: 200 * DAY + 3600 });
    expect(burst2.threadId).toBe(`t-ot-${200 * DAY}`);
  });

  it('is idempotent — re-resolving an already-grouped issue keeps the same thread', () => {
    // A re-run (repairThreading after a backfill) must not walk a mail off its
    // thread or start a new one; at-least-once delivery means this runs twice.
    addEmail(db, notify(100 * DAY));
    const first = resolveNew(db, { subject: OT, from: SENDER, to: OWNER, cc: CC, date: 100 * DAY + 3600 });
    const second = resolveNew(db, { subject: OT, from: SENDER, to: OWNER, cc: CC, date: 100 * DAY + 3600 });
    expect(second.threadId).toBe(first.threadId);
  });

  it('DOES merge months apart when the arriving mail carries a Re: prefix', () => {
    // Somebody replying to a notification turns it into a conversation — that is
    // exactly what the strong path is for, and it must survive the new gate.
    addEmail(db, notify(100 * DAY));
    const r = resolveNew(db, { subject: `Re: ${OT}`, from: 'dhruv@sarv.com', to: `${SENDER}, ${OWNER}`, cc: CC, date: 160 * DAY });
    expect(r.threadId).toBe(`t-ot-${100 * DAY}`);
    expect(r.via).toBe('subject+participants');
  });

  it('DOES merge months apart when only the CANDIDATE carries the prefix (evidence is pair-level)', () => {
    // A webmail reply that drops both the prefix and the headers still belongs to
    // a thread whose other branch has them — the fragmentation the strong path
    // was added to fix, so evidence is checked on either side.
    addEmail(db, { ...notify(100 * DAY), subject: `Re: ${OT}` });
    const r = resolveNew(db, { subject: OT, from: 'dhruv@sarv.com', to: `${SENDER}, ${OWNER}`, cc: CC, date: 160 * DAY });
    expect(r.threadId).toBe(`t-ot-${100 * DAY}`);
    expect(r.via).toBe('subject+participants');
  });

  it('DOES merge months apart when the arriving mail carries In-Reply-To for a parent not in the DB', () => {
    // The original motivation for an unbounded strong path: sarv webmail sends
    // only the immediate parent, and when that parent was never synced Paths 1-2
    // miss. The header still proves this is a reply, so the merge must happen.
    addEmail(db, notify(100 * DAY));
    const r = resolveNew(db, {
      subject: OT, from: 'dhruv@sarv.com', to: `${SENDER}, ${OWNER}`, cc: CC,
      date: 160 * DAY, inReplyTo: '<parent-never-synced@sarv.com>',
    });
    expect(r.threadId).toBe(`t-ot-${100 * DAY}`);
    expect(r.via).toBe('subject+participants');
  });
});
