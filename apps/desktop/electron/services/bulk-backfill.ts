/**
 * One-time bulk-mail backfill (main process).
 *
 * The `bulk` tag (List-Id / List-Unsubscribe / Precedence) is stamped at INGEST,
 * so mail synced before that feature existed has no bulk classification — and the
 * threading subject-fallback can't suppress it. This pass re-reads just those
 * headers from IMAP (header-only fetch, cheap) for already-stored mail and tags
 * the bulk ones, so old and new mail thread identically.
 *
 * Safe + polite: runs on a POOL connection (no IDLE/selection race), header-only,
 * batched with yields, and idempotent per account via a core-DB meta flag — it
 * runs once and then never again (mail arriving afterwards is classified at ingest).
 * It only ADDS the `bulk` tag; it never removes tags and never re-threads existing
 * conversations (tagging prevents FUTURE mis-merges; it doesn't retroactively split).
 */

import { addTag, createLogger } from '@sarvinbox/core';

import { getMeta, setMeta } from './core-db';

const logger = createLogger('bulk-backfill');

const BATCH = 200;            // UIDs classified per IMAP fetch
const YIELD_MS = 50;          // pause between batches so the pass never hogs I/O
const META_PREFIX = 'bulk-backfill:';

// Accounts with a run in flight this session — prevents the scheduler from
// kicking a second concurrent pass for the same account.
const inFlight = new Set<string>();

type TagRow = { id: string; uid: number | null; tags: string };

/**
 * Pure: given a folder's rows and the set of UIDs the server says are bulk,
 * produce the tag updates — only for UID-bearing rows that are actually bulk and
 * not already tagged. Extracted so the decision is unit-testable without IMAP/DB.
 */
export function bulkTagUpdates(rows: TagRow[], bulkUids: Set<number>): Array<{ id: string; tags: string }> {
  const updates: Array<{ id: string; tags: string }> = [];
  for (const r of rows) {
    if (r.uid == null || r.uid <= 0) continue;
    if (!bulkUids.has(r.uid)) continue;
    if ((r.tags || '').includes('|bulk|')) continue; // already tagged
    updates.push({ id: r.id, tags: addTag(r.tags || '||', 'bulk') });
  }
  return updates;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/**
 * Run the one-time bulk backfill for one account. No-op if already done (meta
 * flag) or already running. Fire-and-forget from the scheduler; it self-throttles.
 */
export async function maybeBackfillBulk(storage: any, engine: any, accountId: string): Promise<void> {
  if (!accountId) return;
  const key = META_PREFIX + accountId;
  if (getMeta(key)) return;                       // already completed on a prior run
  if (inFlight.has(accountId)) return;            // a pass is already running
  if (!engine?.isConnected?.() || typeof engine.classifyBulkUids !== 'function') return; // retry later
  if (typeof storage?.getEmailTagsInFolder !== 'function' || typeof storage?.bulkUpdateTags !== 'function') return;

  inFlight.add(accountId);
  const t0 = Date.now();
  let scanned = 0;
  let tagged = 0;
  try {
    const folders: any[] = (await storage.getFolders?.()) ?? [];
    for (const folder of folders) {
      if (folder.subscribed === false) continue;
      // Skip Trash/Spam: bulk classification there has no threading value and just
      // burns fetches. (isTrash/isSpam by special-use / exact path.)
      const su = folder.specialUse;
      if (su === '\\Trash' || su === '\\Junk') continue;
      // Lost connection between folders: THROW (don't break) so the completion
      // flag below stays unset — a `break` would fall through to setMeta and
      // permanently skip every folder we hadn't reached yet.
      if (!engine.isConnected?.()) throw new Error('disconnected between folders');

      const rows: TagRow[] = await storage.getEmailTagsInFolder(folder.id);
      const todo = rows.filter((r) => r.uid != null && r.uid > 0 && !(r.tags || '').includes('|bulk|'));
      for (let i = 0; i < todo.length; i += BATCH) {
        if (!engine.isConnected?.()) throw new Error('disconnected mid-backfill');
        const batch = todo.slice(i, i + BATCH);
        const uids = batch.map((r) => r.uid as number);
        const bulkUids: Set<number> = await engine.classifyBulkUids(folder.path, uids);
        scanned += batch.length;
        if (bulkUids.size > 0) {
          const updates = bulkTagUpdates(batch, bulkUids);
          if (updates.length > 0) {
            await storage.bulkUpdateTags(updates);
            tagged += updates.length;
          }
        }
        await sleep(YIELD_MS);
      }
    }
    // Mark done only on a clean full pass — a mid-run disconnect throws and leaves
    // the flag unset so it resumes (re-classifying is idempotent) next launch.
    setMeta(key, String(Date.now()));
    logger.info(`[BulkBackfill] ${accountId}: done — scanned ${scanned}, tagged ${tagged} bulk in ${Date.now() - t0}ms`);
  } catch (e) {
    logger.warn(`[BulkBackfill] ${accountId}: interrupted (scanned ${scanned}, tagged ${tagged}) — will resume: ${(e as Error).message}`);
  } finally {
    inFlight.delete(accountId);
  }
}
