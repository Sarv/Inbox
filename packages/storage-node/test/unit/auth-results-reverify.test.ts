// Migration 101 and its queue: re-reading the authentication verdicts that
// mailguard < 0.4.3 derived from forged `Authentication-Results` headers.
//
// What breaks if this file goes red: mail whose sender forged `dmarc=pass`
// keeps its green verdict after the parser fix — the trusted-sender spam bypass,
// the automatic image loading, the verified tick and the missing phishing
// banner all go on resting on a header the sender typed — because the fix only
// changes how NEW mail is read.

import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTH_REVERIFY_QUEUE_TABLE,
  AUTH_REVERIFY_WINDOW_DAYS,
  HEADER_STAGE_MAX_ATTEMPTS,
  MigrationManager,
  SPAM_REPAIR_QUEUE_TABLE,
  authResultsReverify,
  createMigrationManager,
  type Migration,
} from '../../src/migrations';
import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb, openTestDb } from '../../src/test-support/test-db';

type ManagerInternals = { migrations: Migration[] };

const CHAIN: Migration[] = (() => {
  const probe = openTestDb();
  try {
    return [...(createMigrationManager(probe) as unknown as ManagerInternals).migrations];
  } finally {
    probe.close();
  }
})();

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
});

/** A mailbox migrated up to just before v101, with one folder. */
function mailboxBefore(): Database.Database {
  const db = openTestDb();
  open.push(db);
  const manager = new MigrationManager(db);
  CHAIN.filter((m) => m.version < authResultsReverify.version).forEach((m) => manager.register(m));
  manager.migrate();
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX'), ('f2','Archive','Archive')`).run();
  return db;
}

const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;
const PASS = JSON.stringify({ spf: 'pass', dkim: 'pass', dmarc: 'pass', overall: 'pass' });
const FAIL = JSON.stringify({ spf: 'fail', dkim: 'none', dmarc: 'fail', overall: 'fail' });
const UNKNOWN = JSON.stringify({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', overall: 'none' });
const AUTH_FAILED = { id: 'auth-failed', points: 3, detail: 'DMARC failed — the sender’s domain did not authenticate this message' };
const BULK = { id: 'bulk-no-unsubscribe', points: 1, detail: 'Bulk mail with no unsubscribe' };
const SPOOF = { id: 'display-name-spoof', points: 3, detail: 'The sender name mentions paypal.com' };

let n = 0;
function seed(
  db: Database.Database,
  row: {
    auth?: string | null;
    date?: number;
    uid?: number | null;
    folder?: string;
    score?: number | null;
    reasons?: string | null;
  } = {},
): string {
  n += 1;
  const id = `e${n}`;
  db.prepare(
    `INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, 1)`,
  ).run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       auth_status, spam_score, spam_reasons, raw_body, clean_body, content_type, content_hash)
     VALUES (?, ?, ?, ?, ?, '||', 's', 'a@b.com', ?, ?, ?, ?, '', '', 'text', ?)`,
  ).run(
    id, `<m${n}@x>`, `t${n}`, row.folder ?? 'f1',
    row.uid === undefined ? n : row.uid,
    row.date ?? NOW() - DAY,
    row.auth === undefined ? PASS : row.auth,
    row.score ?? null, row.reasons ?? null, `h${n}`,
  );
  return id;
}

const queued = (db: Database.Database): string[] =>
  (db.prepare(`SELECT email_id FROM ${AUTH_REVERIFY_QUEUE_TABLE} ORDER BY email_id`).all() as { email_id: string }[])
    .map((r) => r.email_id);

describe('v101 auth_results_reverify', () => {
  // THE point: recent mail whose stored verdict asserts something is queued
  // for a re-read — a pass (possibly forged) and a fail (possibly read from an
  // untrusted hop) alike.
  it('queues recent mail with a stored verdict that asserts something', () => {
    const db = mailboxBefore();
    const pass = seed(db, { auth: PASS });
    const fail = seed(db, { auth: FAIL });
    authResultsReverify.up(db, {});
    expect(queued(db)).toEqual([pass, fail].sort());
  });

  // What cannot change is left alone: an all-unknown verdict (the old reader
  // found no verdict text at all, and the new one reads a subset of it), no
  // verdict yet (the header backfill owns those), old mail, and mail with no
  // uid to fetch by.
  it('skips all-unknown and missing verdicts, mail older than the window, and unfetchable rows', () => {
    const db = mailboxBefore();
    seed(db, { auth: UNKNOWN });
    seed(db, { auth: null });
    seed(db, { date: NOW() - (AUTH_REVERIFY_WINDOW_DAYS + 1) * DAY });
    seed(db, { uid: 0 });
    seed(db, { uid: null });
    authResultsReverify.up(db, {});
    expect(queued(db)).toEqual([]);
  });

  // A verdict the column cannot parse is the one case nobody can reason about
  // from the stored value — re-reading it from the server can only help.
  it('queues a verdict that will not parse', () => {
    const db = mailboxBefore();
    const broken = seed(db, { auth: '{not json' });
    const nullJson = seed(db, { auth: 'null' });
    authResultsReverify.up(db, {});
    expect(queued(db)).toEqual([broken, nullJson].sort());
  });

  // A second run (a restored backup, a re-applied chain) queues nothing twice
  // and resets no attempt counts.
  it('is idempotent', () => {
    const db = mailboxBefore();
    const id = seed(db);
    authResultsReverify.up(db, {});
    db.prepare(`UPDATE ${AUTH_REVERIFY_QUEUE_TABLE} SET attempts = 2`).run();
    authResultsReverify.up(db, {});
    expect(queued(db)).toEqual([id]);
    expect(db.prepare(`SELECT attempts FROM ${AUTH_REVERIFY_QUEUE_TABLE}`).get()).toEqual({ attempts: 2 });
  });

  it('drops only the queue on the way down', () => {
    const db = mailboxBefore();
    seed(db);
    authResultsReverify.up(db, {});
    authResultsReverify.down!(db, {});
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(AUTH_REVERIFY_QUEUE_TABLE);
    expect(table).toBeUndefined();
    expect((db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n).toBe(1);
  });
});

/** A storage over a fully migrated DB, with the queue filled by hand. */
function storage(): { s: SQLiteStorage; db: Database.Database } {
  n = 0;
  const db = newMigratedDb();
  open.push(db);
  db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX'), ('f2','Archive','Archive')`).run();
  const s = Object.create(SQLiteStorage.prototype) as SQLiteStorage;
  (s as unknown as { db: unknown }).db = db;
  (s as unknown as { ensureInitialized: () => void }).ensureInitialized = () => {};
  return { s, db };
}

const enqueue = (db: Database.Database, ...ids: string[]) => {
  for (const id of ids) db.prepare(`INSERT INTO ${AUTH_REVERIFY_QUEUE_TABLE} (email_id) VALUES (?)`).run(id);
};

const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT auth_status, spam_score, spam_reasons FROM emails WHERE id = ?').get(id) as {
    auth_status: string | null;
    spam_score: number | null;
    spam_reasons: string | null;
  };

const repairQueue = (db: Database.Database) =>
  db.prepare(`SELECT email_id, score_before FROM ${SPAM_REPAIR_QUEUE_TABLE} ORDER BY email_id`).all();

describe('the re-check queue in storage', () => {
  // The backfill fetches by folder and uid; newest first so the mail a reader
  // is most likely to open is corrected first.
  it('hands out queued rows newest first, with the folder the fetch needs', () => {
    const { s, db } = storage();
    const older = seed(db, { date: 100, folder: 'f2' });
    const newer = seed(db, { date: 200 });
    seed(db, { date: 300 }); // not queued
    enqueue(db, older, newer);
    expect(s.getAuthReverifyBatch(10)).toEqual([
      { id: newer, uid: 2, folderPath: 'INBOX', folderId: 'f1' },
      { id: older, uid: 1, folderPath: 'Archive', folderId: 'f2' },
    ]);
    expect(s.getAuthReverifyBatch(1)).toHaveLength(1);
    expect(s.countAuthReverify()).toBe(2);
  });

  // Transient vs permanent: one miss is a blip and the row stays; after
  // HEADER_STAGE_MAX_ATTEMPTS it is an expunge, and the row stops being asked
  // for — keeping the verdict it has — instead of being fetched every tick.
  it('retires a row after HEADER_STAGE_MAX_ATTEMPTS misses, not before', () => {
    const { s, db } = storage();
    const id = seed(db);
    enqueue(db, id);
    for (let i = 1; i < HEADER_STAGE_MAX_ATTEMPTS; i += 1) {
      expect(s.recordAuthReverifyMiss([id])).toBe(1);
      expect(s.getAuthReverifyBatch(10).map((r) => r.id)).toEqual([id]);
    }
    s.recordAuthReverifyMiss([id]);
    expect(s.getAuthReverifyBatch(10)).toEqual([]);
    expect(s.countAuthReverify()).toBe(0);
    expect(s.recordAuthReverifyMiss([])).toBe(0);
  });

  // A row whose uid went to 0 (a local copy) cannot be fetched and is not handed out.
  it('does not hand out a queued row that has lost its uid', () => {
    const { s, db } = storage();
    const id = seed(db, { uid: 0 });
    enqueue(db, id);
    expect(s.getAuthReverifyBatch(10)).toEqual([]);
  });

  // A database without the queue (a downgrade, a partial profile) reads as
  // "nothing to do", never as a crash in the main process.
  it('reads as empty on a database without the queue', () => {
    const { s, db } = storage();
    db.exec(`DROP TABLE ${AUTH_REVERIFY_QUEUE_TABLE}`);
    expect(s.getAuthReverifyBatch(10)).toEqual([]);
    expect(s.countAuthReverify()).toBe(0);
  });
});

describe('applyAuthReverify', () => {
  // THE regression: a forged `dmarc=pass` hid the real failure. The verdict is
  // replaced, and the spam verdict gains the `auth-failed` reason it would
  // have had on arrival, re-summed.
  it('replaces a forged pass with the real failure and charges auth-failed', () => {
    const { s, db } = storage();
    const id = seed(db, { auth: PASS, score: 1, reasons: JSON.stringify([BULK]) });
    enqueue(db, id);
    expect(s.applyAuthReverify([{ id, authStatus: FAIL, authReasons: [AUTH_FAILED] }])).toEqual({
      written: 1,
      repairQueued: 0,
    });
    const after = row(db, id);
    expect(after.auth_status).toBe(FAIL);
    expect(after.spam_score).toBe(4);
    expect(JSON.parse(after.spam_reasons!).map((r: { id: string }) => r.id)).toEqual(['bulk-no-unsubscribe', 'auth-failed']);
    expect(queued(db)).toEqual([]);
  });

  // Pushed OVER the line by the correction: the verdict says spam, but the
  // message is not moved — the shield and banner now say what is wrong, and old
  // mail vanishing from the inbox is not the repair's call to make.
  it('does not queue a message pushed over the spam line for any move', () => {
    const { s, db } = storage();
    const id = seed(db, { auth: PASS, score: 3, reasons: JSON.stringify([SPOOF]) });
    enqueue(db, id);
    expect(s.applyAuthReverify([{ id, authStatus: FAIL, authReasons: [AUTH_FAILED] }]).repairQueued).toBe(0);
    expect(row(db, id).spam_score).toBe(6);
    expect(repairQueue(db)).toEqual([]);
  });

  // The other direction: a failure the old reader took from an untrusted hop
  // filed ordinary mail. Taken back under the line, it is handed to the spam
  // repair WITH the score it was filed on — the repair's only way to tell a
  // filter-filed row from one the AI tagged.
  it('hands a message taken back under the spam line to the spam repair', () => {
    const { s, db } = storage();
    const id = seed(db, { auth: FAIL, score: 6, reasons: JSON.stringify([SPOOF, AUTH_FAILED]) });
    enqueue(db, id);
    expect(s.applyAuthReverify([{ id, authStatus: PASS, authReasons: [] }])).toEqual({ written: 1, repairQueued: 1 });
    expect(row(db, id).spam_score).toBe(3);
    expect(repairQueue(db)).toEqual([{ email_id: id, score_before: 6 }]);
  });

  // Nothing changed: the row is taken off the queue but not rewritten — every
  // re-checked message being rewritten for no difference would be churn on the
  // mail table with nothing to show for it.
  it('dequeues without writing when the re-read verdict is the stored one', () => {
    const { s, db } = storage();
    const reasons = JSON.stringify([BULK, AUTH_FAILED]);
    const id = seed(db, { auth: FAIL, score: 4, reasons });
    enqueue(db, id);
    expect(s.applyAuthReverify([{ id, authStatus: FAIL, authReasons: [AUTH_FAILED] }])).toEqual({
      written: 0,
      repairQueued: 0,
    });
    expect(row(db, id)).toEqual({ auth_status: FAIL, spam_score: 4, spam_reasons: reasons });
    expect(queued(db)).toEqual([]);
  });

  // Own mail and mail that predates the filter have no score: only the auth
  // verdict is corrected, and "not judged" stays not judged.
  it('corrects only the verdict on a row that was never scored', () => {
    const { s, db } = storage();
    const id = seed(db, { auth: PASS, score: null });
    enqueue(db, id);
    expect(s.applyAuthReverify([{ id, authStatus: FAIL, authReasons: [AUTH_FAILED] }]).written).toBe(1);
    expect(row(db, id)).toEqual({ auth_status: FAIL, spam_score: null, spam_reasons: null });
  });

  // Unreadable reasons and a non-zero score: "clean" and "could not read" are
  // the same value and opposite facts, so the score is kept as it is. The
  // verdict, which does not depend on the column, is still corrected.
  it('keeps a score whose reasons cannot be read, but corrects the verdict', () => {
    const { s, db } = storage();
    const id = seed(db, { auth: PASS, score: 5, reasons: '{not json' });
    enqueue(db, id);
    s.applyAuthReverify([{ id, authStatus: FAIL, authReasons: [AUTH_FAILED] }]);
    expect(row(db, id)).toEqual({ auth_status: FAIL, spam_score: 5, spam_reasons: '{not json' });
  });

  // A message deleted between the fetch and the write has nothing left to
  // correct; its queue entry must still go, or it would be handed out forever.
  it('takes a vanished message off the queue', () => {
    const { s, db } = storage();
    enqueue(db, 'gone');
    expect(s.applyAuthReverify([{ id: 'gone', authStatus: PASS, authReasons: [] }]).written).toBe(0);
    expect(queued(db)).toEqual([]);
    expect(s.applyAuthReverify([])).toEqual({ written: 0, repairQueued: 0 });
  });
});
