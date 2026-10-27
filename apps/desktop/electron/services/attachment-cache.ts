import { createHash, createHmac, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  createLogger,
  deriveSubkey,
  isSealedBytes,
  openSealedBytes,
  parseAttachmentNames,
  resolveWithinDir,
  safeFilename,
  sealBytes,
  SEALED_BYTES_OVERHEAD,
  type AttachmentRef,
} from '@sarvinbox/core';
import { app } from 'electron';

import { resolveAccountTarget } from './account-target';
import { getDbEncryptionKey } from './db-key-store';

const logger = createLogger('attachment-cache');

/**
 * The on-disk attachment cache, and the one path from "an email plus a
 * filename" to its bytes.
 *
 * Lifted out of `ipc/email-handlers.ts` so the download, forward, system-open
 * and in-app-viewer paths all share one implementation — and so the
 * `sarv-attachment://` protocol handler can reach it without importing the IPC
 * layer.
 *
 * At rest (CASA M-7): every cached file is SEALED (AES-256-GCM, core
 * `sealBytes`) with a key derived from the mail databases' own key, so an
 * attachment on disk is exactly as protected as the mail it came from. Files
 * live per account — `attachment-store/<account>/<email>/<file>` — so removing
 * an account removes its attachments; the account folder is hashed like the
 * account's DB file, and the email and file names are keyed hashes, so a
 * directory listing reveals neither who the mail is for nor what was attached.
 * A cache path is therefore NEVER plaintext: read it with
 * `readCachedAttachment`, and hand an external app a temporary copy instead.
 * Older builds kept plaintext in `attachment-cache/<emailId>/<name>`; see
 * `attachment-cache-legacy.ts`.
 */

// Reject a single attachment larger than this before writing it to disk. Guards
// against a malicious/oversized attachment exhausting disk (the 500 MB cache cap
// below only prunes AFTER the fact). Most providers cap sending well under this.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

// Bound the on-disk attachment cache. Attachments are cached per account and
// email under userData/attachment-store/ and were once never pruned — so the folder
// grew without limit for every attachment ever opened. Enforce a total-size
// cap by evicting least-recently-modified files. Throttled so opening several
// attachments in a row doesn't re-scan the tree each time.
export const ATTACHMENT_CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const ATTACHMENT_CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // at most every 5 min
let lastAttachmentPruneAt = 0;

/** Root of the sealed per-account attachment store. Resolved lazily —
 *  `app.getPath` is only valid once the app is ready. */
function attachmentCacheRoot(): string {
  return path.join(app.getPath('userData'), 'attachment-store');
}

/** Where older builds cached attachments in PLAINTEXT, keyed by email id only. */
export function legacyAttachmentCacheRoot(): string {
  return path.join(app.getPath('userData'), 'attachment-cache');
}

let storeKeys: { seal: Buffer; names: Buffer } | null = null;

/** Both keys come from the DB key, so the store needs no secret of its own. */
function attachmentStoreKeys(): { seal: Buffer; names: Buffer } {
  if (!storeKeys) {
    const root = Buffer.from(getDbEncryptionKey(), 'utf8');
    storeKeys = {
      seal: deriveSubkey(root, 'sarv-inbox/attachment-store/seal/v1'),
      names: deriveSubkey(root, 'sarv-inbox/attachment-store/names/v1'),
    };
  }
  return storeKeys;
}

/** Forget the derived keys (tests that swap the DB key). */
export function resetAttachmentStoreKeys(): void {
  storeKeys = null;
}

/**
 * One account's folder. Hashed exactly like its DB file name (`dbFileForAccount`)
 * so it names no address, and computable without any key so removal and the
 * orphan sweep work even when the key store is locked.
 */
export function accountAttachmentDir(accountId: string): string {
  return path.join(attachmentCacheRoot(), accountDirName(accountId));
}

function accountDirName(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 32);
}

/** A keyed hash: without the key, nobody can confirm a guessed name. */
function hiddenName(kind: 'email' | 'file', value: string): string {
  return createHmac('sha256', attachmentStoreKeys().names).update(`${kind}\0${value}`).digest('hex').slice(0, 32);
}

/** The pre-account default slot has no id yet; its files are swept as orphans. */
const NO_ACCOUNT = '__default__';

function cacheEntryPath(accountId: string | null, emailId: string, filename: string, remote = false): string {
  // Old per-part downloads could repeat a 64 KiB MIME window while retaining
  // a plausible total size. Re-fetch server-backed entries once through the
  // corrected downloader. A separate keyed slot leaves local/unsynced drafts
  // and their only attachment copy intact; never clear the whole store for this.
  const fileKey = remote ? `complete-part-v2\0${filename}` : filename;
  return path.join(accountAttachmentDir(accountId ?? NO_ACCOUNT), hiddenName('email', emailId), hiddenName('file', fileKey));
}

/** Binds sealed bytes to their email and file slot within the account. */
function entryAad(filePath: string): string {
  return `${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`;
}

/**
 * Bump this when a bug made the cached BYTES wrong — not merely stale.
 *
 * A cached file is trusted on existence alone (that is the whole point of a
 * cache), so a file written by broken code is served forever with no way for the
 * app to notice: generation 1 cached the collapsed 7-byte decode of an
 * attachment whose part lied about being base64, and every later open was a
 * cache hit on those 7 bytes. Nothing about the file is locally distinguishable
 * from a genuinely 7-byte attachment, so the only honest signal is "the code
 * that wrote this had the bug" — which is what a generation records.
 *
 * Raising it discards the whole cache ONCE, on the next attachment open. That is
 * safe for everything re-fetchable from the server, which is also what the
 * 500 MB eviction below already assumes — but NOT for an unsynced draft's files
 * (seedAttachmentCache), whose only copy is here: bump it for a real corruption
 * bug, never for housekeeping. The generations of the old plaintext
 * `attachment-cache` ended at 2; the sealed `attachment-store` starts at 1.
 */
const ATTACHMENT_CACHE_GENERATION = 1;
const GENERATION_MARKER = '.cache-generation';

/** One check per cache root per process. Keyed by root so tests using their own
 *  temp userData each get their own check rather than sharing one memo. */
const generationChecked = new Map<string, Promise<void>>();

/**
 * Discard the cache if it was written by an older generation. Best-effort: a
 * cache we cannot clear must never block the attachment the user asked for.
 */
async function ensureCacheGeneration(root: string): Promise<void> {
  let check = generationChecked.get(root);
  if (!check) {
    check = (async () => {
      try {
        const marker = path.join(root, GENERATION_MARKER);
        const seen = await fs.promises.readFile(marker, 'utf8').catch(() => '');
        if (Number(seen) === ATTACHMENT_CACHE_GENERATION) return;
        // `force` so a missing dir (first run) is not an error.
        await fs.promises.rm(root, { recursive: true, force: true });
        await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(marker, String(ATTACHMENT_CACHE_GENERATION), { mode: 0o600 });
        if (seen) {
          logger.info(
            `[attachment-cache] cleared cache from generation ${seen} ` +
              `(now ${ATTACHMENT_CACHE_GENERATION}) — cached files will be re-fetched on demand`,
          );
        }
      } catch (error) {
        logger.warn('[attachment-cache] could not apply cache generation:', error);
      }
    })();
    generationChecked.set(root, check);
  }
  return check;
}

/** The plaintext folder an older build used for one email. */
export function legacyAttachmentDir(emailId: string): string {
  return resolveWithinDir(legacyAttachmentCacheRoot(), safeFilename(emailId));
}

/**
 * An attachment request that failed in a way the caller should report verbatim.
 * `status` maps onto the HTTP status the protocol handler answers with; the IPC
 * handlers use only the message.
 */
export class AttachmentError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/**
 * Evict least-recently-modified cached attachments until the tree is back under
 * `ATTACHMENT_CACHE_MAX_BYTES`. Throttled, and called best-effort (never
 * awaited) after a write — exported so the cache's own tests can drive it.
 */
export async function pruneAttachmentCache(): Promise<void> {
  const now = Date.now();
  if (now - lastAttachmentPruneAt < ATTACHMENT_CACHE_PRUNE_INTERVAL_MS) return;
  lastAttachmentPruneAt = now;

  const root = attachmentCacheRoot();
  let accountDirs: string[];
  try {
    // The generation marker is a file at the root, not an account dir — skip it
    // so it is never counted, evicted, or left as the reason a "dir" scan fails.
    accountDirs = (await fs.promises.readdir(root)).filter((name) => name !== GENERATION_MARKER);
  } catch {
    return; // Cache dir doesn't exist yet — nothing to prune.
  }
  const emailDirs: string[] = [];
  for (const account of accountDirs) {
    try {
      for (const email of await fs.promises.readdir(path.join(root, account))) emailDirs.push(path.join(account, email));
    } catch {
      // Not a directory, or removed mid-scan.
    }
  }

  const files: { path: string; size: number; mtimeMs: number }[] = [];
  let totalBytes = 0;
  for (const dir of emailDirs) {
    const dirPath = path.join(root, dir);
    let names: string[];
    try {
      names = await fs.promises.readdir(dirPath);
    } catch {
      continue;
    }
    for (const name of names) {
      const filePath = path.join(dirPath, name);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      } catch {
        // File vanished mid-scan — ignore.
      }
    }
  }

  if (totalBytes <= ATTACHMENT_CACHE_MAX_BYTES) return;

  // Evict oldest-modified first until back under the cap.
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (totalBytes <= ATTACHMENT_CACHE_MAX_BYTES) break;
    try {
      await fs.promises.rm(file.path, { force: true });
      totalBytes -= file.size;
    } catch {
      // Couldn't delete (in use / permissions) — skip it.
    }
  }

  // Remove now-empty per-email dirs so the tree doesn't accumulate stubs.
  for (const dir of emailDirs) {
    const dirPath = path.join(root, dir);
    try {
      const remaining = await fs.promises.readdir(dirPath);
      if (remaining.length === 0) await fs.promises.rmdir(dirPath);
    } catch {
      // Ignore.
    }
  }
}

/**
 * Cache an attachment to disk, fetching from IMAP if not already cached.
 * Returns the absolute path to the cached file.
 */
export async function getOrCacheAttachment(
  accountId: string | null,
  emailId: string,
  folderPath: string,
  uid: number,
  filename: string,
  // Structurally typed rather than `SyncEngine` so the tests can pass a fake.
  // These mirror SyncEngine.fetchAttachmentPart / .fetchAttachment; they were
  // `Function`, which accepts any callable and silently allowed a fake with the
  // wrong arity through.
  syncEngine: {
    isConnected(): boolean;
    fetchAttachmentPart(
      emailId: string,
      folderPath: string,
      uid: number,
      filename: string
    ): Promise<{ filename: string; content: Buffer } | null>;
    fetchAttachment(
      emailId: string,
      folderPath: string,
      uid: number,
      filename: string
    ): Promise<{ filename: string; contentType: string; content: Buffer }>;
  } | null,
): Promise<string> {
  // IPC input validation: a compromised/misbehaving renderer could pass non-string
  // args, which would throw deep inside path/basename. Fail fast and clearly.
  if (typeof emailId !== 'string' || typeof filename !== 'string' || !emailId || !filename) {
    throw new AttachmentError('Invalid attachment request: emailId and filename must be non-empty strings', 400);
  }

  // `filename` (and even `emailId`) are attacker-controllable — the filename
  // comes straight from the email's MIME headers. Both become keyed hashes, so
  // no name can steer the path. Before trusting anything on disk: drop the
  // cache entirely if it was written by a generation whose bytes we no longer
  // believe (see above).
  await ensureCacheGeneration(attachmentCacheRoot());

  const safeName = safeFilename(filename);
  const cachedPath = cacheEntryPath(accountId, emailId, filename, !!uid);

  // Return cached file if it exists
  try {
    await fs.promises.access(cachedPath);
    return cachedPath;
  } catch {
    // Not cached yet — fetch from IMAP
  }

  // A draft saved while offline has no server copy yet (uid 0): its files exist
  // only where the save seeded them into this cache — or, saved by an older
  // build, in its plaintext cache, which is sealed in here on first use.
  if (!uid) {
    if (await adoptLegacyAttachment(cachedPath, emailId, filename)) return cachedPath;
    throw new AttachmentError('Cannot determine folder/UID for email', 404);
  }
  if (!syncEngine?.isConnected()) {
    throw new AttachmentError('Not connected to IMAP', 503);
  }

  // Prefer fetching JUST this attachment's MIME part (BODY[part]) — far less data
  // than the whole message. Falls back to the full-message parse when the part
  // can't be resolved (e.g. server without the metadata, or a name mismatch).
  const partContent = await syncEngine.fetchAttachmentPart(emailId, folderPath, uid, filename);
  const content: Buffer = partContent?.content
    ?? (await syncEngine.fetchAttachment(emailId, folderPath, uid, filename)).content;
  if (content.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `Attachment "${safeName}" is ${Math.round(content.length / (1024 * 1024))} MB, ` +
        `over the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`,
      413,
    );
  }
  await writeCachedFile(cachedPath, content);
  // Keep the on-disk cache bounded (throttled, best-effort — never block the
  // attachment the user asked for on cache housekeeping).
  void pruneAttachmentCache().catch(() => {});
  return cachedPath;
}

/**
 * An unsynced draft saved by an older build: its files are only in that
 * build's plaintext cache. Seal them into the store and remove the plaintext.
 * Only ever reached after resolveAttachmentFile has checked the email belongs
 * to this account and declares this name.
 */
async function adoptLegacyAttachment(cachedPath: string, emailId: string, filename: string): Promise<boolean> {
  const legacyPath = resolveWithinDir(legacyAttachmentDir(emailId), safeFilename(filename));
  let content: Buffer;
  try {
    content = await fs.promises.readFile(legacyPath);
  } catch {
    return false;
  }
  try {
    await writeCachedFile(cachedPath, content);
  } finally {
    content.fill(0);
  }
  await fs.promises.rm(legacyPath, { force: true });
  return true;
}

async function writeCachedFile(cachedPath: string, content: Buffer): Promise<void> {
  // 0o700 dir / 0o600 file: keep the store non-world-readable on macOS/Linux
  // (no-op on Windows NTFS, harmless) — on top of the sealing.
  await fs.promises.mkdir(path.dirname(cachedPath), { recursive: true, mode: 0o700 });
  // Write to a temp name and rename into place, so an interrupted fetch (dropped
  // connection, quit mid-write) can never leave a TRUNCATED file at the cached
  // path. A partial file would pass the `access` check above forever after and
  // be served as a corrupt document with no way to refresh it.
  // Unique per write: two writes of one entry (a draft opened while the
  // startup migration seals it) must not interleave in one temp file — with a
  // fresh IV each, a mix of the two would never open again.
  const tempPath = `${cachedPath}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
  try {
    await fs.promises.writeFile(tempPath, sealBytes(attachmentStoreKeys().seal, content, entryAad(cachedPath)), { mode: 0o600 });
    await fs.promises.rename(tempPath, cachedPath);
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The plaintext of a cached attachment, from the path resolveAttachmentFile
 * returned. A file that will not open (written under another key, damaged, or
 * not sealed at all) is removed so the next request fetches it afresh, and
 * this one fails rather than serving bytes nobody vouched for.
 *
 * `maxBytes` bounds a read that is held as a snapshot without scanning (the
 * warning-approved path); checked before anything is read. Other readers are
 * not bounded, as when they read the file directly: a draft's own attachment
 * may be larger than a fetch is allowed to be.
 */
export async function readCachedAttachment(filePath: string, maxBytes?: number): Promise<Buffer> {
  // The key BEFORE anything can be called damaged: a key store that will not
  // open says nothing about the file, and deleting it then could cost an
  // unsynced draft its only copy.
  const key = attachmentStoreKeys().seal;
  if (maxBytes !== undefined && (await fs.promises.stat(filePath)).size > maxBytes + SEALED_BYTES_OVERHEAD) {
    throw new AttachmentError('Attachment is too large to open or save without scanning.', 413);
  }
  const sealed = await fs.promises.readFile(filePath);
  try {
    return openSealedBytes(key, sealed, entryAad(filePath));
  } catch {
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    logger.warn('[attachment-cache] discarded a cached attachment that could not be opened');
    throw new AttachmentError('The attachment could not be read. Try again.', 500);
  }
}

/**
 * The plaintext size of a cached attachment, without opening it — or null when
 * the file is not sealed data at all (left by an older build, or damaged), whose
 * size says nothing about the attachment.
 */
export async function cachedAttachmentSize(filePath: string): Promise<number | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, SEALED_BYTES_OVERHEAD));
    await handle.read(head, 0, head.length, 0);
    return isSealedBytes(head) ? size - SEALED_BYTES_OVERHEAD : null;
  } finally {
    await handle.close();
  }
}

/**
 * Put files we already hold into the cache for `emailId` — the attachments of a
 * draft we just wrote locally. Until the IMAP append lands (or forever, when
 * offline) that row has no UID to fetch from, so without this a reopened draft
 * could not get its own attachments back.
 */
export async function seedAttachmentCache(
  accountId: string | null,
  emailId: string,
  files: { filename: string; content: Buffer }[],
): Promise<void> {
  await ensureCacheGeneration(attachmentCacheRoot());
  await Promise.all(
    files.map((file) => writeCachedFile(cacheEntryPath(accountId, emailId, file.filename), file.content)),
  );
  void pruneAttachmentCache().catch(() => {});
}

/** Seal one attachment into an account's store (the legacy-cache migration). */
export async function storeCachedAttachment(
  accountId: string,
  emailId: string,
  filename: string,
  content: Buffer,
): Promise<void> {
  await ensureCacheGeneration(attachmentCacheRoot());
  await writeCachedFile(cacheEntryPath(accountId, emailId, filename), content);
}

// ===== Account lifecycle ===================================================

/** Remove everything cached for an account (account removal). Best-effort. */
export async function deleteAccountAttachments(accountId: string): Promise<void> {
  await fs.promises.rm(accountAttachmentDir(accountId), { recursive: true, force: true });
}

/**
 * Follow an account id change (`rekeyAccount`). The files are sealed against
 * their email and file slot, not the account, so they move as they are. If the
 * new id already has a folder, the entries it lacks are moved in (an entry it
 * already has keeps the new id's copy).
 *
 * Nothing is deleted unless it was moved or is already held by the new id: an
 * unsynced draft's files exist only here. A move that keeps failing throws and
 * leaves the old folder in place.
 */
export async function rekeyAccountAttachments(oldId: string, newId: string): Promise<void> {
  const from = accountAttachmentDir(oldId);
  const to = accountAttachmentDir(newId);
  if (from === to || !(await pathExists(from))) return;
  if (!(await pathExists(to))) {
    await renameRetrying(from, to);
    return;
  }
  let left = false;
  for (const email of await fs.promises.readdir(from)) {
    const source = path.join(from, email);
    const target = path.join(to, email);
    if (!(await pathExists(target))) {
      left = !(await moved(source, target)) || left;
      continue;
    }
    for (const file of await fs.promises.readdir(source)) {
      if (await pathExists(path.join(target, file))) continue; // the new id's copy wins
      left = !(await moved(path.join(source, file), path.join(target, file))) || left;
    }
  }
  if (left) {
    logger.warn('[attachment-cache] rekey left some cached attachments under the old account id; they stay for a retry');
    return;
  }
  await fs.promises.rm(from, { recursive: true, force: true });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function moved(source: string, target: string): Promise<boolean> {
  try {
    await renameRetrying(source, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A rename that rides out a short lock: on Windows a file another process has
 * open (antivirus scanning it just after it was written) refuses a move with
 * EPERM / EACCES / EBUSY for a moment.
 */
async function renameRetrying(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

/**
 * Remove the folders of accounts that no longer exist (removed, or rekeyed while
 * a crash interrupted the move). Same rules as the orphan-DB sweep: the
 * keep-set must come from `readRegistryAccounts` (which throws rather than
 * reporting an unreadable registry as empty), an EMPTY keep-set is not
 * authoritative and removes nothing, and only folders untouched for
 * `staleAfterMs` go. Returns how many folders were removed.
 */
export async function cleanupOrphanedAttachmentStores(
  keepAccountIds: string[],
  { staleAfterMs = 60 * 60 * 1000 }: { staleAfterMs?: number } = {},
): Promise<number> {
  if (!keepAccountIds.length) return 0;
  const keep = new Set(keepAccountIds.map(accountDirName));
  const root = attachmentCacheRoot();
  let removed = 0;
  for (const name of await fs.promises.readdir(root).catch(() => [] as string[])) {
    if (name === GENERATION_MARKER || keep.has(name) || !/^[0-9a-f]{32}$/.test(name)) continue;
    const dir = path.join(root, name);
    try {
      // `0` means no guard at all: a folder written this very millisecond can
      // carry an mtime a fraction ahead of Date.now().
      if (staleAfterMs > 0 && Date.now() - (await fs.promises.stat(dir)).mtimeMs < staleAfterMs) continue;
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or not removable now — the next sweep retries.
    }
  }
  return removed;
}

/**
 * Remove every cached attachment, sealed and legacy plaintext alike: the last
 * account was removed, so none of it belongs to anyone. Callers must have just
 * seen the registry go from non-empty to empty through a deliberate removal —
 * never on a registry that merely read as empty.
 */
export async function removeAllCachedAttachments(): Promise<void> {
  // The generation marker goes with the folder: forget that it was checked, so
  // the next write re-creates it. Without it the next launch would take the
  // markerless store for an old generation and wipe it — a draft saved in
  // between included.
  generationChecked.delete(attachmentCacheRoot());
  await fs.promises.rm(attachmentCacheRoot(), { recursive: true, force: true });
  await fs.promises.rm(legacyAttachmentCacheRoot(), { recursive: true, force: true });
}

/**
 * The full "email id + filename -> a cached file" path, including the account
 * resolution and the authorization check. The file is SEALED: read it with
 * readCachedAttachment.
 *
 * Every caller (download, forward-as-base64, open-in-system-app, and the
 * viewer's protocol handler) goes through here, so the check below cannot be
 * skipped by adding a new entry point.
 */
export async function resolveAttachmentFile(
  ref: AttachmentRef,
): Promise<{ filePath: string; filename: string }> {
  const { emailId, filename, accountId } = ref;
  if (typeof emailId !== 'string' || typeof filename !== 'string' || !emailId || !filename) {
    throw new AttachmentError('Invalid attachment request', 400);
  }

  const { storage, syncEngine, accountId: owner } = await resolveAccountTarget(accountId);

  const email = await storage.getEmail(emailId);
  if (!email) throw new AttachmentError('Email not found', 404);

  // SECURITY: only ever serve a name this email actually declared. Without this
  // the caller chooses the filename, and with it which cached file of this
  // email is read.
  const declared = parseAttachmentNames(email.attachmentNames);
  if (!declared.includes(filename)) {
    throw new AttachmentError('Attachment not found on this email', 403);
  }

  const folder = await storage.getFolder(email.folderId);
  if (!folder) {
    throw new AttachmentError('Cannot determine folder/UID for email', 404);
  }

  // No UID is allowed through: a cache hit needs none (a locally-saved draft),
  // and a miss without one is refused inside.
  const filePath = await getOrCacheAttachment(owner, emailId, folder.path, email.uid || 0, filename, syncEngine);
  await reconcileStoredAttachmentSize(storage, email, filename, filePath);
  return { filePath, filename };
}

/**
 * Make the size stored against the email agree with the bytes we actually have.
 *
 * The stored size comes from parsing the message at import, so a part that lied
 * about its encoding was recorded at its collapsed decode length — an attachment
 * listed as "7 B" on the message and in the viewer header while the real file is
 * a kilobyte. Repairing the fetch does not repair that number: the import only
 * runs once per message, and a mailbox full of already-imported mail would keep
 * showing the wrong size forever.
 *
 * The file on disk is the authority here, because it is exactly what the viewer
 * renders and what "Save a copy" writes — so a size taken from it cannot
 * disagree with what the user sees. Best-effort and silent: a size that fails to
 * update is a cosmetic wrong number, never a reason to fail the open.
 */
async function reconcileStoredAttachmentSize(
  storage: { updateEmail(id: string, updates: { attachmentSizes: string }): Promise<void> },
  email: { id: string; attachmentNames?: string | null; attachmentSizes?: string | null },
  filename: string,
  filePath: string,
): Promise<void> {
  try {
    const declared = parseAttachmentNames(email.attachmentNames);
    const index = declared.indexOf(filename);
    if (index < 0) return;

    const stored: unknown = JSON.parse(email.attachmentSizes ?? 'null');
    // Only touch a well-formed parallel array. A legacy/absent value is left for
    // the import path to populate rather than half-written from one attachment.
    if (!Array.isArray(stored) || stored.length !== declared.length) return;

    const actualBytes = await cachedAttachmentSize(filePath);
    if (actualBytes === null || stored[index] === actualBytes) return;

    const next = [...stored];
    next[index] = actualBytes;
    await storage.updateEmail(email.id, { attachmentSizes: JSON.stringify(next) });
    logger.info(
      `[attachment-cache] corrected stored size for "${filename}": ` +
        `${String(stored[index])} -> ${actualBytes} bytes`,
    );
  } catch (error) {
    logger.warn('[attachment-cache] could not reconcile stored attachment size:', error);
  }
}

/** Message for a failed attachment request, without leaking internals. */
export function attachmentErrorMessage(error: unknown): string {
  if (error instanceof AttachmentError) return error.message;
  logger.error('[attachment-cache] unexpected failure:', error);
  return (error as Error)?.message ?? 'Attachment could not be read';
}
