// Migration 96: undoing the self-referencing In-Reply-To an IMAP server's
// ENVELOPE put on nearly every message, and the spam points charged for it.
//
// What breaks if this file goes red: the org's own authenticated mail keeps
// "Claims to be a reply to itself" in its verdict — and stays filed in Spam —
// after the ingest fix, because the fix only changes what NEW mail stores.

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MigrationManager,
  SPAM_REPAIR_QUEUE_TABLE,
  createMigrationManager,
  inReplyToSelfRepair,
  type Migration,
} from '../../src/migrations';
import { openTestDb } from '../../src/test-support/test-db';

type ManagerInternals = { migrations: Migration[] };

const CHAIN: Migration[] = (() => {
  const probe = openTestDb();
  try {
    return [...(createMigrationManager(probe) as unknown as ManagerInternals).migrations];
  } finally {
    probe.close();
  }
})();

const BEFORE = inReplyToSelfRepair.version - 1;

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
});

function mailboxBefore(): Database.Database {
  const db = openTestDb();
  open.push(db);
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version <= BEFORE).forEach((m) => manager.register(m));
  manager.migrate();
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX')`).run();
  return db;
}

const SELF = { id: 'in-reply-to-self', points: 2, detail: 'Claims to be a reply to itself' };
const LINK = { id: 'link-display-mismatch', points: 4, detail: 'A link dressed as your own domain sarv.com' };
const AUTH = { id: 'auth-failed', points: 3, detail: 'DMARC failed' };

let n = 0;
function seed(
  db: Database.Database,
  row: { messageId: string; inReplyTo: string | null; score?: number | null; reasons?: string | null },
): string {
  n += 1;
  const id = `e${n}`;
  db.prepare(
    `INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, 1)`,
  ).run(`t${n}`, row.messageId, row.messageId);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       in_reply_to, spam_score, spam_reasons, raw_body, clean_body, content_type, content_hash)
     VALUES (?, ?, ?, 'f1', ?, '||', 's', 'a@b.com', 1, ?, ?, ?, '', '', 'text', ?)`,
  ).run(id, row.messageId, `t${n}`, n, row.inReplyTo, row.score ?? null, row.reasons ?? null, `h${n}`);
  return id;
}

const read = (db: Database.Database, id: string) =>
  db.prepare('SELECT in_reply_to, spam_score, spam_reasons FROM emails WHERE id = ?').get(id) as {
    in_reply_to: string | null;
    spam_score: number | null;
    spam_reasons: string | null;
  };

const queued = (db: Database.Database): string[] =>
  (db.prepare(`SELECT email_id FROM ${SPAM_REPAIR_QUEUE_TABLE} ORDER BY email_id`).all() as { email_id: string }[])
    .map((r) => r.email_id);

const scoreBefore = (db: Database.Database, id: string): number | null =>
  (db.prepare(`SELECT score_before FROM ${SPAM_REPAIR_QUEUE_TABLE} WHERE email_id = ?`).get(id) as {
    score_before: number | null;
  }).score_before;

describe('v96 in_reply_to_self_repair', () => {
  // THE regression: the stored reason and its points come off, the score is
  // re-summed from what is left, and the row is queued for re-filing.
  it('clears the self-reference, drops its reason and re-sums the score', () => {
    const db = mailboxBefore();
    const id = seed(db, {
      messageId: '<own@sarv.com>',
      inReplyTo: '<own@sarv.com>',
      score: 6,
      reasons: JSON.stringify([SELF, LINK]),
    });
    inReplyToSelfRepair.up(db, {});
    const row = read(db, id);
    expect(row.in_reply_to).toBeNull();
    expect(row.spam_score).toBe(4);
    expect(JSON.parse(row.spam_reasons!).map((r: { id: string }) => r.id)).toEqual(['link-display-mismatch']);
    expect(queued(db)).toEqual([id]);
    // The score the filter FILED on, not the re-summed one: it is how the
    // repair tells a filter-filed row from one the AI tagged (the AI rewrites
    // the tag, so the tag cannot say). Queued with 4, this row would never
    // come back out of Spam.
    expect(scoreBefore(db, id)).toBe(6);
  });

  // The server stored message_id bare and in_reply_to bracketed: the same id.
  it('matches a Message-ID stored without angle brackets', () => {
    const db = mailboxBefore();
    const id = seed(db, { messageId: 'bare@x.example', inReplyTo: '<bare@x.example>' });
    inReplyToSelfRepair.up(db, {});
    expect(read(db, id).in_reply_to).toBeNull();
  });

  // A real reply names its parent; that is data and must survive.
  it('leaves a genuine In-Reply-To and its verdict alone', () => {
    const db = mailboxBefore();
    const reasons = JSON.stringify([AUTH]);
    const id = seed(db, { messageId: '<child@x>', inReplyTo: '<parent@x>', score: 3, reasons });
    inReplyToSelfRepair.up(db, {});
    expect(read(db, id)).toEqual({ in_reply_to: '<parent@x>', spam_score: 3, spam_reasons: reasons });
    expect(queued(db)).toEqual([]);
  });

  // Unreadable reasons and a non-zero score: "clean" and "could not read" are
  // the same value, so the score stays; the bad column is still cleared.
  it('keeps the score when the stored reasons cannot be read', () => {
    const db = mailboxBefore();
    const id = seed(db, { messageId: '<m@x>', inReplyTo: '<m@x>', score: 5, reasons: '{not json' });
    inReplyToSelfRepair.up(db, {});
    expect(read(db, id)).toMatchObject({ in_reply_to: null, spam_score: 5, spam_reasons: '{not json' });
    expect(queued(db)).toEqual([]);
  });

  // Never-scored rows (own mail, pre-filter) stay "not judged".
  it('does not invent a score for a row that was never scored', () => {
    const db = mailboxBefore();
    const id = seed(db, { messageId: '<m@x>', inReplyTo: '<m@x>', score: null, reasons: null });
    inReplyToSelfRepair.up(db, {});
    expect(read(db, id)).toEqual({ in_reply_to: null, spam_score: null, spam_reasons: null });
  });

  // mailguard 0.4.2 changed what counts as a deceptive link; only the content
  // stage over the stored body can correct those verdicts, so they are queued.
  it('queues every row carrying a link-mismatch reason for the content stage', () => {
    const db = mailboxBefore();
    const id = seed(db, { messageId: '<m@x>', inReplyTo: null, score: 4, reasons: JSON.stringify([LINK]) });
    inReplyToSelfRepair.up(db, {});
    expect(read(db, id).spam_score).toBe(4);
    expect(queued(db)).toEqual([id]);
    expect(scoreBefore(db, id)).toBe(4);
  });

  // A migration that runs twice (a crash before the version stamp) must not
  // take points off twice or duplicate queue rows.
  it('is idempotent', () => {
    const db = mailboxBefore();
    const id = seed(db, {
      messageId: '<own@x>',
      inReplyTo: '<own@x>',
      score: 6,
      reasons: JSON.stringify([SELF, LINK]),
    });
    inReplyToSelfRepair.up(db, {});
    inReplyToSelfRepair.up(db, {});
    expect(read(db, id).spam_score).toBe(4);
    expect(queued(db)).toEqual([id]);
    // The re-run finds the link reason and queues again — the original
    // pre-repair score must survive it.
    expect(scoreBefore(db, id)).toBe(6);
  });

  it('down drops the queue table', () => {
    const db = mailboxBefore();
    inReplyToSelfRepair.up(db, {});
    inReplyToSelfRepair.down!(db, {});
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(SPAM_REPAIR_QUEUE_TABLE),
    ).toBeUndefined();
  });
});
