// Operation Queue - Crash-safe persist-first batched pipeline for all IMAP operations

import type { IIMAPClient, IMAPFolder } from '../types/imap';
import type { IEmailStorage } from '../types/storage';
import { logger } from '../utils/logger';

import { isConnectionError, isRateLimited, isQuotaError, extractOpFailureDetail } from './imap-errors';
import { resolveLabelStrategy, SARV_LABEL_PARENT, type FolderLabelMode } from './label-strategy';

/**
 * Operation types
 */
export type OperationType =
  | 'markRead'
  | 'markUnread'
  | 'markStarred'
  | 'markUnstarred'
  | 'move'
  | 'copy'
  | 'moveToTrash'
  | 'moveToSpam'
  | 'archive'
  | 'delete'
  | 'setLabel'
  | 'removeLabel'
  | 'applyCategoryLabel'
  | 'removeCategoryLabel'
  | 'removeGmailLabels';

/**
 * Queued operation — uses numeric SQLite rowid as ID
 */
export interface QueuedOperation {
  id: number;
  type: OperationType;
  folderPath: string;
  uid: number;
  data?: any;
  retryCount: number;
  queuedAt: number;
}

/**
 * Operation result
 */
export type OperationResult = 'success' | 'queued' | 'failed';

/**
 * Queue configuration
 */
export interface QueueConfig {
  maxRetries: number;
  retryDelayMs: number;
}

const DEFAULT_CONFIG: QueueConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
};

/**
 * Special folder types
 */
type SpecialFolderType = 'trash' | 'spam' | 'archive' | 'sent' | 'drafts';

/**
 * Folder name mappings by type
 */
const FOLDER_MAPPINGS: Record<SpecialFolderType, { names: string[]; specialUse: string[] }> = {
  trash: {
    names: ['[Gmail]/Trash', 'Trash', 'Deleted Items', 'Deleted', '[Gmail]/Bin'],
    specialUse: ['\\Trash'],
  },
  spam: {
    names: ['[Gmail]/Spam', 'Spam', 'Junk', 'Junk Email', 'Junk E-mail'],
    specialUse: ['\\Junk'],
  },
  archive: {
    names: ['[Gmail]/All Mail', 'Archive', 'Archives'],
    specialUse: ['\\All', '\\Archive'],
  },
  sent: {
    names: ['[Gmail]/Sent Mail', 'Sent', 'Sent Items', 'Sent Messages'],
    specialUse: ['\\Sent'],
  },
  drafts: {
    names: ['[Gmail]/Drafts', 'Drafts', 'Draft'],
    specialUse: ['\\Drafts'],
  },
};

/**
 * A batch of operations grouped by (type, folderPath, destPath)
 */
interface OperationBatch {
  type: OperationType;
  folderPath: string;
  destPath?: string;  // for move/setLabel operations
  ops: QueuedOperation[];
}

/** A leased pool connection: the client to run commands on, plus release (return
 *  it healthy) and poison (discard it — a command may be mid-flight). */
type ConnectionLease = { client: IIMAPClient; release: () => void; poison: () => void };

/**
 * Operation Queue
 *
 * Crash-safe, persist-first, batched pipeline for ALL IMAP operations:
 * - Every operation persists to SQLite BEFORE execution
 * - On success: DELETE from SQLite
 * - On crash: status='executing' rows are retried on next startup
 * - Batch execution: groups ops by (type, folder, dest) into single IMAP calls
 * - No queue size limit (soft warning at 1000+)
 */
export class OperationQueue {
  private config: QueueConfig;
  private queue: QueuedOperation[] = [];
  private processing = false;

  // Dependencies
  private client: IIMAPClient | null = null;
  private storage: IEmailStorage | null = null;
  private isConnected: () => boolean = () => false;
  private isSyncing: () => boolean = () => false;
  // Optional: lease a SEPARATE (pool) connection so latency-sensitive FLAG ops
  // (read/star) reach the server IMMEDIATELY without waiting for the shared sync
  // connection to be free (the primary is command-serialized, so those ops are
  // otherwise deferred behind `!isSyncing()`). Returns null when no pool exists
  // (e.g. a background account) — the primary path is used as the fallback.
  private acquireConnection: (() => Promise<ConnectionLease | null>) | null = null;

  // Folder cache
  private folderCache: Map<SpecialFolderType, IMAPFolder> = new Map();

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize with dependencies
   */
  initialize(deps: {
    client: IIMAPClient;
    storage: IEmailStorage;
    isConnected: () => boolean;
    isSyncing: () => boolean;
    acquireConnection?: () => Promise<ConnectionLease | null>;
  }): void {
    this.client = deps.client;
    this.storage = deps.storage;
    this.isConnected = deps.isConnected;
    this.isSyncing = deps.isSyncing;
    this.acquireConnection = deps.acquireConnection ?? null;
    // WIP: a pooled connection lets latency-sensitive flag ops (read/star) reach
    // the server without waiting behind the sync connection. The leasing path
    // that consumes `acquireConnection` isn't wired yet — this read documents
    // availability and keeps the field from tripping noUnusedLocals meanwhile.
    if (this.acquireConnection) {
      logger.debug('[OperationQueue] pooled connection available for flag ops (leasing not yet wired)');
    }
  }

  /**
   * Get queue length
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is empty
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * UIDs in `folderPath` that have a pending (not-yet-round-tripped) operation.
   * Flag reconciliation (syncFlags) must NOT overwrite these — the local change
   * hasn't reached the server yet, so a server-wins pass would revert the user's
   * action (e.g. an email read locally springs back to unread).
   *
   * Unions two sources:
   * - the in-memory queue (fast path), and
   * - the persisted pending_operations rows (durable backstop) with status
   *   pending/executing/failed. The backstop covers the windows where the
   *   in-memory queue is empty but the op is still un-round-tripped: a
   *   dead-lettered ('failed') op, or a mid-drain where `processQueue` has
   *   cleared `this.queue` for the batch it is executing.
   */
  async getPendingUids(folderPath: string): Promise<Set<number>> {
    const uids = new Set<number>();
    for (const op of this.queue) {
      if (op.folderPath === folderPath && op.uid > 0) uids.add(op.uid);
    }
    if (this.storage) {
      try {
        const persisted = await this.storage.getPendingOperationUidsByFolder(folderPath);
        for (const uid of persisted) uids.add(uid);
      } catch (error) {
        // Never fail reconciliation because the backstop query errored — the
        // in-memory set is still a valid (if narrower) guard.
        logger.warn(`getPendingUids: durable backstop query failed for ${folderPath}`, error);
      }
    }
    return uids;
  }

  // ========== Single Operations (persist-first) ==========

  async markAsRead(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('markRead', folderPath, uid, null);
  }

  async markAsUnread(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('markUnread', folderPath, uid, null);
  }

  async star(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('markStarred', folderPath, uid, null);
  }

  async unstar(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('markUnstarred', folderPath, uid, null);
  }

  async move(sourcePath: string, uid: number, destPath: string): Promise<OperationResult> {
    return this.persistAndExecute('move', sourcePath, uid, { destPath });
  }

  // COPY, not move: the message stays in sourcePath AND appears in destPath. On a
  // folder server this is IMAP COPY; on Gmail, copying into a label mailbox adds
  // that label (the message lives in both). Source UID is unchanged, so — unlike
  // move — there is no UID remap.
  async copy(sourcePath: string, uid: number, destPath: string): Promise<OperationResult> {
    return this.persistAndExecute('copy', sourcePath, uid, { destPath });
  }

  async moveToTrash(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('moveToTrash', folderPath, uid, null);
  }

  async moveToSpam(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('moveToSpam', folderPath, uid, null);
  }

  async archive(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('archive', folderPath, uid, null);
  }

  async delete(folderPath: string, uid: number): Promise<OperationResult> {
    return this.persistAndExecute('delete', folderPath, uid, null);
  }

  async setLabel(folderPath: string, uid: number, label: string): Promise<OperationResult> {
    return this.persistAndExecute('setLabel', folderPath, uid, { label });
  }

  /**
   * Mirror an AI category onto the server (keyword / Gmail label / folder — the
   * mechanism is resolved from live capabilities at execute time). Persist-first
   * so it survives offline/crash and retries. `host` selects the provider
   * strategy; `mode` is the move-vs-copy choice for the folder fallback.
   */
  async applyCategoryLabels(
    folderPath: string,
    uid: number,
    data: { categories: Array<{ slug: string; name: string }>; host: string; mode: FolderLabelMode },
  ): Promise<OperationResult> {
    return this.persistAndExecute('applyCategoryLabel', folderPath, uid, data);
  }

  async removeCategoryLabels(
    folderPath: string,
    uid: number,
    data: { categories: Array<{ slug: string; name: string }>; host: string; mode: FolderLabelMode },
  ): Promise<OperationResult> {
    return this.persistAndExecute('removeCategoryLabel', folderPath, uid, data);
  }

  /** Strip stale Gmail category labels from ONE message in a single
   *  STORE -X-GM-LABELS command (persist-first, offline-safe). Gmail-only;
   *  removing a label the message doesn't have is a no-op server-side. */
  async removeGmailLabels(
    folderPath: string,
    uid: number,
    labels: string[],
  ): Promise<OperationResult> {
    return this.persistAndExecute('removeGmailLabels', folderPath, uid, { labels });
  }

  /**
   * Pre-create the (empty) category labels/folders on providers that support
   * blank labels (Gmail, folder-based). No-op on KEYWORD providers (sarv) — a
   * keyword can't exist before it's on a message. Direct (not persist-first):
   * a failure just defers to lazy creation on first tag. Returns how many were
   * ensured (0 on keyword providers).
   */
  /** True when this account's server speaks the Gmail IMAP extension — the
   *  reliable per-account "is Gmail?" signal (independent of folder sync), used
   *  to gate Gmail-API colouring. */
  isGmailCapable(): boolean {
    return !!this.client?.supportsGmailLabels?.();
  }

  /** Rename a category's label in place (name change). No-op on keyword
   *  providers. Returns false if it couldn't rename. */
  async renameCategoryLabel(
    oldCat: { slug: string; name: string },
    newCat: { slug: string; name: string },
    mode: FolderLabelMode,
  ): Promise<boolean> {
    if (!this.client) return false;
    const strategy = await resolveLabelStrategy(this.client, this.client.host ?? '', mode);
    if (strategy.kind === 'keyword') return false;
    try {
      await strategy.rename(oldCat, newCat);
      return true;
    } catch (e) {
      logger.debug(`rename label failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Delete the entire `Sarv Inbox` label/folder subtree (the cleanup action).
   *  No-op on keyword providers (keywords aren't bulk-removable here). Returns
   *  the count of mailboxes deleted. */
  async removeSarvInboxLabels(mode: FolderLabelMode): Promise<number> {
    if (!this.client?.listMailboxPaths || !this.client?.deleteMailbox) return 0;
    const strategy = await resolveLabelStrategy(this.client, this.client.host ?? '', mode);
    if (strategy.kind === 'keyword') return 0;
    const paths = await this.client.listMailboxPaths();
    // Match the parent and anything nested under it (any delimiter follows the name).
    const targets = paths.filter((p) => p === SARV_LABEL_PARENT || /^Sarv Inbox[\\/.]/.test(p));
    // Deepest first so children are removed before their parent.
    targets.sort((a, b) => b.length - a.length);
    let n = 0;
    for (const p of targets) {
      try { await this.client.deleteMailbox(p); n++; } catch (e) { logger.debug(`delete ${p} failed: ${(e as Error).message}`); }
    }
    return n;
  }

  async ensureCategoryLabelsExist(
    categories: Array<{ slug: string; name: string }>,
    mode: FolderLabelMode,
  ): Promise<number> {
    if (!this.client) return 0;
    const strategy = await resolveLabelStrategy(this.client, this.client.host ?? '', mode);
    // Provision (register) each label up front. For folder/Gmail this CREATEs the
    // label mailbox; for the keyword strategy `ensure()` is a no-op on plain
    // keyword servers EXCEPT on Sarv, where it CREATEs the registering folder
    // NESTED under "Sarv Inbox" (e.g. "Sarv Inbox/finance") that Sarv needs to
    // surface the label — and prunes any legacy flat top-level folder from the
    // earlier scheme. We previously EARLY-RETURNED for keyword and never
    // provisioned — so Sarv labels were never created. Always run the loop now;
    // ensure() self-gates.
    logger.info(`[LabelStrategy] label mechanism = "${strategy.kind}" (${categories.length} categories)`);
    let n = 0;
    for (const c of categories) {
      try {
        await strategy.ensure({ slug: c.slug, name: c.name });
        n++;
      } catch (e) {
        logger.warn(`ensure label failed for ${c.slug}: ${(e as Error).message}`);
      }
    }
    return n;
  }

  /**
   * CREATE a plain top-level folder for a USER label (the opt-in "sync to
   * server" from the label dialog) so it shows in the provider's webmail. Unlike
   * category labels this uses no strategy and no nesting — just the label name
   * as a mailbox, which every provider renders (Sarv folder, Gmail label, …).
   * Returns true if the folder now exists (created or already present), false if
   * there's no live connection or the server rejected it.
   */
  async createServerLabel(name: string): Promise<boolean> {
    if (!this.client) return false;
    const path = (name || '').trim();
    if (!path) return false;
    try {
      await this.client.createMailbox(path);
      logger.info(`[labels] user label synced to server — CREATE "${path}"`);
      return true;
    } catch (e) {
      const msg = ((e as Error).message || '').toLowerCase();
      if (msg.includes('exist')) {
        logger.info(`[labels] user label "${path}" already exists on server`);
        return true; // already there is success
      }
      logger.warn(`[labels] createServerLabel "${path}" failed: ${(e as Error).message}`);
      return false;
    }
  }

  // ========== Bulk Operations (persist-first, batch execute) ==========

  async bulkMarkAsRead(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('markRead', folderPath, uids, null);
  }

  async bulkMarkAsUnread(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('markUnread', folderPath, uids, null);
  }

  async bulkStar(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('markStarred', folderPath, uids, null);
  }

  async bulkUnstar(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('markUnstarred', folderPath, uids, null);
  }

  async bulkMoveToTrash(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('moveToTrash', folderPath, uids, null);
  }

  async bulkMoveToSpam(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('moveToSpam', folderPath, uids, null);
  }

  async bulkArchive(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('archive', folderPath, uids, null);
  }

  // Move MANY messages to an arbitrary destination in ONE IMAP command (e.g.
  // whole-thread "not spam" → Inbox). The bulk executor's `move` case issues a
  // single moveMessages(uids, destPath); doing individual move() calls instead
  // drains them ~1/sec and lets a mid-move folder resync re-show the stragglers.
  async bulkMove(sourcePath: string, uids: number[], destPath: string): Promise<OperationResult> {
    return this.persistAndExecuteBulk('move', sourcePath, uids, { destPath });
  }

  // Bulk COPY — one IMAP COPY of many UIDs into destPath; source copies remain.
  async bulkCopy(sourcePath: string, uids: number[], destPath: string): Promise<OperationResult> {
    return this.persistAndExecuteBulk('copy', sourcePath, uids, { destPath });
  }

  async bulkDelete(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.persistAndExecuteBulk('delete', folderPath, uids, null);
  }

  // ========== Core Persist-First Pipeline ==========

  /**
   * Universal persist-first pipeline for single operations:
   * 1. Persist to SQLite → get numeric ID
   * 2. If connected & not syncing: mark executing → execute → delete on success
   * 3. If not connected: stays in SQLite + in-memory queue for later
   */
  private async persistAndExecute(
    type: OperationType,
    folderPath: string,
    uid: number,
    data: any,
  ): Promise<OperationResult> {
    if (!this.client) {
      throw new Error('OperationQueue not initialized');
    }

    // 1. Always persist first
    const id = await this.persistOperation(type, folderPath, uid, data);

    // 2a. FLAG ops (read/star) → run on a SEPARATE pool connection so they reach
    // the server IMMEDIATELY, even while a sync is mid-flight on the primary
    // (which is command-serialized, so the primary path below must wait for
    // !isSyncing). This is what fixes "read in the app, but webmail stays unread
    // until you navigate". No pool (background account) → fall through to primary.
    if (this.isConnected() && this.acquireConnection && OperationQueue.FLAG_OP_TYPES.has(type)) {
      const acqStart = Date.now();
      const lease = await this.acquireConnection().catch(() => null);
      if (lease) {
        const acquireMs = Date.now() - acqStart;
        try {
          await this.storage!.updatePendingOperationStatus(id, 'executing');
          const execStart = Date.now();
          await this.runFlagOp(lease.client, type, folderPath, [uid]);
          const execMs = Date.now() - execStart;
          await this.storage!.deletePendingOperation(id);
          lease.release();
          // acquire = pool-contention cost; exec = SELECT+STORE round-trips (what
          // the ensureFolderSelected fast-path trims). Split so we can tell which
          // dominates the residual latency.
          logger.info(`Operation ${type} on UID ${uid}: success (pool, acquire ${acquireMs}ms, exec ${execMs}ms)`);
          return 'success';
        } catch (error) {
          lease.poison(); // its command may still be in-flight — never reuse it
          if (this.isConnectionError(error)) {
            await this.storage!.updatePendingOperationStatus(id, 'pending');
            this.addToMemoryQueue(id, type, folderPath, uid, data);
            return 'queued';
          }
          const detail = extractOpFailureDetail(error);
          await this.storage!.markPendingOperationFailed(id, detail.message, detail);
          logger.error(`Operation ${type} on UID ${uid}: failed (dead-lettered)`, error);
          throw error;
        }
      }
      // No free pool connection right now — fall through to the primary path.
    }

    // 2b. Try to execute immediately on the PRIMARY if connected and idle.
    if (this.isConnected() && !this.isSyncing()) {
      try {
        await this.storage!.updatePendingOperationStatus(id, 'executing');
        await this.executeSingleOperation(type, folderPath, uid, data);
        await this.storage!.deletePendingOperation(id);
        logger.info(`Operation ${type} on UID ${uid}: success`);
        return 'success';
      } catch (error) {
        if (this.isConnectionError(error)) {
          await this.storage!.updatePendingOperationStatus(id, 'pending');
          this.addToMemoryQueue(id, type, folderPath, uid, data);
          return 'queued';
        }
        // Non-connection error: dead-letter it (keep as status='failed' for
        // visibility + manual retry) instead of silently dropping. Capture the
        // command we sent + the server's reply so the Outbox can show both.
        const detail = extractOpFailureDetail(error);
        await this.storage!.markPendingOperationFailed(id, detail.message, detail);
        logger.error(`Operation ${type} on UID ${uid}: failed (dead-lettered)`, error);
        throw error;
      }
    }

    // 3. Not connected — add to in-memory queue for later
    this.addToMemoryQueue(id, type, folderPath, uid, data);
    return 'queued';
  }

  /**
   * Universal persist-first pipeline for bulk operations:
   * Persist all → batch execute if connected → queue remainder
   */
  private async persistAndExecuteBulk(
    type: OperationType,
    folderPath: string,
    uids: number[],
    data: any,
  ): Promise<OperationResult> {
    if (!this.client) {
      throw new Error('OperationQueue not initialized');
    }
    if (uids.length === 0) return 'success';

    // 1. Persist all operations in a single transaction
    const ops = uids.map(uid => ({
      type,
      folderPath,
      uid,
      data,
      retryCount: 0,
    }));
    const ids = await this.storage!.savePendingOperationsBatch(ops);

    // 2. Try to execute batch if connected
    if (this.isConnected() && !this.isSyncing()) {
      try {
        // Mark all as executing
        for (const id of ids) {
          await this.storage!.updatePendingOperationStatus(id, 'executing');
        }

        // Execute as single IMAP batch
        await this.executeBatchedOperation(type, folderPath, uids, data);

        // Delete all on success
        await this.storage!.deletePendingOperationsBatch(ids);
        logger.info(`Bulk ${type} on ${uids.length} UIDs in ${folderPath}: success`);
        return 'success';
      } catch (error) {
        if (this.isConnectionError(error)) {
          // Reset all to pending, add to memory queue
          for (let i = 0; i < ids.length; i++) {
            await this.storage!.updatePendingOperationStatus(ids[i], 'pending');
            this.addToMemoryQueue(ids[i], type, folderPath, uids[i], data);
          }
          return 'queued';
        }
        // Non-connection error: dead-letter all instead of dropping.
        const detail = extractOpFailureDetail(error);
        for (const failedId of ids) {
          await this.storage!.markPendingOperationFailed(failedId, detail.message, detail);
        }
        logger.error(`Bulk ${type} failed (dead-lettered ${ids.length})`, error);
        throw error;
      }
    }

    // 3. Not connected — queue all
    for (let i = 0; i < ids.length; i++) {
      this.addToMemoryQueue(ids[i], type, folderPath, uids[i], data);
    }
    logger.info(`Bulk ${type}: ${uids.length} ops queued (offline)`);
    return 'queued';
  }

  // ========== Queue Management ==========

  /**
   * Add operation to in-memory queue (deduplicating by type+folder+uid)
   */
  private addToMemoryQueue(
    id: number,
    type: OperationType,
    folderPath: string,
    uid: number,
    data: any,
  ): void {
    // Deduplicate
    const existing = this.queue.findIndex(
      op => op.type === type && op.folderPath === folderPath && op.uid === uid
    );
    if (existing >= 0) {
      // Move the replacement to the TAIL, don't overwrite the old slot. Keeping
      // the original position made the user's LAST action lose: offline
      // read → unread → read deduped the second `read` into slot 0, so the drain
      // ran [markRead, markUnread] and the message ended UNREAD — the opposite of
      // what was asked for.
      this.queue.splice(existing, 1);
    }

    this.queue.push({ id, type, folderPath, uid, data, retryCount: 0, queuedAt: Date.now() });

    // Soft warning at 1000+
    if (this.queue.length === 1000) {
      logger.warn('Operation queue has 1000+ pending operations');
    }
  }

  /**
   * Process all queued operations in batches
   */
  async processQueue(): Promise<{ success: number; failed: number }> {
    if (this.processing || this.queue.length === 0) {
      return { success: 0, failed: 0 };
    }

    if (!this.isConnected()) {
      return { success: 0, failed: 0 };
    }

    this.processing = true;
    const result = { success: 0, failed: 0 };

    logger.info(`Processing ${this.queue.length} queued operations`);

    try {
      // Take all queued ops
      const toProcess = [...this.queue];
      this.queue = [];

      // Group into batches by (type, folderPath, destPath)
      const batches = this.groupIntoBatches(toProcess);

      for (const batch of batches) {
        try {
          // Mark all as executing
          for (const op of batch.ops) {
            try {
              await this.storage!.updatePendingOperationStatus(op.id, 'executing');
            } catch { /* may already be deleted */ }
          }

          // Execute batch
          const uids = batch.ops.map(op => op.uid);
          await this.executeBatchedOperation(batch.type, batch.folderPath, uids, batch.ops[0].data);

          // Delete all on success
          const ids = batch.ops.map(op => op.id);
          await this.storage!.deletePendingOperationsBatch(ids);
          result.success += batch.ops.length;
        } catch (error) {
          result.failed += batch.ops.length;
          const msg = (error as Error)?.message ?? String(error);
          // Transient failures (network down, throttle, quota) mean the change
          // is valid but the connection isn't — do NOT burn a retry or drop the
          // op, or a just-read email loses its \Seen and springs back to unread
          // when syncFlags reconciles. Re-queue for the next cycle instead.
          const transient = isConnectionError(error) || isRateLimited(error) || isQuotaError(error);
          logger.warn(`Batch op ${batch.type} (${batch.ops.length} uid(s)) failed${transient ? ' [transient — will retry]' : ''}: ${msg}`);

          for (const op of batch.ops) {
            if (transient) {
              this.queue.push(op);
              try {
                await this.storage!.updatePendingOperationStatus(op.id, 'pending');
              } catch { /* ignore */ }
              continue;
            }
            op.retryCount++;
            if (op.retryCount < this.config.maxRetries) {
              this.queue.push(op);
              try {
                await this.storage!.updatePendingOperationStatus(op.id, 'pending');
                await this.storage!.updatePendingOperationRetry(op.id, op.retryCount);
              } catch { /* ignore */ }
            } else {
              logger.warn(`Dead-lettering operation ${op.type} for UID ${op.uid} after ${this.config.maxRetries} retries: ${msg}`);
              try {
                await this.storage!.markPendingOperationFailed(op.id, msg);
              } catch { /* ignore */ }
            }
          }
        }
      }
    } finally {
      this.processing = false;
    }

    logger.info(`Queue processed: ${result.success} success, ${result.failed} failed`);
    return result;
  }

  /**
   * Group operations into batches by (type, folderPath, and the ENTIRE payload).
   *
   * The batch executes with `batch.ops[0].data`, so every op in a batch must
   * carry the same payload. Keying on `destPath ?? label` alone ignored the
   * category/labels payload, so two messages queued with DIFFERENT categories
   * collapsed into one batch and both got the FIRST one's label — the second
   * label was never applied, its mailbox never created, and both rows were
   * deleted as "success". Silent wrong-label plus data loss; same hazard for
   * removeCategoryLabel / removeGmailLabels with differing label lists.
   */
  private groupIntoBatches(ops: QueuedOperation[]): OperationBatch[] {
    const map = new Map<string, OperationBatch>();

    for (const op of ops) {
      const destPath = op.data?.destPath || op.data?.label || '';
      // Stable serialisation of the payload (key order can vary between ops).
      const payload = op.data
        ? JSON.stringify(Object.entries(op.data as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : '';
      const key = `${op.type}|${op.folderPath}|${destPath}|${payload}`;

      if (!map.has(key)) {
        map.set(key, {
          type: op.type,
          folderPath: op.folderPath,
          destPath: destPath || undefined,
          ops: [],
        });
      }
      map.get(key)!.ops.push(op);
    }

    return Array.from(map.values());
  }

  // ========== IMAP Execution ==========

  /** Flag ops are just a SELECT + STORE — cheap and safe to run on a transient
   *  pool connection, so a read/star reaches the server immediately even while a
   *  sync is mid-flight on the primary. Moves/deletes/labels stay on the primary
   *  (multi-step, uid-remap — not worth the extra plumbing). */
  private static readonly FLAG_OP_TYPES: ReadonlySet<OperationType> =
    new Set<OperationType>(['markRead', 'markUnread', 'markStarred', 'markUnstarred']);

  /** Run a flag op on an arbitrary (leased) connection. */
  private async runFlagOp(client: IIMAPClient, type: OperationType, folderPath: string, uids: number[]): Promise<void> {
    // Cheapest select: no-op if already open on this mailbox, and no STATUS
    // round-trip (a flag op never needs the unseen count). Falls back to the
    // full selectFolder for clients that don't implement the fast path.
    if (client.ensureFolderSelected) {
      await client.ensureFolderSelected(folderPath);
    } else {
      await client.selectFolder(folderPath);
    }
    switch (type) {
      case 'markRead': await client.addFlags(uids, ['\\Seen']); break;
      case 'markUnread': await client.removeFlags(uids, ['\\Seen']); break;
      case 'markStarred': await client.addFlags(uids, ['\\Flagged']); break;
      case 'markUnstarred': await client.removeFlags(uids, ['\\Flagged']); break;
      default: throw new Error(`runFlagOp: ${type} is not a flag op`);
    }
  }

  /**
   * Execute a single operation via IMAP
   */
  private async executeSingleOperation(
    type: OperationType,
    folderPath: string,
    uid: number,
    data: any,
  ): Promise<void> {
    await this.executeBatchedOperation(type, folderPath, [uid], data);
  }

  /**
   * Execute a batched operation — single IMAP call for N UIDs
   */
  private async executeBatchedOperation(
    type: OperationType,
    folderPath: string,
    uids: number[],
    data: any,
  ): Promise<void> {
    switch (type) {
      case 'markRead': {
        await this.client!.selectFolder(folderPath);
        // Explicit IMAP-command log so the mail server / IMAP team can confirm we
        // ALWAYS issue a STORE for reads. Single read = INFO (visible by default);
        // bulk = DEBUG (a select-all mark-read would otherwise flood INFO).
        const seenDetail = `folder="${folderPath}" ${uids.length === 1 ? `UID ${uids[0]}` : `${uids.length} UIDs [${uids.slice(0, 20).join(',')}${uids.length > 20 ? ',…' : ''}]`}`;
        if (uids.length > 1) logger.debug(`IMAP STORE +FLAGS (\\Seen) — bulk mark-read ${seenDetail}`);
        else logger.info(`IMAP STORE +FLAGS (\\Seen) — mark-read ${seenDetail}`);
        await this.client!.addFlags(uids, ['\\Seen']);
        break;
      }

      case 'markUnread':
        await this.client!.selectFolder(folderPath);
        await this.client!.removeFlags(uids, ['\\Seen']);
        break;

      case 'markStarred':
        await this.client!.selectFolder(folderPath);
        await this.client!.addFlags(uids, ['\\Flagged']);
        break;

      case 'markUnstarred':
        await this.client!.selectFolder(folderPath);
        await this.client!.removeFlags(uids, ['\\Flagged']);
        break;

      case 'move': {
        await this.client!.selectFolder(folderPath);
        const uidMap = await this.client!.moveMessages(uids, data.destPath);
        await this.remapMovedUids(data.destPath, uids, uidMap);
        break;
      }

      case 'copy': {
        // COPY leaves the source copies in place, so — unlike move — there is no
        // UID remap for the source rows (their UIDs don't change). The dest copies
        // get their own new UIDs, picked up by the destination folder's next sync.
        await this.client!.selectFolder(folderPath);
        await this.client!.copyMessages(uids, data.destPath);
        break;
      }

      case 'moveToTrash': {
        const trashFolder = await this.findSpecialFolder('trash');
        await this.client!.selectFolder(folderPath);
        const uidMap = await this.client!.moveMessages(uids, trashFolder.path);
        await this.remapMovedUids(trashFolder.path, uids, uidMap);
        break;
      }

      case 'moveToSpam': {
        const spamFolder = await this.findSpecialFolder('spam');
        await this.client!.selectFolder(folderPath);
        const uidMap = await this.client!.moveMessages(uids, spamFolder.path);
        await this.remapMovedUids(spamFolder.path, uids, uidMap);
        break;
      }

      case 'archive': {
        const archiveFolder = await this.findSpecialFolder('archive');
        await this.client!.selectFolder(folderPath);
        const uidMap = await this.client!.moveMessages(uids, archiveFolder.path);
        await this.remapMovedUids(archiveFolder.path, uids, uidMap);
        break;
      }

      case 'delete':
        await this.client!.selectFolder(folderPath);
        await this.client!.deleteMessages(uids);
        await this.client!.expunge();
        break;

      case 'setLabel':
        await this.client!.selectFolder(folderPath);
        await this.client!.copyMessages(uids, data.label);
        break;

      case 'applyCategoryLabel': {
        // ALL of the email's categories travel in ONE op (the pending-ops unique
        // index is (type, folder_path, uid), so one op per category would
        // collide). Resolve the strategy once, apply each category.
        const strategy = await resolveLabelStrategy(this.client!, this.client!.host ?? data.host ?? '', (data.mode as FolderLabelMode) || 'copy');
        for (const c of (data.categories ?? [])) await strategy.apply(folderPath, uids, { slug: c.slug, name: c.name });
        break;
      }

      case 'removeCategoryLabel': {
        const strategy = await resolveLabelStrategy(this.client!, this.client!.host ?? data.host ?? '', (data.mode as FolderLabelMode) || 'copy');
        for (const c of (data.categories ?? [])) await strategy.remove(folderPath, uids, { slug: c.slug, name: c.name });
        break;
      }

      case 'removeGmailLabels': {
        // Strip stale Gmail labels in place (STORE -X-GM-LABELS) — no delete.
        if (!this.client!.removeGmailLabels) break;
        const labels: string[] = data.labels ?? [];
        if (labels.length === 0) break;
        await this.client!.selectFolder(folderPath);
        await this.client!.removeGmailLabels(uids, labels);
        break;
      }

      default:
        throw new Error(`Unknown operation type: ${type}`);
    }
  }

  /**
   * Re-home moved rows' UIDs after a server MOVE succeeds.
   *
   * A move leaves the local row with `folder_id = destination` but `uid` still
   * pointing at the SOURCE folder's UID space. Deletion-detection then sees that
   * UID missing from the destination folder and DELETES the moved mail, and flag
   * sync targets a stale UID. This resolves each message's real destination UID
   * and persists it onto the local row so `emails.uid` matches its folder.
   *
   * Two resolution paths:
   *  - UIDPLUS servers (Gmail and most modern IMAPs) return `uidMap`
   *    (sourceUID -> destUID) — the common, exact path.
   *  - Servers without UIDPLUS return no map; fall back to a Message-ID SEARCH in
   *    the destination folder for each moved row.
   *
   * Best-effort and idempotent: the enclosing move already succeeded on the
   * server, so a failure here must never throw or roll it back; and re-running a
   * move whose row already carries the destination UID is a no-op (the
   * source-UID lookup no longer matches, or the UID is already correct).
   */
  private async remapMovedUids(
    destPath: string,
    sourceUids: number[],
    uidMap: Map<number, number> | null,
  ): Promise<void> {
    if (!this.storage) return;
    try {
      const destFolder = await this.storage.getFolderByPath(destPath);
      if (!destFolder) {
        logger.warn(`remapMovedUids: destination folder not found for "${destPath}"; skipping uid writeback`);
        return;
      }

      // Exact path: server gave us source->dest UIDs.
      if (uidMap && uidMap.size > 0) {
        for (const [srcUid, destUid] of uidMap) {
          await this.persistDestUid(destFolder.id, srcUid, destUid);
        }
        return;
      }

      // Fallback (no UIDPLUS): resolve each dest UID by Message-ID SEARCH in the
      // destination folder. We're here right after a successful move, so the
      // client is connected; guard anyway to avoid throwing if it dropped.
      if (!this.isConnected()) {
        logger.warn(`remapMovedUids: no uidMap and client not connected for "${destPath}"; local uids left stale (will self-heal on next full sync)`);
        return;
      }
      await this.client!.selectFolder(destPath);
      for (const srcUid of sourceUids) {
        const row = await this.storage.getEmailByFolderAndUid(destFolder.id, srcUid);
        if (!row || !row.messageId) continue;
        const msgId = row.messageId.replace(/^<|>$/g, '');
        if (!msgId) continue;
        const hits = await this.client!.search({ header: [{ name: 'Message-ID', value: msgId }] });
        if (hits.length > 0 && hits[0] !== row.uid) {
          await this.storage.updateEmail(row.id, { uid: hits[0] });
        }
      }
    } catch (error) {
      // The move itself succeeded; never fail it because the uid writeback did.
      logger.warn(`remapMovedUids: failed to persist destination uids for "${destPath}"`, error);
    }
  }

  /**
   * Persist a single moved message's destination UID onto its local row.
   * Idempotent: no-op when source==dest UID, when no row still carries the
   * source UID in the destination folder, or when the row already has destUid.
   */
  private async persistDestUid(destFolderId: string, srcUid: number, destUid: number): Promise<void> {
    if (srcUid === destUid) return;
    const row = await this.storage!.getEmailByFolderAndUid(destFolderId, srcUid);
    if (row && row.uid !== destUid) {
      await this.storage!.updateEmail(row.id, { uid: destUid });
    }
  }

  // ========== Persistence ==========

  /**
   * Persist a single operation to SQLite (INSERT OR REPLACE)
   */
  private async persistOperation(
    type: OperationType,
    folderPath: string,
    uid: number,
    data: any,
  ): Promise<number> {
    if (!this.storage) {
      throw new Error('Storage not available');
    }

    return this.storage.savePendingOperation({
      type,
      folderPath,
      uid,
      data,
      retryCount: 0,
    });
  }

  /**
   * Load operations from storage on startup
   * Resets any status='executing' back to 'pending' (crashed mid-flight)
   */
  async loadFromStorage(): Promise<void> {
    if (!this.storage) return;

    try {
      const ops = await this.storage.getPendingOperations();

      for (const op of ops) {
        // Reset crashed operations
        if (op.status === 'executing') {
          await this.storage.updatePendingOperationStatus(op.id, 'pending');
        }

        this.queue.push({
          id: op.id,
          type: op.type as OperationType,
          folderPath: op.folderPath,
          uid: op.uid,
          data: op.data,
          retryCount: op.retryCount,
          queuedAt: Date.now(),
        });
      }

      if (ops.length > 0) {
        logger.info(`Loaded ${ops.length} pending operations from storage (including crashed ops reset to pending)`);
      }
    } catch (error) {
      logger.error('Failed to load operations from storage:', error);
    }
  }

  /**
   * Re-arm all dead-lettered ('failed') operations: reset them to 'pending' and
   * add them back to the in-memory queue. The caller should then processQueue().
   * Returns the number of operations re-armed.
   */
  async retryFailed(): Promise<number> {
    if (!this.storage) return 0;
    const failed = await this.storage.getFailedOperations();
    return this.rearmFailed(failed);
  }

  /**
   * Re-arm a single dead-lettered operation by id. Returns false if the id is
   * not among the currently-failed operations (already retried/discarded).
   */
  async retryFailedOne(id: number): Promise<boolean> {
    if (!this.storage) return false;
    const failed = await this.storage.getFailedOperations();
    const op = failed.find((o) => o.id === id);
    if (!op) return false;
    await this.rearmFailed([op]);
    return true;
  }

  /**
   * Reset the given dead-lettered ops back to 'pending' and re-add them to the
   * in-memory queue so the next drain picks them up. Shared by retryFailed()
   * (all) and retryFailedOne() (single).
   */
  private async rearmFailed(
    failed: Array<{ id: number; type: string; folderPath: string; uid: number; data: any }>,
  ): Promise<number> {
    if (!this.storage) return 0;
    for (const op of failed) {
      await this.storage.resetFailedOperation(op.id);
      this.addToMemoryQueue(op.id, op.type as OperationType, op.folderPath, op.uid, op.data);
    }
    if (failed.length > 0) {
      logger.info(`Re-armed ${failed.length} dead-lettered operation(s) for retry`);
    }
    return failed.length;
  }

  // ========== Helper Methods ==========

  /**
   * Find special folder by type
   */
  private async findSpecialFolder(type: SpecialFolderType): Promise<IMAPFolder> {
    const cached = this.folderCache.get(type);
    if (cached) {
      return cached;
    }

    const folders = await this.client!.listFolders();
    const flatFolders = this.flattenFolders(folders);

    const mapping = FOLDER_MAPPINGS[type];
    const folder = flatFolders.find(f =>
      mapping.names.some(name => f.path.toLowerCase() === name.toLowerCase()) ||
      mapping.specialUse.some(use => f.specialUse === use)
    );

    if (!folder) {
      throw new Error(`${type} folder not found`);
    }

    this.folderCache.set(type, folder);
    return folder;
  }

  /**
   * Flatten nested folders
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
   * Check if error is connection-related
   */
  private isConnectionError(error: unknown): boolean {
    return isConnectionError(error);
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
    this.folderCache.clear();
  }
}
