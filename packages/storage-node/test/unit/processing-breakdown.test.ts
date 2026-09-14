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
  opts: { body?: string; aiProcessed?: boolean } = {},
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
       raw_body_len, clean_body_len, content_type, content_hash, ai_processed_at)
     VALUES (?, ?, ?, 'f1', ?, ?, 's', 'a@b.com', 1, ?, ?, ?, ?, 'text', ?, ?)`,
  ).run(
    `e${n}`, `<m${n}@x>`, `t${n}`, n, tags,
    body, body, body.length, body.length, `h${n}`, opts.aiProcessed ? 1 : null,
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
