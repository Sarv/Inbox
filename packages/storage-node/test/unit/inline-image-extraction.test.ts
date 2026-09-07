import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_CANDIDATES_SQL, InlineImageBackfill } from '../../src/inline-image-backfill';
import { createMigrationManager } from '../../src/migrations';
import { markBodiesRelocated, rawBodyExpression } from '../../src/repositories/body-storage';
import { EmailRepository } from '../../src/repositories/email-repository';
import {
  INLINE_IMAGE_SIZE_SQL,
  areInlineImagesExtracted,
  clearInlineImageCache,
  collectUnreferencedImages,
  hashImageBytes,
  inflateInlineImages,
  inlineImageStats,
} from '../../src/repositories/inline-image-store';
import { newMigratedDb } from '../../src/test-support/test-db';

// What breaks if this file fails: the images in the user's mail, and the size of
// the database on disk. Neither failure throws.
//
// Migration 74 takes the base64 `data:` images out of `raw_body` and stores the
// decoded bytes once, content-addressed, with the body holding a
// `sarv-inline:<hash>` ref. On the measured mailbox that is 94.6% of all body
// bytes and a 10.7x dedup factor — the difference between a 10.4 GB database and
// roughly a gigabyte. The ways it can go wrong are all quiet:
//
//  * A blob written outside the body's transaction, or a body committed before
//    its blob: the ref resolves to nothing and the image is gone for good, since
//    the base64 it came from was discarded in the same breath.
//  * A read path that forgets to inflate hands `sarv-inline:<hash>` to the
//    renderer as an image URL. Every inline image in the mailbox breaks at once.
//  * A reclaim sweep that runs while a body is mid-rewrite sees a shared image as
//    unreferenced and deletes bytes that thousands of other mails still use.
//  * An edge set that is merged rather than rebuilt pins every image an email
//    ever referenced, so nothing is ever reclaimable.
//  * A `raw_body_len` left describing the pre-extraction size makes every
//    size-based read — AI eligibility, search filters — answer from a number
//    about bytes that are no longer there.
//  * A backfill loop whose exit condition is "the cursor is empty" never
//    terminates, because the cursor deliberately matches more than the pass
//    rewrites.

// Captures what the module actually logged. The only difference between "a
// writer is broken" and "relocation is still running" IS the log level, so the
// logger is the only place that distinction can be asserted.
const { logLines, pacer } = vi.hoisted(() => ({
  logLines: [] as Array<{ level: string; name: string; message: string }>,
  // Pacing is invisible in the data — the same rows end up extracted whether the
  // pass rested between chunks or held the main thread for the whole migration.
  // The only observable is that `rest()` was awaited, so it is recorded here.
  // `elapseMs` lets a test buy time on the frozen fake clock without waiting.
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
    // Partial mock: createByteBudget and createLoopYielder must stay real, or
    // this file would test a chunk that no longer bounds anything.
    createLogger: (name: string) => ({
      ...actual.createLogger(name),
      info: record('info', name),
      warn: record('warn', name),
      error: record('error', name),
    }),
    // The real pacer, wrapped to count. Its own arithmetic is tested in core.
    createPacer: (options: Parameters<typeof actual.createPacer>[0] = {}) => {
      pacer.dutyCycles.push(options.dutyCycle);
      const real = actual.createPacer(options);
      return {
        rest: async (): Promise<number> => {
          pacer.rests += 1;
          if (pacer.elapseMs > 0) vi.setSystemTime(Date.now() + pacer.elapseMs);
          return real.rest();
        },
      };
    },
  };
});

const NOW = 1780315200; // 2026-06-15T12:00:00Z

/** Distinct decoded bytes per call, all comfortably over MIN_INLINE_IMAGE_CHARS. */
function imageBytes(seed: string, kilobytes = 2): Buffer {
  return Buffer.from(seed.repeat(Math.ceil((kilobytes * 1024) / seed.length)).slice(0, kilobytes * 1024));
}

const dataUri = (bytes: Buffer, mime = 'image/png'): string =>
  `data:${mime};base64,${bytes.toString('base64')}`;

/** A body carrying `images` inline, the way mailparser hands it to us. */
const bodyWith = (...images: Buffer[]): string =>
  `<p>hello</p>${images.map((bytes) => `<img src="${dataUri(bytes)}">`).join('')}<p>bye</p>`;

function seedFolderAndThread(db: Database.Database, id: string): void {
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)').run(
    'f-inbox',
    'INBOX',
    'INBOX',
    '\\Inbox',
  );
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 's', ?, ?, ?)`,
  ).run(`t-${id}`, `<${id}>`, `<${id}>`, NOW);
}

/** Insert through the repository — the production write path. */
async function insertViaRepo(
  repo: EmailRepository,
  db: Database.Database,
  id: string,
  rawBody: string,
  cleanBody = 'hello bye',
): Promise<void> {
  seedFolderAndThread(db, id);
  // Every optional field spelled out as null: `node:sqlite` (the fallback when
  // better-sqlite3 is built for the Electron ABI) refuses to bind `undefined`
  // where better-sqlite3 accepts it.
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
    contentType: 'html',
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

/** Write a body the pre-v74 way: base64 inline in the side table. This is what a
 *  database looks like the moment migration 74 lands. */
async function seedUnextracted(
  repo: EmailRepository,
  db: Database.Database,
  id: string,
  rawBody: string,
): Promise<void> {
  await insertViaRepo(repo, db, id, '<p>placeholder</p>');
  db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?').run(rawBody, id);
  db.prepare(
    `UPDATE emails SET raw_body_len = LENGTH(TRIM(${rawBodyExpression('emails')})) WHERE id = ?`,
  ).run(id);
}

/** What the side table PHYSICALLY holds — never what a caller should read. */
const storedBody = (db: Database.Database, id: string): string =>
  (db.prepare('SELECT raw_body FROM email_bodies WHERE email_id = ?').get(id) as {
    raw_body: string;
  }).raw_body;

const storedLength = (db: Database.Database, id: string): number =>
  (db.prepare('SELECT raw_body_len FROM emails WHERE id = ?').get(id) as { raw_body_len: number })
    .raw_body_len;

const edgesOf = (db: Database.Database, id: string): string[] =>
  (
    db
      .prepare('SELECT hash FROM email_inline_images WHERE email_id = ? ORDER BY hash')
      .all(id) as Array<{ hash: string }>
  ).map((row) => row.hash);

const ftsIds = (db: Database.Database, match: string): string[] =>
  (
    db
      .prepare('SELECT email_id FROM emails_fts WHERE emails_fts MATCH ? ORDER BY email_id')
      .all(match) as Array<{ email_id: string }>
  ).map((row) => row.email_id);

describe('inline images — the write path', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newMigratedDb();
    // Production runs with FKs on (sqlite-storage.ts). It matters here: the edge
    // table references emails(id), which is what forces the blob → header row →
    // edges ordering on the insert path. With FKs off, a wrong order would pass
    // this suite and fail in the app.
    db.pragma('foreign_keys = ON');
    repo = new EmailRepository(() => db);
    clearInlineImageCache();
  });

  afterEach(() => db.close());

  // The core of the change. If this fails, the database keeps growing the way it
  // has been — nothing else in the app misbehaves, which is why it went unnoticed
  // for so long.
  it('stores a ref, not base64, and the bytes exactly once', async () => {
    const bytes = imageBytes('alpha');
    await insertViaRepo(repo, db, 'e1', bodyWith(bytes));

    const stored = storedBody(db, 'e1');
    expect(stored).not.toContain('base64');
    expect(stored).toContain('sarv-inline:');
    expect(stored.length).toBeLessThan(500);

    const stats = inlineImageStats(db);
    expect(stats.images).toBe(1);
    expect(stats.bytes).toBe(bytes.length);
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(bytes)]);
  });

  // Fidelity. The base64 is discarded at write time, so if this round-trip is not
  // exact there is no copy anywhere to recover from.
  it('reads back byte-identical to what was written', async () => {
    const original = bodyWith(imageBytes('beta'), imageBytes('gamma'));
    await insertViaRepo(repo, db, 'e1', original);

    const record = await repo.get('e1');
    expect(record?.rawBody).toBe(original);
  });

  // The 10.7x dedup factor IS the saving — 1,086 distinct images stored 12,392
  // times. A per-email copy would leave the database exactly as large as before.
  it('stores one blob for an image shared by many emails, with an edge each', async () => {
    const logo = imageBytes('shared-logo');
    await insertViaRepo(repo, db, 'e1', bodyWith(logo));
    await insertViaRepo(repo, db, 'e2', bodyWith(logo));
    await insertViaRepo(repo, db, 'e3', bodyWith(logo, imageBytes('unique')));

    const stats = inlineImageStats(db);
    expect(stats.images).toBe(2); // the logo + e3's own image
    expect(stats.links).toBe(4); // e1, e2, and e3 twice
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(logo)]);
  });

  // A body using the same image twice must not write the edge twice — the
  // composite primary key is what makes that a no-op rather than an error.
  it('records one edge for an image used twice in one body', async () => {
    const bytes = imageBytes('twice');
    await insertViaRepo(repo, db, 'e1', bodyWith(bytes, bytes));

    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(bytes)]);
    expect(inlineImageStats(db).images).toBe(1);
  });

  // `raw_body_len` has to describe the body that is actually stored. Left
  // describing the pre-extraction size, every size-based read (AI eligibility,
  // the search size filter) answers from bytes that are no longer there.
  it('stamps raw_body_len from the stored ref-form body, not the original', async () => {
    const original = bodyWith(imageBytes('len'));
    await insertViaRepo(repo, db, 'e1', original);

    expect(storedLength(db, 'e1')).toBe(storedBody(db, 'e1').trim().length);
    expect(storedLength(db, 'e1')).toBeLessThan(original.length);
  });

  // A tracking pixel is below the relocation floor: rewriting it buys nothing and
  // would mean touching almost every marketing email.
  it('leaves a sub-threshold image inline', async () => {
    const body = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP">';
    await insertViaRepo(repo, db, 'e1', body);

    expect(storedBody(db, 'e1')).toBe(body);
    expect(inlineImageStats(db).images).toBe(0);
  });

  // An update rewrites the edge set rather than merging into it. Merged, an email
  // would pin every image it ever referenced and nothing could ever be reclaimed.
  it('rebuilds the edge set when a body is replaced, dropping the image it no longer uses', async () => {
    const first = imageBytes('first');
    const second = imageBytes('second');
    await insertViaRepo(repo, db, 'e1', bodyWith(first));
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(first)]);

    await repo.update('e1', { rawBody: bodyWith(second) } as never);

    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(second)]);
    // Both blobs still exist — dropping bytes is the reclaim sweep's job, never
    // the write path's, because a shared image may still be in use elsewhere.
    expect(inlineImageStats(db).images).toBe(2);
  });

  // A body cleared to '' must lose its edges too. If it kept them, the reclaim
  // sweep (which reads the edge table, not the bodies) would never notice.
  it('drops the edges when a body is cleared', async () => {
    await insertViaRepo(repo, db, 'e1', bodyWith(imageBytes('cleared')));
    await repo.update('e1', { rawBody: '' } as never);

    expect(edgesOf(db, 'e1')).toEqual([]);
    expect(collectUnreferencedImages(db)).toBe(1);
  });

  // Same as clearing to '': a body set to NULL has no images, so its edges must
  // go too. Kept, they pin a blob nothing references, and the reclaim sweep reads
  // the edge table rather than the bodies — so nothing would ever notice.
  it('drops the edges when a body is set to null', async () => {
    await insertViaRepo(repo, db, 'e1', bodyWith(imageBytes('nulled')));
    await repo.update('e1', { rawBody: null } as never);

    expect(edgesOf(db, 'e1')).toEqual([]);
    expect(collectUnreferencedImages(db)).toBe(1);
  });

  // A mail with no images at all is the common case: no blobs, no edges, and no
  // wasted scan of a body that cannot contain one.
  it('stores a body with no images without touching either table', async () => {
    await insertViaRepo(repo, db, 'e1', '<p>just text</p>');
    await insertViaRepo(repo, db, 'e2', null as never);

    expect(storedBody(db, 'e1')).toBe('<p>just text</p>');
    expect(edgesOf(db, 'e1')).toEqual([]);
    expect(edgesOf(db, 'e2')).toEqual([]);
    expect(inlineImageStats(db).images).toBe(0);
  });

  // A patch that says nothing about the body must not touch it — or its edges.
  // This is the multi-thousand-per-sync path: every flag flip and every AI
  // categorisation is an update of this shape.
  it('leaves body and edges untouched by a header-only update', async () => {
    const bytes = imageBytes('untouched');
    await insertViaRepo(repo, db, 'e1', bodyWith(bytes));
    const before = storedBody(db, 'e1');

    await repo.update('e1', { tags: '|INBOX|read|' } as never);

    expect(storedBody(db, 'e1')).toBe(before);
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(bytes)]);
  });

  // A re-fetch of the same message hands us a body that is ALREADY in ref form
  // on the second pass. Re-relocating must not double-store or lose the edges.
  it('is idempotent when handed a body that already holds refs', async () => {
    const bytes = imageBytes('idem');
    await insertViaRepo(repo, db, 'e1', bodyWith(bytes));
    const refForm = storedBody(db, 'e1');

    await repo.update('e1', { rawBody: refForm } as never);

    expect(storedBody(db, 'e1')).toBe(refForm);
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(bytes)]);
    expect(inlineImageStats(db).images).toBe(1);
  });

  // Reading a thread reads the same sender logo once per message. Without the
  // cache that is one blob read and one base64 encode per message — and the
  // cached form has to be split back into mime and payload correctly, or every
  // second read of an image renders a corrupt URI.
  it('serves a repeated read from the cache, still byte-exact', async () => {
    const bytes = imageBytes('cached');
    const original = bodyWith(bytes);
    await insertViaRepo(repo, db, 'e1', original);

    const first = await repo.get('e1');
    const second = await repo.get('e1'); // cache hit
    expect(first?.rawBody).toBe(original);
    expect(second?.rawBody).toBe(original);
  });

  // The inflate guard: a body with no refs must come straight back, untouched and
  // unscanned. Every read of every plain-text mail goes through here.
  it('returns a ref-free body from inflate without work', () => {
    expect(inflateInlineImages(db, '<p>nothing to do</p>')).toBe('<p>nothing to do</p>');
    expect(inflateInlineImages(db, '')).toBe('');
  });

  // A malformed payload must stay exactly as it is. Replacing it with a ref to an
  // empty blob would turn the sender's broken image into one we appear to own.
  it('leaves a data: URI whose payload decodes to nothing alone', async () => {
    const body = `<img src="data:image/png;base64,${'='.repeat(2048)}">`;
    await insertViaRepo(repo, db, 'e1', body);

    expect(storedBody(db, 'e1')).toBe(body);
    expect(inlineImageStats(db).images).toBe(0);
  });
});

describe('inline images — reclaim and deletion', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    repo = new EmailRepository(() => db);
    clearInlineImageCache();
  });

  afterEach(() => db.close());

  // Deleting a mail must drop its EDGES, never the bytes: at a 10.7x dedup
  // factor the image it used is usually still in thousands of other mails.
  it('drops only the deleted email edges, leaving a shared blob intact', async () => {
    const logo = imageBytes('logo');
    await insertViaRepo(repo, db, 'e1', bodyWith(logo));
    await insertViaRepo(repo, db, 'e2', bodyWith(logo));

    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');

    expect(edgesOf(db, 'e1')).toEqual([]);
    expect(edgesOf(db, 'e2')).toEqual([hashImageBytes(logo)]);
    // The sweep must NOT take it: e2 still references it.
    expect(collectUnreferencedImages(db)).toBe(0);
    const record = await repo.get('e2');
    expect(record?.rawBody).toBe(bodyWith(logo));
  });

  it('reclaims a blob once the last email referencing it is gone', async () => {
    const only = imageBytes('only');
    await insertViaRepo(repo, db, 'e1', bodyWith(only));

    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');

    expect(collectUnreferencedImages(db)).toBe(1);
    expect(inlineImageStats(db).images).toBe(0);
  });

  // The edge cleanup is an explicit trigger, not ON DELETE CASCADE, because
  // `PRAGMA foreign_keys` is per-connection and defaults OFF — any tool opening
  // this DB without it would leak an edge row per deleted email.
  it('cleans edges on delete even with foreign keys OFF', async () => {
    const bytes = imageBytes('fk-off');
    await insertViaRepo(repo, db, 'e1', bodyWith(bytes));

    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM emails WHERE id = ?').run('e1');

    expect(edgesOf(db, 'e1')).toEqual([]);
  });

  // The reason reclaim is a sweep and never a trigger. A body rewrite deletes its
  // edges before inserting the new ones, so a trigger on that delete would see a
  // shared image as momentarily unreferenced and destroy bytes the very next
  // statement is about to reference — with no copy left anywhere.
  it('never loses a shared image across a rewrite of one of its users', async () => {
    const logo = imageBytes('mid-write');
    await insertViaRepo(repo, db, 'e1', bodyWith(logo));
    await insertViaRepo(repo, db, 'e2', bodyWith(logo));

    // e1 is rewritten and, in the same transaction, stops using the logo.
    await repo.update('e1', { rawBody: '<p>no images now</p>' } as never);

    // e2's body must still resolve. If a trigger had eaten the blob, this comes
    // back as a bare ref instead.
    const record = await repo.get('e2');
    expect(record?.rawBody).toBe(bodyWith(logo));
  });
});

describe('inline images — the extraction backfill', () => {
  let db: Database.Database;
  let repo: EmailRepository;
  let backfill: InlineImageBackfill;

  beforeEach(() => {
    db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    repo = new EmailRepository(() => db);
    backfill = new InlineImageBackfill(() => db);
    clearInlineImageCache();
  });

  afterEach(() => db.close());

  it('extracts the bodies an upgraded database already holds', async () => {
    const bytes = imageBytes('upgrade');
    const original = bodyWith(bytes);
    await seedUnextracted(repo, db, 'e1', original);
    expect(storedBody(db, 'e1')).toContain('base64');

    const result = backfill.backfillNow();

    expect(result.changed).toBe(1);
    expect(storedBody(db, 'e1')).not.toContain('base64');
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(bytes)]);
    // And the body still reads back exactly.
    const record = await repo.get('e1');
    expect(record?.rawBody).toBe(original);
    expect(areInlineImagesExtracted(db)).toBe(true);
  });

  it('re-stamps raw_body_len for every body it rewrites', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('len')));
    const lengthBefore = storedLength(db, 'e1');

    backfill.backfillNow();

    expect(storedLength(db, 'e1')).toBeLessThan(lengthBefore);
    expect(storedLength(db, 'e1')).toBe(storedBody(db, 'e1').trim().length);
  });

  // A second run must find nothing to do. Without idempotence, an interrupted
  // pass that restarts would double-store or re-write bodies on every launch.
  it('is a no-op on a second run', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('twice')));
    backfill.backfillNow();
    const after = storedBody(db, 'e1');

    const second = backfill.backfillNow();

    expect(second.changed).toBe(0);
    expect(storedBody(db, 'e1')).toBe(after);
    expect(inlineImageStats(db).images).toBe(1);
  });

  // The pass is interrupted constantly in practice — the app quits. Whatever was
  // committed must be correct on its own, and the rest must still be pending.
  it('leaves a correct database when interrupted mid-walk, and resumes', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      await seedUnextracted(repo, db, id, bodyWith(imageBytes(`img-${id}`)));
    }

    // One chunk, one row: the byte budget always admits at least one row.
    const first = backfill.runChunk(db, 1, '');
    expect(first.changed).toBe(1);
    expect(first.lastId).toBe('e1');

    // e1 is fully done (blob, ref and edge all committed together)...
    expect(storedBody(db, 'e1')).not.toContain('base64');
    expect(edgesOf(db, 'e1')).toHaveLength(1);
    // ...and the others are untouched, still holding their base64.
    expect(storedBody(db, 'e2')).toContain('base64');
    expect(areInlineImagesExtracted(db)).toBe(false);

    // A fresh instance resumes from the data with nothing to reconcile.
    const resumed = new InlineImageBackfill(() => db);
    expect(resumed.backfillNow().changed).toBe(2);
    for (const id of ['e1', 'e2', 'e3']) {
      expect(storedBody(db, id)).not.toContain('base64');
    }
  });

  // The regression this walk exists for: the cursor (`raw_body LIKE '%;base64,%'`)
  // deliberately matches more than the pass rewrites — a pixel-only body stays in
  // it forever. An exit condition of "loop until the cursor is empty" spins
  // forever on exactly this row. If this test hangs, that is the bug back.
  it('terminates on a body it deliberately leaves alone', async () => {
    await seedUnextracted(
      repo,
      db,
      'e1',
      '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP">',
    );
    await seedUnextracted(repo, db, 'e2', bodyWith(imageBytes('real')));

    const result = backfill.backfillNow();

    expect(result.visited).toBe(2);
    expect(result.changed).toBe(1); // only e2
    expect(storedBody(db, 'e1')).toContain('base64'); // the pixel stays
    expect(areInlineImagesExtracted(db)).toBe(true);
    // And a re-walk of a "complete" DB still terminates and changes nothing.
    expect(backfill.backfillNow().changed).toBe(0);
  });

  // THE performance regression. The behaviour is identical either way — only the
  // cost changes — so it is asserted on the statement and its plan, the only
  // places it is visible at all.
  //
  // A V8 CPU profile of the running app put 90% of ALL main-thread time (21.7s of
  // 30) in this one statement, against 0.3% for the transaction doing the real
  // work. The cause was `LENGTH(raw_body)` in the select list: the partial index
  // carries `email_id` alone, so asking for anything else makes SQLite fetch each
  // candidate's row and decrypt a multi-megabyte body through SQLCipher — ~240 MB
  // read to authorize 2 MB of work. Measured on plain SQLite with 200 KB bodies:
  // 7.11 ms with the length, 0.02 ms without. A 355x tax for a number the
  // transaction below already gets free from the body it reads anyway.
  //
  // Note what is NOT asserted: "COVERING INDEX". SQLite never labels a PARTIAL
  // index covering when the query repeats the partial predicate, even though it
  // demonstrably reads no rows (0.02 ms across 600 MB of bodies). The label is
  // absent by design, so asserting it would only pin a lie. What keeps the cost
  // down is the select list, so that is what this guards.
  it('reads no body column when it looks for candidates', () => {
    // The SELECT LIST only — `raw_body` MUST appear in the WHERE, verbatim, or
    // the partial index is lost. A body column in the select list, wrapped in
    // anything at all, is the 355x regression.
    const selectList = IMAGE_CANDIDATES_SQL.split(/\bFROM\b/i)[0];
    expect(selectList).not.toMatch(/raw_body|clean_body/);
    expect(selectList).toMatch(/^SELECT\s+email_id\s*$/);

    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${IMAGE_CANDIDATES_SQL}`).all('', 100) as Array<{
        detail: string;
      }>
    )
      .map((row) => row.detail)
      .join(' | ');

    // It must walk the partial index — a full table scan would read every body
    // in the mailbox, which is the same disaster by a different route.
    expect(plan).toContain('idx_email_bodies_image_pending');
    expect(plan).not.toMatch(/SCAN email_bodies(?! USING)/);
  });

  // Regression: the same mistake as above, one table over, and it shipped. The
  // stats line at the end of the pass totals `byte_length` — an integer column
  // that sits AFTER the `bytes` BLOB in the record, so without the v75 index
  // SQLite walks every image's overflow pages to reach it. That is the whole
  // image store read and decrypted to add up a thousand integers, and the
  // event-loop monitor logged it as one 2613 ms freeze at the moment the pass
  // finished. Measured on plain SQLite with 1024 blobs of 640 KB: 70.7 ms
  // without this index, 0.0 ms with it.
  it('totals the stored image sizes without reading a single blob', () => {
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${INLINE_IMAGE_SIZE_SQL}`).all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(' | ');

    // Here the COVERING label IS load-bearing: the index is unconditional, so
    // SQLite does say it, and saying it is exactly the proof that no row — and
    // therefore no blob — is touched.
    expect(plan).toContain('COVERING INDEX idx_inline_images_byte_length');
  });

  // And the number it reports must still be right: an index that made the query
  // cheap but the total wrong would silently understate every storage report.
  it('still reports the true total after the index answers it', async () => {
    const bytes = [imageBytes('sized-a', 3), imageBytes('sized-b', 5)];
    await insertViaRepo(repo, db, 'e1', bodyWith(...bytes));

    const stats = inlineImageStats(db);

    expect(stats.images).toBe(2);
    expect(stats.bytes).toBe(bytes[0].length + bytes[1].length);
  });

  // Per-row cost spans four orders of magnitude (1 KB to 21 MB), so the chunk is
  // budgeted in bytes. A row-counted chunk would hold the transaction, the WAL
  // and the main thread for as long as the wrong 100 rows take.
  it('fills a chunk to the byte budget, and always takes at least one row', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      await seedUnextracted(repo, db, id, bodyWith(imageBytes(`b-${id}`, 4)));
    }

    // A budget far below one body still makes progress on exactly one row.
    expect(backfill.runChunk(db, 10, '').visited).toBe(1);
    // A budget above all of them takes the rest in one go.
    expect(backfill.runChunk(db, 100 * 1024 * 1024, 'e1').visited).toBe(2);
  });

  it('marks a database with nothing to extract complete without touching a row', async () => {
    await insertViaRepo(repo, db, 'e1', '<p>plain text mail</p>');

    const result = backfill.backfillNow();

    expect(result.visited).toBe(0);
    expect(areInlineImagesExtracted(db)).toBe(true);
  });

  // FTS5 indexes `clean_body`, which is plain text and has never held an image.
  // The body trigger's guard is `WHEN new.clean_body IS NOT old.clean_body`, so a
  // pass that writes `raw_body` only must not re-tokenize anything — a pass that
  // touched `clean_body` would re-index the entire mailbox on top of the rewrite.
  it('does not disturb the search index', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('fts')));
    const before = ftsIds(db, 'hello');
    expect(before).toContain('e1');

    backfill.backfillNow();

    expect(ftsIds(db, 'hello')).toEqual(before);
    // And the base64 never entered the index in the first place — searching for a
    // fragment of it must find nothing, before or after.
    expect(ftsIds(db, 'sarv')).toEqual([]);
  });
});

describe('inline images — the backfill as a background task', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    repo = new EmailRepository(() => db);
    clearInlineImageCache();
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

  // The delay is the whole reason this is a background task: a launch that
  // competed with an 8.83 GB rewrite would show a splash screen for minutes.
  it('waits before the first chunk, then extracts', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('delayed')));
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storedBody(db, 'e1')).toContain('base64'); // not yet

    await vi.advanceTimersByTimeAsync(30_000);
    expect(storedBody(db, 'e1')).not.toContain('base64');
    expect(areInlineImagesExtracted(db)).toBe(true);
    backfill.stop();
  });

  // A quit during the delay must leave the timer dead. A pump firing against a
  // closed database is an unhandled rejection in the main process — a crash.
  it('stop() before the first chunk cancels it entirely', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('cancelled')));
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    backfill.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(storedBody(db, 'e1')).toContain('base64');
    expect(areInlineImagesExtracted(db)).toBe(false);
  });

  // start() is called on every launch and from more than one place. A second
  // call adding a second timer chain would double every chunk from then on.
  it('is idempotent — a second start does not add a second chain', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('twice-started')));
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    backfill.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(inlineImageStats(db).images).toBe(1);
    expect(edgesOf(db, 'e1')).toHaveLength(1);
    backfill.stop();
  });

  it('resumes on a later start after a stop', async () => {
    await seedUnextracted(repo, db, 'e1', bodyWith(imageBytes('resumed')));
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    backfill.stop();
    backfill.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(storedBody(db, 'e1')).not.toContain('base64');
    backfill.stop();
  });

  // Every writer is supposed to relocate its images, but "supposed to" is the
  // invariant a future write path breaks, and the breakage is silent: the body
  // keeps its base64 and the database quietly grows again. So the walk runs even
  // on a database already marked complete, and repairs what it finds.
  it('repairs a body that a writer stored with its base64 intact', async () => {
    await insertViaRepo(repo, db, 'e1', bodyWith(imageBytes('bypassed')));
    const bytes = imageBytes('smuggled');
    const smuggled = bodyWith(bytes);
    // A writer bypassing rawBodyForStorage — raw SQL straight into the body.
    db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?').run(smuggled, 'e1');
    expect(areInlineImagesExtracted(db)).toBe(false);
    new InlineImageBackfill(() => db).backfillNow();
    expect(areInlineImagesExtracted(db)).toBe(true);

    // Second launch: the flag is set, but the walk still runs.
    db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?').run(smuggled, 'e1');
    const backfill = new InlineImageBackfill(() => db);
    backfill.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(storedBody(db, 'e1')).not.toContain('base64');
    expect(edgesOf(db, 'e1')).toEqual([hashImageBytes(bytes)]);
    backfill.stop();
  });

  // A WARN that fires when nothing is wrong is worse than no WARN at all: it
  // trains everyone to scroll past the line that will one day be real. This one
  // fired on 112 bodies on the first launch after migration 74, and the writer it
  // accused did not exist.
  //
  // Base64 arriving on a DB already marked extracted has two causes. Phase 2's
  // relocation pass moves bodies out of `emails` with plain SQL, deliberately
  // NOT through rawBodyForStorage, so every row it feeds in still holds its
  // base64 — extraction finding work again is then the two passes interleaving,
  // and it resolves itself. Only once relocation is DONE does the same evidence
  // mean an ingest path skipped extraction.
  describe('base64 on an already-extracted database', () => {
    /** Marks extraction complete, then smuggles a base64 body in behind it. */
    const smuggleIntoExtractedDb = async (bytes: Buffer): Promise<void> => {
      await insertViaRepo(repo, db, 'e1', bodyWith(imageBytes('first')));
      new InlineImageBackfill(() => db).backfillNow();
      expect(areInlineImagesExtracted(db)).toBe(true);
      db.prepare('UPDATE email_bodies SET raw_body = ? WHERE email_id = ?').run(
        bodyWith(bytes),
        'e1',
      );
    };

    const linesAbout = (level: string): string[] =>
      logLines
        .filter((line) => line.level === level && line.message.includes('already'))
        .map((line) => line.message);

    it('stays quiet while relocation is still feeding rows in', async () => {
      await smuggleIntoExtractedDb(imageBytes('mid-relocation'));
      // A fresh DB seeds bodies_relocated = '0'; Phase 2 has not finished.
      const backfill = new InlineImageBackfill(() => db);

      backfill.start();
      await vi.advanceTimersByTimeAsync(30_000);
      backfill.stop();

      // Repaired either way — the body must not keep its base64.
      expect(storedBody(db, 'e1')).not.toContain('base64');
      expect(linesAbout('warn')).toEqual([]);
      expect(linesAbout('info')[0]).toContain('relocation is still feeding rows in');
    });

    it('accuses the writer once relocation can no longer explain it', async () => {
      await smuggleIntoExtractedDb(imageBytes('genuine-bypass'));
      markBodiesRelocated(db);
      const backfill = new InlineImageBackfill(() => db);

      backfill.start();
      await vi.advanceTimersByTimeAsync(30_000);
      backfill.stop();

      expect(storedBody(db, 'e1')).not.toContain('base64');
      expect(linesAbout('warn')[0]).toContain('bypassed rawBodyForStorage');
    });

    // A multi-account install runs one of these per account, and the lines
    // interleave. Without the DB name in them, a warning cannot be attributed to
    // a mailbox — which is what made the false alarm above take a log dig and a
    // profile to place. An unused label would be silently useless, so assert it
    // reaches the logger.
    it('names the account database in the lines it logs', async () => {
      await smuggleIntoExtractedDb(imageBytes('labelled'));
      markBodiesRelocated(db);
      const backfill = new InlineImageBackfill(() => db, 'sarvinbox-abc123.db');

      backfill.start();
      await vi.advanceTimersByTimeAsync(30_000);
      backfill.stop();

      const warned = logLines.find((line) => line.message.includes('bypassed'));
      expect(warned?.name).toBe('inline-image-backfill:sarvinbox-abc123.db');
    });

    // The steady state on every launch forever: the cursor still matches the
    // pixel-only bodies the pass leaves alone, and changes none of them. Neither
    // log line may fire, or the app cries wolf on every single launch.
    it('says nothing when the walk changes nothing', async () => {
      await insertViaRepo(repo, db, 'e1', '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP">');
      new InlineImageBackfill(() => db).backfillNow();
      markBodiesRelocated(db);
      logLines.length = 0;
      const backfill = new InlineImageBackfill(() => db);

      backfill.start();
      await vi.advanceTimersByTimeAsync(30_000);
      backfill.stop();

      expect(linesAbout('warn')).toEqual([]);
      expect(linesAbout('info')).toEqual([]);
    });
  });

  // The overwhelmingly common launch: a fresh install, or any launch after this
  // finished. It must cost one index seek and mark itself done — never a walk.
  it('marks a database with nothing to extract complete on the first tick', async () => {
    await insertViaRepo(repo, db, 'e1', '<p>no images anywhere</p>');
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(areInlineImagesExtracted(db)).toBe(true);
    expect(inlineImageStats(db).images).toBe(0);
    backfill.stop();
  });

  // A tick that fires while the previous one is still walking would run two
  // transactions over the same cursor — double the work, and two writers
  // contending for the same rows.
  it('does not re-enter a tick that is still running', async () => {
    for (const id of ['e1', 'e2', 'e3']) {
      await seedUnextracted(repo, db, id, bodyWith(imageBytes(`re-${id}`)));
    }
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    // Fire the recheck cadence repeatedly while the first walk is mid-flight.
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // Three images, one blob each, one edge each — no double-store from a
    // second concurrent walk.
    expect(inlineImageStats(db).images).toBe(3);
    expect(inlineImageStats(db).links).toBe(3);
    backfill.stop();
  });

  // Quitting mid-pass. The walk must abandon at a chunk boundary, leaving every
  // committed chunk correct — a stop that only took effect at the end would hold
  // the app open behind an 8.83 GB rewrite.
  it('abandons the walk at a chunk boundary when stopped mid-pass', async () => {
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
      await seedUnextracted(repo, db, id, bodyWith(imageBytes(`stop-${id}`)));
    }
    const backfill = new InlineImageBackfill(() => db);

    backfill.start();
    // Fire the start timer, then stop before the walk's yield resumes.
    await vi.advanceTimersToNextTimerAsync();
    backfill.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    // Whatever it did commit is fully consistent: no body holds base64 without
    // its blob and edge, and none is half-rewritten.
    const done = ['e1', 'e2', 'e3', 'e4'].filter((id) => !storedBody(db, id).includes('base64'));
    for (const id of done) {
      expect(edgesOf(db, id)).toHaveLength(1);
      expect(storedLength(db, id)).toBe(storedBody(db, id).trim().length);
    }
    expect(inlineImageStats(db).images).toBe(done.length);
    // Stopping is not finishing: the flag stays off unless the walk ran out.
    if (done.length < 4) expect(areInlineImagesExtracted(db)).toBe(false);
  });

  // A closed or not-yet-initialised database must never throw out of a
  // background timer. The pass is an optimisation; un-extracted bodies render
  // exactly as they did before this change.
  it('survives a database that is unavailable or fails mid-pass', async () => {
    expect(new InlineImageBackfill(() => null).backfillNow()).toEqual({
      visited: 0,
      changed: 0,
      savedChars: 0,
    });

    const missing = new InlineImageBackfill(() => null);
    missing.start();
    await vi.advanceTimersByTimeAsync(30_000);
    missing.stop();

    // A handle that throws on use — what a closed DB looks like from here. The
    // throw happens inside the timer callback, so nothing is there to catch it
    // if the pass does not catch it itself.
    let failures = 0;
    const broken = {
      prepare: () => {
        failures += 1;
        throw new Error('database connection is closed');
      },
      transaction: () => () => undefined,
    } as unknown as Database.Database;
    const backfill = new InlineImageBackfill(() => broken);
    backfill.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const afterFirstTick = failures;
    expect(afterFirstTick).toBeGreaterThan(0); // it did try

    // And it has scheduled itself to try again rather than given up silently.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failures).toBeGreaterThan(afterFirstTick);
    backfill.stop();
  });

  // What breaks if these fail: nothing in the data, and everything in the app.
  // The rows come out identically extracted whether the pass rested between
  // chunks or owned the main thread for the full 13 minutes — the difference is
  // only that in the second case IMAP reads time out, IPC replies queue up and
  // macOS draws the beachball. A CPU profile of the running app measured exactly
  // that: 79% of wall clock in JS with a yielder in this position, because a
  // yield hands the thread back for one turn and the loop takes it straight back.
  describe('pacing', () => {
    /** Bodies over CHUNK_BYTES, so the walk is forced to take several chunks. */
    async function seedOversizedBodies(ids: string[]): Promise<void> {
      for (const id of ids) {
        // ~800 KB of bytes is ~1.07 MB of base64 — one chunk's whole budget.
        await seedUnextracted(repo, db, id, bodyWith(imageBytes(`paced-${id}`, 800)));
      }
    }

    it('rests after every committed chunk, at a duty cycle below full speed', async () => {
      await seedOversizedBodies(['e1', 'e2', 'e3']);
      const backfill = new InlineImageBackfill(() => db);

      backfill.start();
      await vi.advanceTimersByTimeAsync(120_000);
      backfill.stop();

      // The work still finished — pacing must slow the pass, never stall it.
      expect(areInlineImagesExtracted(db)).toBe(true);
      expect(inlineImageStats(db).images).toBe(3);
      // One rest per chunk, and each body filled a chunk on its own.
      expect(pacer.rests).toBeGreaterThanOrEqual(3);
      // A duty cycle of 1 (or an absent one) is the unpaced bug this replaces.
      expect(pacer.dutyCycles[0]).toBeGreaterThan(0);
      expect(pacer.dutyCycles[0]).toBeLessThan(1);
    });

    // Regression: a progress line per chunk is itself a stall. `logger.debug` is
    // not level-gated and there are thousands of chunks on a 10 GB mailbox, so
    // the cadence is a clock, not a counter.
    it('says nothing per chunk while the progress cadence has not elapsed', async () => {
      await seedOversizedBodies(['e1', 'e2', 'e3']);
      const backfill = new InlineImageBackfill(() => db);

      backfill.start();
      await vi.advanceTimersByTimeAsync(120_000);
      backfill.stop();

      expect(pacer.rests).toBeGreaterThanOrEqual(3);
      expect(logLines.filter((line) => line.message.includes('visited'))).toHaveLength(0);
    });

    // The other half of that trade: a multi-minute pass that logs only its start
    // and end looks indistinguishable from a hung one, which is how the last
    // stall went unnoticed. Once the cadence elapses it must report.
    it('reports progress once the cadence elapses', async () => {
      await seedOversizedBodies(['e1', 'e2', 'e3']);
      pacer.elapseMs = 31_000; // each rest carries the clock past PROGRESS_LOG_MS
      const backfill = new InlineImageBackfill(() => db);

      backfill.start();
      await vi.advanceTimersByTimeAsync(120_000);
      backfill.stop();

      const progress = logLines.filter((line) => line.message.includes('visited'));
      expect(progress.length).toBeGreaterThan(0);
      expect(progress[0].level).toBe('info');
      expect(progress[0].message).toMatch(/Inline-image extraction: \d+\/\d+ visited/);
      expect(progress[0].message).toMatch(/MB saved so far/);
    });
  });

  // A pre-v74 database has no state row to read. The flag probe must answer
  // "not extracted" rather than throw, or an upgrade path that runs the check
  // before the migration takes the app down.
  it('reads the flag as false on a database without the state table', () => {
    db.prepare('DROP TABLE email_body_metrics_state').run();
    expect(areInlineImagesExtracted(db)).toBe(false);
  });
});

describe('inline images — rollback and multi-account', () => {
  beforeEach(() => clearInlineImageCache());

  // The blobs are the ONLY copy of those bytes once the refs are written, so a
  // rollback that drops the tables without inflating first is data loss —
  // silent, and only discovered when someone opens an old mail.
  it('restores every image inline before dropping the tables', async () => {
    const db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    const repo = new EmailRepository(() => db);
    const bytes = imageBytes('rollback');
    const original = bodyWith(bytes);
    await insertViaRepo(repo, db, 'e1', original);
    expect(storedBody(db, 'e1')).not.toContain('base64');
    const lengthAsRef = storedLength(db, 'e1');

    createMigrationManager(db).rollback(73);

    expect(storedBody(db, 'e1')).toBe(original);
    // The length column has to come back with it, or a rolled-back DB reads as
    // though every image-bearing mail were a fortieth of its size.
    expect(storedLength(db, 'e1')).toBeGreaterThan(lengthAsRef);
    expect(storedLength(db, 'e1')).toBe(original.trim().length);
    db.close();
  });

  // v75 is a pure index, so its rollback must take the index and nothing else —
  // a `down()` that dropped a table here would be data loss, and one that left
  // the index behind would block a re-run of the chain.
  it('drops only the size index when migration 75 is rolled back', async () => {
    const db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    await insertViaRepo(new EmailRepository(() => db), db, 'e1', bodyWith(imageBytes('sized')));

    createMigrationManager(db).rollback(74);

    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).not.toContain('idx_inline_images_byte_length');
    // The images themselves — and the total — survive; it is only slow again.
    expect(inlineImageStats(db)).toMatchObject({ images: 1, links: 1 });
    db.close();
  });

  // Each account owns its own database file. The hash is the identity of the
  // BYTES, so the same logo in two accounts is the same hash — but the blobs and
  // edges must be entirely separate, or deleting one account's mail would reach
  // into the other's images.
  it('keeps two accounts blobs independent while agreeing on the hash', async () => {
    const dbs = [newMigratedDb(), newMigratedDb()];
    const logo = imageBytes('cross-account');
    for (const [index, db] of dbs.entries()) {
      db.pragma('foreign_keys = ON');
      await insertViaRepo(new EmailRepository(() => db), db, `acct${index}`, bodyWith(logo));
    }

    const [first, second] = dbs;
    expect(edgesOf(first, 'acct0')).toEqual(edgesOf(second, 'acct1'));
    expect(inlineImageStats(first).images).toBe(1);

    // Wipe the first account's mail entirely and reclaim.
    first.prepare('DELETE FROM emails').run();
    expect(collectUnreferencedImages(first)).toBe(1);
    expect(inlineImageStats(first).images).toBe(0);

    // The second account is untouched, and its body still resolves — which also
    // proves the resolved-image cache is not answering across databases from a
    // hash it saw in the other one.
    expect(inlineImageStats(second).images).toBe(1);
    expect(inflateInlineImages(second, storedBody(second, 'acct1'))).toBe(bodyWith(logo));
    for (const db of dbs) db.close();
  });

  // A ref whose blob is missing must stay VISIBLE. Substituting a transparent
  // pixel would make a lost image indistinguishable from a deliberate one, so
  // nobody would ever report it.
  it('leaves an unresolvable ref in the body rather than hiding it', async () => {
    const db = newMigratedDb();
    db.pragma('foreign_keys = ON');
    const repo = new EmailRepository(() => db);
    await insertViaRepo(repo, db, 'e1', bodyWith(imageBytes('vanished')));
    const refForm = storedBody(db, 'e1');

    // Simulate the bytes going missing without the body being updated.
    db.prepare('DELETE FROM inline_images').run();
    clearInlineImageCache();

    const record = await repo.get('e1');
    expect(record?.rawBody).toBe(refForm);
    expect(record?.rawBody).toContain('sarv-inline:');
    db.close();
  });
});
