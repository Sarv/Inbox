/**
 * Where inline email images LIVE — the `inline_images` blob table, and the one
 * surface that moves image bytes in and out of a body.
 *
 * ## The measurement that produced this
 *
 * A full read-only scan of every body in the live 26,198-email mailbox
 * (Aug 2026) found the database is essentially an image store:
 *
 *   | `emails` table                    | 9.54 GB of a 10.4 GB file (98.1%) |
 *   | `raw_body` within it              | 9.33 GB                           |
 *   | base64 `data:` image URIs         | 8.83 GB — **94.6% of body bytes** |
 *   | actual HTML                       | 0.50 GB                           |
 *   | image occurrences                 | 12,392                            |
 *   | DISTINCT images                   | **1,086** — a 10.7x dedup factor  |
 *   | after dedup, stored as binary     | 0.62 GB                           |
 *
 * 1,086 distinct images stored 12,392 times: logos and signature graphics
 * repeated across thousands of marketing mails, each mail carrying its own full
 * base64 copy. Content-addressing collapses that to one copy, and storing the
 * decoded bytes instead of base64 removes a flat 33% inflation on top.
 *
 * Note the sampling trap, because it nearly chose the wrong design: a 558-body
 * stratified sample put the dedup factor at 1.1x, since an image appearing in
 * 2,000 of 26,198 mails lands in a sparse sample roughly once. Dedup looked
 * worthless and downscaling looked mandatory. It is the other way round — dedup
 * is the entire saving, and no image has to be re-encoded or degraded. Scan
 * everything before revisiting these numbers.
 *
 * ## Why the bytes stay in SQLite rather than going to files
 *
 * A directory of blobs under `userData` would be simpler, and wrong here:
 *
 *  - **At-rest encryption.** The mail DB is SQLCipher-encrypted precisely so a
 *    stolen laptop does not yield the user's mail. Inline images ARE mail
 *    content — scanned documents, screenshots, photos. Writing them to a plain
 *    directory would quietly move the bulk of the mailbox outside the
 *    encryption boundary. A blob column inherits it for free.
 *  - **Account deletion.** Each account owns its DB file; deleting the account
 *    deletes the images with it. A shared blob directory would need
 *    cross-database refcounting to know when a file is safe to remove.
 *  - **No new failure mode.** No partial writes, no orphaned temp files, no
 *    per-OS path-length or case-sensitivity questions, and it stays inside the
 *    transaction that writes the body.
 *
 * Blobs are insert-only and immutable, so the write-amplification argument that
 * moved bodies out of `emails` (see `body-storage.ts`) does not apply to them:
 * nothing ever UPDATEs a row here.
 *
 * ## The contract
 *
 * `raw_body` in `email_bodies` holds `sarv-inline:<hash>` refs, never base64.
 * Everything that reads a body for DISPLAY or for SENDING must go through
 * {@link inflateInlineImages}; everything that writes one must go through
 * {@link relocateBodyImages}. `clean_body` is deliberately untouched — it is
 * plain text derived after the markup is gone, it carries no images, and it is
 * the FTS index source, so putting refs in it would only pollute search tokens.
 */

import { createHash } from 'node:crypto';

import {
  SizeBudgetedLru,
  findDataImages,
  findInlineImageRefs,
  hasInlineImageRefs,
  makeInlineImageRef,
  replaceRanges,
  restoreInlineImages,
} from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { prepared } from '../statement-cache';

import { BODY_METRICS_STATE_TABLE } from './body-storage';

/** Content-addressed image bytes. One row per DISTINCT image. */
export const INLINE_IMAGES_TABLE = 'inline_images';

/**
 * Which emails reference which images — the edge set that makes deletion safe.
 *
 * Without it there is no way to know whether the logo an unsubscribed newsletter
 * used is still needed by the other 1,999 mails that used it. Rebuilt from the
 * body inside the same transaction that writes the body, so an edge can never be
 * missing for a persisted ref.
 */
export const EMAIL_INLINE_IMAGES_TABLE = 'email_inline_images';

/**
 * Content hash of decoded image bytes: SHA-256 truncated to 128 bits.
 *
 * 128 bits, not the 32-bit FNV-1a the renderer's prompt cache uses. That cache
 * holds a few hundred entries and a collision costs one wrong thumbnail for one
 * session; this one is the durable identity of mail content, where a collision
 * means one email silently rendering another's image. At 128 bits a collision
 * across even a million images stays far below the probability of the disk
 * lying to us.
 */
export function hashImageBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Resolved `data:` URIs, keyed by hash.
 *
 * Every email in a thread typically carries the SAME sender logo, so opening a
 * 20-message thread would otherwise decode and base64-re-encode one image 20
 * times. Budgeted in characters because entries range from 1 KB to several MB.
 *
 * Keyed by content hash, so it is safe across accounts and databases by
 * construction — the same hash is the same bytes anywhere.
 */
const dataUriCache = new SizeBudgetedLru<string>({ maxEntries: 256, maxSize: 24 * 1024 * 1024 });

/** Drop the resolved-image cache. Exposed for tests and for re-key/reopen. */
export function clearInlineImageCache(): void {
  dataUriCache.clear();
}

const INSERT_IMAGE_SQL = `
  INSERT INTO ${INLINE_IMAGES_TABLE} (hash, mime, bytes, byte_length, first_seen)
  VALUES (@hash, @mime, @bytes, @byteLength, @firstSeen)
  ON CONFLICT(hash) DO NOTHING
`;

const SELECT_IMAGE_SQL = `SELECT mime, bytes FROM ${INLINE_IMAGES_TABLE} WHERE hash = ?`;

const DELETE_LINKS_SQL = `DELETE FROM ${EMAIL_INLINE_IMAGES_TABLE} WHERE email_id = ?`;

const INSERT_LINK_SQL = `
  INSERT INTO ${EMAIL_INLINE_IMAGES_TABLE} (email_id, hash) VALUES (?, ?)
  ON CONFLICT(email_id, hash) DO NOTHING
`;

/** What {@link relocateBodyImages} did, for logging and for the backfill's tally. */
export interface RelocationResult {
  /** The body with every relocated `data:` URI replaced by a ref. */
  readonly html: string;
  /** Distinct image hashes the body now references. */
  readonly hashes: string[];
  /** Characters removed from the body. */
  readonly savedChars: number;
  /** Bytes newly added to the blob table (0 when every image was already known). */
  readonly storedBytes: number;
}

/**
 * Move every inline `data:` image in `html` into the blob table and return the
 * body with refs in their place.
 *
 * MUST run inside the caller's transaction, alongside the body write. The blob
 * has to be durable before — or atomically with — the body that references it:
 * a body persisted with a ref whose bytes were never written renders a broken
 * image with no way to recover the original, since the base64 it came from is
 * exactly what we just discarded.
 *
 * Takes no email id, and writes no edges, ON PURPOSE. `email_inline_images` has
 * a foreign key to `emails(id)`, so on the INSERT path the edges cannot be
 * written until the header row exists — while the rewritten body has to be in
 * hand BEFORE that INSERT runs, because `raw_body_len` is computed from the
 * bound parameter. Callers therefore relocate first, insert, then call
 * {@link writeImageLinks} with the hashes returned here, all inside one
 * transaction.
 *
 * Idempotent. A body that already holds refs contains no `data:` URIs, so a
 * re-run finds nothing and returns it unchanged — which is what makes the
 * background backfill safe to interrupt and restart, and what keeps a re-fetched
 * message from double-storing.
 */
export function relocateBodyImages(
  db: Database.Database,
  html: string,
  now: number = Math.floor(Date.now() / 1000),
): RelocationResult {
  const found = findDataImages(html);
  if (found.length === 0) {
    // The body may already be in ref form — a re-fetch, or a backfill re-run.
    // Its existing refs are still the edges the caller must record.
    return { html, hashes: findInlineImageRefs(html), savedChars: 0, storedBytes: 0 };
  }

  const insertImage = prepared(db, INSERT_IMAGE_SQL);
  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  const hashes = new Set<string>();
  let savedChars = 0;
  let storedBytes = 0;

  for (const image of found) {
    const bytes = Buffer.from(image.base64, 'base64');
    // A `data:` URI whose payload decodes to nothing is malformed — leave it
    // alone rather than replacing it with a ref to an empty blob, which would
    // turn a broken image in the source into a broken image we appear to own.
    if (bytes.length === 0) continue;
    const hash = hashImageBytes(bytes);
    const info = insertImage.run({
      hash,
      mime: image.mime,
      bytes,
      byteLength: bytes.length,
      firstSeen: now,
    });
    // 0 changes means DO NOTHING fired: this image is already stored, which is
    // the common case at a 10.7x dedup factor.
    if (info.changes > 0) storedBytes += bytes.length;
    const ref = makeInlineImageRef(hash);
    ranges.push({ start: image.start, end: image.end, replacement: ref });
    savedChars += image.length - ref.length;
    hashes.add(hash);
  }

  // Refs the body already carried (a partially-relocated body, e.g. one written
  // before this change and re-fetched after) must keep their edges too.
  const rewritten = replaceRanges(html, ranges);
  for (const hash of findInlineImageRefs(rewritten)) hashes.add(hash);

  return { html: rewritten, hashes: [...hashes], savedChars, storedBytes };
}

/**
 * Make `hashes` the complete set of images `emailId` references.
 *
 * Delete-then-insert rather than a merge: a body being rewritten (an edit, a
 * re-fetch that returned different content) may have STOPPED referencing an
 * image, and a merge would leave that edge behind forever, pinning a blob no
 * mail uses. Both statements are in the caller's transaction.
 *
 * Called unconditionally — including with an empty list — so that a body that
 * lost its last image also loses its last edge. Skipping the call when there is
 * nothing to insert would leave the stale edges in place, which is the one way
 * the GC sweep can be starved forever.
 */
export function writeImageLinks(
  db: Database.Database,
  emailId: string,
  hashes: readonly string[],
): void {
  prepared(db, DELETE_LINKS_SQL).run(emailId);
  if (hashes.length === 0) return;
  const insertLink = prepared(db, INSERT_LINK_SQL);
  for (const hash of hashes) insertLink.run(emailId, hash);
}

/**
 * What an UPDATE site should store as `raw_body`: images relocated, blobs and
 * edges written, refs in their place.
 *
 * A single guarded wrapper rather than three lines repeated at each write site,
 * because there are several of them (the repository plus three desktop
 * main-process writers) and one added later must not be able to silently skip
 * extraction — a write that misses this is not an error, it is a body that
 * quietly keeps its 2 MB of base64 and is never picked up again, because the
 * backfill will long since have marked itself complete.
 *
 * `null` and `undefined` pass straight through UNTOUCHED: a PATCH that does not
 * mention the body must not be turned into one that clears it, and the edges of
 * an untouched body must not be rewritten from a body we were never given.
 *
 * An empty string and an explicit `null` do NOT take that path — they are a body
 * being cleared, so their edges have to go with it. Returning early there would
 * leave the old edges pinning a blob no mail references, and since the reclaim
 * sweep reads the edge table rather than the bodies, nothing would ever notice.
 * Only `undefined` — "this patch says nothing about the body" — is a true no-op.
 *
 * Requires the `emails` row to EXIST (the edge table has a foreign key to it and
 * `sqlite-storage` runs with `foreign_keys = ON`). On the insert path use
 * {@link relocateBodyForInsert} instead; using this one there raises an FK error
 * immediately, which is the failure mode we want — loud, at the first test run,
 * rather than a body silently keeping its base64.
 *
 * MUST be called inside the caller's transaction — see {@link relocateBodyImages}.
 */
export function rawBodyForStorage<T extends string | null | undefined>(
  db: Database.Database,
  emailId: string,
  rawBody: T,
): T {
  // `undefined` is "the patch said nothing about the body" — leave it, and the
  // edges, exactly as they are. `null` and `''` are both a body being CLEARED,
  // and their edges have to go with them for the reason in the doc comment above.
  if (rawBody === undefined) return rawBody;
  if (typeof rawBody !== 'string') {
    writeImageLinks(db, emailId, []);
    return rawBody;
  }
  const relocated = relocateBodyImages(db, rawBody);
  writeImageLinks(db, emailId, relocated.hashes);
  return relocated.html as T;
}

/**
 * The INSERT-path counterpart: relocate the images and persist the blobs, but
 * hand the edges back for the caller to write AFTER the `emails` row lands.
 *
 * Two calls instead of one, because of a genuine ordering constraint rather than
 * taste. `raw_body_len` is computed from the bound `@rawBody` parameter in the
 * same INSERT that creates the header row, so the rewritten body must exist
 * before the row does — while `email_inline_images.email_id` references that row,
 * so the edges cannot exist until after it. Blob rows have no such dependency,
 * which is why they can go first and the body can be durable with bytes already
 * behind every ref it carries.
 */
export function relocateBodyForInsert<T extends string | null | undefined>(
  db: Database.Database,
  rawBody: T,
): { rawBody: T; hashes: string[] } {
  if (typeof rawBody !== 'string' || rawBody.length === 0) return { rawBody, hashes: [] };
  const relocated = relocateBodyImages(db, rawBody);
  return { rawBody: relocated.html as T, hashes: relocated.hashes };
}

/**
 * Put the images back: every `sarv-inline:` ref becomes a `data:` URI again.
 *
 * Call this on any body about to be DISPLAYED or SENT. Do NOT call it on the
 * path to the AI pipeline, the reheal scanner, the phishing check or contact
 * mining: none of them can use image bytes, and inflating a body for them undoes
 * the saving in memory for no benefit. Those want the ref form.
 *
 * A ref whose blob is missing is left in place — see `restoreInlineImages`.
 */
export function inflateInlineImages(db: Database.Database, html: string): string {
  if (!hasInlineImageRefs(html)) return html;
  const select = prepared(db, SELECT_IMAGE_SQL);
  return restoreInlineImages(html, (hash) => {
    const cached = dataUriCache.get(hash);
    if (cached !== undefined) {
      const separator = cached.indexOf(',');
      return { mime: cached.slice(0, separator), base64: cached.slice(separator + 1) };
    }
    const row = select.get(hash) as { mime: string; bytes: Buffer | Uint8Array } | undefined;
    if (!row) return null;
    // `node:sqlite` (the Electron-ABI fallback the tests use) hands back a
    // Uint8Array where better-sqlite3 gives a Buffer; both need to become base64.
    const buffer = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes);
    const base64 = buffer.toString('base64');
    dataUriCache.set(hash, `${row.mime},${base64}`);
    return { mime: row.mime, base64 };
  });
}

/**
 * Set once this database's extraction pass has drained.
 *
 * Shares `email_body_metrics_state` with the length and relocation flags rather
 * than adding a table: it is the same kind of fact about the same subject, and
 * one key-value table for "which body upgrades has this DB had" is easier to
 * read at a glance than three.
 */
export const INLINE_IMAGES_EXTRACTED_KEY = 'inline_images_extracted';

/** Has this DB's inline-image extraction finished? */
export function areInlineImagesExtracted(db: Database.Database): boolean {
  try {
    const row = prepared(db, `SELECT value FROM ${BODY_METRICS_STATE_TABLE} WHERE key = ?`).get(
      INLINE_IMAGES_EXTRACTED_KEY,
    ) as { value?: string } | undefined;
    return row?.value === '1';
  } catch {
    // Table absent on a DB below v74. "Not extracted" is the safe answer: it
    // means bodies are read as-is, which is where their images actually are.
    return false;
  }
}

/** Record that this DB's extraction pass has completed. */
export function markInlineImagesExtracted(db: Database.Database): void {
  db.prepare(
    `INSERT INTO ${BODY_METRICS_STATE_TABLE}(key, value) VALUES (?, '1') ` +
      "ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run(INLINE_IMAGES_EXTRACTED_KEY);
}

/**
 * Total stored image bytes and row count.
 *
 * Exported so a test can EXPLAIN it, because this innocent-looking aggregate was
 * a 2613 ms main-thread block in the running app. `byte_length` sits after the
 * `bytes` BLOB in the record, so without `idx_inline_images_byte_length` (v75)
 * SQLite reaches it by walking every image's overflow pages — the entire image
 * store, decrypted through SQLCipher, to add up a thousand integers.
 */
export const INLINE_IMAGE_SIZE_SQL = `SELECT COUNT(*) AS images,
         COALESCE(SUM(byte_length), 0) AS bytes
    FROM ${INLINE_IMAGES_TABLE}`;

/** Total stored image bytes and row count — for the storage report and tests. */
export function inlineImageStats(db: Database.Database): {
  images: number;
  bytes: number;
  links: number;
} {
  const blobs = db.prepare(INLINE_IMAGE_SIZE_SQL).get() as { images: number; bytes: number };
  const links = db
    .prepare(`SELECT COUNT(*) AS links FROM ${EMAIL_INLINE_IMAGES_TABLE}`)
    .get() as { links: number };
  return { images: blobs.images, bytes: blobs.bytes, links: links.links };
}

/**
 * Delete blob rows no email references any more, returning how many went.
 *
 * Orphans appear when mail is deleted: the delete trigger drops that email's
 * edges, and an image only that mail used is then unreferenced. Driven off the
 * edge table rather than by scanning bodies for refs — the edge set is exact and
 * indexed, whereas a body scan would have to read every body to answer.
 *
 * Deliberately NOT a trigger. A body rewrite deletes an email's edges before
 * inserting the new ones, so a trigger firing on that delete would see the
 * image as momentarily unreferenced and destroy bytes the very next statement
 * is about to reference — with no copy left anywhere. Sweeping explicitly, well
 * away from the write path, cannot race that way.
 */
export function collectUnreferencedImages(db: Database.Database): number {
  const info = db
    .prepare(
      `DELETE FROM ${INLINE_IMAGES_TABLE}
        WHERE NOT EXISTS (
          SELECT 1 FROM ${EMAIL_INLINE_IMAGES_TABLE} l WHERE l.hash = ${INLINE_IMAGES_TABLE}.hash
        )`,
    )
    .run();
  return info.changes;
}
