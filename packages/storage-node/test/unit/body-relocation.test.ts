import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BodyStorageBackfill } from '../../src/body-storage-backfill';
import { createMigrationManager } from '../../src/migrations';
import { missingBodyClause } from '../../src/repositories/agent-eligibility';
import { areBodyLengthsReady } from '../../src/repositories/body-metrics';
import {
  areBodiesRelocated,
  cleanBodyExpression,
  rawBodyExpression,
} from '../../src/repositories/body-storage';
import { EmailRepository } from '../../src/repositories/email-repository';
import { SearchRepository } from '../../src/repositories/search-repository';
import { newMigratedDb } from '../../src/test-support/test-db';

// What breaks if this file fails: mail is still there, still lists, still opens —
// and is no longer FINDABLE, or silently loses its body.
//
// Migration 73 moves `clean_body`/`raw_body` out of the `emails` record into the
// `email_bodies` side table, because a 330 KB body inline means every flag flip
// rewrites the whole record. Nothing about that move throws if it goes wrong:
//
//  * A reader left on the inline column gets `''` back. The list renders a blank
//    snippet, the AI pipeline sees a body-less mail and skips it forever, and the
//    body-reheal scheduler reads the same `''` as "never downloaded" and queues
//    the entire mailbox for re-download from IMAP.
//  * The FTS triggers still fire and still succeed on the inline column — they
//    just index an EMPTY body. Mail keeps arriving and opening, and body search
//    stops returning it, with no error anywhere.
//  * A writer that keeps writing inline leaves two copies of a body, one stale,
//    and nothing can tell which is current.
//
// So every test here is the same assertion from a different angle: a body reads
// back, and stays findable, no matter which side of the move the row is on.

// Pacing and progress leave no trace in the data — the rows come out relocated
// either way — so the pacer and the logger are wrapped to record what the pass
// actually did between chunks. Everything else in core stays real: mocking
// `createByteBudget` here would test a chunk that no longer bounds anything.
const { logLines, pacer } = vi.hoisted(() => ({
  logLines: [] as Array<{ level: string; name: string; message: string }>,
  pacer: { dutyCycles: [] as Array<number | undefined>, rests: 0, elapseMs: 0 },
}));

vi.mock('@sarvinbox/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sarvinbox/core')>();
  const record =
    (level: string, name: string) =>
    (...args: unknown[]): void => {
      logLines.push({ level, name, message: args.map(String).join(' ') });
    };
  return {
    ...actual,
    createLogger: (name: string) => ({
      ...actual.createLogger(name),
      info: record('info', name),
      warn: record('warn', name),
      error: record('error', name),
    }),
    createPacer: (options: Parameters<typeof actual.createPacer>[0] = {}) => {
      pacer.dutyCycles.push(options.dutyCycle);
      const real = actual.createPacer(options);
      return {
        rest: async (): Promise<number> => {
          pacer.rests += 1;
          // Buys time on the frozen fake clock, so the progress cadence can be
          // reached without a test waiting 30 real seconds for it.
          if (pacer.elapseMs > 0) vi.setSystemTime(Date.now() + pacer.elapseMs);
          return real.rest();
        },
      };
    },
  };
});

const NOW = 1780315200; // 2026-06-15T12:00:00Z

/** Write a row the pre-v73 way: bodies INLINE, no side row. This is what an
 *  upgraded database actually looks like the moment migration 73 lands. */
function seedLegacy(
  db: Database.Database,
  id: string,
  cleanBody: string,
  rawBody: string,
): void {
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(`t-${id}`, `<${id}>`, `<${id}>`, NOW);
  db.prepare(
    `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject, from_address,
                         date, clean_body, raw_body, clean_body_len, raw_body_len,
                         content_type, content_hash)
     VALUES (?, ?, ?, 'f-inbox', 1, '|INBOX|', 'a subject', 'a@b.example', ?, ?, ?,
             LENGTH(TRIM(?)), LENGTH(TRIM(?)), 'text', ?)`,
  ).run(id, `<${id}@test>`, `t-${id}`, NOW, cleanBody, rawBody, cleanBody, rawBody, `h-${id}`);
}

/** Insert through the repository — the production write path. */
async function insertViaRepo(
  repo: EmailRepository,
  db: Database.Database,
  id: string,
  cleanBody: string,
  rawBody: string,
): Promise<void> {
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(`t-${id}`, `<${id}>`, `<${id}>`, NOW);
  // Every optional field spelled out as null: `node:sqlite` (the fallback when
  // better-sqlite3 is built for the Electron ABI) refuses to bind `undefined`
  // where better-sqlite3 takes it, so omitting one makes this file pass or fail
  // depending on which ABI the checkout is on.
  await repo.insert({
    id,
    messageId: `<${id}@test>`,
    threadId: `t-${id}`,
    folderId: 'f-inbox',
    uid: 1,
    subject: 'a subject',
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
}

/** What the inline columns physically hold — never what a caller should read. */
const inlineOf = (db: Database.Database, id: string) =>
  db.prepare('SELECT clean_body AS clean, raw_body AS raw FROM emails WHERE id = ?').get(id) as {
    clean: string | null;
    raw: string | null;
  };

/** What the side table physically holds, or undefined when there is no row. */
const sideOf = (db: Database.Database, id: string) =>
  db
    .prepare('SELECT clean_body AS clean, raw_body AS raw FROM email_bodies WHERE email_id = ?')
    .get(id) as { clean: string | null; raw: string | null } | undefined;

/** What every reader in the app sees — the COALESCE over both. */
const effectiveOf = (db: Database.Database, id: string) =>
  db
    .prepare(
      `SELECT ${cleanBodyExpression('emails')} AS clean, ${rawBodyExpression('emails')} AS raw
         FROM emails WHERE id = ?`,
    )
    .get(id) as { clean: string | null; raw: string | null };

/** Ids whose body text matches an FTS query, via the real MATCH path. */
const ftsIds = (db: Database.Database, match: string): string[] =>
  (
    db
      .prepare('SELECT email_id FROM emails_fts WHERE emails_fts MATCH ? ORDER BY email_id')
      .all(match) as Array<{ email_id: string }>
  ).map((r) => r.email_id);

describe('body relocation — the incremental move to email_bodies', () => {
  let db: Database.Database;
  let backfill: BodyStorageBackfill;

  beforeEach(() => {
    db = newMigratedDb();
    backfill = new BodyStorageBackfill(() => db);
  });

  // The move itself. A body that does not read back identically afterwards is
  // data loss, not a layout change.
  it('moves an inline body into the side table and reads back identically', () => {
    seedLegacy(db, 'a', 'the quarterly invoice', '<p>the quarterly invoice</p>');
    backfill.backfillNow();

    expect(sideOf(db, 'a')).toEqual({
      clean: 'the quarterly invoice',
      raw: '<p>the quarterly invoice</p>',
    });
    // Emptied, NOT dropped — `DROP COLUMN` rewrites the whole multi-GB table.
    // Emptied to '' rather than NULL so the read-side COALESCE stays total.
    expect(inlineOf(db, 'a')).toEqual({ clean: '', raw: '' });
    expect(effectiveOf(db, 'a')).toEqual({
      clean: 'the quarterly invoice',
      raw: '<p>the quarterly invoice</p>',
    });
    expect(areBodiesRelocated(db)).toBe(true);
    expect(areBodyLengthsReady(db)).toBe(true);
  });

  // A synced-but-not-yet-fetched row already carries '' in both columns. There
  // are tens of thousands of them on a real mailbox: giving each a side row of
  // two empty strings is pure overhead, and keeps the relocation cursor churning
  // over rows that have nothing to move.
  it('creates no side row for a header-only email', () => {
    seedLegacy(db, 'nobody', '', '');
    backfill.backfillNow();

    expect(sideOf(db, 'nobody')).toBeUndefined();
    expect(effectiveOf(db, 'nobody')).toEqual({ clean: '', raw: '' });
    // And it is still correctly reported as awaiting a download, which is what
    // keeps the body prefetch pointed at it.
    const missing = db
      .prepare(`SELECT id FROM emails WHERE ${missingBodyClause('', areBodyLengthsReady(db))}`)
      .all() as Array<{ id: string }>;
    expect(missing.map((r) => r.id)).toEqual(['nobody']);
  });

  // A partial run is the NORMAL state for minutes on a large mailbox, and the app
  // is fully usable throughout. Half-moved must be as correct as fully-moved, or
  // the user sees blank bodies for whichever rows the cursor has not reached.
  it('reads every body correctly mid-move, on both sides of the cursor', () => {
    seedLegacy(db, 'a', 'body a', 'raw a');
    seedLegacy(db, 'b', 'body b', 'raw b');
    seedLegacy(db, 'c', 'body c', 'raw c');

    expect(backfill.runChunk(db, 1)).toBe(1);
    expect(areBodiesRelocated(db)).toBe(false); // flags stay off until it is done

    const relocated = ['a', 'b', 'c'].filter((id) => sideOf(db, id) !== undefined);
    expect(relocated).toHaveLength(1);
    for (const id of ['a', 'b', 'c']) {
      expect(effectiveOf(db, id)).toEqual({ clean: `body ${id}`, raw: `raw ${id}` });
    }
  });

  // THE regression this chunk was rewritten for. It used to take 50 ROWS, which
  // bounds nothing when a row is anywhere from 200 bytes to 21 MB: on the live
  // mailbox each transaction moved ~18 MB and the event-loop monitor logged
  // "main process blocked for 851ms", 524 times in a row. A chunk cannot yield —
  // it is one transaction — so the only bound is the bytes it admits.
  //
  // Asserting on ROWS TAKEN rather than on time, because time is flaky and the
  // row count is the thing the budget actually controls.
  it('stops a chunk at its byte budget instead of at a row count', () => {
    const body = 'x'.repeat(10_000); // 20k chars per row across clean+raw
    for (const id of ['a', 'b', 'c', 'd', 'e']) seedLegacy(db, id, body, body);

    // A budget of three rows' worth takes three rows and leaves the rest, where
    // the old row-counted chunk would have taken all five however big they were.
    expect(backfill.runChunk(db, 60_000)).toBe(3);
    expect(['a', 'b', 'c', 'd', 'e'].filter((id) => sideOf(db, id) !== undefined)).toHaveLength(3);
  });

  // The other half of the rule: a body larger than the whole budget must still
  // move. Refusing it would park it at the head of the cursor and stall every row
  // behind it forever — a pass that logs "0 changed" and never completes.
  it('moves a single body that is bigger than the entire budget', () => {
    const huge = 'y'.repeat(100_000);
    seedLegacy(db, 'huge', huge, huge);
    seedLegacy(db, 'next', 'small', 'small');

    expect(backfill.runChunk(db, 1024)).toBe(1);
    expect(sideOf(db, 'huge')).toEqual({ clean: huge, raw: huge });
    expect(sideOf(db, 'next')).toBeUndefined(); // and nothing after it
  });

  // A body-less row costs nothing to move, so it must not consume budget — or a
  // mailbox of never-downloaded rows advances one row per chunk and the pass
  // takes as many transactions as there are emails.
  it('does not spend budget on rows with no body', () => {
    for (const id of ['a', 'b', 'c']) seedLegacy(db, id, '   ', '  '); // whitespace only
    seedLegacy(db, 'z', 'real', 'real');

    // Budget of 1 byte: the whitespace rows measure 0 and do not exhaust it, so
    // the chunk keeps going until it hits a row that actually costs something.
    expect(backfill.runChunk(db, 1)).toBe(4);
  });

  // Crash-resume and every subsequent launch call this. Progress lives in the
  // data, so a stop mid-way must lose nothing and re-running must not double-apply.
  it('resumes after a stop and is idempotent on re-run', () => {
    seedLegacy(db, 'a', 'body a', 'raw a');
    seedLegacy(db, 'b', 'body b', 'raw b');

    backfill.runChunk(db, 1);
    backfill.stop();

    new BodyStorageBackfill(() => db).backfillNow();
    expect(areBodiesRelocated(db)).toBe(true);
    const first = { a: sideOf(db, 'a'), b: sideOf(db, 'b') };

    backfill.backfillNow(); // second pass: nothing left to do
    expect({ a: sideOf(db, 'a'), b: sideOf(db, 'b') }).toEqual(first);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM email_bodies').get() as { n: number }).n,
    ).toBe(2);
  });

  // A side row exists only because a writer put the CURRENT body there and
  // emptied the inline column in the same transaction. A leftover inline value is
  // therefore always the older one, so the copy must be DO NOTHING: DO UPDATE
  // would overwrite a freshly-fetched body with the stale one it replaced.
  it('never overwrites an existing side row from a leftover inline value', () => {
    seedLegacy(db, 'a', 'stale inline', 'stale raw');
    db.prepare(
      'INSERT INTO email_bodies (email_id, clean_body, raw_body) VALUES (?, ?, ?)',
    ).run('a', 'current body', 'current raw');

    backfill.backfillNow();

    expect(sideOf(db, 'a')).toEqual({ clean: 'current body', raw: 'current raw' });
    expect(inlineOf(db, 'a')).toEqual({ clean: '', raw: '' });
    // And the lengths are measured from the body readers will actually see.
    expect(
      db.prepare('SELECT clean_body_len AS c FROM emails WHERE id = ?').get('a'),
    ).toEqual({ c: 'current body'.length });
  });

  // Multi-account: each account is its own database file, so the move must be
  // per-database state. A DB already relocated must not make a second one skip.
  it('tracks the move per database, not per process', () => {
    const other = newMigratedDb();
    try {
      seedLegacy(db, 'a', 'body a', 'raw a');
      seedLegacy(other, 'z', 'body z', 'raw z');

      backfill.backfillNow();
      expect(areBodiesRelocated(db)).toBe(true);
      expect(sideOf(other, 'z')).toBeUndefined();

      new BodyStorageBackfill(() => other).backfillNow();
      expect(sideOf(other, 'z')).toEqual({ clean: 'body z', raw: 'raw z' });
    } finally {
      other.close();
    }
  });

  // A closed/uninitialised DB must not throw out of a background timer — an
  // unhandled rejection in the main process is a crash, not a slow query.
  it('does nothing when the database is unavailable', () => {
    expect(() => new BodyStorageBackfill(() => null).backfillNow()).not.toThrow();
  });
});

describe('body relocation — full-text search survives the move', () => {
  let db: Database.Database;
  let repo: EmailRepository;
  let search: SearchRepository;
  let backfill: BodyStorageBackfill;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new EmailRepository(() => db);
    search = new SearchRepository(() => db);
    backfill = new BodyStorageBackfill(() => db);
  });

  // THE headline regression of this whole change. The old triggers read
  // `new.clean_body`; after the move that is '' and they would still fire, still
  // succeed, and index an empty body. Mail keeps arriving, listing and opening,
  // and simply stops being findable — no error, nobody notices for days.
  it('still finds a legacy email by a word in its body after relocation', () => {
    seedLegacy(db, 'a', 'the pangolin quarterly report', '<p>the pangolin quarterly report</p>');
    expect(ftsIds(db, 'pangolin')).toEqual(['a']);

    backfill.backfillNow();

    expect(ftsIds(db, 'pangolin')).toEqual(['a']);
  });

  // The trigger path that actually decides whether the move is safe. Changing a
  // search-relevant HEADER column rebuilds the whole index row from scratch — so
  // on a relocated email that rebuild has to read the body through
  // `email_bodies`. Reading the inline column instead re-indexes it with an EMPTY
  // body: nothing errors, the mail keeps listing and opening, and it drops out of
  // body search the first time anything touches its subject or attachment names.
  it('keeps the body indexed when a header column changes on a relocated email', async () => {
    seedLegacy(db, 'a', 'the pangolin quarterly report', '<p>pangolin</p>');
    backfill.backfillNow();
    expect(inlineOf(db, 'a').clean).toBe(''); // body is in the side table only

    await repo.update('a', { subject: 'renamed subject' });

    expect(ftsIds(db, 'pangolin')).toEqual(['a']);
    expect(ftsIds(db, 'renamed')).toEqual(['a']);
  });

  // Dropping only the body row (an email whose body is discarded while the mail
  // itself stays) must leave the header terms searchable and take the body terms
  // with it — not leave stale body terms behind pointing at a body that is gone.
  it('drops body terms but keeps header terms when only the body row is deleted', async () => {
    await insertViaRepo(repo, db, 'a', 'echidna invoice', '<p>echidna</p>');
    expect(ftsIds(db, 'echidna')).toEqual(['a']);

    db.prepare('DELETE FROM email_bodies WHERE email_id = ?').run('a');

    expect(ftsIds(db, 'echidna')).toEqual([]);
    expect(ftsIds(db, 'subject')).toEqual(['a']); // 'a subject' from the seed
  });

  // The production write path. A body written to the side table that the index
  // never learns about is mail that arrives already unfindable.
  it('indexes a body the repository writes to the side table', async () => {
    await insertViaRepo(repo, db, 'a', 'aardvark milestone notes', '<p>aardvark</p>');

    expect(sideOf(db, 'a')?.clean).toBe('aardvark milestone notes');
    expect(inlineOf(db, 'a')).toEqual({ clean: '', raw: '' });
    expect(ftsIds(db, 'aardvark')).toEqual(['a']);
  });

  // The body arrives long AFTER the header row (fetchBody -> updateEmail), so
  // this is the update every real email actually goes through.
  it('re-indexes when a body is filled in later, and when it is replaced', async () => {
    await insertViaRepo(repo, db, 'a', '', '');
    expect(ftsIds(db, 'capybara')).toEqual([]);

    await repo.update('a', { cleanBody: 'capybara arrives', rawBody: '<p>capybara</p>' });
    expect(ftsIds(db, 'capybara')).toEqual(['a']);

    await repo.update('a', { cleanBody: 'now about okapis' });
    expect(ftsIds(db, 'capybara')).toEqual([]);
    expect(ftsIds(db, 'okapis')).toEqual(['a']);
  });

  // The body-reheal scheduler rebuilds `clean_body` FROM `raw_body` and writes
  // back only `cleanBody`. If that patch blanked `raw_body` it would destroy the
  // source it had just read, and the row could never be repaired again.
  it('leaves the raw body untouched when only the clean body is patched', async () => {
    await insertViaRepo(repo, db, 'a', '', '<p>html only</p>');
    await repo.update('a', { cleanBody: 'html only' });

    expect(effectiveOf(db, 'a')).toEqual({ clean: 'html only', raw: '<p>html only</p>' });
  });

  // Deleting mail must leave nothing behind: an orphan body row is a leaked 300 KB
  // per deleted email (and the FK pragma is per-connection, so it cannot be
  // relied on), and an orphan FTS row makes a deleted mail keep showing up in
  // search results that then open nothing.
  it('leaves no orphan body or index row when an email is deleted', async () => {
    await insertViaRepo(repo, db, 'a', 'wombat receipt', '<p>wombat</p>');
    expect(ftsIds(db, 'wombat')).toEqual(['a']);

    await repo.delete('a');

    expect(sideOf(db, 'a')).toBeUndefined();
    expect(ftsIds(db, 'wombat')).toEqual([]);
  });

  // The manual "rebuild the search index" path. Rebuilding from the inline column
  // would replace a working index with an empty-bodied one — a repair that
  // silently breaks the thing it was run to fix.
  it('rebuilds the index from the side table', async () => {
    await insertViaRepo(repo, db, 'a', 'numbat expense claim', '<p>numbat</p>');
    db.exec('DELETE FROM emails_fts');
    expect(ftsIds(db, 'numbat')).toEqual([]);

    search.rebuildIndex();

    expect(ftsIds(db, 'numbat')).toEqual(['a']);
  });

  // Mid-move again, this time for search: a mailbox half-relocated must be
  // wholly searchable, or the user sees results appear and disappear depending on
  // where the background cursor happens to be.
  it('finds bodies on both sides of a partially-run move', () => {
    seedLegacy(db, 'a', 'quokka one', 'raw one');
    seedLegacy(db, 'b', 'quokka two', 'raw two');
    backfill.runChunk(db, 1);

    expect(ftsIds(db, 'quokka')).toEqual(['a', 'b']);
  });
});

// What breaks if this block fails: the app, for the whole length of the move —
// and nothing else, which is why it went unnoticed for so long. The rows relocate
// correctly either way. A yielder in this position hands the thread back for one
// turn and the loop takes it straight back; a CPU profile of the running app
// measured the sibling inline-image pass keeping 79% of wall clock that way,
// which surfaces as IMAP body-fetch timeouts, poisoned pool connections and the
// macOS beachball — all of it looking like a network fault rather than a
// migration.
describe('body relocation — pacing the background pass', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = newMigratedDb();
    logLines.length = 0;
    pacer.dutyCycles.length = 0;
    pacer.rests = 0;
    pacer.elapseMs = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  /** More rows than CHUNK_ROWS_MAX, so the drain is forced to take several
   *  chunks without seeding megabytes of body to fill the byte budget. */
  function seedManyLegacyRows(count: number): void {
    for (let index = 0; index < count; index += 1) {
      seedLegacy(db, `e${index}`, `body ${index}`, `<p>body ${index}</p>`);
    }
  }

  it('rests after every committed chunk, at a duty cycle below full speed', async () => {
    seedManyLegacyRows(450); // 200 + 200 + 50 = three chunks
    const backfill = new BodyStorageBackfill(() => db);

    backfill.start();
    await vi.advanceTimersByTimeAsync(120_000);
    backfill.stop();

    // Paced, not stalled: the move still completed.
    expect(areBodiesRelocated(db)).toBe(true);
    expect(areBodyLengthsReady(db)).toBe(true);
    expect(sideOf(db, 'e449')).toEqual({ clean: 'body 449', raw: '<p>body 449</p>' });
    expect(pacer.rests).toBeGreaterThanOrEqual(3);
    // An absent or full duty cycle is the unpaced bug this replaces.
    expect(pacer.dutyCycles[0]).toBeGreaterThan(0);
    expect(pacer.dutyCycles[0]).toBeLessThan(1);
  });

  // Regression: a progress line per chunk is itself a stall — `logger.debug` is
  // not level-gated and a 10 GB mailbox is thousands of chunks. The cadence is a
  // clock, not a counter.
  it('logs no progress line per chunk, and one once the cadence elapses', async () => {
    seedManyLegacyRows(450);

    new BodyStorageBackfill(() => db).start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(logLines.filter((line) => line.message.includes('row(s) processed'))).toHaveLength(0);

    // Same work on a database where each rest carries the clock past the cadence.
    const second = newMigratedDb();
    try {
      for (let index = 0; index < 450; index += 1) {
        seedLegacy(second, `e${index}`, `body ${index}`, `<p>body ${index}</p>`);
      }
      pacer.elapseMs = 31_000;
      const backfill = new BodyStorageBackfill(() => second);
      backfill.start();
      await vi.advanceTimersByTimeAsync(120_000);
      backfill.stop();

      const progress = logLines.filter((line) => line.message.includes('row(s) processed'));
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0].level).toBe('info');
      expect(progress[0].message).toMatch(/Body-storage backfill: \d+\/\d+ row\(s\) processed/);
    } finally {
      second.close();
    }
  });

  // The label is what makes a multi-account log readable: two accounts both
  // backfilling wrote identical anonymous lines, so neither could be followed.
  it('names the account database in every line it logs', async () => {
    seedManyLegacyRows(1);
    const backfill = new BodyStorageBackfill(() => db, 'sarvinbox-abc123.db');

    backfill.start();
    await vi.advanceTimersByTimeAsync(120_000);
    backfill.stop();

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line.name).toBe('body-storage-backfill:sarvinbox-abc123.db');
    }
  });
});

describe('body relocation — migration rollback', () => {
  // `down` exists so a bad release can be backed out. It has to put the bodies
  // back inline before dropping the table, or the rollback is the data loss.
  it('puts the bodies back inline when migration 73 is rolled back', () => {
    const db = newMigratedDb();
    try {
      seedLegacy(db, 'a', 'restore me', '<p>restore me</p>');
      new BodyStorageBackfill(() => db).backfillNow();
      expect(inlineOf(db, 'a')).toEqual({ clean: '', raw: '' });

      createMigrationManager(db).rollback(72);

      expect(inlineOf(db, 'a')).toEqual({ clean: 'restore me', raw: '<p>restore me</p>' });
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(tables).not.toContain('email_bodies');
    } finally {
      db.close();
    }
  });
});
