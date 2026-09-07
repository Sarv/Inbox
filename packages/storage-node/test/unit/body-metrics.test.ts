import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BodyStorageBackfill } from '../../src/body-storage-backfill';
import {
  areBodyLengthsReady,
  bodyLengthSetClauses,
  fastHasBodyExpression,
  legacyHasBodyExpression,
  markBodyLengthsReady,
  rawBodyLengthExpression,
} from '../../src/repositories/body-metrics';
import { EmailRepository } from '../../src/repositories/email-repository';
import { newMigratedDb } from '../../src/test-support/test-db';

// What breaks if this file fails: mail stops being categorized, and nobody
// notices.
//
// `clean_body_len`/`raw_body_len` exist so "does this email have a body?" can be
// answered from an index instead of by reading a 300 KB body off disk. The whole
// speedup rests on one invariant: the stored length must give the SAME verdict
// the body-reading expression would have given, for EVERY row. Two ways that
// breaks, both silent:
//
//  1. A row whose length columns are NULL (it predates the migration, or a
//     writer forgot them) reads as `NULL > 0` = false = "no body", so the AI
//     pipeline skips it forever. No error, no retry — the email just never gets
//     categorized.
//  2. A length computed differently from `LENGTH(TRIM(body))` — in JS, say —
//     flips the verdict on whitespace-only and emoji-bearing bodies.
//
// So every test here is ultimately the same assertion from a different angle:
// the fast expression and the legacy expression select exactly the same rows.

const NOW = 1780315200; // 2026-06-15T12:00:00Z

interface Seed {
  id: string;
  cleanBody?: string;
  rawBody?: string;
  /** Leave the length columns NULL, i.e. pretend this row predates the migration. */
  legacyRow?: boolean;
}

function seed(db: Database.Database, s: Seed): void {
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(`t-${s.id}`, `<${s.id}>`, `<${s.id}>`, NOW);

  const clean = s.cleanBody ?? 'clean body';
  const raw = s.rawBody ?? 'raw body';
  const lengths = s.legacyRow ? 'NULL, NULL' : 'LENGTH(TRIM(?)), LENGTH(TRIM(?))';
  const params: unknown[] = [s.id, `<${s.id}>`, `t-${s.id}`, `|INBOX|`, NOW, clean, raw];
  if (!s.legacyRow) params.push(clean, raw);
  params.push(`hash-${s.id}`);

  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       clean_body, raw_body, clean_body_len, raw_body_len, content_type, content_hash
     ) VALUES (?, ?, ?, 'f-inbox', 0, ?, 's', 'a@b.example', ?, ?, ?, ${lengths}, 'text', ?)`,
  ).run(...params);
}

/** Ids selected by an arbitrary WHERE expression, sorted. */
const select = (db: Database.Database, where: string): string[] =>
  (db.prepare(`SELECT id FROM emails WHERE ${where} ORDER BY id`).all() as Array<{ id: string }>)
    .map((r) => r.id);

/** Pretend the whole DB predates migration v72. */
function makeUnbackfilled(db: Database.Database): void {
  db.exec('UPDATE emails SET clean_body_len = NULL, raw_body_len = NULL');
  db.prepare("UPDATE email_body_metrics_state SET value = '0' WHERE key = 'lengths_backfilled'").run();
}

describe('body-metrics SQL builders (pure)', () => {
  // These strings are interpolated straight into SQL, so a typo here is a
  // syntax error at runtime in whichever query happens to run first.
  it('builds a length SET clause only for the body fields a patch actually touches', () => {
    expect(bodyLengthSetClauses({})).toEqual([]);
    expect(bodyLengthSetClauses({ cleanBody: 'x' })).toEqual([
      'clean_body_len = LENGTH(TRIM(@cleanBody))',
    ]);
    expect(bodyLengthSetClauses({ rawBody: 'x' })).toEqual([
      'raw_body_len = LENGTH(TRIM(@rawBody))',
    ]);
    expect(bodyLengthSetClauses({ cleanBody: '', rawBody: '' })).toHaveLength(2);
  });

  // An empty-string body is a real value that must still refresh the stored
  // length — otherwise clearing a body leaves the row claiming it has one.
  it('treats an empty-string body as present and undefined as absent', () => {
    expect(bodyLengthSetClauses({ cleanBody: '' })).toHaveLength(1);
    expect(bodyLengthSetClauses({ cleanBody: undefined })).toHaveLength(0);
  });

  // The fast expression must not MENTION a body column even in a dead branch:
  // SQLite decides index coverage from the columns a query names, so one textual
  // reference re-introduces the overflow-page walk the columns exist to avoid.
  it('never names a body column in the fast expression', () => {
    const fast = fastHasBodyExpression('e');
    expect(fast).not.toMatch(/clean_body\b/);
    expect(fast).not.toMatch(/raw_body\b/);
    expect(fast).toBe('(e.clean_body_len > 0 OR e.raw_body_len > 0)');
  });

  it('qualifies with an alias only when one is given', () => {
    expect(fastHasBodyExpression()).toBe('(clean_body_len > 0 OR raw_body_len > 0)');
    expect(legacyHasBodyExpression('e')).toContain('e.clean_body');
    expect(rawBodyLengthExpression('emails', true)).toBe('emails.raw_body_len');
    // The slow form used to be `length(emails.raw_body)`. Since migration 73 it
    // measures the EFFECTIVE body — through `email_bodies`, falling back to the
    // inline column — because on a relocated row the inline column is empty and
    // `length('')` is 0, which would drop every email out of a size filter.
    const slow = rawBodyLengthExpression('emails', false);
    expect(slow).toContain('email_bodies');
    expect(slow).toContain('emails.raw_body');
    expect(slow.startsWith('length(')).toBe(true);
  });
});

describe('body-metrics readiness flag', () => {
  it('is already complete on a fresh database — a new install has nothing to backfill', () => {
    const db = newMigratedDb();
    expect(areBodyLengthsReady(db)).toBe(true);
  });

  // A DB predating v72 has no state table at all. Reading that as "ready" would
  // apply the fast expression to columns that do not exist / are all NULL, i.e.
  // declare the entire mailbox body-less.
  it('reports NOT ready when the state table is missing', () => {
    const db = newMigratedDb();
    db.exec('DROP TABLE email_body_metrics_state');
    expect(areBodyLengthsReady(db)).toBe(false);
  });

  it('reports NOT ready while the flag is 0, and ready once marked', () => {
    const db = newMigratedDb();
    makeUnbackfilled(db);
    expect(areBodyLengthsReady(db)).toBe(false);
    markBodyLengthsReady(db);
    expect(areBodyLengthsReady(db)).toBe(true);
  });

  // Multi-account: every account is a separate database file with its own
  // backfill progress. A module-level flag would let a freshly-added account
  // borrow a long-running one's "ready" and read its NULLs as "no body".
  it('is per-database, not global', () => {
    const backfilled = newMigratedDb();
    const pending = newMigratedDb();
    makeUnbackfilled(pending);
    expect(areBodyLengthsReady(backfilled)).toBe(true);
    expect(areBodyLengthsReady(pending)).toBe(false);
  });
});

describe('migration v72 schema', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = newMigratedDb();
  });

  it('adds both length columns to emails', () => {
    const cols = new Set(
      (db.prepare('PRAGMA table_info(emails)').all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('clean_body_len')).toBe(true);
    expect(cols.has('raw_body_len')).toBe(true);
  });

  // The partial index is both the backfill's cursor and its completeness check.
  // Without it, "find rows still needing measurement" is a full scan of a
  // multi-GB table on every launch, forever.
  it('creates the pending-rows partial index and the pipeline covering indexes', () => {
    const names = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(names.has('idx_emails_body_len_pending')).toBe(true);
    expect(names.has('idx_emails_agent_pipeline')).toBe(true);
    expect(names.has('idx_emails_extraction_pipeline')).toBe(true);
  });

  // The point of the whole change. If the planner still visits the table, the
  // 400ms aggregate stays 400ms and the columns bought nothing.
  it('answers the has-body test from an index, without visiting the table', () => {
    seed(db, { id: 'e1' });
    db.exec('ANALYZE');
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM emails
           WHERE extraction_status = 'pending' AND ${fastHasBodyExpression()}`,
        )
        .all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toMatch(/COVERING INDEX/i);
  });
});

describe('writers maintain the length columns', () => {
  let db: Database.Database;
  let repo: EmailRepository;
  beforeEach(() => {
    db = newMigratedDb();
    repo = new EmailRepository(() => db);
    db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
      .run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  });

  const insertViaRepo = async (id: string, cleanBody: string, rawBody: string) => {
    db.prepare(
      `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
       VALUES (?, 's', ?, ?, ?)`,
    ).run(`t-${id}`, `<${id}>`, `<${id}>`, NOW);
    // Every optional field is spelled out as null rather than left off. The
    // insert binds them by name, and `node:sqlite` — which test-db falls back to
    // when better-sqlite3 is built for the Electron ABI — refuses to bind
    // `undefined` where better-sqlite3 quietly takes it. Omitting them makes this
    // file pass or fail depending on which ABI the checkout happens to be on.
    await repo.insert({
      id,
      messageId: `<${id}@test>`,
      threadId: `t-${id}`,
      folderId: 'f-inbox',
      uid: 1,
      subject: 's',
      fromAddress: 'a@b.example',
      fromName: null,
      toAddress: 'me@test.example',
      toNames: null,
      ccAddress: null,
      ccNames: null,
      bccAddress: null,
      bccNames: null,
      replyTo: null,
      date: NOW,
      receivedDate: NOW,
      cleanBody,
      rawBody,
      contentType: 'text',
      contentHash: `h-${id}`,
      inReplyTo: null,
      references: null,
      priority: null,
      tags: '|INBOX|',
      hasAttachments: false,
      attachmentCount: 0,
      attachmentNames: null,
      embeddingLastGenerated: null,
    } as never);
  };

  const lengthsOf = (id: string) =>
    db.prepare('SELECT clean_body_len AS c, raw_body_len AS r FROM emails WHERE id = ?').get(id) as {
      c: number | null;
      r: number | null;
    };

  it('stores both lengths on insert', async () => {
    await insertViaRepo('e1', 'hello', 'raw raw raw');
    expect(lengthsOf('e1')).toEqual({ c: 5, r: 11 });
  });

  // The body arrives long after the header row does (fetchBody -> updateEmail),
  // so the UPDATE path is the one that actually decides whether real mail is
  // eligible. If it skipped the lengths, every downloaded body would be invisible.
  it('refreshes the lengths when a body is filled in later', async () => {
    await insertViaRepo('e2', '', '');
    expect(lengthsOf('e2')).toEqual({ c: 0, r: 0 });
    repo.update('e2', { cleanBody: 'now it has text', rawBody: '<p>now it has text</p>' } as never);
    const after = lengthsOf('e2');
    expect(after.c).toBe('now it has text'.length);
    expect(after.r).toBe('<p>now it has text</p>'.length);
  });

  it('leaves the lengths alone when a patch touches neither body', async () => {
    await insertViaRepo('e3', 'hello', 'raw');
    repo.update('e3', { subject: 'changed' } as never);
    expect(lengthsOf('e3')).toEqual({ c: 5, r: 3 });
  });

  // Computed in SQL, never in JS. SQLite's one-argument TRIM strips U+0020 only,
  // while JS .trim() also strips \n — so a "\n\n" body is non-empty to the legacy
  // expression and empty to a JS-computed length. Getting this backwards makes a
  // whitespace-only body change its eligibility verdict for no reason.
  it('matches SQLite TRIM semantics on a whitespace-only body, not JS trim()', async () => {
    await insertViaRepo('e4', '\n\n', '   ');
    const { c, r } = lengthsOf('e4');
    expect(c).toBe(2); // \n survives SQLite TRIM; JS .trim() would have given 0
    expect(r).toBe(0); // spaces are stripped by both
    expect(select(db, fastHasBodyExpression())).toEqual(select(db, legacyHasBodyExpression()));
  });

  // SQLite LENGTH() counts characters; JS .length counts UTF-16 units, so an
  // astral character (emoji) is 1 vs 2. Only matters for equality with the
  // legacy expression at the zero boundary, but a wrong unit here is the kind of
  // thing that shows up as an off-by-one in a size filter much later.
  it('counts characters, not UTF-16 code units', async () => {
    await insertViaRepo('e5', 'ab', 'ab');
    db.prepare("UPDATE emails SET clean_body = '🙂', clean_body_len = LENGTH(TRIM('🙂')) WHERE id='e5'").run();
    expect(lengthsOf('e5').c).toBe(1);
  });
});

describe('BodyStorageBackfill', () => {
  let db: Database.Database;
  let backfill: BodyStorageBackfill;

  beforeEach(() => {
    db = newMigratedDb();
    // A mailbox of pre-v72 rows, spanning every has-body shape that matters.
    seed(db, { id: 'a', cleanBody: 'text', rawBody: 'text', legacyRow: true });
    seed(db, { id: 'b', cleanBody: '', rawBody: '<p>html only</p>', legacyRow: true }); // marketing send
    seed(db, { id: 'c', cleanBody: '', rawBody: '', legacyRow: true }); // never downloaded
    seed(db, { id: 'd', cleanBody: '   ', rawBody: '  ', legacyRow: true }); // whitespace only
    makeUnbackfilled(db);
    backfill = new BodyStorageBackfill(() => db);
  });

  const nullCount = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM emails WHERE clean_body_len IS NULL').get() as {
      n: number;
    }).n;

  it('measures every row and marks the database ready', () => {
    expect(areBodyLengthsReady(db)).toBe(false);
    backfill.backfillNow();
    expect(nullCount()).toBe(0);
    expect(areBodyLengthsReady(db)).toBe(true);
  });

  // THE contract. If the fast expression ever selects a different set than the
  // expression it replaced, some email silently gained or lost its body.
  it('leaves the fast expression selecting exactly the rows the legacy one did', () => {
    const before = select(db, legacyHasBodyExpression());
    backfill.backfillNow();
    expect(select(db, fastHasBodyExpression())).toEqual(before);
    // And the html-only row (empty clean_body) is in there — gating on
    // clean_body alone would strand every marketing send.
    expect(select(db, fastHasBodyExpression())).toContain('b');
    expect(select(db, fastHasBodyExpression())).not.toContain('c');
  });

  // A partial run is the normal state for minutes on a large mailbox: the app is
  // usable throughout, so the interim MUST be correct, not just eventually
  // correct. Half-measured means the flag stays off and callers keep using the
  // body-reading expression.
  it('is correct mid-run: a partial pass does not mark the DB ready', () => {
    // The second argument is a BYTE budget, not a row count (see CHUNK_BYTES).
    // One byte therefore takes exactly one row — the at-least-one-row rule — and
    // leaves the pass deliberately half done.
    expect(backfill.runChunk(db, 1)).toBe(1);
    expect(nullCount()).toBe(3);
    expect(areBodyLengthsReady(db)).toBe(false);
  });

  // Idempotent re-run: crash-resume and every subsequent launch call this.
  it('is a no-op once complete', () => {
    backfill.backfillNow();
    const analyze = vi.spyOn(db, 'exec');
    backfill.backfillNow();
    expect(backfill.runChunk(db)).toBe(0);
    expect(analyze).not.toHaveBeenCalled();
    expect(areBodyLengthsReady(db)).toBe(true);
  });

  // Progress lives in the data, so a stop mid-way loses nothing: the rows
  // already measured stay measured and the rest are still findable.
  it('resumes after a stop without redoing measured rows', () => {
    backfill.runChunk(db, 1);
    backfill.stop();
    const measured = 4 - nullCount();
    expect(measured).toBe(1);
    new BodyStorageBackfill(() => db).backfillNow();
    expect(nullCount()).toBe(0);
  });

  // Self-heal: every writer is supposed to store the lengths, but a future
  // insert path that forgets would put a NULL on a DB already marked ready —
  // one row of mail invisible to the pipeline. The next drain repairs it.
  it('repairs a stray NULL on a database already marked ready', () => {
    backfill.backfillNow();
    expect(areBodyLengthsReady(db)).toBe(true);
    db.prepare("UPDATE emails SET clean_body_len = NULL, raw_body_len = NULL WHERE id = 'a'").run();
    backfill.backfillNow();
    expect(nullCount()).toBe(0);
    expect(select(db, fastHasBodyExpression())).toEqual(select(db, legacyHasBodyExpression()));
  });

  // A closed/uninitialised database must not throw out of a background timer —
  // an unhandled rejection in the main process is a crash, not a slow query.
  it('does nothing when the database is unavailable', () => {
    expect(() => new BodyStorageBackfill(() => null).backfillNow()).not.toThrow();
  });

  it('does not start a drain after stop()', async () => {
    backfill.stop();
    backfill.start();
    backfill.stop();
    expect(nullCount()).toBe(4);
  });
});
