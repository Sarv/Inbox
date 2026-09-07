import type { IIMAPClient } from '../types/imap';
import type { FolderRecord } from '../types/models';
import type { IEmailStorage } from '../types/storage';
import { logger } from '../utils/logger';

// Resolve/apply VANISHED in chunks so a huge backlog (e.g. a folder that drifted
// tens of thousands of rows behind an auto-expiring server) never runs as one giant
// SQL transaction or stalls the main thread, and the UI updates incrementally.
const APPLY_CHUNK = 500;

/**
 * Authoritatively reconcile a folder's server-side deletions via QRESYNC VANISHED
 * (RFC 7162). A resynchronising SELECT — opened with our stored `(uidValidity,
 * modseq)` — makes the server report `VANISHED (EARLIER) <uids>`: the EXACT messages
 * expunged since that modseq (e.g. mail auto-expired by server retention). We apply
 * them locally with unlink-or-delete semantics (a row still tagged in another folder
 * is only unlinked, never destroyed).
 *
 * This is server GROUND TRUTH, not a diff inference, so it needs NO ratio/`serverUids
 * === 0` guard: it can safely remove a genuine mass-expiry that the SEARCH-ALL diff's
 * safety guards (rightly) refuse to trust. It is the escalation used when those guards
 * would otherwise strand a drifted folder forever.
 *
 * No-op (`selected:false`) when QRESYNC isn't usable — the server lacks it, or we have
 * no stored `modseq`/`uidValidity` (first sync), or the resync SELECT errors (e.g.
 * UIDVALIDITY changed → the server returns no VANISHED; the folder-sync's
 * UIDVALIDITY-change handler wipes-and-refetches instead). Callers that relied on this
 * SELECT to open the folder use the returned `selected` to skip a redundant SELECT.
 *
 * `onDeleted` fires per reconciled row so the caller can drive in-place UI removal
 * (same path the live IDLE expunge / move-back fixes use).
 */
export async function applyQresyncVanished(
  client: IIMAPClient,
  folder: FolderRecord,
  storage: IEmailStorage,
  onDeleted?: (emailId: string, uid: number) => void,
): Promise<{ selected: boolean; removed: number }> {
  if (
    !client.supportsQresync?.() ||
    typeof client.selectFolderWithQresync !== 'function' ||
    folder.highestModseq == null || folder.highestModseq <= 0 ||
    folder.uidValidity == null
  ) {
    return { selected: false, removed: 0 };
  }

  let vanishedUids: number[];
  let status: { uidValidity?: number | bigint } | undefined;
  try {
    ({ status, vanishedUids } = await client.selectFolderWithQresync(
      folder.path, folder.uidValidity, folder.highestModseq,
    ));
  } catch (err) {
    logger.warn(`QRESYNC resync SELECT failed for ${folder.path}, skipping VANISHED reconcile: ${(err as Error).message}`);
    return { selected: false, removed: 0 };
  }

  // Belt-and-suspenders: RFC 7162 says a UIDVALIDITY mismatch must suppress
  // VANISHED (EARLIER), but a non-compliant server could still return UIDs that,
  // under a silently-changed validity, now point at DIFFERENT local rows — deleting
  // valid mail. If the SELECT's validity doesn't match what we resynced against,
  // trust NOTHING here and let FolderSyncer's authoritative UIDVALIDITY re-key
  // handle it (unlink-or-delete + refetch) instead of applying these UIDs.
  // Number.isFinite guard: a server that OMITS UIDVALIDITY yields Number(undefined)
  // = NaN, and NaN !== folder.uidValidity is always true — which would wrongly skip
  // VANISHED (disabling the live-deletion fast-path) on EVERY sync. Only act on a
  // finite, genuinely-different validity.
  const rawValidity = Number(status?.uidValidity);
  const seenValidity = Number.isFinite(rawValidity) ? rawValidity : undefined;
  if (seenValidity !== undefined && seenValidity !== folder.uidValidity) {
    logger.warn(`QRESYNC ${folder.path}: UIDVALIDITY changed (${folder.uidValidity} -> ${seenValidity}) — skipping VANISHED, deferring to the re-key path`);
    return { selected: true, removed: 0 };
  }

  if (vanishedUids.length === 0) return { selected: true, removed: 0 };

  let removed = 0;
  for (let i = 0; i < vanishedUids.length; i += APPLY_CHUNK) {
    const chunk = vanishedUids.slice(i, i + APPLY_CHUNK);
    // Batched uid -> id resolve (chunked well under SQLite's variable limit) instead
    // of one point lookup per UID — a huge VANISHED must not be N sequential queries.
    const pairs = await storage.getEmailIdsByFolderAndUids(folder.id, chunk);
    if (pairs.length === 0) continue;
    const { deleted, unlinked } = await storage.unlinkOrDeleteEmailsFromFolder(
      pairs.map((p) => p.id), folder.id,
    );
    removed += deleted + unlinked;
    if (onDeleted) for (const p of pairs) onDeleted(p.id, p.uid);
  }

  if (removed > 0) {
    logger.info(`QRESYNC ${folder.path}: applied ${vanishedUids.length} VANISHED (${removed} local rows reconciled)`);
    try {
      await storage.recalculateFolderCounts([folder.path]);
    } catch (err) {
      logger.warn(`QRESYNC ${folder.path}: recount after VANISHED failed: ${(err as Error).message}`);
    }
  }
  return { selected: true, removed };
}
