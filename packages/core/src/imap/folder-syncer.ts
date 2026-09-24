// Folder Syncer - Handles sync logic for individual folders

import { BACKFILL_UID_SPAN } from '../config/sync';
import type { IIMAPClient, IMAPFolder, FolderStatus } from '../types/imap';
import type { FolderRecord } from '../types/models';
import type { IEmailStorage } from '../types/storage';
import { generateFolderId } from '../utils/id';
import { logger } from '../utils/logger';
import { isWatermarkImpossible } from '../utils/sync-watermark';

import { fetchNewestMessagesWindowed } from './incremental-fetch';
import { MessageProcessor, type IngestServerActions } from './message-processor';
import type { ReputationLookup } from './reputation-stage';
import { withFolderSelected } from './with-folder';


/**
 * Folder sync options
 */
export interface FolderSyncOptions {
  fullSync: boolean;         // Force full sync
  maxMessages: number;       // Max messages to fetch
  headersOnly: boolean;      // Only fetch headers
  flagsOnly: boolean;        // Only sync flags
}

const DEFAULT_OPTIONS: FolderSyncOptions = {
  fullSync: false,
  maxMessages: 50,
  headersOnly: true,
  flagsOnly: false,
};

// Messages fetched per FETCH during a full sync. Bounded so a single command
// always finishes well under the IMAP op timeout even on slow servers (a whole-
// range fetch of 1000 messages-with-bodies timed out on imap.sarv.com). Small
// enough to be safe, large enough to keep round-trips reasonable on fast ones.
const FULL_SYNC_BATCH = 200;
/** Cap on messages one incremental sync pass may fetch. Bounds the pass so it
 *  always completes inside the sync timeout even when the watermark has fallen
 *  tens of thousands of UIDs behind; the rest is closed by the background drain. */
const INCREMENTAL_MAX_NEW_MESSAGES = 500;

/**
 * Folder sync result
 */
export interface FolderSyncResult {
  success: boolean;
  messagesProcessed: number;
  messagesInserted: number;
  messagesUpdated: number;
  flagsUpdated: number;
  deletedCount: number;
  lastSyncUid: number | null;
  error?: Error;
  uidValidityChanged: boolean;
}

/**
 * Folder priority for sync ordering
 */
const FOLDER_PRIORITIES: Record<string, number> = {
  'inbox': 0,
  'sent': 1,
  '[gmail]/sent mail': 1,
  'starred': 2,
  '[gmail]/starred': 2,
  'all mail': 3,
  '[gmail]/all mail': 3,
  'important': 4,
  '[gmail]/important': 4,
  'drafts': 5,
  '[gmail]/drafts': 5,
  'trash': 100,
  '[gmail]/trash': 100,
  'spam': 101,
  '[gmail]/spam': 101,
  'junk': 101,
};

/**
 * Folder Syncer
 *
 * Handles:
 * - UIDVALIDITY tracking and handling
 * - Incremental sync (new messages only)
 * - Full sync (all messages)
 * - Flags-only sync
 * - Folder priority ordering
 */
export class FolderSyncer {
  private messageProcessor: MessageProcessor;
  // Notify subscribers when individual emails get inserted during a
  // folder sync. Without this, the SyncEngine's full/incremental sync
  // paths insert rows silently — the renderer's "new email" UI refresh
  // is driven by per-email events emitted only by RealtimeManager. So
  // when a periodic poll fires a sync that inserts before the realtime
  // polling sees the UIDs, the realtime path dedups + skips (no event)
  // and the renderer never gets notified.
  private onNewEmail: ((emailId: string, folderPath: string) => void) | null = null;
  // Notify subscribers when a folder sync detects a server-side deletion and
  // removes the local row. Without this, syncFlags' Phase-2 deletes the DB row
  // silently and the renderer keeps showing the ghost until a manual reload —
  // the reported "mail deleted on webmail still visible in the app". Wired by
  // SyncEngine to syncState.emitEmailDeleted (same path RealtimeManager uses).
  private onEmailDeleted: ((emailId: string, uid: number, folderPath: string) => void) | null = null;
  // Fired with the SOURCE folder(s) of an external move-BACK detected during a sync:
  // a row relinked into THIS folder that still carries another folder's tag (e.g. a
  // Trash→Inbox move leaves the mail tagged Trash). Those folders aren't in the sync
  // rotation and aren't live-monitored, so the SyncEngine reconciles them AFTER the
  // sync to drop the stale source membership — the folder-sync path's equivalent of
  // RealtimeManager.handleNewMessages' onSyncRequest reconcile.
  private onReconcileFolders: ((folders: string[]) => void) | null = null;

  constructor() {
    this.messageProcessor = new MessageProcessor({
      headersOnly: true,
      batchSize: 10,
    });
  }

  /** Forward the pending-flag-op source to this syncer's message processor so
   * its syncFlags pass doesn't revert un-synced local flag changes. */
  setPendingUidsProvider(fn: (folderPath: string) => Promise<Set<number>>): void {
    this.messageProcessor.setPendingUidsProvider(fn);
  }

  /** Forward the server-side actions so what this syncer's ingest decides —
   * a spam re-file, a rule's move or flag — happens on the server too. */
  setServerActions(actions: Partial<IngestServerActions>): void {
    this.messageProcessor.setServerActions(actions);
  }

  /** Forward the blocklist lookup so mail this syncer ingests is scored on the
   * same evidence the realtime path scores it on — otherwise the same message
   * would be spam or not depending on which path happened to see it first. */
  setReputationLookup(fn: ReputationLookup): void {
    this.messageProcessor.setReputationLookup(fn);
  }

  /**
   * Register a callback invoked once per email that this syncer
   * INSERTS (not updates, not skips). The SyncEngine wires this to
   * its syncState.emitNewEmail so the IPC bridge can forward the
   * `new-email` event to the renderer.
   */
  setOnNewEmail(cb: ((emailId: string, folderPath: string) => void) | null): void {
    this.onNewEmail = cb;
  }

  /**
   * Register a callback invoked once per email that a folder sync DELETES
   * because it vanished from the server. SyncEngine wires this to its
   * syncState.emitEmailDeleted so the IPC bridge forwards `email-deleted` to
   * the renderer, which removes the row live (no manual refresh needed).
   */
  setOnEmailDeleted(cb: ((emailId: string, uid: number, folderPath: string) => void) | null): void {
    this.onEmailDeleted = cb;
  }

  /**
   * Register a callback invoked with the SOURCE folder path(s) whenever a sync
   * relinks an external move-BACK into a folder. SyncEngine collects these and
   * reconciles the source folders after the sync (see onReconcileFolders above).
   */
  setOnReconcileFolders(cb: ((folders: string[]) => void) | null): void {
    this.onReconcileFolders = cb;
  }

  /** Emit insertion events for everything in a processBatch result. */
  private emitInsertedFor(result: { insertedIds: string[] }, folderPath: string): void {
    if (!this.onNewEmail || result.insertedIds.length === 0) return;
    for (const id of result.insertedIds) {
      try {
        this.onNewEmail(id, folderPath);
      } catch (err) {
        logger.warn('FolderSyncer onNewEmail callback threw:', err);
      }
    }
  }

  /**
   * Get folder priority for sync ordering
   */
  getFolderPriority(path: string): number {
    const lowerPath = path.toLowerCase();
    return FOLDER_PRIORITIES[lowerPath] ?? 50;
  }

  /**
   * Sort folders by sync priority
   */
  sortFoldersByPriority(folders: IMAPFolder[]): IMAPFolder[] {
    return [...folders].sort((a, b) =>
      this.getFolderPriority(a.path) - this.getFolderPriority(b.path)
    );
  }

  /**
   * Sync folder metadata to storage
   */
  async syncFolderList(
    folders: IMAPFolder[],
    storage: IEmailStorage
  ): Promise<void> {
    const flatFolders = this.flattenFolders(folders);
    const folderRecords: FolderRecord[] = [];

    for (const folder of flatFolders) {
      const folderId = generateFolderId(folder.path);
      const now = Math.floor(Date.now() / 1000);

      folderRecords.push({
        id: folderId,
        name: folder.name,
        path: folder.path,
        parentId: null,
        uidValidity: null,
        lastSyncUid: null,
        lastSyncTime: null,
        totalCount: 0,
        unreadCount: 0,
        specialUse: folder.specialUse,
        subscribed: folder.subscribed,
        createdAt: now,
        updatedAt: now,
      });
    }

    await storage.syncFolders(folderRecords);
    logger.info(`Synced ${folderRecords.length} folders`);
  }

  /**
   * Sync a single folder
   */
  async syncFolder(
    client: IIMAPClient,
    folder: IMAPFolder,
    storage: IEmailStorage,
    options: Partial<FolderSyncOptions> = {},
    onProgress?: (processed: number, total: number) => void,
    // Pool stuck-eviction heartbeat (see reconcileDeletionsFull). The parallel
    // sync runs each folder on a pooled connection; a big folder's flag/deletion
    // reconcile can hold it past the 120s stuck timeout. Threaded to syncFlags.
    touch?: () => void,
  ): Promise<FolderSyncResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const result: FolderSyncResult = {
      success: false,
      messagesProcessed: 0,
      messagesInserted: 0,
      messagesUpdated: 0,
      flagsUpdated: 0,
      deletedCount: 0,
      lastSyncUid: null,
      uidValidityChanged: false,
    };

    try {
      // Select folder and get status
      const boxStatus = await client.selectFolder(folder.path);
      const storedFolder = await storage.getFolderByPath(folder.path);

      if (!storedFolder) {
        logger.warn(`Folder ${folder.path} not found in storage`);
        result.error = new Error(`Folder not found: ${folder.path}`);
        return result;
      }

      // Check UIDVALIDITY
      result.uidValidityChanged = await this.handleUidValidity(
        storedFolder,
        boxStatus,
        storage
      );

      // Check if local email count is much lower than expected BEFORE updating.
      // This can happen after a bug or interrupted sync — force a full sync to
      // recover. Uses the folder's cached total_count (maintained by
      // recalculateFolderCounts; NOT NULL, defaults 0) instead of materialising
      // up to 50 full emails — that was a heavy per-folder tag scan (instr +
      // THREAD_META + bodies) firing on EVERY folder of EVERY sync, the main
      // driver of the sync-time beachball on large mailboxes. The heuristic only
      // needs to know the local count is below ~10 (expectedMinCount), which the
      // cached count answers exactly.
      const localCount = storedFolder.totalCount ?? 0;
      const serverCount = boxStatus.messages;
      const expectedMinCount = Math.min(opts.maxMessages * 0.3, serverCount * 0.1, 10);
      const needsRecoverySync = storedFolder.lastSyncUid &&
        serverCount > 20 &&
        localCount < expectedMinCount;

      // The watermark claims a UID the server has never assigned, so it cannot
      // have come from this mailbox and every forward sync keyed on it is a
      // no-op (see isWatermarkImpossible). Left alone this NEVER heals: the
      // forward sync is the thing being gated, the backfill only pages BELOW the
      // oldest local UID, and on a large mailbox the addition reconcile is
      // skipped too — so the folder silently stops receiving mail for good.
      // Drop the watermark and let the full-sync branch below re-establish it
      // from messages we actually fetched. Checked BEFORE the strategy dispatch
      // so the repair takes effect on THIS pass, not the next one.
      const watermarkImpossible = isWatermarkImpossible({
        lastSyncUid: storedFolder.lastSyncUid,
        uidNext: boxStatus.uidNext,
      });
      if (watermarkImpossible) {
        logger.warn(
          `[watermark] ${folder.path}: stored lastSyncUid ${storedFolder.lastSyncUid} is above server UIDNEXT `
          + `${boxStatus.uidNext} (server holds ${serverCount}) — impossible, so incremental sync has been a no-op. `
          + `Discarding it and forcing a full re-sync.`,
        );
        await storage.updateFolder(storedFolder.id, { lastSyncUid: null });
        storedFolder.lastSyncUid = null;
      }

      if (needsRecoverySync) {
        logger.info(`Recovery sync needed for ${folder.path}: local=${localCount}, expected at least ${expectedMinCount}, server=${serverCount}`);
        // Reset lastSyncUid to force full sync
        await storage.updateFolder(storedFolder.id, {
          lastSyncUid: null,
        });
      }

      // Update folder with server counts (for "load more" feature)
      // Don't overwrite totalCount — it will be recalculated from local DB after sync
      await storage.updateFolder(storedFolder.id, {
        lastKnownMessageCount: boxStatus.messages,
        lastKnownUidnext: boxStatus.uidNext,
      } as any);

      // Determine sync strategy
      if (opts.flagsOnly && storedFolder.lastSyncUid) {
        // Flags-only sync — force deletion reconciliation (see incrementalSync).
        // Held across the whole reconcile: syncFlags issues many commands over a
        // long window against the CURRENTLY selected mailbox, and the select at
        // the top of syncFolder is long gone by now — a body prefetch or realtime
        // re-select landing in between makes it read another folder entirely.
        const flagsResult = await withFolderSelected(client, storedFolder.path, () =>
          this.messageProcessor.syncFlags(
            client,
            storedFolder,
            storage,
            undefined,
            (emailId, uid) => this.onEmailDeleted?.(emailId, uid, storedFolder.path),
            { forceDeletion: true },
            undefined,
            touch,
          ));
        result.flagsUpdated = flagsResult.updated;
        result.deletedCount = flagsResult.deleted;
        result.success = true;
      } else if (opts.fullSync || !storedFolder.lastSyncUid || result.uidValidityChanged || needsRecoverySync) {
        // Full sync (also triggered when local count is too low)
        const fullResult = await this.fullSync(
          client,
          storedFolder,
          boxStatus,
          storage,
          opts,
          onProgress,
          touch,
        );
        this.mergeResults(result, fullResult);
      } else {
        // Incremental sync
        const incrementalResult = await this.incrementalSync(
          client,
          storedFolder,
          boxStatus,
          storage,
          opts,
          onProgress,
          touch,
        );
        this.mergeResults(result, incrementalResult);
      }

      // Update sync time
      await storage.updateFolder(storedFolder.id, {
        lastSyncTime: Math.floor(Date.now() / 1000),
      });

      result.success = true;
      return result;
    } catch (error) {
      logger.error(`Failed to sync folder ${folder.path}:`, error);
      result.error = error as Error;
      return result;
    }
  }

  /**
   * Handle UIDVALIDITY changes
   */
  private async handleUidValidity(
    folder: FolderRecord,
    boxStatus: FolderStatus,
    storage: IEmailStorage
  ): Promise<boolean> {
    const serverV = boxStatus.uidValidity;
    // Only trust a VALID uidValidity. Some servers omit it and ImapFlow can yield
    // NaN/0; `folder.uidValidity !== NaN` is ALWAYS true, so the old check would
    // spuriously "detect a change" and wipe the folder on a garbage reading. Never
    // wipe unless the server reported a finite, positive value that actually differs.
    const serverValidityUsable = typeof serverV === 'number' && Number.isFinite(serverV) && serverV > 0;
    const uidValidityChanged = serverValidityUsable &&
      folder.uidValidity !== null && folder.uidValidity !== serverV;

    if (uidValidityChanged) {
      logger.warn(`UIDVALIDITY changed for ${folder.path}: ${folder.uidValidity} -> ${serverV}`);

      // Re-key the folder NON-DESTRUCTIVELY. Every local uid here is now stale, but
      // a blind `deleteEmailsByFolder` (DELETE by tag) also destroyed multi-folder
      // (Gmail-label) rows that still live in OTHER folders. Use unlink-or-delete
      // semantics instead: drop only THIS folder's tag (repoint the primary + clear
      // uid) on rows that survive elsewhere, and hard-delete only rows in no other
      // folder. The folder then re-syncs from scratch and re-links with fresh uids.
      if (typeof storage.invalidateFolderMembership === 'function') {
        const r = await storage.invalidateFolderMembership(folder.id);
        logger.info(`UIDVALIDITY re-key for ${folder.path}: ${r.unlinked} unlinked (kept in other folders), ${r.deleted} deleted`);
      } else {
        await storage.deleteEmailsByFolder(folder.id);
      }

      // Reset sync state. Null highest_modseq too: the stored modseq is only
      // meaningful under the OLD uidValidity, so the next flag sync must take
      // the full path (which then re-stores a fresh modseq under the new one).
      await storage.updateFolder(folder.id, {
        uidValidity: serverV,
        lastSyncUid: null,
        highestModseq: null,
      });

      return true;
    }

    if (folder.uidValidity === null && serverValidityUsable) {
      // First time - store UIDVALIDITY (only when the server gave a usable value).
      await storage.updateFolder(folder.id, {
        uidValidity: serverV,
      });
    }

    return false;
  }

  /**
   * Full sync - fetch recent messages
   */
  private async fullSync(
    client: IIMAPClient,
    folder: FolderRecord,
    boxStatus: FolderStatus,
    storage: IEmailStorage,
    options: FolderSyncOptions,
    onProgress?: (processed: number, total: number) => void,
    touch?: () => void,
  ): Promise<Partial<FolderSyncResult>> {
    if (boxStatus.messages === 0) {
      return {
        success: true,
        messagesProcessed: 0,
        lastSyncUid: null,
      };
    }

    // Fetch last N messages — but in BOUNDED BATCHES, newest batch first.
    //
    // Fetching the whole range as a single FETCH (headers + full bodies) is what
    // stalled first sync on slower servers: imap.sarv.com timed out after 60s on
    // a 1000-message range (~16 msg/s), so NOTHING was ever stored and the inbox
    // stayed empty. Batching keeps every FETCH well under the op timeout, lets a
    // slow/rejecting server serve one chunk at a time, and — because each batch
    // is persisted + emitted as it lands — mail appears progressively and a mid-
    // sync failure keeps the batches that already succeeded (partial > nothing).
    const fetchCount = Math.min(options.maxMessages, boxStatus.messages);
    const startSeq = Math.max(1, boxStatus.messages - fetchCount + 1);

    logger.info(`Full sync ${folder.path}: fetching ${startSeq}:${boxStatus.messages} (${fetchCount} messages) in batches of ${FULL_SYNC_BATCH}`);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let maxUid = 0;
    let processed = 0;
    let failedBatches = 0;

    // Walk newest → oldest so the most recent mail is stored + shown first.
    for (let hi = boxStatus.messages; hi >= startSeq; hi -= FULL_SYNC_BATCH) {
      const lo = Math.max(startSeq, hi - FULL_SYNC_BATCH + 1);
      const range = `${lo}:${hi}`;

      let messages;
      try {
        // Re-asserted PER BATCH, not once for the loop: processBatch between
        // batches is long storage work, and holding the mailbox across it would
        // pin the connection. `range` is a SEQUENCE range — in the wrong mailbox
        // it returns someone else's mail with no error at all, which is why this
        // one matters more than the UID fetches.
        messages = await withFolderSelected(client, folder.path, () =>
          client.fetchMessages(range, {
            fetchHeaders: true,
            fetchBody: !options.headersOnly,
            fetchBodyStructure: true,
          }));
      } catch (err) {
        // A single batch failing (timeout on a heavy chunk) must not abort the
        // whole sync — log it and keep going so the rest of the inbox still lands.
        failedBatches++;
        logger.warn(`Full sync ${folder.path}: batch ${range} failed: ${(err as Error)?.message ?? err}; continuing`);
        continue;
      }

      // Newest-first within the batch, matching the overall ordering.
      messages.reverse();

      const r = await this.messageProcessor.processBatch(
        messages,
        folder,
        storage,
        onProgress ? (p) => onProgress(processed + p, fetchCount) : undefined,
      );
      inserted += r.inserted;
      updated += r.updated;
      skipped += r.skipped;
      processed += messages.length;
      if (r.maxUid > maxUid) maxUid = r.maxUid;
      if (r.relinkedFromFolders?.length) this.onReconcileFolders?.(r.relinkedFromFolders);

      // Persist progress + surface this batch's new mail immediately, so a later
      // batch failure never loses what already synced and the UI fills in live.
      if (maxUid > 0) {
        await storage.updateFolder(folder.id, { lastSyncUid: maxUid });
      }
      this.emitInsertedFor(r, folder.path);
      touch?.(); // batch persisted — heartbeat the pooled connection between chunks
    }

    if (failedBatches > 0) {
      logger.warn(`Full sync ${folder.path}: ${failedBatches} batch(es) failed; stored ${inserted + updated} of ${fetchCount}`);
    }

    return {
      success: true,
      messagesProcessed: inserted + updated + skipped,
      messagesInserted: inserted,
      messagesUpdated: updated,
      lastSyncUid: maxUid > 0 ? maxUid : null,
    };
  }

  /**
   * Incremental sync - fetch new messages and update flags
   */
  private async incrementalSync(
    client: IIMAPClient,
    folder: FolderRecord,
    boxStatus: FolderStatus,
    storage: IEmailStorage,
    options: FolderSyncOptions,
    onProgress?: (processed: number, total: number) => void,
    touch?: () => void,
  ): Promise<Partial<FolderSyncResult>> {
    const lastUID = folder.lastSyncUid || 0;

    // Log the watermark WITH the two server numbers that decide whether the "no
    // new messages" gate below is telling the truth. Without them a WEDGED folder
    // is indistinguishable from a quiet one: both print the same line forever,
    // and the only visible symptom is mail that silently stops arriving.
    // (Observed: a Gmail INBOX pinned at "from UID 59804" for nine days while the
    // server's own EXISTS climbed by 144 — every sync reported "No new messages".)
    logger.info(
      `Incremental sync ${folder.path}: from UID ${lastUID} `
      + `(server uidNext ${boxStatus.uidNext}, exists ${boxStatus.messages})`,
    );

    // First, sync flags for existing emails. Force deletion reconciliation:
    // incrementalSync runs on a manual Refresh and the 5-min periodic sync — not
    // on the frequent IDLE ticks — so the CONDSTORE deletion throttle (which
    // exists to keep SEARCH ALL off every IDLE poll) must NOT suppress it here.
    // A user hitting Refresh expects mail deleted on webmail to disappear NOW.
    // One section (see the flags-only branch of syncFolder): the mailbox must
    // stay put for every command syncFlags issues, not merely be right when it
    // starts.
    const flagsResult = await withFolderSelected(client, folder.path, () =>
      this.messageProcessor.syncFlags(
        client,
        folder,
        storage,
        undefined,
        (emailId, uid) => this.onEmailDeleted?.(emailId, uid, folder.path),
        { forceDeletion: true },
        undefined,
        touch,
      ));

    // Check for new messages
    if (boxStatus.uidNext <= lastUID + 1) {
      logger.info(`No new messages in ${folder.path}`);
      return {
        success: true,
        messagesProcessed: 0,
        flagsUpdated: flagsResult.updated,
        deletedCount: flagsResult.deleted,
        lastSyncUid: lastUID,
      };
    }

    // Fetch new messages NEWEST-FIRST, in BOUNDED UID windows, and stop after
    // INCREMENTAL_MAX_NEW_MESSAGES. Never an unbounded `lastUID+1:*`, which on a
    // LARGE/slow mailbox blows the op timeout (see incremental-fetch.ts), and
    // never an uncapped ascending walk of the whole gap either: a watermark that
    // has fallen far behind (observed: INBOX at UID 3226 against uidNext 27709)
    // cannot be traversed inside the 120s sync timeout, so the sync was torn
    // down mid-flight, lastSyncUid never advanced, and every later cycle
    // restarted from the same UID — the newest month of mail never arrived while
    // the oldest end drained steadily. The helper also drops any UID <= lastUID
    // (some servers echo the boundary message for an out-of-range low bound) so
    // lastSyncUid can never regress into a permanent redundant refetch loop.
    const { messages, scannedDownToUid } = await withFolderSelected(client, folder.path, () =>
      fetchNewestMessagesWindowed(client, lastUID, boxStatus.uidNext, {
        fetchHeaders: true,
        fetchBody: !options.headersOnly,
        fetchBodyStructure: true,
      }, { maxMessages: INCREMENTAL_MAX_NEW_MESSAGES }));

    // True when the cap stopped the pass before it reached the watermark, so
    // unfetched UIDs remain BELOW the newest message we just took.
    const gapRemainsBelow = scannedDownToUid > lastUID + 1;

    if (messages.length === 0) {
      // Handle sent folder edge case
      if (this.isSentFolder(folder.path) && lastUID > 0) {
        return this.handleSentFolderSync(client, folder, boxStatus, storage, options, onProgress);
      }

      return {
        success: true,
        messagesProcessed: 0,
        flagsUpdated: flagsResult.updated,
        deletedCount: flagsResult.deleted,
        lastSyncUid: lastUID,
      };
    }

    // Process newest first
    messages.reverse();

    const processResult = await this.messageProcessor.processBatch(
      messages,
      folder,
      storage,
      onProgress
    );
    if (processResult.relinkedFromFolders?.length) this.onReconcileFolders?.(processResult.relinkedFromFolders);

    // Update last sync UID — never write a value below the stored one, and never
    // ACROSS a hole. lastSyncUid means "everything at or below this is synced";
    // jumping it to the newest UID after a capped pass would mark the skipped
    // range as done and permanently hide that mail from incremental sync. When a
    // gap remains we leave the watermark where it is and let
    // SyncEngine.drainFolderChunk close it — the drain derives its work from
    // `serverUids - localUids`, so it is unaffected by the watermark, and once
    // the gap is closed a later pass reaches the watermark and advances it.
    const nextSyncUid = !gapRemainsBelow && processResult.maxUid > lastUID
      ? processResult.maxUid
      : lastUID;
    if (nextSyncUid > lastUID) {
      await storage.updateFolder(folder.id, {
        lastSyncUid: nextSyncUid,
      });
    }

    // Emit per-email events so the renderer merges them into the
    // visible list. Critical for the case where this incremental sync
    // is the path that picks up new mail (e.g. periodic poller fires
    // before realtime sees the UIDs).
    this.emitInsertedFor(processResult, folder.path);

    return {
      success: true,
      messagesProcessed: processResult.inserted + processResult.updated,
      messagesInserted: processResult.inserted,
      messagesUpdated: processResult.updated,
      flagsUpdated: flagsResult.updated,
      deletedCount: flagsResult.deleted,
      lastSyncUid: nextSyncUid,
    };
  }

  /**
   * Fetch ONE bounded chunk of historical (older) mail for a folder, paging
   * DOWNWARD by UID. The background backfill calls this repeatedly until `done`.
   *
   * Anchored at `backfillOldestUid` (persisted floor) or, on the first chunk, the
   * oldest local UID already synced. Each call fetches the UID window
   * `[boundary - SPAN, boundary - 1]` header-only and advances the persisted
   * floor to `lo` REGARDLESS of how many messages that window held — advancing by
   * UID width (not message count) is what lets it step across the UID gaps that
   * deletions leave without stalling. Inserts are `quiet` (no categorisation / no
   * prefetch wake — see MessageProcessor.processBatch). Idempotent: re-running a
   * window re-inserts nothing (insertEmailBatch dedups on message-id).
   *
   * The caller owns connection choice + folder RE-selection afterwards; this only
   * SELECTs the target folder to fetch. Returns progress for logging/scheduling.
   */
  async backfillChunk(
    client: IIMAPClient,
    folder: FolderRecord,
    storage: IEmailStorage,
  ): Promise<{ fetched: number; inserted: number; done: boolean; loUid: number; hiUid: number }> {
    const noop = { fetched: 0, inserted: 0, loUid: 0, hiUid: 0 };

    // The server can't page older mail we can't address, and if we've never
    // synced any UID for this folder there's no floor to page below yet — let the
    // normal sync seed the newest window first; retry next tick.
    const anchor = folder.backfillOldestUid ?? (await storage.getOldestUidInFolder?.(folder.id) ?? null);
    if (anchor == null) {
      // No local UID floor yet. Only conclude "complete" for a folder that HAS
      // been synced and is genuinely empty on the server — otherwise we'd mark a
      // not-yet-synced folder done and never download its history. Never-synced
      // folders (serverMessageCount still 0 by default) just wait for initial sync.
      const synced = folder.lastSyncTime != null || folder.lastSyncUid != null;
      if (synced && (folder.serverMessageCount ?? 0) === 0) {
        await storage.updateFolder(folder.id, { backfillComplete: true });
        return { ...noop, done: true };
      }
      return { ...noop, done: false };
    }

    const hiUid = anchor - 1;
    if (hiUid < 1) {
      await storage.updateFolder(folder.id, { backfillOldestUid: anchor, backfillComplete: true });
      return { ...noop, hiUid: 0, done: true };
    }
    const loUid = Math.max(1, hiUid - BACKFILL_UID_SPAN + 1);
    const done = loUid <= 1;

    if (typeof client.fetchMessagesByUidRange !== 'function') {
      // Client can't page by UID range — don't spin; mark done so the scheduler
      // stops selecting this folder (search still works over whatever synced).
      logger.warn(`Backfill ${folder.path}: client lacks fetchMessagesByUidRange — skipping backfill`);
      await storage.updateFolder(folder.id, { backfillComplete: true });
      return { ...noop, loUid, hiUid, done: true };
    }

    const messages = await withFolderSelected(client, folder.path, () =>
      client.fetchMessagesByUidRange!(loUid, hiUid, {
        fetchHeaders: true,
        fetchBody: false,
        fetchBodyStructure: true,
      }));

    let inserted = 0;
    if (messages.length > 0) {
      messages.reverse(); // newest-first, same ordering as fullSync
      const res = await this.messageProcessor.processBatch(messages, folder, storage, undefined, { quiet: true });
      inserted = res.inserted;
      // NOTE: intentionally NO emitInsertedFor — backfilled history must not push
      // into the live list or wake the pipeline. It surfaces on the next DB read.
    }

    // Advance the floor by UID WIDTH regardless of message count (gap-safe), and
    // flip complete once we've reached the bottom of the UID space.
    await storage.updateFolder(folder.id, {
      backfillOldestUid: loUid,
      ...(done ? { backfillComplete: true } : {}),
    });

    logger.info(
      `Backfill ${folder.path}: UID ${loUid}:${hiUid} → ${messages.length} fetched, ${inserted} new`
      + `${done ? ' — COMPLETE (reached bottom)' : ` (next floor ${loUid})`}`,
    );

    return { fetched: messages.length, inserted, loUid, hiUid, done };
  }

  /**
   * Run the FULL whole-folder deletion reconcile that the hot-path sync DEFERS
   * for large mailboxes (Phase 1 windows the flag reconcile and skips the
   * whole-mailbox SEARCH ALL there to avoid partial UID lists / timeouts). Off
   * the hot path — driven by the background backfill scheduler — the whole-folder
   * SEARCH-ALL diff is safe to run, so deletions on large NON-CONDSTORE mailboxes
   * (which have no VANISHED signal) finally reconcile. Selects the folder first so
   * syncFlags reads the correct live mailbox state.
   */
  async reconcileDeletionsFull(
    client: IIMAPClient,
    folder: FolderRecord,
    storage: IEmailStorage,
    // Pool stuck-eviction heartbeat: this whole-mailbox reconcile runs on a
    // POOLED connection and, on a big folder ([Gmail]/All Mail), out-lasts the
    // 120s stuck timeout. Forward it to syncFlags so each sub-step refreshes the
    // connection instead of being reclaimed mid-run (the reconnect-storm cause).
    touch?: () => void,
  ): Promise<{ updated: number; deleted: number }> {
    // The full reconcile is the most dangerous pass to run on the wrong mailbox
    // — it treats "not on the server" as a deletion — so the selection is held
    // for the whole of it rather than set once and hoped for.
    return withFolderSelected(client, folder.path, () =>
      this.messageProcessor.syncFlags(
        client,
        folder,
        storage,
        undefined,
        (emailId, uid) => this.onEmailDeleted?.(emailId, uid, folder.path),
        { forceDeletion: true, fullReconcile: true },
        undefined,
        touch,
      ));
  }

  /**
   * Handle special case for Sent folder
   */
  private async handleSentFolderSync(
    client: IIMAPClient,
    folder: FolderRecord,
    boxStatus: FolderStatus,
    storage: IEmailStorage,
    options: FolderSyncOptions,
    onProgress?: (processed: number, total: number) => void
  ): Promise<Partial<FolderSyncResult>> {
    logger.info('Checking Sent folder for recent sends');

    if (boxStatus.messages === 0) {
      return { success: true, messagesProcessed: 0 };
    }

    // Fetch last 20 messages to catch recent sends
    const fetchCount = Math.min(20, boxStatus.messages);
    const startSeq = Math.max(1, boxStatus.messages - fetchCount + 1);
    const range = `${startSeq}:${boxStatus.messages}`;

    // Sequence range again — see fullSync. The wrong mailbox here would file
    // another folder's mail as recently-sent.
    const messages = await withFolderSelected(client, folder.path, () =>
      client.fetchMessages(range, {
        fetchHeaders: true,
        fetchBody: !options.headersOnly,
        fetchBodyStructure: true,
      }));

    // Filter to only new messages. One batched existence lookup instead of a
    // getEmailByMessageId per message (matches the main processBatch path).
    const existingIds = new Set(
      (await storage.getEmailsByMessageIds(messages.map((m) => m.envelope.messageId)))
        .map((e) => e.messageId),
    );
    const newMessages = messages.filter((msg) => !existingIds.has(msg.envelope.messageId));

    if (newMessages.length === 0) {
      return { success: true, messagesProcessed: 0 };
    }

    newMessages.reverse();

    const processResult = await this.messageProcessor.processBatch(
      newMessages,
      folder,
      storage,
      onProgress
    );

    // Never regress lastSyncUid — these are re-fetched recent messages
    // and an old unseen one may carry a uid below the stored value
    if (processResult.maxUid > (folder.lastSyncUid || 0)) {
      await storage.updateFolder(folder.id, {
        lastSyncUid: processResult.maxUid,
      });
    }

    // Emit per-email events for sent-folder inserts too — keeps the
    // Sent view in sync if the user is viewing it during the sync.
    this.emitInsertedFor(processResult, folder.path);

    logger.info(`Added ${processResult.inserted} new sent emails`);

    return {
      success: true,
      messagesProcessed: processResult.inserted,
      messagesInserted: processResult.inserted,
      lastSyncUid: processResult.maxUid > 0 ? processResult.maxUid : null,
    };
  }

  /**
   * Check if folder has changed since last sync
   */
  async hasChanges(
    client: IIMAPClient,
    storedFolder: FolderRecord
  ): Promise<boolean> {
    try {
      const status = await client.getFolderStatus(storedFolder.path);

      const uidValidityUnchanged = storedFolder.uidValidity === status.uidValidity;
      const messageCountUnchanged = (storedFolder as any).lastKnownMessageCount === status.messages;
      const uidNextUnchanged = (storedFolder as any).lastKnownUidnext === status.uidNext;

      return !(uidValidityUnchanged && messageCountUnchanged && uidNextUnchanged);
    } catch {
      return true; // Assume changed if we can't check
    }
  }

  /**
   * Merge partial results into main result
   */
  private mergeResults(target: FolderSyncResult, source: Partial<FolderSyncResult>): void {
    Object.assign(target, source);
  }

  /**
   * Check if folder is Sent folder
   */
  private isSentFolder(path: string): boolean {
    const lowerPath = path.toLowerCase();
    return lowerPath.includes('sent') || lowerPath === '[gmail]/sent mail';
  }

  /**
   * Flatten nested folder structure
   */
  private flattenFolders(folders: IMAPFolder[]): IMAPFolder[] {
    const result: IMAPFolder[] = [];

    const flatten = (folder: IMAPFolder) => {
      result.push(folder);
      folder.children?.forEach(flatten);
    };

    folders.forEach(flatten);
    return result;
  }

  /**
   * Get message processor for direct access
   */
  getMessageProcessor(): MessageProcessor {
    return this.messageProcessor;
  }
}
