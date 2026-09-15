import { describe, it, expect } from 'vitest';

import { processingBreakdown } from '../../src/repositories/agent-eligibility';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * The AI dashboard's "processing breakdown" panel.
 *
 * THE complaint this pins: "Unread + with body (eligible pool)" sat at 554 and
 * "Unread + no body yet" at 757, and neither fell however much mail was read.
 * Both queries lacked the folder exclusions that the `Eligible right now` row
 * directly above them applies, so they counted unread mail in Trash, Spam and
 * Junk — mail the user will never open. With ~1,000 unread in Trash against
 * ~358 in the inbox, three quarters of the number was deleted mail that had
 * never been opened, so reading could not move it.
 *
 * The row is LABELLED "eligible pool" in the UI. A number under that label has
 * to describe mail that can actually become eligible, or the panel is telling
 * the user something untrue about their own mailbox.
 */

let n = 0;
/** Insert one email. `tags` is the pipe-delimited membership+flags string. */
function seed(
  db: ReturnType<typeof newMigratedDb>,
  tags: string,
  opts: {
    body?: string;
    aiProcessed?: boolean;
    /** agent pipeline state — separate from aiProcessed, see agentPending. */
    agentStatus?: 'pending' | 'done';
    extractionDone?: boolean;
    /** Older than everything else, to fall outside the recent window. */
    old?: boolean;
  } = {},
) {
  n += 1;
  const body = opts.body ?? '';
  db.prepare(
    `INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, 1)`,
  ).run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags,
       subject, from_address, date, raw_body, clean_body,
       raw_body_len, clean_body_len, content_type, content_hash, ai_processed_at,
       agent_status, extraction_status)
     VALUES (?, ?, ?, 'f1', ?, ?, 's', 'a@b.com', ?, ?, ?, ?, ?, 'text', ?, ?, ?, ?)`,
  ).run(
    `e${n}`, `<m${n}@x>`, `t${n}`, n, tags, opts.old ? 1 : 1_000_000 + n,
    body, body, body.length, body.length, `h${n}`, opts.aiProcessed ? 1 : null,
    opts.agentStatus ?? null, opts.extractionDone === false ? 'pending' : 'done',
  );
}

const fresh = () => {
  n = 0; // ids restart with the database, so `e1` always means "the first seeded"
  const db = newMigratedDb();
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX')`).run();
  return db;
};

describe('processingBreakdown — the unread rows', () => {
  // THE regression. Unread mail sitting in Trash is not an eligible pool; it is
  // deleted mail, and counting it made the figure look permanently stuck.
  it('excludes unread mail in Trash from both unread rows', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });          // unread, has body  → counts
    seed(db, '|Trash|', { body: 'hello' });          // unread in Trash   → excluded
    seed(db, '|INBOX|');                             // unread, no body   → counts
    seed(db, '|Trash|');                             // unread, no body, Trash → excluded

    const b = processingBreakdown(db);

    expect(b.unreadWithBody).toBe(1);
    expect(b.unreadNoBody).toBe(1);
  });

  it('excludes Spam and Junk for the same reason', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|Spam|', { body: 'hello' });
    seed(db, '|Junk|', { body: 'hello' });
    seed(db, '|[Gmail]/Spam|', { body: 'hello' });

    expect(processingBreakdown(db).unreadWithBody).toBe(1);
  });

  // The rows say UNREAD. Read mail belongs to `readSkipped`, and letting it in
  // here would make the pool grow as the user worked through their inbox.
  it('counts only unread mail, never read', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|INBOX|read|', { body: 'hello' });

    const b = processingBreakdown(db);

    expect(b.unreadWithBody).toBe(1);
    expect(b.readSkipped).toBe(1);
  });

  // The point of the whole panel: reading mail must visibly shrink the pool.
  it('falls when mail is read — the behaviour the user expected', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|INBOX|', { body: 'hello' });
    expect(processingBreakdown(db).unreadWithBody).toBe(2);

    db.prepare(`UPDATE emails SET tags = '|INBOX|read|' WHERE id = 'e1'`).run();

    expect(processingBreakdown(db).unreadWithBody).toBe(1);
  });

  // Body presence is what splits the two rows, and it decides whether the AI
  // can do anything with the message at all.
  it('splits on whether the body has been downloaded', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|INBOX|');

    const b = processingBreakdown(db);

    expect(b.unreadWithBody).toBe(1);
    expect(b.unreadNoBody).toBe(1);
  });
});

describe('processingBreakdown — the mailbox totals', () => {
  // `total` is deliberately the WHOLE mailbox, Trash included: it answers "how
  // much mail is there", not "how much can the AI work on". Narrowing it would
  // make the panel's arithmetic stop adding up.
  it('counts every message in total, including Trash', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|Trash|', { body: 'hello' });

    const b = processingBreakdown(db);

    expect(b.total).toBe(2);
    expect(b.withBody).toBe(2);
    expect(b.unreadWithBody).toBe(1); // …but the eligible pool is not
  });

  it('splits the mailbox into withBody + noBody with nothing lost', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|INBOX|');
    seed(db, '|Trash|');

    const b = processingBreakdown(db);

    expect(b.withBody + b.noBody).toBe(b.total);
  });

  it('reports an empty mailbox as all zeroes rather than throwing', () => {
    const b = processingBreakdown(fresh());
    expect(b).toMatchObject({ total: 0, withBody: 0, noBody: 0, unreadWithBody: 0, unreadNoBody: 0 });
  });
});

describe('processingBreakdown — eligibility', () => {
  // `eligibleNow` asks "never AI-processed", so a processed message drops out
  // even though it is still unread with a body.
  it('excludes mail the AI has already finished with', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' });
    seed(db, '|INBOX|', { body: 'hello', aiProcessed: true });

    const b = processingBreakdown(db);

    expect(b.eligibleNow).toBe(1);
    expect(b.aiProcessed).toBe(1);
    // Both are still unread with a body, so the pool row counts both.
    expect(b.unreadWithBody).toBe(2);
  });

  // The two rows are built from the same exclusion list, so a Trash message can
  // never be eligible NOR appear in the pool that claims to describe eligibility.
  it('keeps eligibleNow and the pool agreeing about Trash', () => {
    const db = fresh();
    seed(db, '|Trash|', { body: 'hello' });

    const b = processingBreakdown(db);

    expect(b.eligibleNow).toBe(0);
    expect(b.unreadWithBody).toBe(0);
  });
});


/**
 * The agent pipeline's own backlog.
 *
 * THE complaint: the panel read "100% complete, 0 pending" for a solid hour
 * while the agent worked through 252 emails — scoring them, assigning
 * categories, even auto-drafting replies. The bar only ever measured
 * CATEGORIZATION (`ai_processed_at`), which was genuinely finished; the agent
 * runs on `agent_status` and had no row at all. The user reasonably read
 * "0 pending" as "nothing is happening" and asked why processing had stopped.
 */
describe('processingBreakdown — the agent pipeline', () => {
  it('counts what the agent still has to do', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'pending' });
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'done' });

    const b = processingBreakdown(db);

    expect(b.agentPending).toBe(1);
    expect(b.agentDone).toBe(1);
  });

  // THE bug this row exists to make visible: categorization finished, agent
  // did not. The two numbers have to be able to disagree.
  it('reports agent work outstanding even when categorization is finished', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', aiProcessed: true, agentStatus: 'pending' });

    const b = processingBreakdown(db);

    expect(b.eligibleNow).toBe(0);   // the bar's input — nothing left
    expect(b.agentPending).toBe(1);  // …but the agent is still working
  });

  // The agent's worker skips rows whose body has not been extracted yet, so
  // counting them would show a backlog the poll cannot actually take on.
  it('ignores rows the agent worker cannot select yet', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'pending', extractionDone: false });
    seed(db, '|INBOX|', { agentStatus: 'pending' });                       // no body
    seed(db, '|INBOX|read|', { body: 'hello', agentStatus: 'pending' });   // read
    seed(db, '|Trash|', { body: 'hello', agentStatus: 'pending' });        // deleted

    expect(processingBreakdown(db).agentPending).toBe(0);
  });

  // THE reason the window is passed in at all. With a cap of 500 and a row
  // older than the newest 500, the poll can never reach it — so counting it
  // would reproduce the exact "number that never moves" bug this panel keeps
  // being reported for.
  it('counts only what the poll can reach within the user\'s window', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'pending', old: true });
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'pending' });

    // Window of 1 = only the newest row is reachable.
    expect(processingBreakdown(db, { recentWindow: 1 }).agentPending).toBe(1);
    // A window wide enough for both.
    expect(processingBreakdown(db, { recentWindow: 500 }).agentPending).toBe(2);
  });

  // Omitting the window must mean "no window", matching getEmailsPendingAgent,
  // rather than silently defaulting to some cap the caller never chose.
  it('applies no window when none is given', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'pending', old: true });

    expect(processingBreakdown(db).agentPending).toBe(1);
  });
});

/**
 * ONE number for "what does the AI still owe me".
 *
 * THE complaint: the panel showed "0 pending" from the categorizer beside
 * "agent: 196 to go" from the agent. Both mean outstanding work; they disagreed
 * because they measure different pipelines; and a user looking at a progress
 * bar does not care which internal queue owes the work. Two numbers for one
 * question is the same defect as the mislabelled "eligible pool" row.
 */
describe('processingBreakdown — one merged pending count', () => {
  it('counts work the categorizer still owes', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello' }); // never processed
    expect(processingBreakdown(db).pending).toBe(1);
  });

  it('counts work the agent still owes', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', aiProcessed: true, agentStatus: 'pending' });
    expect(processingBreakdown(db).pending).toBe(1);
  });

  // THE arithmetic that matters. An email owed work by BOTH pipelines is ONE
  // pending email — summing the two rows would double-count it and make the
  // progress bar move at half speed for the rest of the run.
  it('counts an email owed by both pipelines exactly once', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', agentStatus: 'pending' }); // neither done

    const b = processingBreakdown(db);

    expect(b.eligibleNow).toBe(1);
    expect(b.agentPending).toBe(1);
    expect(b.pending).toBe(1); // …not 2
  });

  it('is zero when both pipelines are finished', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', aiProcessed: true, agentStatus: 'done' });
    expect(processingBreakdown(db).pending).toBe(0);
  });

  // Deleted and read mail is not outstanding work — the headline must not
  // report a backlog the pipelines will never touch. This is the bug that made
  // the "eligible pool" row look permanently stuck.
  it('ignores mail neither pipeline will ever process', () => {
    const db = fresh();
    seed(db, '|Trash|', { body: 'hello', agentStatus: 'pending' });
    seed(db, '|INBOX|read|', { body: 'hello', agentStatus: 'pending' });
    seed(db, '|INBOX|', { agentStatus: 'pending' }); // no body

    expect(processingBreakdown(db).pending).toBe(0);
  });

  // The agent half honours the user's window; the headline must too, or it
  // shows a backlog the poll cannot reach — the never-moving number again.
  it('respects the window for the agent half', () => {
    const db = fresh();
    seed(db, '|INBOX|', { body: 'hello', aiProcessed: true, agentStatus: 'pending', old: true });
    seed(db, '|INBOX|', { body: 'hello', aiProcessed: true, agentStatus: 'pending' });

    expect(processingBreakdown(db, { recentWindow: 1 }).pending).toBe(1);
    expect(processingBreakdown(db, { recentWindow: 500 }).pending).toBe(2);
  });
});
