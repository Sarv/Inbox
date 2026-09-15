import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  createLogger,
  parseAttachmentNames,
  resolveWithinDir,
  safeFilename,
  type AttachmentRef,
} from '@sarvinbox/core';

import { resolveAccountTarget } from './account-target';

const logger = createLogger('attachment-cache');

/**
 * The on-disk attachment cache, and the one path from "an email plus a
 * filename" to "bytes on disk".
 *
 * Lifted out of `ipc/email-handlers.ts` so the download, forward, system-open
 * and in-app-viewer paths all share one implementation — and so the
 * `sarv-attachment://` protocol handler can reach it without importing the IPC
 * layer.
 */

// Reject a single attachment larger than this before writing it to disk. Guards
// against a malicious/oversized attachment exhausting disk (the 500 MB cache cap
// below only prunes AFTER the fact). Most providers cap sending well under this.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

// Bound the on-disk attachment cache. Attachments are cached per email under
// userData/attachment-cache/<emailId>/ and were never pruned — so the folder
// grew without limit for every attachment ever opened. Enforce a total-size
// cap by evicting least-recently-modified files. Throttled so opening several
// attachments in a row doesn't re-scan the tree each time.
export const ATTACHMENT_CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const ATTACHMENT_CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000; // at most every 5 min
let lastAttachmentPruneAt = 0;

/** Root of the per-email attachment cache. Resolved lazily — `app.getPath` is
 *  only valid once the app is ready. */
function attachmentCacheRoot(): string {
  return path.join(app.getPath('userData'), 'attachment-cache');
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
 * safe by construction: everything under here is re-fetchable from the server
 * (attachments, and the calendar `.ics` files written alongside them), which is
 * also what the 500 MB eviction below already assumes.
 */
const ATTACHMENT_CACHE_GENERATION = 2;
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

/**
 * The cache directory for one email.
 *
 * SECURITY: `emailId` reaches us from the renderer, so it is reduced to a safe
 * basename and the result asserted to stay inside the cache root — a crafted id
 * like "../../db-key.bin" must not escape. Exported so every writer into the
 * cache (attachments here, the calendar-invite .ics in `email-handlers`) derives
 * the path the same way instead of re-joining the root by hand.
 */
export function attachmentCacheDir(emailId: string): string {
  return resolveWithinDir(attachmentCacheRoot(), safeFilename(emailId));
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
  let emailDirs: string[];
  try {
    // The generation marker is a file at the root, not a per-email dir — skip it
    // so it is never counted, evicted, or left as the reason a "dir" scan fails.
    emailDirs = (await fs.promises.readdir(root)).filter((name) => name !== GENERATION_MARKER);
  } catch {
    return; // Cache dir doesn't exist yet — nothing to prune.
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
  emailId: string,
  folderPath: string,
  uid: number,
  filename: string,
  syncEngine: { isConnected(): boolean; fetchAttachmentPart: Function; fetchAttachment: Function } | null,
): Promise<string> {
  // IPC input validation: a compromised/misbehaving renderer could pass non-string
  // args, which would throw deep inside path/basename. Fail fast and clearly.
  if (typeof emailId !== 'string' || typeof filename !== 'string' || !emailId || !filename) {
    throw new AttachmentError('Invalid attachment request: emailId and filename must be non-empty strings', 400);
  }

  // SECURITY: `filename` (and even `emailId`) are attacker-controllable — the
  // filename comes straight from the email's MIME headers. Reduce each to a safe
  // basename and assert the resolved path stays inside the cache dir, so a
  // crafted name like "../../../db-key.bin" can't escape and clobber files.
  // Before trusting anything on disk: drop the cache entirely if it was written
  // by a generation whose bytes we no longer believe (see above).
  await ensureCacheGeneration(attachmentCacheRoot());

  const cacheDir = attachmentCacheDir(emailId);
  const safeName = safeFilename(filename);
  const cachedPath = resolveWithinDir(cacheDir, safeName);

  // Return cached file if it exists
  try {
    await fs.promises.access(cachedPath);
    return cachedPath;
  } catch {
    // Not cached yet — fetch from IMAP
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
  // 0o700 dir / 0o600 file: keep cached attachments non-world-readable on
  // macOS/Linux (no-op on Windows NTFS, harmless).
  await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  // Write to a temp name and rename into place, so an interrupted fetch (dropped
  // connection, quit mid-write) can never leave a TRUNCATED file at the cached
  // path. A partial file would pass the `access` check above forever after and
  // be served as a corrupt document with no way to refresh it.
  const tempPath = `${cachedPath}.${process.pid}.partial`;
  try {
    await fs.promises.writeFile(tempPath, content, { mode: 0o600 });
    await fs.promises.rename(tempPath, cachedPath);
  } catch (err) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
  // Keep the on-disk cache bounded (throttled, best-effort — never block the
  // attachment the user asked for on cache housekeeping).
  void pruneAttachmentCache().catch(() => {});
  return cachedPath;
}

/**
 * The full "email id + filename -> a readable file on disk" path, including the
 * account resolution and the authorization check.
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

  const { storage, syncEngine } = await resolveAccountTarget(accountId);

  const email = await storage.getEmail(emailId);
  if (!email) throw new AttachmentError('Email not found', 404);

  // SECURITY: only ever serve a name this email actually declared. Without this
  // the caller chooses the filename, which — combined with the cache being a
  // real directory — turns the attachment path into a read primitive for any
  // file previously cached under any email. `safeFilename` stops traversal out
  // of the cache; this stops traversal *within* it.
  const declared = parseAttachmentNames(email.attachmentNames);
  if (!declared.includes(filename)) {
    throw new AttachmentError('Attachment not found on this email', 403);
  }

  const folder = await storage.getFolder(email.folderId);
  if (!folder || !email.uid) {
    throw new AttachmentError('Cannot determine folder/UID for email', 404);
  }

  const filePath = await getOrCacheAttachment(emailId, folder.path, email.uid, filename, syncEngine);
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

    const actualBytes = (await fs.promises.stat(filePath)).size;
    if (stored[index] === actualBytes) return;

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
