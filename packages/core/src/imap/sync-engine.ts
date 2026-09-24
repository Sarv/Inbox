// Sync Engine - Main orchestrator for IMAP sync

import LRUCache from 'lru-cache';
import { simpleParser } from 'mailparser';

import { buildStandardFolderAliasMap, describeDuplicateRoles, duplicateRoleCandidates } from '../config/folder-mapping';
import { getEventBus, createEvent } from '../pipeline/event-bus';
import type { IMAPConfig, IIMAPClient, IMAPFolder, IMAPMessage, SearchCriteria } from '../types/imap';
import type { EmailRecord, FolderRecord } from '../types/models';
import type { IEmailStorage } from '../types/storage';
import { createDeferredFetchError } from '../utils/deferred-fetch-error';
import { withFiledCounts } from '../utils/folder-counts';
import { logger } from '../utils/logger';
import { SIMPLE_PARSER_OPTIONS } from '../utils/mail-parse';
import type { EmailProvider } from '../utils/provider';
import { withStallTimeout, isTimeoutError } from '../utils/timeout';

import { base64DecodeCollapsed, findAttachmentNodeByName } from './body-structure';
import { poolIdleTimeoutForHost } from './connection-budget';
import { ConnectionManager } from './connection-manager';
import { IMAPConnectionPool, PoolConnectionParkedError, type ConnectionPoolConfig } from './connection-pool';
import { mapEnvelopeFields } from './envelope-mapper';
import { isFolderSyncEnabled, folderHeadersOnly } from './folder-sync-policy';
import { FolderSyncer, type FolderSyncResult } from './folder-syncer';
import { getSuggestedBackoffMs } from './imap-errors';
import { MessageProcessor, isExpectedMessage, type IngestServerActions } from './message-processor';
import { OperationQueue, type OperationResult } from './operation-queue';
import { applyQresyncVanished } from './qresync-reconcile';
import { attachmentBytesFromSource } from './raw-mime-part';
import { RealtimeManager, type RealtimeMode, type RealtimeEvent } from './realtime-manager';
import type { ReputationLookup } from './reputation-stage';
import { SyncStateManager, type SyncStatus, type SyncState } from './sync-state';
import { withFolderSelected } from './with-folder';

/**
 * Sync engine options
 */
export interface SyncEngineOptions {
  fullSync?: boolean;
  maxMessages?: number;
  folders?: string[];
  skipRecentMinutes?: number;
  headersOnly?: boolean;
  flagsOnly?: boolean;
  skipUnchanged?: boolean;
  parallelSync?: boolean;
  parallelConnections?: number;
  onProgress?: (status: SyncStatus) => void;
}

const DEFAULT_OPTIONS: SyncEngineOptions = {
  fullSync: false,
  maxMessages: 50,
  headersOnly: true,
  flagsOnly: false,
  skipUnchanged: true,
  parallelSync: false,
  parallelConnections: 2,
};

// Fast dedicated drain (drainFolderChunk): download messages the server has but the DB
// lacks (count-capped initial sync, mid-range holes the downward backfill can't fill).
// MAX_PER_CALL bounds one call's work so a pooled connection isn't held too long; FETCH
// _BATCH keeps each UID FETCH well under the op timeout on a slow server (~250ms/header).
const DRAIN_MAX_PER_CALL = 300;
// Body-fetch budget. STALL is the "nothing has arrived for this long" cut-off —
// a dead socket still fails in 30s, exactly as it did under the old flat
// timeout. MAX is the ceiling for a transfer that IS progressing, so a large
// message on a slow link can finish (it never could before) without any one
// fetch being able to hold a pooled connection indefinitely.
const BODY_FETCH_STALL_TIMEOUT = 30_000;
const BODY_FETCH_MAX_TIMEOUT = 5 * 60_000;
const DRAIN_FETCH_BATCH = 100;
// Server-search escalation: newest-first cap on how many missing matches one
// server search downloads, so a query hitting thousands of old mails stays
// bounded (header-only, in DRAIN_FETCH_BATCH sub-batches).
const SERVER_SEARCH_MAX_FETCH = 200;
// Per-folder cap on the drain's "already tried this session" set (see drainTriedUids).
const DRAIN_TRIED_CAP = 50000;
// How long a body-fetch failure ledger entry lives. Hitting the retry cap must be
// a COOL-DOWN, not a session-long blacklist: the strikes are mostly timeouts and
// connection errors, which are properties of the link at that moment. Before this
// TTL the only way back was a forceReconnect, so a bad ten minutes could hide mail
// for the rest of the session.
export const BODY_FETCH_FAILURE_TTL_MS = 15 * 60_000;
// How long a folder stays on the "won't SELECT" list. A `NO SELECT` is very often
// the server being momentarily busy, and this list is FOLDER-wide — leaving INBOX
// on it for a whole session stops every body in the mailbox from downloading.
export const UNSELECTABLE_FOLDER_TTL_MS = 10 * 60_000;

/**
 * Body fetch queue item — uses a listeners array instead of chaining closures
 * to prevent unbounded closure accumulation when multiple callers request the same email.
 */
interface BodyFetchItem {
  emailId: string;
  folderPath: string;
  uid: number;
  listeners: Array<{ resolve: (result: any) => void; reject: (error: any) => void }>;
  // Fired once, when the item leaves the queue and its FETCH actually starts.
  // Callers that impose their own deadline need this: time spent queued behind
  // other items says nothing about this message, and a caller that submits a
  // batch would otherwise time out its own tail before the drain reaches it.
  // Emptied on fire, so a re-queued retry doesn't re-signal (a caller's budget
  // must stay bounded — see `withStartGatedTimeout`).
  onStart: Array<() => void>;
}

/**
 * Sync Engine
 *
 * Clean, modular orchestrator for IMAP sync:
 * - Connection management via ConnectionManager
 * - State tracking via SyncStateManager
 * - Folder sync via FolderSyncer
 * - Real-time updates via RealtimeManager
 * - Email operations via OperationQueue
 */
export class SyncEngine {
  // Core components
  private connectionManager: ConnectionManager;
  private syncState: SyncStateManager;
  private folderSyncer: FolderSyncer;
  private messageProcessor: MessageProcessor;
  private realtimeManager: RealtimeManager;
  private operationQueue: OperationQueue;
  // Source folders of move-backs relinked during the current sync, drained +
  // reconciled by syncAll after the folder loop (see setOnReconcileFolders wiring).
  private pendingSourceReconcile = new Set<string>();

  // Connection pool for parallel sync
  private connectionPool: IMAPConnectionPool | null = null;
  // In-flight pool init, shared by concurrent initializePool() callers so a
  // second call can't build (and leak) a second pool + socket.
  private poolInitInFlight: Promise<void> | null = null;

  // Storage
  private storage: IEmailStorage;
  /** Last duplicate-role report, so the line prints on change, not per sync. */
  private lastDuplicateRoleSummary: string | null = null;
  /** Folders whose local count was recounted because two names claim one role. */
  private readonly recountedContestedFolders = new Set<string>();

  // Body fetch queue. Items are tiny ({emailId, folderPath, uid, listeners})
  // and the drain rate is IMAP-bound regardless of size, so the cap exists
  // only to bound memory — keep it generous so bursts (opening a large
  // thread, fast scrolling, prefetch + visible-email fetches overlapping)
  // don't evict legitimate requests with "Queue full" and force renderer
  // retries. 50 was too small and produced frequent queue-full churn.
  private bodyFetchQueue: BodyFetchItem[] = [];
  // O(1) dedup index into bodyFetchQueue, keyed by emailId. Kept in lock-step
  // with the array on every enqueue/dequeue/clear so fetchBody() can look up an
  // in-flight request without an O(queue) scan. Deletes are identity-guarded
  // (only remove the key when it still points to THIS item) so a re-enqueued
  // duplicate never gets its live entry clobbered by a stale item's removal.
  private bodyFetchQueueIndex = new Map<string, BodyFetchItem>();
  private bodyFetchInProgress = false;
  private readonly MAX_BODY_FETCH_QUEUE = 300;
  // emailId -> failure count. LRU-capped so it can't grow unbounded, and TTL'd
  // so hitting the retry cap is a COOL-DOWN rather than a session-long
  // blacklist: a message that only failed because the server was slow for ten
  // minutes must get another chance without waiting for a forceReconnect.
  private bodyFetchFailures = new LRUCache<string, number>({
    max: 500,
    ttl: BODY_FETCH_FAILURE_TTL_MS,
  });
  // Body fetches that SUCCEEDED (or reached a server verdict) since the last
  // reconnect. A timeout is ambiguous — it can be the MESSAGE (large/slow) or a
  // ZOMBIE SOCKET where everything hangs. We only let a timeout accrue a give-up
  // strike once this is > 0: proof the pipe works, so a hang is that message's
  // fault, not the socket's. While it's 0 (nothing has come back since reconnect)
  // timeouts are retried WITHOUT counting, so a dead socket can't blacklist good
  // mail — the exact case the old blanket clear-on-reconnect protected, but
  // without resetting genuine poison pills to zero on every flap.
  private bodyFetchSuccessesSinceReconnect = 0;

  // Per-folder set of server UIDs the DRAIN has already fetched this session and
  // that made no folder_id-space progress (a message present in this folder by TAG
  // whose primary folder is elsewhere — Gmail's All-Mail superset). Like the
  // addition-reconcile's tried-set: without it the oldest-first drain re-fetched
  // the same no-op band every call, counted those relinks as "progress", and
  // declared the folder `done` prematurely — skipping it for the rest of the
  // session while genuinely-missing newer holes stayed undownloaded. Session-only,
  // size-capped, safe to lose.
  private drainTriedUids = new Map<string, Set<number>>();
  // Did the current syncAll* pass actually mutate the emails table (insert new
  // mail, update flags, or delete)? Only then can folder counts have changed, so
  // only then is the end-of-sync recalculateFolderCounts() worth its full-table
  // scan. A quiet poll over N folders with nothing new used to fire N unconditional
  // ~120-230ms synchronous main-thread recounts (macOS beachball); this gates them.
  private syncDidMutateCounts = false;
  // Full raw RFC822 source per email, captured for free during the body fetch
  // (which downloads it anyway) so "Show Original" needs no second fetch.
  // Session-only, LRU-capped — least-recently-used eviction handled by lru-cache.
  private rawSourceCache = new LRUCache<string, string>({ max: 100 });
  private readonly MAX_BODY_FETCH_RETRIES = 5;
  // Folders whose SELECT the server rejects (e.g. an unsubscribed [Gmail]/*
  // duplicate that can't be opened). Once seen, skip all body fetches for that
  // folder instead of retrying every message on it forever and churning
  // connections. Cleared on forceReconnect in case it was transient — and now
  // ALSO self-expiring: `NO SELECT INBOX` from a momentarily busy server used to
  // sideline the whole mailbox until the next forced reconnect.
  private unselectableFolders = new LRUCache<string, true>({
    max: 100,
    ttl: UNSELECTABLE_FOLDER_TTL_MS,
  });
  // Debounced resume timer for when the server throttles / hits the connection
  // quota — we back off (honoring any server-suggested delay) instead of
  // retrying into the limit. One timer shared by the whole batch.
  private bodyFetchResumeTimer: ReturnType<typeof setTimeout> | null = null;
  // Latches true while the drain is paused waiting for the primary to reconnect,
  // so we log "waiting for reconnect" ONCE per disconnect episode instead of once
  // per processBodyFetchQueue() call. On a saturated/flapping account the pipeline
  // re-requests bodies constantly, and the per-call line flooded app.log (hundreds
  // of INFO lines) — a synchronous main-thread write each time, which stalls the
  // event loop and is the "logs stuck / slow startup" symptom. Cleared the moment
  // a drain actually proceeds (connected again).
  private bodyFetchWaitingForReconnect = false;
  // Set once the queue is torn down (disconnect/shutdown). An in-flight fetch
  // that was already dequeued can error on the closing socket AFTER the queue is
  // cleared and try to requeue itself — resurrecting the queue into a re-queue
  // loop that spammed logs and held teardown open (a stuck Ctrl+C on quit). While
  // stopped, requeue/process are no-ops; a fresh connect() clears it.
  private bodyFetchStopped = false;
  // Set when IMAP auth fails (invalid credentials / expired app password).
  // Stops the body-fetch queue from hammering the server with retries that
  // will all fail until the user re-enters credentials. Cleared on a
  // successful reconnect/auth, or when the queue is explicitly resumed.
  private authPaused = false;

  // Progress callback
  private onProgressCallback: ((status: SyncStatus) => void) | null = null;

  constructor(storage: IEmailStorage) {
    this.storage = storage;

    // Initialize components
    this.connectionManager = new ConnectionManager();
    // Per-engine sync state (NOT a shared singleton). Each account has its own
    // SyncEngine, so its sync progress/status/isSyncing flag and new-email event
    // stream must be independent — otherwise a background account's sync (Tier B)
    // would block the active account's sync (shared isSyncing), pollute its
    // status/error, and its new-email events would leak into the active view.
    this.syncState = new SyncStateManager();
    this.folderSyncer = new FolderSyncer();
    this.messageProcessor = new MessageProcessor();
    this.realtimeManager = new RealtimeManager();
    this.operationQueue = new OperationQueue();

    // Make every syncFlags pass (full sync, incremental, IDLE poll, on-demand)
    // skip UIDs that have a pending local flag op, so the server-wins
    // reconciliation can't revert a just-made local change before it round-trips
    // (the "read email springs back to unread" bug, and the same for star).
    const pendingUids = (folderPath: string) => this.operationQueue.getPendingUids(folderPath);
    this.messageProcessor.setPendingUidsProvider(pendingUids);
    this.folderSyncer.setPendingUidsProvider(pendingUids);
    this.realtimeManager.setPendingUidsProvider(pendingUids);

    // What ingest decides locally — the spam filter's re-file, a rule's move,
    // read or star — is mirrored on the server through the same persisted
    // queue every user action takes. Persisting first is what makes the UID
    // show up in `pendingUids` above, so the source folder's next reconcile
    // does not read the server's not-yet-moved copy as an external move-back
    // and relink it, and syncFlags does not read its still-unread copy as the
    // truth — a local-only re-file sprang back within one reconcile, a local
    // "mark read" on the next flag sync. Mid-sync the ops wait in the queue
    // and run when the sync finishes, exactly like a user action taken during
    // a sync.
    const ingestActions: IngestServerActions = {
      markRead: (folderPath, uid) => this.operationQueue.markAsRead(folderPath, uid),
      star: (folderPath, uid) => this.operationQueue.star(folderPath, uid),
      moveToSpam: (folderPath, uid) => this.operationQueue.moveToSpam(folderPath, uid),
      archive: (folderPath, uid) => this.operationQueue.archive(folderPath, uid),
      moveToTrash: (folderPath, uid) => this.operationQueue.moveToTrash(folderPath, uid),
      move: (sourcePath, uid, destPath) => this.operationQueue.move(sourcePath, uid, destPath),
    };
    this.messageProcessor.setServerActions(ingestActions);
    this.folderSyncer.setServerActions(ingestActions);
    this.realtimeManager.setServerActions(ingestActions);

    // The blocklist lookup is NOT wired here. It is a network call to a third
    // party about the user's correspondents, governed by the user's settings,
    // so it arrives from outside (see setReputationLookup) and the engine runs
    // perfectly without one.

    // Hook folder-sync inserts into the same event stream realtime
    // uses, so manual / periodic syncs that insert new emails get
    // surfaced to the renderer (otherwise the realtime polling that
    // runs after would dedup by messageId and skip — no per-email
    // event fires and the UI list stays stale until refresh).
    this.folderSyncer.setOnNewEmail((emailId, folderPath) => {
      this.syncState.emitNewEmail(emailId, folderPath);
    });
    this.folderSyncer.setOnEmailDeleted((emailId, _uid, folderPath) => {
      this.syncState.emitEmailDeleted(emailId, folderPath);
    });
    // A move-BACK relinked during a folder sync leaves the mail still tagged in its
    // SOURCE folder (e.g. Trash→Inbox leaves it in Trash). Collect those source
    // folders; syncAll drains + reconciles them AFTER the folder loop (not
    // re-entrantly — syncAll guards on isSyncing).
    this.folderSyncer.setOnReconcileFolders((folders) => {
      for (const f of folders) this.pendingSourceReconcile.add(f);
    });

    // Wire up event handlers
    this.setupEventHandlers();
  }

  /**
   * Setup event handlers between components
   */
  private setupEventHandlers(): void {
    // Connection events -> Sync state
    this.connectionManager.on('connected', () => {
      this.syncState.setConnected();
      // A successful connect implies auth succeeded — clear the
      // auth-pause flag so newly-queued body fetches can run.
      if (this.authPaused) {
        logger.info('Body fetch queue: auth-pause cleared after successful (re)connect');
        this.authPaused = false;
      }
    });

    this.connectionManager.on('disconnected', () => {
      this.syncState.setDisconnected();
      // Don't clear body fetch queue — items will be retried after reconnect
    });

    // Gmail "Too many simultaneous connections" was hit. The pool's
    // sockets are likely the culprit — they each count against the
    // 15-connection cap. Close the pool so the server-side reaper
    // has fewer holds to wait out, and so the next reconnect attempt
    // has room under the cap. The auto-ladder is already paused for
    // 5min (per ConnectionManager.attemptReconnect quota path) so we
    // give the server time to release the stale sockets.
    this.connectionManager.on('quota-exceeded', async () => {
      logger.warn('SyncEngine: quota-exceeded received — closing connection pool to release sockets');
      if (this.connectionPool) {
        try {
          await this.connectionPool.close();
        } catch (err) {
          logger.warn('Pool close after quota error failed (ignored):', err);
        }
      }
    });

    // Defensive: subscribe to 'error' so EventEmitter doesn't throw
    // synchronously when the manager emits one (Node default). We
    // already have a non-emit branch via 'max-attempts-reached', but
    // some paths still emit 'error' (e.g. the connect() catch).
    this.connectionManager.on('error', (err) => {
      // Transient connection drops are handled by the reconnect ladder (which
      // logs its own attempts), so don't spam a WARN + stack for each one.
      // Non-connection errors (e.g. auth) stay visible.
      if (this.connectionManager.isConnectionError(err)) {
        logger.debug(`ConnectionManager connection error (reconnecting): ${(err as Error)?.message ?? err}`);
      } else {
        logger.warn('ConnectionManager error event:', err);
      }
    });

    this.connectionManager.on('reconnected', async () => {
      // Re-initialize components with the new client
      this.initializeComponents();

      // Restart realtime monitoring with the new client
      try {
        await this.realtimeManager.updateClient(this.connectionManager.client);
      } catch (error) {
        logger.error('Failed to restart realtime after reconnect:', error);
      }

      // Process pending operations after reconnect. WRAPPED: this handler is an
      // async listener invoked by a synchronous emit('reconnected'), so nobody
      // awaits it — an unhandled throw here surfaces as a process-level
      // "Unhandled rejection: Connection not available" (a reconnect that
      // immediately re-drops makes processQueue throw). The queue has its own
      // retry, so log and move on rather than crash the tick.
      if (!this.operationQueue.isEmpty) {
        try {
          await this.operationQueue.processQueue();
        } catch (error) {
          logger.warn(`Post-reconnect operation-queue drain failed (will retry): ${(error as Error)?.message ?? error}`);
        }
      }

      // Do NOT blanket-clear the failure ledger here. On a FLAPPING account
      // (frequent reconnects) that reset the per-email timeout count to zero
      // every time, so a genuine poison-pill message never reached the give-up
      // cap and churned a fresh connection forever. Instead reset only the
      // "pipe proven healthy" signal: right after a reconnect we again give
      // timeouts the benefit of the doubt (not counted) until a fetch succeeds
      // and proves the new socket works — then message-specific hangs count
      // again. Sleep/wake bursts surface as connection errors (not counted),
      // not timeouts, so they still can't blacklist good mail.
      this.bodyFetchSuccessesSinceReconnect = 0;

      // Resume body fetch queue after reconnect
      if (this.bodyFetchQueue.length > 0) {
        logger.info(`Resuming ${this.bodyFetchQueue.length} pending body fetches after reconnect`);
        this.processBodyFetchQueue();
      }
    });

    // Sync state events -> Progress callback
    this.syncState.on('state-change', () => {
      this.emitProgress();
    });

    this.syncState.on('folder-progress', () => {
      this.emitProgress();
    });

    // Realtime events -> Forward to listeners
    this.realtimeManager.on('event', (event) => {
      this.handleRealtimeEvent(event);
    });
  }

  /**
   * Initialize dependencies for sub-components
   */
  private initializeComponents(): void {
    const client = this.connectionManager.client;

    this.realtimeManager.initialize({
      client,
      storage: this.storage,
      onSyncRequest: (folders) => this.syncAll({ folders }),
    });

    this.operationQueue.initialize({
      client,
      storage: this.storage,
      isConnected: () => this.connectionManager.isConnected(),
      isSyncing: () => this.syncState.isSyncing(),
      // Lease a transient pool connection so flag ops (read/star) go to the server
      // immediately, independent of the sync running on the primary. Null when no
      // pool exists (background account) → the queue uses the primary as fallback.
      acquireConnection: async () => {
        const pool = this.connectionPool;
        if (!pool) return null;
        try { return await pool.acquire(); } catch { return null; }
      },
    });
  }

  /**
   * Hand the engine a blocklist lookup, or replace the one it has.
   *
   * Injected rather than constructed because the decision to ask a blocklist
   * operator about the user's mail is the user's, made in Security settings,
   * and because the cache and circuit breakers behind it are shared across
   * every account's engine — one process, one set of queries.
   */
  setReputationLookup(fn: ReputationLookup): void {
    this.messageProcessor.setReputationLookup(fn);
    this.folderSyncer.setReputationLookup(fn);
    this.realtimeManager.setReputationLookup(fn);
  }

  // ========== Connection ==========

  /**
   * Connect to IMAP server
   */
  async connect(config: IMAPConfig): Promise<void> {
    await this.connectionManager.connect(config);
    // Fresh connection — lift the body-fetch stop latch set by a prior
    // disconnect so on-demand fetches resume (reconnect / account switch-back).
    this.bodyFetchStopped = false;
    this.initializeComponents();

    // Load pending operations from storage
    await this.operationQueue.loadFromStorage();
  }

  /**
   * CREATE a user label as a top-level folder on the server (opt-in "sync to
   * server" from the label dialog), so it shows in the provider's webmail.
   * Returns true if the folder exists after the call, false if not connected /
   * rejected. Best-effort — a false result leaves the label local-only.
   */
  async createServerLabel(name: string): Promise<boolean> {
    return this.operationQueue.createServerLabel(name);
  }

  /**
   * Initialize connection pool for parallel sync
   */
  async initializePool(config: IMAPConfig, poolConfig?: Partial<ConnectionPoolConfig>): Promise<void> {
    // Coalesce concurrent callers. Without this, two overlapping imap:connect
    // calls (startup + a focus/online reconnect) both build a pool; the loser's
    // pool is reassigned away while it's mid-initialize(), orphaning its already-
    // opened socket + idle-check timer — a silent connection leak. One in-flight
    // init is shared by all callers.
    // Share the SAME connection-cap back-off the pool uses with the primary
    // reconnect ladder, so all connect paths (primary + pool) wait out one window
    // together instead of the primary hammering a saturated cap while the pool
    // waits. Set here (not just on the pool) because the reconnect ladder was the
    // last path that ignored the shared park — the "stuck reconnecting" deadlock.
    this.connectionManager.setConnectBackoffHooks(poolConfig?.connectGate, poolConfig?.onConnectError);

    if (this.poolInitInFlight) return this.poolInitInFlight;
    this.poolInitInFlight = (async () => {
      try {
        // Close the previous pool BEFORE building the new one, and only publish
        // the new pool once it's fully initialized — so a half-open pool is never
        // referenced and the old one's sockets are released first.
        if (this.connectionPool) {
          const old = this.connectionPool;
          this.connectionPool = null;
          await old.close();
        }
        const pool = new IMAPConnectionPool({
          maxConnections: poolConfig?.maxConnections || 4,
          connectionTimeout: poolConfig?.connectionTimeout || 30000,
          // Warm-connection lifetime is host-aware (single source in
          // connection-budget): a flat 60s re-opened pooled connections on nearly
          // every drip-fed prefetch/backfill pass, and that CHURN — not the live
          // count — is what trips Gmail's connect-rate throttle. Keep them warm
          // much longer (Gmail 5m, others 10m) so the socket is reused instead of
          // re-handshaken. An explicit poolConfig.idleTimeout still wins.
          idleTimeout: poolConfig?.idleTimeout || poolIdleTimeoutForHost(config.host),
          // Pass the shared connect gate through untouched so the pool honours the
          // SAME per-account back-off the other connect paths use (owned by the
          // desktop layer, which knows the accountId). Undefined here = no gate.
          connectGate: poolConfig?.connectGate,
          onConnectError: poolConfig?.onConnectError,
        });
        await pool.initialize(config);
        this.connectionPool = pool;
        logger.info('Connection pool initialized');
      } finally {
        this.poolInitInFlight = null;
      }
    })();
    return this.poolInitInFlight;
  }

  /**
   * Disconnect from IMAP server
   */
  async disconnect(): Promise<void> {
    // Stop realtime monitoring
    await this.realtimeManager.stop();

    // Clear body fetch queue
    this.clearBodyFetchQueue();

    // Close connection pool
    if (this.connectionPool) {
      await this.connectionPool.close();
      this.connectionPool = null;
    }

    // Disconnect main connection
    await this.connectionManager.disconnect();

    // Reset state
    this.syncState.reset();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionManager.isConnected();
  }

  /**
   * Mailbox storage quota (RFC 2087) in bytes, or null when unavailable
   * (disconnected, QUOTA not advertised, or no meaningful limit). Prefers the
   * pool so it never contends with the foreground/IDLE primary socket.
   */
  async getQuota(path = 'INBOX'): Promise<{ used: number; limit: number } | null> {
    if (!this.isConnected()) return null;
    try {
      if (this.connectionPool?.isInitialized()) {
        return await this.connectionPool.withConnection((client) => client.getQuota?.(path) ?? Promise.resolve(null));
      }
      return await (this.connectionManager.client.getQuota?.(path) ?? Promise.resolve(null));
    } catch {
      return null;
    }
  }

  /** Subscribe / unsubscribe a mailbox on the server (LSUB). Best-effort — a
   *  server that rejects it must not fail the local policy change. */
  async setMailboxSubscribed(path: string, subscribed: boolean): Promise<void> {
    if (!this.isConnected()) return;
    const run = async (client: IIMAPClient) => {
      if (subscribed) await client.subscribeMailbox?.(path);
      else await client.unsubscribeMailbox?.(path);
    };
    try {
      if (this.connectionPool?.isInitialized()) { await this.connectionPool.withConnection(run); return; }
      await run(this.connectionManager.client);
    } catch (err) {
      logger.warn(`setMailboxSubscribed(${path}, ${subscribed}) failed: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * Ensure connection is alive, reconnect if needed.
   * Returns true if connected (or reconnected), false if failed.
   */
  async ensureConnection(): Promise<boolean> {
    return this.connectionManager.ensureConnection();
  }

  /**
   * Probe whether the current connection answers a NOOP (liveness), without
   * triggering the reconnect ladder. Callers use this to avoid a needless
   * hard teardown of a healthy connection.
   */
  async verifyConnection(): Promise<boolean> {
    return this.connectionManager.verifyConnection();
  }

  /**
   * True while a connect() handshake is in flight. A pending connect is NOT a
   * dead connection — `verifyConnection()` reports false for one because there
   * is no authenticated socket yet. See ConnectionManager.isConnecting.
   */
  isConnecting(): boolean {
    return this.connectionManager.isConnecting();
  }

  /**
   * Resolve once the connection is usable, or false on timeout. Never rejects.
   * Used to wait out an in-flight connect instead of racing it.
   */
  async waitUntilConnected(timeoutMs?: number): Promise<boolean> {
    return this.connectionManager.waitUntilConnected(timeoutMs);
  }

  /**
   * Get provider
   */
  getProvider(): EmailProvider {
    return this.connectionManager.provider;
  }

  /**
   * Reset reconnect attempts to allow fresh connection attempt
   * Call this when user wants to manually retry after max attempts reached
   */
  resetReconnectAttempts(): void {
    this.connectionManager.resetReconnectAttempts();
  }

  /** True while a "too many simultaneous connections" quota back-off is active —
   *  callers should not force a reconnect (it just re-hits the server's cap). */
  isInQuotaCooldown(): boolean {
    return this.connectionManager.isInQuotaCooldown();
  }

  /** True while an auth-failure back-off is active — callers must not force a
   *  reconnect (retrying rejected credentials prolongs the server lockout). */
  isInAuthCooldown(): boolean {
    return this.connectionManager.isInAuthCooldown();
  }

  /**
   * Force a hard disconnect + reconnect. Use when the connection is a
   * ZOMBIE (socket appears open but server has dropped it; every
   * request hangs until timeout). Plain `connect()` won't help — its
   * "already connected" guard short-circuits on the zombie state.
   * Also re-initializes the connection pool so parallel fetches use
   * fresh sockets.
   */
  async forceReconnect(): Promise<void> {
    await this.connectionManager.forceReconnect();

    // Clear the body-fetch failure ledger. Emails that hit 5 timeouts
    // against the zombie connection were blacklisted ("Body fetch
    // skipped — failed 5 times previously") — but those failures were
    // all the dead socket, not the email itself. Without this clear,
    // those rows stay invisible forever even after the fresh socket
    // would happily fetch them.
    this.bodyFetchFailures.clear();
    this.bodyFetchSuccessesSinceReconnect = 0; // new socket: re-prove health before counting timeouts
    // Drop the unselectable-folder blacklist too — a fresh socket may open
    // folders that failed during the zombie window.
    this.unselectableFolders.clear();
    // Also drop the auth-pause flag (defensive — the 'connected' event
    // handler does this too, but a sync that ran during the zombie
    // window may have set it spuriously).
    this.authPaused = false;
    logger.info('forceReconnect: cleared body-fetch failure ledger + folder blacklist + auth-pause flag');

    // Pool's old connections are dead too — tear it down and let the
    // next sync rebuild it (or proactively rebuild here if the pool
    // is in use immediately by the caller).
    if (this.connectionPool && this.connectionManager.imapConfig) {
      try {
        await this.connectionPool.close();
      } catch (err) {
        logger.debug('forceReconnect: pool close error (ignored):', err);
      }
      try {
        await this.initializePool(this.connectionManager.imapConfig, {
          maxConnections: 4,
          connectionTimeout: 60000,
          idleTimeout: 120000,
        });
      } catch (err) {
        logger.warn('forceReconnect: pool re-init failed (sync will fall back to single connection):', err);
      }
    }
  }

  /**
   * Repair emails stored with an incomplete envelope — blank sender/subject or
   * a synthesized "<missing-...>" Message-ID, caused by an empty ENVELOPE at
   * ingest (e.g. a partial fetch during connection flapping). Incremental sync
   * skips these because their UID already exists, so they never self-heal.
   * This re-fetches each by UID and updates the display fields in place.
   * Returns the number of rows corrected. Best-effort: safe to fire-and-forget.
   */
  async repairIncompleteEmails(limit = 200): Promise<number> {
    if (!this.isConnected()) return 0;
    const incomplete = await this.storage.getIncompleteEmails(limit);
    if (incomplete.length === 0) return 0;

    const folders = await this.storage.getFolders();
    const pathById = new Map(folders.map((f) => [f.id, f.path]));

    // Group by folder so each folder is SELECTed once and its UIDs fetched in a
    // single batch.
    const byFolder = new Map<string, EmailRecord[]>();
    for (const email of incomplete) {
      const list = byFolder.get(email.folderId) ?? [];
      list.push(email);
      byFolder.set(email.folderId, list);
    }

    let repaired = 0;
    for (const [folderId, records] of byFolder) {
      const folderPath = pathById.get(folderId);
      if (!folderPath) continue;
      try {
        repaired += await this.repairFolderBatch(folderPath, records);
      } catch (error) {
        logger.warn(`Repair: folder ${folderPath} failed: ${(error as Error)?.message ?? error}`);
      }
    }
    logger.info(`Repair: corrected ${repaired}/${incomplete.length} incomplete emails`);
    return repaired;
  }

  private async repairFolderBatch(folderPath: string, records: EmailRecord[]): Promise<number> {
    const uids = records.map((r) => r.uid).filter((u) => u > 0);
    if (uids.length === 0) return 0;
    const byUid = new Map(records.map((r) => [r.uid, r]));

    const fetchViaClient = async (client: IIMAPClient) =>
      withFolderSelected(client, folderPath, () => client.fetchMessagesByUID(uids, {
        fetchHeaders: true,
        fetchBody: false,
        fetchBodyStructure: false,
      }));

    const messages = this.connectionPool?.isInitialized()
      ? await this.connectionPool.withConnection(fetchViaClient)
      : await fetchViaClient(this.connectionManager.client);

    let repaired = 0;
    for (const msg of messages) {
      const record = byUid.get(msg.uid);
      if (!record) continue;

      // Same decode/join logic as ingest — apply only the fields we actually
      // recovered so a still-empty re-fetch never blanks existing good data.
      const fields = mapEnvelopeFields(msg.envelope);
      const updates: Partial<EmailRecord> = {};
      if (fields.fromAddress) {
        updates.fromAddress = fields.fromAddress;
        updates.fromName = fields.fromName;
      }
      if (fields.subject) updates.subject = fields.subject;
      if (fields.toAddress) {
        updates.toAddress = fields.toAddress;
        updates.toNames = fields.toNames;
      }
      if (fields.ccAddress) {
        updates.ccAddress = fields.ccAddress;
        updates.ccNames = fields.ccNames;
      }
      if (fields.bccAddress) {
        updates.bccAddress = fields.bccAddress;
        updates.bccNames = fields.bccNames;
      }
      if (fields.replyTo) updates.replyTo = fields.replyTo;
      if (msg.envelope.date) updates.date = Math.floor(msg.envelope.date.getTime() / 1000);

      // Replace a synthesized id with the real Message-ID when the server now
      // provides one — but only if it doesn't collide with an existing row.
      if (
        record.messageId.startsWith('<missing-') &&
        msg.envelope.messageId &&
        !msg.envelope.messageId.startsWith('<missing-')
      ) {
        const clash = await this.storage.getEmailByMessageId(msg.envelope.messageId);
        if (!clash) updates.messageId = msg.envelope.messageId;
      }

      if (Object.keys(updates).length === 0) continue;
      await this.storage.updateEmail(record.id, updates);
      repaired++;
    }
    return repaired;
  }

  // ========== Sync ==========

  /**
   * Sync all folders
   */
  async syncAll(options: SyncEngineOptions = {}): Promise<void> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // Check if already syncing. isSyncing() auto-recovers from a
    // stuck "syncing" state (5min watchdog), so by the time this
    // check returns true the sync is genuinely running. Throw rather
    // than return silently — the previous silent-return surfaced in
    // the UI as "sync shows done but didn't actually sync anything"
    // (IPC handler returned {success: true} regardless).
    if (this.syncState.isSyncing()) {
      logger.warn('Sync already in progress — refusing duplicate request');
      throw new Error('Sync already in progress');
    }

    // Store progress callback
    this.onProgressCallback = opts.onProgress || null;

    try {
      // Ensure connection
      if (!await this.connectionManager.ensureConnection()) {
        throw new Error('Failed to connect to IMAP server');
      }

      // Use parallel sync if enabled and pool available
      if (opts.parallelSync && this.connectionPool?.isInitialized()) {
        await this.syncAllParallel(opts);
      } else {
        await this.syncAllSequential(opts);
      }

      // Drain move-back source reconciles collected during this sync. A Trash→Inbox
      // move (done offline / picked up by this sync) relinks the mail into Inbox but
      // leaves it tagged in Trash; Trash isn't in the sync rotation or live-monitored,
      // so reconcile the source folder(s) NOW — after the loop, never re-entrantly
      // (syncAll guards on isSyncing). refreshFolderFlags runs the deletion reconcile
      // (dropping the stale source membership) and reselects the monitored folder.
      if (this.pendingSourceReconcile.size > 0) {
        const sources = [...this.pendingSourceReconcile];
        this.pendingSourceReconcile.clear();
        for (const src of sources) {
          try {
            logger.info(`[SyncEngine] move-back source reconcile: ${src}`);
            await this.refreshFolderFlags(src);
          } catch (err) {
            logger.warn(`[SyncEngine] move-back source reconcile failed for ${src}: ${(err as Error).message}`);
          }
        }
      }
    } catch (error) {
      this.syncState.setError(error as Error);
      throw error;
    }
  }

  /**
   * Sequential sync (single connection)
   */
  private async syncAllSequential(options: SyncEngineOptions): Promise<void> {
    const client = this.connectionManager.client;

    // Get folder list
    const folders = await client.listFolders();
    await this.folderSyncer.syncFolderList(folders, this.storage);

    // Get selectable folders
    let selectableFolders = this.getSelectableFolders(folders);

    // Drop the duplicate names for a mailbox we already sync under another one.
    const collapsed = await this.collapseDuplicateMailboxes(selectableFolders);
    selectableFolders = collapsed.folders;

    // Filter to requested folders — through the alias map, so a request naming
    // a dropped duplicate syncs the mailbox it stands for instead of nothing.
    if (options.folders && options.folders.length > 0) {
      selectableFolders = this.filterFolders(
        selectableFolders,
        options.folders.map((path) => collapsed.aliases.get(path) ?? path),
      );
    }

    // Sort by priority
    selectableFolders = this.folderSyncer.sortFoldersByPriority(selectableFolders);

    // Start sync
    this.syncState.startSync(selectableFolders.map(f => f.path));
    this.syncDidMutateCounts = false;
    this.emitProgress();

    logger.info(`Syncing ${selectableFolders.length} folders: ${selectableFolders.map(f => f.path).join(', ')}`);

    const skipRecentMs = (options.skipRecentMinutes || 0) * 60 * 1000;

    for (const folder of selectableFolders) {
      // Check if sync was stopped
      if (!this.syncState.isSyncing()) {
        break;
      }

      // One folder lookup per iteration, reused by the policy + skip checks below.
      const storedFolder = await this.storage.getFolderByPath(folder.path);

      // Per-folder policy: a folder the user turned OFF is skipped entirely.
      if (!isFolderSyncEnabled(storedFolder)) {
        logger.info(`Skipping ${folder.path} — sync disabled for this folder`);
        this.syncState.completeFolder(folder.path);
        continue;
      }

      // Skip recently synced
      if (skipRecentMs > 0 && storedFolder?.lastSyncTime) {
        const timeSinceSync = Date.now() - storedFolder.lastSyncTime * 1000;
        if (timeSinceSync < skipRecentMs) {
          logger.info(`Skipping ${folder.path} - synced ${Math.round(timeSinceSync / 60000)} min ago`);
          this.syncState.completeFolder(folder.path);
          continue;
        }
      }

      // Skip unchanged
      if (options.skipUnchanged && storedFolder && !await this.folderSyncer.hasChanges(client, storedFolder)) {
        logger.info(`Skipping unchanged: ${folder.path}`);
        this.syncState.completeFolder(folder.path);
        continue;
      }

      // Sync folder — a per-folder syncMode overrides the global headers-only.
      await this.syncFolder(folder, { ...options, headersOnly: folderHeadersOnly(storedFolder, options.headersOnly ?? true) });
    }

    // Recalculate folder counts from local DB — only if the pass actually
    // changed something. A quiet poll (no new mail, no flag/deletion changes)
    // can't have moved any count, so the full-table scan would be pure waste
    // and, repeated per folder, the main-thread stall behind the beachball.
    if (this.syncDidMutateCounts) {
      await this.storage.recalculateFolderCounts();
    }

    this.syncState.completeSync(true);
    this.emitProgress();

    logger.info('Sync completed', {
      messagesProcessed: this.syncState.getStatus().messagesProcessed,
    });

    // Process pending operations
    if (!this.operationQueue.isEmpty) {
      await this.operationQueue.processQueue();
    }

    // Sync left the main client SELECTed on the last folder — restore
    // the realtime-monitored folder so IDLE keeps watching it
    await this.reselectMonitoredFolder();
  }

  /**
   * Parallel sync using connection pool
   */
  private async syncAllParallel(options: SyncEngineOptions): Promise<void> {
    if (!this.connectionPool?.isInitialized()) {
      logger.warn('Connection pool not available, falling back to sequential');
      await this.syncAllSequential(options);
      return;
    }

    // Get folder list
    const folders = await this.connectionPool.withConnection(client => client.listFolders());
    await this.folderSyncer.syncFolderList(folders, this.storage);

    // Get selectable folders
    let selectableFolders = this.getSelectableFolders(folders);

    const collapsed = await this.collapseDuplicateMailboxes(selectableFolders);
    selectableFolders = collapsed.folders;

    if (options.folders && options.folders.length > 0) {
      selectableFolders = this.filterFolders(
        selectableFolders,
        options.folders.map((path) => collapsed.aliases.get(path) ?? path),
      );
    }

    selectableFolders = this.folderSyncer.sortFoldersByPriority(selectableFolders);

    // Start sync
    this.syncState.startSync(selectableFolders.map(f => f.path));
    this.syncDidMutateCounts = false;
    this.emitProgress();

    const concurrency = Math.min(options.parallelConnections || 2, 2);
    logger.info(`Parallel sync: ${selectableFolders.length} folders with ${concurrency} connections`);

    // Filter folders to sync
    const skipRecentMs = (options.skipRecentMinutes || 0) * 60 * 1000;
    const foldersToSync: IMAPFolder[] = [];

    for (const folder of selectableFolders) {
      const storedFolder = await this.storage.getFolderByPath(folder.path);
      // Per-folder policy: a folder the user turned OFF is skipped entirely.
      if (!isFolderSyncEnabled(storedFolder)) {
        this.syncState.completeFolder(folder.path);
        continue;
      }
      if (skipRecentMs > 0 && storedFolder?.lastSyncTime) {
        const timeSinceSync = Date.now() - storedFolder.lastSyncTime * 1000;
        if (timeSinceSync < skipRecentMs) {
          this.syncState.completeFolder(folder.path);
          continue;
        }
      }
      foldersToSync.push(folder);
    }

    // Create sync tasks
    const tasks = foldersToSync.map(folder => async (client: IIMAPClient, touch?: () => void) => {
      try {
        const storedFolder = await this.storage.getFolderByPath(folder.path);

        // Skip unchanged check
        if (options.skipUnchanged && storedFolder && !await this.folderSyncer.hasChanges(client, storedFolder)) {
          this.syncState.completeFolder(folder.path);
          return;
        }

        // Sync — a per-folder syncMode overrides the global headers-only. `touch`
        // is the pool's stuck-eviction heartbeat: a big folder's flag/deletion
        // reconcile can hold this pooled connection past the 120s stuck timeout,
        // so thread it through so a progressing sync isn't reclaimed mid-run.
        const result = await this.folderSyncer.syncFolder(
          client,
          folder,
          this.storage,
          {
            fullSync: options.fullSync || false,
            maxMessages: options.maxMessages || 50,
            headersOnly: folderHeadersOnly(storedFolder, options.headersOnly !== false),
            flagsOnly: options.flagsOnly || false,
          },
          (processed, total) => {
            this.syncState.updateFolderProgress(folder.path, processed, total);
            this.emitProgress();
          },
          touch,
        );

        if (result.success) {
          this.noteCountMutation(result);
          this.syncState.completeFolder(folder.path);
        } else {
          this.syncState.setFolderError(folder.path, result.error || new Error('Sync failed'));
        }
      } catch (error) {
        logger.error(`Parallel sync error for ${folder.path}:`, error);
        this.syncState.setFolderError(folder.path, error as Error);
      }
    });

    // Execute in parallel
    await this.connectionPool.parallel(tasks, concurrency);

    // Recalculate folder counts from local DB — only when the pass actually
    // changed something (see syncAllSequential for the rationale).
    if (this.syncDidMutateCounts) {
      await this.storage.recalculateFolderCounts();
    }

    this.syncState.completeSync(true);
    this.emitProgress();

    logger.info('Parallel sync completed');

    // Process pending operations after parallel sync
    if (!this.operationQueue.isEmpty) {
      await this.operationQueue.processQueue();
    }

    // Queued ops run on the main client and move its SELECTed folder
    await this.reselectMonitoredFolder();
  }

  /**
   * Sync a single folder
   */
  private async syncFolder(folder: IMAPFolder, options: SyncEngineOptions): Promise<void> {
    const client = this.connectionManager.client;

    this.syncState.startFolder(folder.path);
    this.emitProgress();

    try {
      const result = await this.folderSyncer.syncFolder(
        client,
        folder,
        this.storage,
        {
          fullSync: options.fullSync || false,
          maxMessages: options.maxMessages || 50,
          headersOnly: options.headersOnly !== false,
          flagsOnly: options.flagsOnly || false,
        },
        (processed, total) => {
          this.syncState.updateFolderProgress(folder.path, processed, total);
          this.emitProgress();
        }
      );

      if (result.success) {
        this.noteCountMutation(result);
        this.syncState.completeFolder(folder.path);
      } else {
        this.syncState.setFolderError(folder.path, result.error || new Error('Sync failed'));
      }
    } catch (error) {
      if (this.connectionManager.isConnectionError(error)) {
        this.syncState.setError(new Error('Connection lost during sync'));
        throw error;
      }
      this.syncState.setFolderError(folder.path, error as Error);
    }
  }

  /**
   * Flip the per-sync dirty flag when a folder result shows the emails table
   * actually changed. Mirrors the realtime flag-sync gate: only inserts, flag
   * updates or deletions can move a folder count — a skipped/no-op batch cannot.
   */
  private noteCountMutation(result: Partial<FolderSyncResult>): void {
    if (
      (result.messagesInserted ?? 0) > 0 ||
      (result.flagsUpdated ?? 0) > 0 ||
      (result.deletedCount ?? 0) > 0
    ) {
      this.syncDidMutateCounts = true;
    }
  }

  // ========== Historical backfill (Phase 2) ==========

  /**
   * Fetch ONE bounded chunk of older mail for `folderPath`, paging downward by
   * UID (see FolderSyncer.backfillChunk). Driven by the background scheduler.
   *
   * YIELDS to live mail: bails while a foreground sync is running so backfill
   * never competes with new-mail processing. Prefers an ISOLATED pool connection
   * (leaves the primary's IDLE folder untouched); falls back to the primary
   * connection and re-selects the monitored folder afterwards. Returns null when
   * it couldn't run this tick (disconnected / syncing / error) so the scheduler
   * simply retries later.
   */
  /**
   * Repair Gmail folder membership for `folderPath` (labels only, no message
   * re-download). Mail synced from the All Mail superset before labels were
   * fetched is filed under All Mail alone, so it never appears in INBOX, Starred
   * or the user's own labels. Runs on the POOL so it can't contend with a
   * foreground sync. Returns null when it couldn't run.
   */
  async repairGmailLabels(folderPath: string): Promise<{ scanned: number; updated: number } | null> {
    if (!this.isConnected()) return null;
    const folder = await this.storage.getFolderByPath(folderPath);
    if (!folder) return null;
    try {
      if (this.connectionPool?.isInitialized()) {
        return await this.connectionPool.withConnection((client) =>
          this.messageProcessor.repairGmailLabels(client, folder, this.storage),
        );
      }
      if (this.isSyncing()) return null;   // share the primary socket politely
      const r = await this.messageProcessor.repairGmailLabels(
        this.connectionManager.client,
        folder,
        this.storage,
      );
      // The repair SELECTed another mailbox on the primary connection — put IDLE
      // back on the monitored folder.
      await this.reselectMonitoredFolder();
      return r;
    } catch (error) {
      logger.warn(`[GmailLabels] repair of ${folderPath} failed (isolated): ${(error as Error).message}`);
      return null;
    }
  }

  async backfillOlderChunk(
    folderPath: string,
  ): Promise<{ fetched: number; inserted: number; done: boolean } | null> {
    if (!this.isConnected()) return null;
    const folder = await this.storage.getFolderByPath(folderPath);
    if (!folder) return null;
    if (folder.backfillComplete) return { fetched: 0, inserted: 0, done: true };

    try {
      // Prefer the POOL: it isolates the backfill on its own socket so it runs even
      // while a foreground sync owns the primary + drives IDLE. Previously this method
      // bailed on engine-wide isSyncing() BEFORE this branch, so the pool routing was
      // dead code whenever a sync was in flight — and a constantly-syncing active
      // account never downloaded its history. Running on the pool (max 4; foreground
      // parallel caps at 2, leaving headroom) is what lets the full mailbox download.
      if (this.connectionPool?.isInitialized()) {
        const r = await this.connectionPool.withConnection((client) =>
          this.folderSyncer.backfillChunk(client, folder, this.storage),
        );
        return { fetched: r.fetched, inserted: r.inserted, done: r.done };
      }
      // No pool (e.g. background accounts): the backfill shares the single PRIMARY
      // socket, so it MUST yield to a foreground sync to avoid contending it.
      if (this.isSyncing()) return null;
      const r = await this.folderSyncer.backfillChunk(this.connectionManager.client, folder, this.storage);
      // Backfill SELECTed the target folder on the primary connection — restore
      // the monitored folder so IDLE keeps watching the right mailbox.
      await this.reselectMonitoredFolder();
      return { fetched: r.fetched, inserted: r.inserted, done: r.done };
    } catch (error) {
      if (this.connectionManager.isConnectionError(error)) {
        logger.warn(`Backfill ${folderPath}: connection lost — will retry next tick`);
      } else {
        logger.warn(`Backfill ${folderPath} failed: ${(error as Error).message}`);
      }
      return null;
    }
  }

  /**
   * Run the deferred FULL whole-folder deletion reconcile for `folderPath` (the
   * sweep Phase 1 skips on large mailboxes in the hot path). Background-only;
   * mirrors backfill's connection handling. Returns null when it couldn't run.
   */
  async reconcileFolderDeletionsFull(
    folderPath: string,
  ): Promise<{ updated: number; deleted: number } | null> {
    if (!this.isConnected()) return null;
    const folder = await this.storage.getFolderByPath(folderPath);
    if (!folder) return null;

    try {
      // Pool-isolated so it runs alongside a foreground sync (see backfillOlderChunk).
      if (this.connectionPool?.isInitialized()) {
        // Pass the pool's `touch` heartbeat through: on a big folder ([Gmail]/All
        // Mail) this whole-mailbox reconcile out-lasts the 120s stuck-eviction, so
        // without the heartbeat the pool reclaimed the connection mid-reconcile —
        // poisoning the socket and cascading into the connect-timeout back-off
        // storm. Mirrors doDrain below, which already threads touch.
        return await this.connectionPool.withConnection((client, touch) =>
          this.folderSyncer.reconcileDeletionsFull(client, folder, this.storage, touch),
        );
      }
      // No pool → shared primary socket → yield to a foreground sync.
      if (this.isSyncing()) return null;
      const r = await this.folderSyncer.reconcileDeletionsFull(this.connectionManager.client, folder, this.storage);
      await this.reselectMonitoredFolder();
      return r;
    } catch (error) {
      if (!this.connectionManager.isConnectionError(error)) {
        logger.warn(`Background deletion reconcile ${folderPath} failed: ${(error as Error).message}`);
      }
      return null;
    }
  }

  /**
   * Fast, pool-isolated drain of a folder's MISSING messages — the server holds UIDs the
   * DB lacks (count-capped initial sync, mid-range holes the downward-only backfill can't
   * fill, failed inserts). Computes the exact missing set ONCE per call (server UIDs −
   * local UIDs − in-flight ops), then fetches up to DRAIN_MAX_PER_CALL of them header-only
   * in DRAIN_FETCH_BATCH sub-batches (so no single FETCH times out on a slow server) and
   * inserts. Running on the POOL means it downloads back-to-back at server speed, not
   * throttled by the foreground sync cadence — the scheduler calls it repeatedly until
   * `remaining` hits 0. Returns null when it can't run (disconnected / no pool + syncing).
   */
  async drainFolderChunk(
    folderPath: string,
    maxPerCall = DRAIN_MAX_PER_CALL,
  ): Promise<{ inserted: number; remaining: number; done: boolean } | null> {
    if (!this.isConnected()) return null;
    const folder = await this.storage.getFolderByPath(folderPath);
    if (!folder) return null;
    if (typeof this.storage.getEmailUidsInFolder !== 'function') return null;

    const doDrain = async (client: IIMAPClient, touch?: () => void): Promise<{ inserted: number; remaining: number; done: boolean }> => {
      if (typeof client.fetchAllUIDs !== 'function') return { inserted: 0, remaining: 0, done: true };
      const serverUids = await withFolderSelected(client, folderPath, () => client.fetchAllUIDs!(folderPath));
      if (serverUids.length === 0) return { inserted: 0, remaining: 0, done: true };
      const localRows = await this.storage.getEmailUidsInFolder!(folder.id);
      const localSet = new Set(localRows.map((r) => r.uid));
      const pending = await this.operationQueue.getPendingUids(folderPath).catch(() => new Set<number>());
      const missing = serverUids
        .filter((u) => !localSet.has(u) && !pending.has(u))
        .sort((a, b) => a - b); // OLDEST missing first — the foreground addition-reconcile
                                // takes newest-first, so the two streams work opposite ends
                                // of the gap with no overlap (≈2× combined throughput).
      if (missing.length === 0) { this.drainTriedUids.delete(folderPath); return { inserted: 0, remaining: 0, done: true }; }

      // Tag-aware convergence (crucial for Gmail): a message can belong to a folder by
      // TAG without its primary folder_id being this folder — Gmail's "All Mail" superset
      // holds messages already stored under INBOX/labels, so they look folder_id-"missing"
      // but are already downloaded. Fetching them just re-links and never reduces the
      // folder_id gap. Gate the DECISION on the tag-based count (what the view shows):
      // when the folder is fully covered by tags, there's genuinely nothing to download.
      const serverExists = serverUids.length;
      let genuinelyMissing = missing.length;
      if (typeof this.storage.countEmailsWithFolderTag === 'function') {
        const tagCount = await this.storage.countEmailsWithFolderTag(folderPath).catch(() => null);
        if (typeof tagCount === 'number') genuinelyMissing = Math.max(0, serverExists - tagCount);
      }
      if (genuinelyMissing === 0) { this.drainTriedUids.delete(folderPath); return { inserted: 0, remaining: 0, done: true }; }

      // Exclude UIDs already fetched this session that made no folder_id progress
      // (present-elsewhere no-ops). Without this the oldest-first drain re-fetched
      // the SAME 300 no-ops every call, and — because it counted those relinks as
      // "progress" — computed remaining=0 and marked the folder `done`, skipping it
      // for the whole session while genuinely-missing newer holes never downloaded.
      const tried = this.drainTriedUids.get(folderPath) ?? new Set<number>();
      const drainable = missing.filter((u) => !tried.has(u));
      if (drainable.length === 0) {
        // Every candidate tried this session; the residual gap is present-elsewhere
        // or unresolvable here — the always-on full reconcile is the backstop. Done.
        return { inserted: 0, remaining: 0, done: true };
      }

      const toFetch = drainable.slice(0, maxPerCall);
      let inserted = 0;
      const accounted = new Set<number>();
      for (let i = 0; i < toFetch.length; i += DRAIN_FETCH_BATCH) {
        const sub = toFetch.slice(i, i + DRAIN_FETCH_BATCH);
        // Re-asserted per batch rather than held across the whole loop: each
        // FETCH is its own critical section, so the processBatch/storage work
        // between batches doesn't keep the primary's mailbox pinned away from
        // the IDLE folder for the length of a drain.
        const fetched = await withFolderSelected(client, folderPath, () => client.fetchMessagesByUID(sub, {
          fetchHeaders: true,
          fetchBody: false,          // header-only; bodies fetch lazily on open
          fetchBodyStructure: true,
        }));
        if (fetched.length > 0) {
          const r = await this.messageProcessor.processBatch(fetched, folder, this.storage, undefined, { quiet: true });
          inserted += r.inserted;
          // Mark tried ONLY the UIDs the server RETURNED and we ACCOUNTED FOR
          // (stored/matched/permanently-unprocessable) — never a transiently-errored
          // one. A requested UID the server DROPPED isn't in `fetched` at all, so it
          // stays untried and gets retried. Mirrors the addition-reconcile.
          const errored = new Set(r.erroredUids);
          for (const m of fetched) if (!errored.has(m.uid)) { accounted.add(m.uid); tried.add(m.uid); }
        }
        touch?.(); // progress heartbeat — keep stuck-eviction from reclaiming this connection mid-drain
      }
      if (tried.size > DRAIN_TRIED_CAP) tried.clear();
      this.drainTriedUids.set(folderPath, tried);

      // remaining = UNtried candidates left + any requested UID this call that was
      // NOT accounted for (server dropped it from a partial response, or it errored
      // transiently). `done` only when remaining is truly 0 — so a dropped/errored
      // UID keeps the drain coming back for it instead of being stranded, and a
      // batch of already-present no-ops never fakes completion. Newly-inserted UIDs
      // leave `missing` on the next call (they become primary here).
      const droppedThisCall = toFetch.length - accounted.size;
      const remaining = (drainable.length - toFetch.length) + droppedThisCall;
      return { inserted, remaining, done: remaining === 0 };
    };

    try {
      let result: { inserted: number; remaining: number; done: boolean };
      if (this.connectionPool?.isInitialized()) {
        result = await this.connectionPool.withConnection(doDrain);
      } else {
        // No pool → shared primary socket → yield to a foreground sync.
        if (this.isSyncing()) return null;
        result = await doDrain(this.connectionManager.client);
        await this.reselectMonitoredFolder();
      }
      if (result.inserted > 0) {
        try { await this.storage.recalculateFolderCounts([folderPath]); } catch { /* recount best-effort */ }
        logger.info(`Drain ${folderPath}: +${result.inserted} downloaded (${result.remaining} still missing)`);
      }
      return result;
    } catch (error) {
      if (!this.connectionManager.isConnectionError(error)) {
        logger.warn(`Drain ${folderPath} failed: ${(error as Error).message}`);
      }
      return null;
    }
  }

  /**
   * Server-side search — the escalation path behind the renderer's local-first
   * search. Runs an IMAP UID SEARCH in `folderPath`, then downloads (header-only)
   * the newest matches the local DB is MISSING, so the ordinary local search then
   * surfaces them. Returns a summary so the UI can say what it found.
   *
   * Deliberately reuses the drain's fetch→processBatch→recount path: message
   * mapping, persistence and FTS indexing are never re-implemented, and a re-run
   * is idempotent because processBatch upserts by message identity. Bounded on
   * purpose — at most `maxFetch` of the newest missing UIDs per call, fetched in
   * DRAIN_FETCH_BATCH sub-batches — so a query matching thousands of old mails
   * can't stall the event loop or hammer a slow server. Returns null when it
   * can't run (disconnected / no folder / no pool while a sync holds the socket).
   */
  async serverSearch(
    folderPath: string,
    criteria: SearchCriteria,
    options: { maxFetch?: number } = {},
  ): Promise<{ matched: number; alreadyLocal: number; inserted: number } | null> {
    if (!this.isConnected()) return null;
    const folder = await this.storage.getFolderByPath(folderPath);
    if (!folder) return null;

    const maxFetch = Math.max(1, options.maxFetch ?? SERVER_SEARCH_MAX_FETCH);

    const doSearch = async (
      client: IIMAPClient,
      touch?: () => void,
    ): Promise<{ matched: number; alreadyLocal: number; inserted: number }> => {
      const matchedUids = await withFolderSelected(client, folderPath, () => client.search(criteria));
      if (matchedUids.length === 0) return { matched: 0, alreadyLocal: 0, inserted: 0 };

      // UIDs the DB already holds are already searchable locally — never re-fetch
      // them; count them only so the UI can distinguish "found new mail" from
      // "everything matching was already here".
      let localSet = new Set<number>();
      if (typeof this.storage.getEmailUidsInFolder === 'function') {
        const localRows = await this.storage.getEmailUidsInFolder(folder.id).catch(() => []);
        localSet = new Set(localRows.map((r) => r.uid));
      }
      const alreadyLocal = matchedUids.filter((u) => localSet.has(u)).length;

      // Newest first (highest UID = the mail a user is most likely hunting for),
      // capped so a huge match set stays bounded.
      const missing = matchedUids
        .filter((u) => !localSet.has(u))
        .sort((first, second) => second - first)
        .slice(0, maxFetch);
      if (missing.length === 0) return { matched: matchedUids.length, alreadyLocal, inserted: 0 };

      let inserted = 0;
      for (let i = 0; i < missing.length; i += DRAIN_FETCH_BATCH) {
        const sub = missing.slice(i, i + DRAIN_FETCH_BATCH);
        // Re-asserted per batch (processBatch between batches is storage work
        // that must not pin the mailbox): these UIDs came from the SEARCH above
        // and mean something else entirely in any other folder.
        const fetched = await withFolderSelected(client, folderPath, () =>
          client.fetchMessagesByUID(sub, {
            fetchHeaders: true,
            fetchBody: false,          // header-only; bodies fetch lazily on open
            fetchBodyStructure: true,
          }));
        if (fetched.length > 0) {
          const result = await this.messageProcessor.processBatch(fetched, folder, this.storage, undefined, { quiet: true });
          inserted += result.inserted;
        }
        touch?.(); // heartbeat — keep stuck-eviction from reclaiming the connection mid-search
      }
      return { matched: matchedUids.length, alreadyLocal, inserted };
    };

    try {
      let result: { matched: number; alreadyLocal: number; inserted: number };
      if (this.connectionPool?.isInitialized()) {
        result = await this.connectionPool.withConnection(doSearch);
      } else {
        // No pool → shared primary socket → yield to a foreground sync.
        if (this.isSyncing()) return null;
        result = await doSearch(this.connectionManager.client);
        await this.reselectMonitoredFolder();
      }
      if (result.inserted > 0) {
        try { await this.storage.recalculateFolderCounts([folderPath]); } catch { /* recount best-effort */ }
        logger.info(`Server search ${folderPath}: matched ${result.matched}, +${result.inserted} downloaded`);
      }
      return result;
    } catch (error) {
      if (!this.connectionManager.isConnectionError(error)) {
        logger.warn(`Server search ${folderPath} failed: ${(error as Error).message}`);
      }
      return null;
    }
  }

  /**
   * Header-only classify: of `uids` in `folderPath`, return the subset that are
   * bulk/list mail (List-Id / List-Unsubscribe / Precedence — computed at fetch by
   * the client's detectBulk). Powers the one-time bulk backfill that tags already-
   * stored mail so threading treats old and new mail identically. Runs ONLY on a
   * pool connection (isolated — no IDLE/selection race); when no pool is available
   * it returns empty so the caller retries later. Header-only, far cheaper than a
   * body fetch.
   */
  async classifyBulkUids(folderPath: string, uids: number[]): Promise<Set<number>> {
    const bulk = new Set<number>();
    if (!this.isConnected() || uids.length === 0) return bulk;
    if (!this.connectionPool?.isInitialized()) return bulk; // pool-only for safety
    const doFetch = async (client: IIMAPClient): Promise<Set<number>> => {
      const msgs = await withFolderSelected(client, folderPath, () => client.fetchMessagesByUID(uids, {
        fetchHeaders: true,
        fetchBody: false,
        fetchBodyStructure: false,
      }));
      const set = new Set<number>();
      for (const m of msgs) if (m.isBulk && typeof m.uid === 'number') set.add(m.uid);
      return set;
    };
    try {
      return await this.connectionPool.withConnection(doFetch);
    } catch (error) {
      if (!this.connectionManager.isConnectionError(error)) {
        logger.warn(`[BulkBackfill] classify ${folderPath} failed: ${(error as Error).message}`);
      }
      return bulk;
    }
  }

  /**
   * Re-fetch the HEADERS of a set of UIDs in one folder — no body.
   *
   * Powers the header backfill. Two columns depend on it and both were added
   * after mail had already been synced: `auth_status` (a message with none
   * reads "Unverified" whatever the server actually recorded) and the spam
   * filter's `spam_score`. One fetch answers both, because a headers-only
   * FETCH already returns the envelope, the raw header block and INTERNALDATE
   * — every input `headerStage` needs. A few hundred bytes per message.
   *
   * Returns the whole message rather than one extracted field precisely so a
   * third column added later costs no new round-trip and no new method.
   *
   * Same isolation rules as classifyBulkUids: runs ONLY on a pool connection
   * (no IDLE/selection race with the primary), and returns an empty map when no
   * pool is available so the caller simply retries later.
   *
   * @returns uid → the fetched message. A uid ABSENT from the map was not
   *   returned by the server this time (connection trouble, or expunged) and
   *   must stay NULL for the next pass. A uid PRESENT whose `authHeaders` is
   *   undefined is a real answer: the server recorded no verdict.
   */
  async fetchHeaderMessages(folderPath: string, uids: number[]): Promise<Map<number, IMAPMessage>> {
    const out = new Map<number, IMAPMessage>();
    if (!this.isConnected() || uids.length === 0) return out;
    if (!this.connectionPool?.isInitialized()) return out; // pool-only for safety
    const doFetch = async (client: IIMAPClient): Promise<Map<number, IMAPMessage>> => {
      const msgs = await withFolderSelected(client, folderPath, () => client.fetchMessagesByUID(uids, {
        fetchHeaders: true,
        fetchBody: false,
        fetchBodyStructure: false,
      }));
      const map = new Map<number, IMAPMessage>();
      for (const m of msgs) if (typeof m.uid === 'number') map.set(m.uid, m);
      return map;
    };
    try {
      return await this.connectionPool.withConnection(doFetch);
    } catch (error) {
      if (!this.connectionManager.isConnectionError(error)) {
        logger.warn(`[HeaderBackfill] fetch ${folderPath} failed: ${(error as Error).message}`);
      }
      return out;
    }
  }

  // ========== Real-time ==========

  /**
   * Start real-time monitoring
   */
  async startRealTime(folderPath: string = 'INBOX'): Promise<RealtimeMode> {
    // Wait for the connection to be usable before starting monitoring. At cold
    // start this is often called while connect() is still handshaking, and
    // issuing IDLE mid-handshake throws "Connection not available", dropping
    // realtime to 'none' with no reliable re-arm. Waiting lets the first start
    // succeed, so IDLE comes up on launch (and re-arms on later reconnects).
    if (!this.connectionManager.isConnected()) {
      const ready = await this.connectionManager.waitUntilConnected();
      if (!ready) {
        logger.warn('Realtime: connection not ready — monitoring not started');
        return 'none';
      }
    }
    return this.realtimeManager.start(folderPath);
  }

  /**
   * Stop real-time monitoring
   */
  async stopRealTime(): Promise<void> {
    await this.realtimeManager.stop();
  }

  /**
   * Lightweight per-folder STATUS (UNSEEN/UIDNEXT/…) — a count query, NOT a
   * message download. Used by the multi-account background sweep to detect unread
   * in non-inbox folders (skip-inbox filters/labels) without a full sync.
   */
  async getFolderStatus(folderPath: string): Promise<{ uidNext: number; messages: number; uidValidity: number; unseen: number; highestModseq?: number }> {
    return this.connectionManager.client.getFolderStatus(folderPath);
  }

  /**
   * Check if real-time is active
   */
  isRealTimeActive(): boolean {
    return this.realtimeManager.isActive();
  }

  /**
   * Get real-time mode
   */
  getRealTimeMode(): RealtimeMode {
    return this.realtimeManager.getMode();
  }

  /**
   * Re-select the realtime-monitored folder on the main client. Folder
   * operations (sequential sync, flag refresh, queued ops) leave the
   * connection SELECTed on the last folder they touched, which silently
   * breaks IDLE monitoring — IDLE only watches the selected mailbox.
   */
  private async reselectMonitoredFolder(): Promise<void> {
    const folder = this.realtimeManager.getMonitoredFolder();
    if (!folder || this.realtimeManager.getMode() !== 'idle') return;
    if (!this.connectionManager.isConnected()) return;
    try {
      await this.connectionManager.client.selectFolder(folder);
    } catch (err) {
      logger.debug('Re-select of monitored folder failed (ignored):', err);
    }
  }

  /**
   * Handle realtime event
   */
  private handleRealtimeEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'new':
        if (event.emailId) {
          this.syncState.emitNewEmail(event.emailId, event.folderPath);
        }
        break;
      case 'flagsChanged':
        if (event.emailId && event.flags) {
          this.syncState.emitEmailUpdated(event.emailId, event.folderPath, ['flags']);
        }
        break;
      case 'deleted':
        if (event.emailId) {
          this.syncState.emitEmailDeleted(event.emailId, event.folderPath);
        }
        break;
    }
  }

  // ========== Email Operations ==========

  /**
   * Re-arm all dead-lettered ('failed') IMAP operations and drain the queue.
   * Returns how many were re-armed. Used by the failure-surface retry action.
   */
  async retryFailedOperations(): Promise<number> {
    const count = await this.operationQueue.retryFailed();
    if (count > 0 && this.isConnected() && !this.operationQueue.isEmpty) {
      await this.operationQueue.processQueue();
    }
    return count;
  }

  /**
   * Re-arm a single dead-lettered operation and drain. Returns false if the id
   * was no longer among the failed operations.
   */
  async retryFailedOperation(id: number): Promise<boolean> {
    const ok = await this.operationQueue.retryFailedOne(id);
    if (ok && this.isConnected() && !this.operationQueue.isEmpty) {
      await this.operationQueue.processQueue();
    }
    return ok;
  }

  /**
   * Mark as read (with boolean toggle for compatibility)
   */
  async markAsRead(folderPath: string, uid: number, read: boolean = true): Promise<OperationResult> {
    if (read) {
      return this.operationQueue.markAsRead(folderPath, uid);
    } else {
      return this.operationQueue.markAsUnread(folderPath, uid);
    }
  }

  /**
   * Mark as unread
   */
  async markAsUnread(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.markAsUnread(folderPath, uid);
  }

  /**
   * Mark as starred (with boolean toggle for compatibility)
   */
  async markAsStarred(folderPath: string, uid: number, starred: boolean = true): Promise<OperationResult> {
    if (starred) {
      return this.operationQueue.star(folderPath, uid);
    } else {
      return this.operationQueue.unstar(folderPath, uid);
    }
  }

  /**
   * Star email
   */
  async star(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.star(folderPath, uid);
  }

  /**
   * Unstar email
   */
  async unstar(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.unstar(folderPath, uid);
  }

  /**
   * Move to folder
   */
  async move(sourcePath: string, uid: number, destPath: string): Promise<OperationResult> {
    return this.operationQueue.move(sourcePath, uid, destPath);
  }

  /**
   * Copy to folder (source copy stays; message ends up in BOTH folders).
   */
  async copy(sourcePath: string, uid: number, destPath: string): Promise<OperationResult> {
    return this.operationQueue.copy(sourcePath, uid, destPath);
  }

  /** Bulk copy many UIDs to a destination folder in one IMAP COPY. */
  async bulkCopy(sourcePath: string, uids: number[], destPath: string): Promise<OperationResult> {
    return this.operationQueue.bulkCopy(sourcePath, uids, destPath);
  }

  /**
   * Move to trash
   */
  async moveToTrash(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.moveToTrash(folderPath, uid);
  }

  /**
   * Move to spam
   */
  async moveToSpam(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.moveToSpam(folderPath, uid);
  }

  /**
   * Archive
   */
  async archive(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.archive(folderPath, uid);
  }

  /**
   * Delete permanently
   */
  async deleteEmail(folderPath: string, uid: number): Promise<OperationResult> {
    return this.operationQueue.delete(folderPath, uid);
  }

  // ========== Bulk Operations ==========

  async bulkMarkAsRead(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkMarkAsRead(folderPath, uids);
  }

  async bulkMarkAsUnread(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkMarkAsUnread(folderPath, uids);
  }

  async bulkStar(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkStar(folderPath, uids);
  }

  async bulkUnstar(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkUnstar(folderPath, uids);
  }

  async bulkMoveToTrash(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkMoveToTrash(folderPath, uids);
  }

  async bulkMoveToSpam(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkMoveToSpam(folderPath, uids);
  }

  async bulkMove(sourcePath: string, uids: number[], destPath: string): Promise<OperationResult> {
    return this.operationQueue.bulkMove(sourcePath, uids, destPath);
  }

  async bulkArchive(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkArchive(folderPath, uids);
  }

  async bulkDelete(folderPath: string, uids: number[]): Promise<OperationResult> {
    return this.operationQueue.bulkDelete(folderPath, uids);
  }

  // ========== Body Fetching ==========

  /**
   * Fetch email body on-demand
   */
  async fetchBody(
    emailId: string,
    folderPath: string,
    uid: number,
    opts?: { onStart?: () => void }
  ): Promise<{ rawBody: string; cleanBody: string; contentType: string; source: string } | null> {
    // Skip emails that have failed too many times (e.g. persistent timeout).
    // DEFERRED, not a verdict: these strikes were counted for timeouts and
    // connection errors, which say nothing about whether the message exists.
    // Resolving null here told the scheduler "the server has no such message"
    // and got good mail tagged `|nobody|`. The ledger entry expires
    // (BODY_FETCH_FAILURE_TTL_MS), so the skip is a cool-down, not a blacklist.
    const failures = this.bodyFetchFailures.get(emailId) || 0;
    if (failures >= this.MAX_BODY_FETCH_RETRIES) {
      logger.warn(`Body fetch skipped for ${emailId} — failed ${failures} times previously, cooling down`);
      throw createDeferredFetchError(`${failures} prior failures`);
    }

    // Folder can't be SELECTed on this server (e.g. an unsubscribed [Gmail]/*
    // duplicate) — don't queue, it would just fail and churn connections. Also
    // DEFERRED: a `NO SELECT` is very often the server being busy, and this is
    // FOLDER-level, so resolving null marked every email in it un-fetchable.
    if (this.unselectableFolders.has(folderPath)) {
      throw createDeferredFetchError(`folder "${folderPath}" would not open`);
    }

    // Auth-paused: credentials known bad. Don't queue — surface the
    // failure immediately so the caller / UI can show an auth banner
    // rather than spin forever waiting on a queue that will never run.
    if (this.authPaused) {
      const err = new Error('IMAP authentication failed — please re-enter your account credentials');
      (err as Error & { code?: string }).code = 'AUTH_PAUSED';
      throw err;
    }

    // Check for existing request — add listener so all callers get notified.
    // O(1) via the dedup index (mirrors the queue array).
    const existing = this.bodyFetchQueueIndex.get(emailId);
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.listeners.push({ resolve, reject });
        // This caller is waiting on the SAME queued item, so it must be told
        // when that item starts too — otherwise a coalesced request keeps the
        // enqueue-time deadline the coalescing was supposed to spare it.
        if (opts?.onStart) existing.onStart.push(opts.onStart);
      });
    }

    // Enforce queue limit — drop from back (least recently added) to make room
    while (this.bodyFetchQueue.length >= this.MAX_BODY_FETCH_QUEUE) {
      const dropped = this.bodyFetchQueue.pop();
      if (dropped) {
        this.unindexBodyFetch(dropped);
        for (const l of dropped.listeners) l.reject(new Error('Queue full'));
        dropped.listeners.length = 0;
      }
    }

    return new Promise((resolve, reject) => {
      // Add to front of queue so user-initiated fetches get priority
      const item: BodyFetchItem = {
        emailId,
        folderPath,
        uid,
        listeners: [{ resolve, reject }],
        onStart: opts?.onStart ? [opts.onStart] : [],
      };
      this.bodyFetchQueue.unshift(item);
      this.indexBodyFetch(item);
      this.processBodyFetchQueue();
    });
  }

  /**
   * Process body fetch queue — fetches multiple bodies in parallel using pool connections
   */
  /**
   * Schedule a single deferred restart of the body-fetch drain after `delayMs`.
   * Shared by the throttle/quota back-off and the connection-cap park so both
   * back-off paths coalesce to ONE pending resume (a second call while a timer is
   * already armed is a no-op — the queue is drained once when it fires).
   */
  private scheduleBodyFetchResume(delayMs: number): void {
    if (this.bodyFetchResumeTimer) return;
    this.bodyFetchResumeTimer = setTimeout(() => {
      this.bodyFetchResumeTimer = null;
      this.processBodyFetchQueue();
    }, delayMs);
  }

  private async processBodyFetchQueue(): Promise<void> {
    if (this.bodyFetchInProgress || this.bodyFetchStopped) return;
    // Parked on the shared connection-cap back-off: draining now only refuses
    // every item against the closed gate (the log flood + wasted retry budget we
    // saw once the connect-timeout park started engaging). Skip SILENTLY — no
    // per-call log, so a burst of new requestBodyFetch() calls during the window
    // can't re-flood it. The resume timer restarts the drain when the window ends;
    // this live check also lets a new request resume the instant the gate reopens
    // (e.g. a successful connect on another path cleared the park early).
    if ((this.connectionPool?.remainingParkMs() ?? 0) > 0) return;

    // Disconnected: the reconnect handler resumes the queue (it fires the resume
    // path on 'connected'), so pause here. Log only on the TRANSITION into the
    // waiting state — not on every re-entry — or a re-requesting pipeline floods
    // the log with identical lines while the socket is down.
    if (!this.isConnected()) {
      if (!this.bodyFetchWaitingForReconnect) {
        this.bodyFetchWaitingForReconnect = true;
        logger.info(`Body fetch queue paused (${this.bodyFetchQueue.length} pending) - waiting for reconnect`);
      }
      return;
    }
    // Connected again — clear the latch so the next disconnect logs once more.
    this.bodyFetchWaitingForReconnect = false;

    this.bodyFetchInProgress = true;
    // Use up to 4 concurrent fetches when pool is available, otherwise 1
    const concurrency = this.connectionPool?.isInitialized() ? 4 : 1;

    try {
      while (this.bodyFetchQueue.length > 0) {
        // A disconnect can also land MID-drain (between batches). Stop silently —
        // the top-of-function latch already logged this episode, and the reconnect
        // handler will resume — so we don't re-log per batch.
        if (!this.isConnected()) {
          this.bodyFetchWaitingForReconnect = true;
          break;
        }

        // Take up to `concurrency` items from queue. They leave the array, so
        // drop them from the dedup index too — a request arriving while they're
        // in flight creates a fresh entry (matches the pre-index behavior).
        const batch = this.bodyFetchQueue.splice(0, concurrency);
        for (const item of batch) {
          this.unindexBodyFetch(item);
          this.signalBodyFetchStarted(item);
        }

        const promises = batch.map(async (item) => {
          try {
            let result: { rawBody: string; cleanBody: string; contentType: string; source: string } | null;

            // A body fetch downloads a whole RFC822 message, so its duration is
            // a function of the message's SIZE — which means it cannot be given
            // a flat budget. The old fixed 30s one declared any message slower
            // than that broken, and since each retry restarted the download from
            // byte zero it failed at exactly the same point every time, burned a
            // poisoned pool connection per attempt, and after MAX_BODY_FETCH_RETRIES
            // retired perfectly good mail as un-fetchable. Time the STALL instead:
            // 30s with nothing arriving is still a dead socket, but a transfer
            // that keeps delivering bytes is allowed to finish, up to a hard
            // ceiling so nothing can hold a connection forever.
            const fetchWithStallTimeout = (client: IIMAPClient, touch?: () => void) =>
              withStallTimeout(
                this.messageProcessor.fetchBody(client, item.folderPath, item.uid, this.storage, item.emailId),
                {
                  stallMs: BODY_FETCH_STALL_TIMEOUT,
                  maxMs: BODY_FETCH_MAX_TIMEOUT,
                  // Per-CONNECTION byte counter. Exact on a pooled connection,
                  // which serves this fetch alone; on the shared primary client
                  // (no pool) other traffic on the same socket can also read as
                  // progress. That only ever delays a give-up, never causes a
                  // premature one, and maxMs still bounds it.
                  progress: () => client.bytesReceived?.() ?? Number.NaN,
                  // Refresh the pool's stuck-connection clock while bytes are
                  // arriving, or a download legitimately running past
                  // STUCK_CONNECTION_TIMEOUT would be evicted mid-transfer.
                  onProgress: touch,
                  message: 'Body fetch timeout',
                },
              );

            if (this.connectionPool?.isInitialized()) {
              // Use withConnection for automatic release (even on timeout/error)
              result = await this.connectionPool.withConnection(fetchWithStallTimeout);
            } else {
              result = await fetchWithStallTimeout(this.connectionManager.client);
            }

            // A null result is NOT success — fetchBody returns null when the
            // message could not be identified or carried no body. Logging it as
            // "completed" made a permanently-unloadable email look healthy in
            // the log while the UI sat on "Unable to load email content".
            if (result) {
              // Per-body routine detail — debug (off in release 'info'), so a
              // bulk body-prefetch drain doesn't fill app.log with one line each.
              logger.debug(`Body fetch completed: ${item.emailId}`);
              // Body is now in the DB — tell the pipeline to categorize NOW rather
              // than wait for the 30s poll. Best-effort; the poll is the fallback.
              try { getEventBus().emit(createEvent.emailBodyReady(item.emailId)); } catch { /* non-fatal */ }
            } else {
              logger.trace(`Body fetch returned no body: ${item.emailId} (UID ${item.uid} in ${item.folderPath})`);
            }
            this.bodyFetchFailures.delete(item.emailId); // Clear failure count on success
            // The FETCH round-tripped (a body, or a definitive "no body" verdict)
            // — proof the socket is alive. From here a timeout is the message's
            // fault, so timeouts may start accruing give-up strikes.
            this.bodyFetchSuccessesSinceReconnect++;
            if (result?.source) this.setRawSourceCache(item.emailId, result.source);
            for (const l of item.listeners) l.resolve(result);
            item.listeners.length = 0; // Release listener references
          } catch (error) {
            // Auth failure: credentials are bad / expired. Retrying
            // just hammers Gmail and will get the IP rate-limited or
            // temporarily blocked. Mark ALL queued fetches as failed
            // immediately and pause the queue — caller / UI surface
            // surfaces the auth error so the user can re-enter creds.
            if (this.connectionManager.isAuthError(error)) {
              logger.error(`Body fetch auth failure for ${item.emailId} — pausing queue, all retries cancelled until credentials are re-entered`);
              this.authPaused = true;
              // Reject this item and every other pending item with the
              // same auth error so callers don't sit waiting forever.
              for (const l of item.listeners) l.reject(error);
              item.listeners.length = 0;
              const remaining = this.bodyFetchQueue.splice(0);
              for (const other of remaining) {
                this.unindexBodyFetch(other);
                for (const l of other.listeners) l.reject(error);
                other.listeners.length = 0;
              }
              return 'auth_error';
            }
            // Shared connection-cap back-off closed the gate mid-batch (a connect
            // just timed out / hit the cap and parked the account). This is NOT a
            // failure and NOT this message's fault: re-queue to the BACK with no
            // strike and signal the batch to pause. Must be caught BEFORE the
            // generic branch below — its "Connection pool parked" message matches
            // none of the classifiers, so it would otherwise be counted as a retry
            // and its listeners REJECTED, burning good mail's budget and logging
            // one WARN per item (the parked-drain log flood).
            if (error instanceof PoolConnectionParkedError) {
              this.requeueBodyFetch(item, true /* toBack */);
              return 'parked';
            }
            // Rate-limit / quota: the server is telling us to slow down (Gmail
            // connection cap, or a throttle carrying a suggested backoff). Do
            // NOT count toward per-email retries and do NOT keep hammering —
            // re-queue the item, pause the queue, and resume after the
            // server-suggested (or default) backoff, with jitter.
            if (this.connectionManager.isRateLimited(error) || this.connectionManager.isQuotaError(error)) {
              const base = Math.min(getSuggestedBackoffMs(error) ?? 60_000, 5 * 60_000);
              const backoff = Math.round(base * (0.75 + Math.random() * 0.5));
              logger.warn(`Body fetch throttled/quota for ${item.emailId} — backing off ${backoff}ms (not counted as failure): ${(error as Error)?.message ?? error}`);
              this.requeueBodyFetch(item);
              this.scheduleBodyFetchResume(backoff);
              return 'rate_limited';
            }
            // A per-operation body-fetch TIMEOUT is NOT a dead socket. The pool
            // has already poisoned & discarded the one stalled connection (see
            // ConnectionPool.withConnection), and a fresh one is available for
            // the next item. Crucially it must be handled BEFORE isConnectionError
            // — which also matches "timeout" in the message — because the old
            // path re-queued the item at the HEAD with NO retry increment and
            // BROKE the whole drain loop, so one poison-pill message (a large or
            // pipeline-corrupting body) blocked the queue head forever, poisoning
            // a fresh connection every tick and starving all 25k messages behind
            // it (the reported "bodies never download"). Instead: COUNT it toward
            // the retry cap, re-queue to the BACK so the rest keeps draining, and
            // after MAX give a VERDICT (resolve null) so the caller/scheduler can
            // move on and eventually tag it un-fetchable.
            if (isTimeoutError(error)) {
              // Only hold a timeout against the MESSAGE once the pipe has proven
              // healthy since the last reconnect. Until a fetch has come back,
              // this may be a zombie socket where everything hangs — retry
              // without a strike so a dead connection can't blacklist good mail.
              if (this.bodyFetchSuccessesSinceReconnect > 0) {
                const count = (this.bodyFetchFailures.get(item.emailId) || 0) + 1;
                this.bodyFetchFailures.set(item.emailId, count);
                if (count >= this.MAX_BODY_FETCH_RETRIES) {
                  // Stop retrying (the queue must not churn on a poison pill),
                  // but REJECT rather than resolve null. N timeouts is evidence
                  // about throughput, not about whether the message exists —
                  // resolving null here handed the scheduler a fake verdict and
                  // was one of the two paths that tagged live mail `|nobody|`.
                  logger.warn(`Body fetch timed out ${count}x for ${item.emailId} — deferring (UID ${item.uid} in ${item.folderPath})`);
                  const deferred = createDeferredFetchError(`${count} consecutive timeouts`);
                  for (const l of item.listeners) l.reject(deferred);
                  item.listeners.length = 0;
                  return 'ok';
                }
                logger.warn(`Body fetch timeout for ${item.emailId} (attempt ${count}/${this.MAX_BODY_FETCH_RETRIES}) — re-queuing to back`);
              } else {
                logger.warn(`Body fetch timeout for ${item.emailId} — no successful fetch since reconnect yet, retrying without a strike`);
              }
              this.requeueBodyFetch(item, true /* toBack: don't block the queue head */);
              return 'ok'; // keep draining — the stalled connection was already discarded
            }
            if (this.connectionManager.isConnectionError(error)) {
              logger.warn(`Body fetch connection error for ${item.emailId}, re-queuing`);
              this.requeueBodyFetch(item);
              return 'connection_error';
            }
            // Folder-level SELECT rejection: the server won't open this folder
            // (e.g. an unselectable [Gmail]/* duplicate). Retrying every message
            // on it just churns. Blacklist the folder and drop all its queued
            // items so we stop hammering.
            if ((error as { code?: string })?.code === 'SELECT_FOLDER_ERROR') {
              if (!this.unselectableFolders.has(item.folderPath)) {
                this.unselectableFolders.set(item.folderPath, true);
                logger.warn(`Body fetch: folder "${item.folderPath}" would not open — skipping its body fetches for ${UNSELECTABLE_FOLDER_TTL_MS / 60_000}m (${(error as Error)?.message ?? error})`);
              }
              // Everyone waiting on this folder is told DEFERRED, not handed the
              // raw server error: a `NO SELECT` says nothing about any single
              // message, and some servers word it in a way the renderer reads as
              // "gone from the server" ("mailbox not found"). One folder-level
              // hiccup must not be re-broadcast as a per-message verdict.
              const deferred = createDeferredFetchError(`folder "${item.folderPath}" would not open`);
              for (const l of item.listeners) l.reject(deferred);
              item.listeners.length = 0;
              for (let i = this.bodyFetchQueue.length - 1; i >= 0; i--) {
                if (this.bodyFetchQueue[i].folderPath === item.folderPath) {
                  const [dropped] = this.bodyFetchQueue.splice(i, 1);
                  this.unindexBodyFetch(dropped);
                  for (const l of dropped.listeners) l.reject(deferred);
                  dropped.listeners.length = 0;
                }
              }
              return 'ok';
            }
            // Track failures for timeout/other errors
            const count = (this.bodyFetchFailures.get(item.emailId) || 0) + 1;
            // lru-cache caps size and evicts the least-recently-used entry.
            this.bodyFetchFailures.set(item.emailId, count);
            logger.warn(`Body fetch failed for ${item.emailId} (attempt ${count}/${this.MAX_BODY_FETCH_RETRIES}): ${(error as Error)?.message ?? error}`);
            for (const l of item.listeners) l.reject(error);
            item.listeners.length = 0; // Release listener references
          }
          return 'ok';
        });

        const results = await Promise.all(promises);

        // Parked on the connection-cap back-off: stop draining for the whole park
        // window (one summary line, not one per queued item) and let the resume
        // timer restart it. +1s so the gate is definitely open when we retry.
        if (results.includes('parked')) {
          const parkedMs = this.connectionPool?.remainingParkMs() ?? 0;
          logger.info(`Body fetch queue paused (${this.bodyFetchQueue.length} pending) — connection-cap back-off, resuming in ${Math.round(parkedMs / 1000)}s`);
          this.scheduleBodyFetchResume(parkedMs + 1000);
          break;
        }
        // Throttled/quota-limited: stop draining now; the resume timer will
        // restart the queue after the backoff window.
        if (results.includes('rate_limited')) {
          break;
        }
        // If any had connection errors, pause queue
        if (results.includes('connection_error')) {
          break;
        }
        // If auth failed, the queue has been drained + all listeners
        // rejected — exit the loop. Stays paused until the user
        // re-enters credentials (clears via resumeBodyFetchQueue()).
        if (results.includes('auth_error')) {
          break;
        }
      }
    } finally {
      this.bodyFetchInProgress = false;
    }
  }

  /**
   * Clear the auth-paused flag — call after the user re-enters
   * credentials and the connection re-authenticates successfully.
   * Re-trigger queue processing so any newly-queued fetches run.
   */
  resumeBodyFetchQueue(): void {
    if (!this.authPaused) return;
    logger.info('Body fetch queue: auth-pause cleared, resuming');
    this.authPaused = false;
    // Best-effort: kick the queue. Caller usually queued nothing while
    // paused (failures returned synchronously) so this is mostly a
    // safety net for any items that snuck in.
    if (this.bodyFetchQueue.length > 0) this.processBodyFetchQueue();
  }

  /** Register an item in the O(1) dedup index (last write wins for an emailId). */
  private indexBodyFetch(item: BodyFetchItem): void {
    this.bodyFetchQueueIndex.set(item.emailId, item);
  }

  /**
   * Re-queue an in-flight item after a retryable error. If a concurrent
   * request enqueued a FRESH item for the same emailId while this one was in
   * flight, merge this item's listeners into that live entry instead of adding
   * a second queue entry — otherwise both would be fetched, wasting one IMAP
   * round-trip. When there's no live duplicate, just put it back at the front.
   */
  private requeueBodyFetch(item: BodyFetchItem, toBack = false): void {
    // Queue torn down (disconnect/shutdown) — do NOT re-add (that resurrects a
    // just-cleared queue into a retry loop). Fail the waiters and stop.
    if (this.bodyFetchStopped) {
      for (const l of item.listeners) l.reject(new Error('Disconnected'));
      item.listeners.length = 0;
      return;
    }
    const existing = this.bodyFetchQueueIndex.get(item.emailId);
    if (existing && existing !== item) {
      existing.listeners.push(...item.listeners);
      existing.onStart.push(...item.onStart);
      item.listeners.length = 0;
      item.onStart.length = 0;
      return;
    }
    // Head by default (user-initiated retries keep priority); BACK for a
    // timed-out item so a slow/poison-pill body can't block everything queued
    // behind it — the rest drains first and the retry comes around after.
    if (toBack) this.bodyFetchQueue.push(item);
    else this.bodyFetchQueue.unshift(item);
    this.indexBodyFetch(item);
  }

  /**
   * Tell everyone waiting on this item that its FETCH is starting now. Fired at
   * the dequeue point so a caller's deadline covers the fetch, not the wait for
   * a turn. Callbacks are dropped after firing (one signal per item) and each is
   * isolated: a throwing listener must not abort the drain of the whole batch.
   */
  private signalBodyFetchStarted(item: BodyFetchItem): void {
    if (item.onStart.length === 0) return;
    const callbacks = item.onStart.splice(0, item.onStart.length);
    for (const cb of callbacks) {
      try { cb(); } catch { /* a caller's own bookkeeping must not break the drain */ }
    }
  }

  /**
   * Remove an item from the dedup index, but only if the index still points to
   * THIS exact item — a newer duplicate for the same emailId must keep its slot.
   */
  private unindexBodyFetch(item: BodyFetchItem): void {
    if (this.bodyFetchQueueIndex.get(item.emailId) === item) {
      this.bodyFetchQueueIndex.delete(item.emailId);
    }
  }

  /**
   * Clear body fetch queue
   */
  private clearBodyFetchQueue(): void {
    // Latch the queue closed so an in-flight fetch that errors after this (on the
    // socket we're about to close) can't requeue itself and resurrect the queue.
    this.bodyFetchStopped = true;
    const queue = this.bodyFetchQueue;
    this.bodyFetchQueue = [];
    this.bodyFetchQueueIndex.clear();
    for (const item of queue) {
      for (const l of item.listeners) l.reject(new Error('Disconnected'));
      item.listeners.length = 0;
    }
    // Clear failure tracking to prevent unbounded growth
    this.bodyFetchFailures.clear();
    // Cancel any pending backoff resume — the queue it would drain is now
    // empty, so leaving it armed just wakes up to process nothing.
    if (this.bodyFetchResumeTimer) {
      clearTimeout(this.bodyFetchResumeTimer);
      this.bodyFetchResumeTimer = null;
    }
  }

  // ========== Attachment Fetching ==========

  /**
   * Fetch a single attachment by filename from an email via IMAP
   * Fetches the full RFC822 message, parses it, and extracts the matching attachment.
   */
  async fetchAttachment(
    _emailId: string,
    folderPath: string,
    uid: number,
    filename: string
  ): Promise<{ filename: string; contentType: string; content: Buffer }> {
    // Select-then-fetch is ONE mailbox section: a UID only means anything against
    // the mailbox it was issued in.
    const doFetch = async (client: IIMAPClient) => withFolderSelected(client, folderPath, async () => {
      const messages = await client.fetchMessagesByUID([uid], {
        fetchHeaders: false,
        fetchBody: true,
      });

      if (messages.length === 0) {
        throw new Error(`Message not found: UID ${uid} in ${folderPath}`);
      }

      const message = messages[0];
      if (!message.body) {
        throw new Error('Message body is empty');
      }

      // message.body is the lossless latin1 raw source — reconstruct exact bytes
      // so mailparser decodes attachments in the message's own charset/CTE.
      const source = Buffer.from(message.body, 'latin1');
      const parsed = await simpleParser(source, SIMPLE_PARSER_OPTIONS);

      if (!parsed.attachments || parsed.attachments.length === 0) {
        throw new Error('No attachments found in message');
      }

      const attachment = parsed.attachments.find(a => a.filename === filename);
      if (!attachment) {
        throw new Error(`Attachment "${filename}" not found`);
      }

      // The lying-encoding recovery, judged against the source we already hold.
      // This fallback is not the rare path it looks like: the per-part fetch bows
      // out whenever a sync holds the primary socket, so most opens during a sync
      // land here — and without this the collapsed 7-byte decode was what reached
      // the cache. The source, not the server's BODYSTRUCTURE: the mailbox that
      // produced this bug returns every BODYSTRUCTURE parameter with its value
      // missing, so there is no filename in it to match and no size to compare.
      return {
        filename: attachment.filename || filename,
        contentType: attachment.contentType || 'application/octet-stream',
        content: await attachmentBytesFromSource(source, filename, attachment.content),
      };
    });

    if (this.connectionPool?.isInitialized()) {
      return this.connectionPool.withConnection(doFetch);
    } else {
      return doFetch(this.connectionManager.client);
    }
  }

  /**
   * Fetch ONE attachment by fetching only its MIME part (BODY[part]) instead of
   * the whole message — the bandwidth win. Resolves the part number from a cheap
   * BODYSTRUCTURE fetch, then downloads just that part (already transfer-decoded
   * by ImapFlow). Returns null when the part can't be resolved or the client
   * doesn't support per-part download, so the caller falls back to the full
   * fetchAttachment path — never a silent failure.
   */
  async fetchAttachmentPart(
    _emailId: string,
    folderPath: string,
    uid: number,
    filename: string,
  ): Promise<{ filename: string; content: Buffer } | null> {
    if (!this.isConnected()) return null;
    const doFetch = async (client: IIMAPClient): Promise<{ filename: string; content: Buffer } | null> => {
      if (typeof client.downloadPart !== 'function') return null;
      // The structure FETCH and the part download are ONE section: the part
      // path it resolves is only meaningful against the mailbox it came from.
      return withFolderSelected(client, folderPath, async () => {
        const msgs = await client.fetchMessagesByUID([uid], {
          fetchHeaders: false, fetchBody: false, fetchBodyStructure: true,
        });
        const node = findAttachmentNodeByName(msgs[0]?.bodyStructure, filename);
        if (!node?.part) return null; // unresolved → caller uses the whole-message path
        const content = await client.downloadPart!(uid, node.part);
        if (!content) return null;
        const part = { number: node.part, encoding: node.encoding, declaredSize: node.size ?? 0 };
        return { filename, content: await this.repairMisdeclaredBase64(client, uid, part, content) };
      });
    };
    try {
      if (this.connectionPool?.isInitialized()) return await this.connectionPool.withConnection(doFetch);
      if (this.isSyncing()) return null; // don't fight the primary/IDLE socket
      const r = await doFetch(this.connectionManager.client);
      await this.reselectMonitoredFolder(); // we SELECTed off the monitored folder
      return r;
    } catch (err) {
      logger.warn(`fetchAttachmentPart failed for "${filename}" (falling back to full message): ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  /**
   * Undo a part whose `Content-Transfer-Encoding` header lies.
   *
   * A part that declares `base64` but carries raw text collapses when decoded:
   * the decoder keeps only alphabet characters and stops at the first `=`, so a
   * real message whose .txt attachment begins `"<p><span style=` decoded to
   * SEVEN bytes of binary — which is what got cached, opened in the OS viewer,
   * and stored as the attachment's size. The server's declared part size is the
   * tell: genuine base64 decodes to about 75% of it and never to under half.
   * Below that, re-fetch the part undecoded and use those bytes — the same
   * content Gmail shows for the same attachment.
   */
  private async repairMisdeclaredBase64(
    client: IIMAPClient,
    uid: number,
    part: { number: string; encoding: string; declaredSize: number },
    decoded: Buffer,
  ): Promise<Buffer> {
    // One line per attachment open (user-initiated, never a hot path), because
    // the numbers this decision turns on are otherwise invisible: when the
    // recovery does not happen, "wrong bytes" and "a part that was fine" look
    // identical from outside.
    logger.info(
      `Attachment part ${part.number}: encoding=${part.encoding} ` +
        `declared=${part.declaredSize} decoded=${decoded.length}`,
    );
    if (!base64DecodeCollapsed(part.encoding, part.declaredSize, decoded.length)) return decoded;

    // Past here the bytes are known bad, so EVERY exit says why it could not
    // repair them. Silent early returns are what made this undiagnosable: the
    // absence of a log meant any of three different things.
    const context =
      `Part ${part.number} declares base64 but decoded to ${decoded.length} bytes of ~` +
      `${Math.round(part.declaredSize * 0.75)} expected`;

    if (typeof client.downloadPartRaw !== 'function') {
      logger.warn(`${context} — this client cannot fetch a part undecoded`);
      return decoded;
    }

    let raw: Buffer | null;
    try {
      raw = await client.downloadPartRaw(uid, part.number);
    } catch (error) {
      // A failed REPAIR must never fail the fetch: the decoded bytes are wrong,
      // but returning them still opens the attachment, and throwing here would
      // take down an open that used to work.
      logger.warn(`${context} — the undecoded re-fetch failed: ${(error as Error)?.message ?? error}`);
      return decoded;
    }

    if (!raw || raw.length <= decoded.length) {
      logger.warn(
        `${context} — the undecoded re-fetch returned ${raw?.length ?? 0} bytes, keeping the decode`,
      );
      return decoded;
    }
    logger.warn(`${context} — serving the ${raw.length} undecoded bytes`);
    return raw;
  }

  // Cache a raw source. lru-cache handles recency + eviction past the cap.
  private setRawSourceCache(emailId: string, source: string): void {
    this.rawSourceCache.set(emailId, source);
  }

  /**
   * Get the full raw RFC822 source of one message for "Show Original". The app
   * discards the true source at import (keeps only the HTML body), so it must
   * come from the server — but the body fetch every mail-open already runs
   * downloads it, so we cache it there and serve from cache here. On a miss we
   * REUSE the body-fetch path (which dedups against any in-flight fetch for the
   * same email and re-populates the cache) rather than opening a second,
   * competing connection. A direct fetch is the last-resort fallback.
   */
  async getRawSource(emailId: string, folderPath: string, uid: number): Promise<string> {
    const cached = this.rawSourceCache.get(emailId);
    if (cached) return cached;

    // Reuse (and dedup with) the body-fetch queue — it downloads the full
    // source and caches it via the completion path above.
    try {
      const result = await this.fetchBody(emailId, folderPath, uid);
      if (result?.source) {
        this.setRawSourceCache(emailId, result.source);
        return result.source;
      }
    } catch {
      // Fall through to a direct fetch below.
    }
    const afterFetch = this.rawSourceCache.get(emailId);
    if (afterFetch) return afterFetch;

    // Last resort: fetch the source directly (e.g. the body-fetch path returned
    // nothing usable). Still cached so a reopen is instant.
    // Same identity guard as the body-fetch path (see isExpectedMessage): this
    // caches the result under emailId, so a mailbox that changed underneath the
    // select would make "Show Original" display somebody else's message.
    const expectedMessageId = (await this.storage.getEmail(emailId))?.messageId;
    const doFetch = async (client: IIMAPClient) => {
      const messages = await withFolderSelected(client, folderPath, () => client.fetchMessagesByUID([uid], {
        fetchHeaders: false,
        fetchBody: true,
        fetchBodyStructure: false,
      }));
      const message = messages[0];
      if (!message?.body) {
        throw new Error(`Raw source unavailable: UID ${uid} in ${folderPath}`);
      }
      if (!isExpectedMessage(message, expectedMessageId)) {
        throw new Error(
          `Raw source identity mismatch for ${emailId} (UID ${uid} in ${folderPath}): `
          + `expected ${expectedMessageId}, server returned ${message.envelope?.messageId}`,
        );
      }
      return message.body;
    };
    const src = this.connectionPool?.isInitialized()
      ? await this.connectionPool.withConnection(doFetch)
      : await doFetch(this.connectionManager.client);
    this.setRawSourceCache(emailId, src);
    return src;
  }

  /**
   * Extract the raw iCalendar (.ics) text from a message's calendar invite, if
   * any, by parsing the full RFC822 source. Reuses the raw-source cache (and the
   * deduped body-fetch path) so a viewed email — whose source is already cached —
   * resolves offline and instantly. Catches BOTH a named `.ics` attachment and
   * the unnamed inline `text/calendar` part that Google/Outlook ship (the latter
   * has no filename, so an attachment-name match alone would miss it). Returns
   * null when there is no calendar part or the source is unavailable.
   */
  async getCalendarIcs(emailId: string, folderPath: string, uid: number): Promise<string | null> {
    const source = await this.getRawSource(emailId, folderPath, uid);
    if (!source) return null;
    const parsed = await this.messageProcessor.parseBody(source);
    return parsed.calendarIcs;
  }

  // ========== Status ==========

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return this.syncState.getStatus();
  }

  /**
   * Get sync state
   */
  getState(): SyncState {
    return this.syncState.state;
  }

  /**
   * Check if syncing
   */
  isSyncing(): boolean {
    return this.syncState.isSyncing();
  }

  /**
   * Stop current sync
   */
  stopSync(): void {
    if (this.syncState.isSyncing()) {
      this.syncState.completeSync(false);
      logger.info('Sync stopped by user');
    }
  }

  /**
   * Get pending operations count
   */
  getPendingOperationsCount(): number {
    return this.operationQueue.length;
  }

  /**
   * Subscribe to sync events
   */
  on(event: string, listener: (...args: any[]) => void): this {
    this.syncState.on(event as any, listener);
    return this;
  }

  /**
   * Unsubscribe from sync events
   */
  removeListener(event: string, listener: (...args: any[]) => void): this {
    this.syncState.removeListener(event as any, listener);
    return this;
  }

  /**
   * Register disconnect callback
   */
  onDisconnect(callback: () => void): void {
    this.connectionManager.on('disconnected', callback);
  }

  /**
   * Register reconnected callback. The reconnect ladder recovers in the
   * main process without renderer involvement, so the UI needs this
   * positive signal too — otherwise it shows "disconnected" forever
   * after a self-healed drop.
   */
  onReconnect(callback: () => void): void {
    this.connectionManager.on('reconnected', callback);
  }

  /**
   * Register reconnect-attempt callback. Fires on every attempt of the
   * backoff ladder BEFORE it succeeds, so the UI can show a distinct
   * "reconnecting" (retry) state instead of sitting on "disconnected"
   * for the whole self-healing window.
   */
  onReconnecting(callback: (attempt: number, maxAttempts: number) => void): void {
    this.connectionManager.on('reconnecting', callback);
  }

  /**
   * Register reconnect-exhausted callback. Fires when the ladder hits its
   * max-attempts cap (entering cooldown) — the UI should fall back from
   * "reconnecting" to a definitive "disconnected" until the ladder resumes.
   */
  onReconnectFailed(callback: () => void): void {
    this.connectionManager.on('max-attempts-reached', callback);
  }

  /**
   * Register auth-failure callback. Fired when the server rejects the
   * credentials (terminal — the renderer should prompt re-authentication).
   */
  onAuthError(callback: (error: Error) => void): void {
    this.connectionManager.on('auth-error', callback);
  }

  /**
   * Get the underlying IMAP client (for advanced operations)
   */
  getClient(): IIMAPClient {
    return this.connectionManager.client;
  }

  /**
   * Fetch UID by message ID
   */
  async fetchUidByMessageId(folderPath: string, messageId: string): Promise<number | null> {
    if (!this.isConnected()) {
      return null;
    }

    try {
      const client = this.connectionManager.client;
      const uids = await withFolderSelected(client, folderPath, () => client.search({
        // Search by message ID header
        header: [{ name: 'Message-ID', value: messageId }],
      }));

      return uids.length > 0 ? uids[0] : null;
    } catch (error) {
      logger.error('Failed to fetch UID by message ID:', error);
      return null;
    }
  }

  /**
   * Refresh flags for a folder (efficient flag-only sync)
   */
  async refreshFolderFlags(folderPath: string): Promise<number> {
    if (!this.isConnected()) {
      return 0;
    }

    const folder = await this.storage.getFolderByPath(folderPath);
    if (!folder) {
      return 0;
    }

    const client = this.connectionManager.client;
    // QRESYNC fast-path for OFFLINE deletions: a resynchronising SELECT makes the
    // server report `VANISHED (EARLIER)` — messages expunged while we were away —
    // which we apply directly and authoritatively (no whole-folder UID diff). The
    // shared helper also serves as the folder's SELECT; it no-ops (and leaves the
    // folder unselected) when QRESYNC is unavailable, so fall back to a plain SELECT.
    // syncFlags still runs afterwards for flag reconciliation.
    // ONE critical section: the QRESYNC select, the fallback select and the whole
    // of syncFlags read the CURRENTLY selected mailbox, and syncFlags issues many
    // commands over a long window. Without the lock the realtime manager's own
    // re-select of the IDLE folder lands in the middle and the reconcile either
    // aborts (MAILBOX_MISMATCH) or, worse, applies another folder's flags.
    // `select: false` — applyQresyncVanished performs the specialised select itself.
    const result = await withFolderSelected(client, folderPath, async () => {
      const { selected } = await applyQresyncVanished(
        client, folder, this.storage,
        (id) => this.syncState.emitEmailDeleted(id, folderPath),
      );
      // syncFlags fetches flags from the CURRENTLY selected mailbox —
      // select the requested folder or we'd apply another folder's flags
      if (!selected) {
        await client.selectFolder(folderPath);
      }
      return this.messageProcessor.syncFlags(client, folder, this.storage);
    }, { select: false });

    // Restore the IDLE-watched folder
    await this.reselectMonitoredFolder();

    return result.updated;
  }

  /**
   * Process pending operations (called after reconnect)
   */
  async processPendingOps(): Promise<{ success: number; failed: number }> {
    return this.operationQueue.processQueue();
  }

  // ========== Helpers ==========

  /**
   * Get selectable folders from folder tree
   */
  private getSelectableFolders(folders: IMAPFolder[]): IMAPFolder[] {
    // Skip provider Important folders — this app's AI is the sole source of the
    // `important` tag. Skipping the mailbox is only half of it: Gmail also puts
    // `\Important` in X-GM-LABELS on messages we fetch from INBOX/All Mail, so
    // `SYSTEM_LABEL_FLAGS` (gmail-labels.ts) drops that label for the same reason.
    // Change one and you must change the other, or importance leaks back in.
    const SKIP_FOLDERS = ['important', '[gmail]/important'];

    const result: IMAPFolder[] = [];
    const flatten = (folder: IMAPFolder) => {
      if (folder.selectable && !SKIP_FOLDERS.includes(folder.path.toLowerCase())) {
        result.push(folder);
      }
      folder.children?.forEach(flatten);
    };
    folders.forEach(flatten);

    // Prefer SUBSCRIBED folders only. Some servers (e.g. this one) expose an
    // unsubscribed `[Gmail]/*` compatibility namespace with duplicate special-
    // use folders — including a `[Gmail]/Sent Mail` whose SELECT the server
    // rejects. Syncing those dumps mail into unselectable duplicates whose
    // bodies can never be fetched. The native, subscribed folders (INBOX,
    // Sent Mail, …) are the real ones. Fall back to all selectable folders if
    // the server reports nothing subscribed (not all servers set the flag).
    const subscribed = result.filter(
      (f) => f.subscribed || f.path.toUpperCase() === 'INBOX',
    );
    return subscribed.length > 0 ? subscribed : result;
  }

  /**
   * Collapse a role the server published TWICE, and say which name replaced
   * which.
   *
   * Sarv lists both `Sent` and `Sent Mail` for one physical store — same
   * UIDVALIDITY, same UID range, same messages. Synced as two folders they each
   * keep their own sync state and counts, while the sidebar shows only one of
   * them: the other accumulates state nothing displays. Worse, dedup by
   * message-id means whichever name synced FIRST owns every row and the second
   * can never gain one, which is how Sent came to claim 1,719 messages, show
   * one, and offer a "next page" that was always blank.
   *
   * Which name wins is decided in `buildStandardFolderAliasMap`, and it needs
   * the sync state — local row count, UIDVALIDITY, server EXISTS — that a bare
   * LIST entry does not carry, so the stored record for each path is merged in
   * first. Without it the ranking alone picks, and on this account it picks the
   * empty one: Sarv puts SPECIAL-USE `\Sent` on the alias.
   *
   * If that read fails we collapse NOTHING. An unreadable store and a store
   * with no folders are the same value here and opposite facts, and the wrong
   * guess stops syncing a mailbox that holds mail.
   */
  private async collapseDuplicateMailboxes(
    folders: IMAPFolder[],
  ): Promise<{ folders: IMAPFolder[]; aliases: Map<string, string> }> {
    const unchanged = { folders, aliases: new Map<string, string>() };

    let stored: FolderRecord[];
    try {
      stored = await this.storage.getFolders();
    } catch (error) {
      logger.warn(
        `Could not read stored folders; not collapsing duplicate mailboxes: ${(error as Error).message}`,
      );
      return unchanged;
    }

    const attachSyncState = (records: FolderRecord[]) => {
      const byPath = new Map(records.map((f) => [f.path, f]));
      return folders.map((folder) => {
        const record = byPath.get(folder.path);
        return {
          ...folder,
          // The stored id, so the filed-count measurement below can address the
          // folder; '' for a mailbox the LIST just discovered, which has no
          // stored rows to count anyway.
          id: record?.id ?? '',
          uidValidity: record?.uidValidity ?? null,
          totalCount: record?.totalCount ?? 0,
          serverMessageCount: record?.serverMessageCount ?? null,
        };
      });
    };

    let withSyncState = attachSyncState(stored);

    // Refresh the stored tag counts for the contested folders once each. These
    // feed the totals the UI shows (they are only recomputed when a sync pass
    // changed something, so a quiet duplicate can sit indefinitely on a stale
    // value — and, until the polling fix, on the server's count written over
    // it). They do NOT decide which name wins: a tag count reads the whole
    // mailbox under both of its names, because a message belonging to two
    // folders is one row carrying both tags. That decision is made from the
    // filed counts attached below.
    const contested = duplicateRoleCandidates(withSyncState)
      .flatMap((role) => role.candidates.map((candidate) => candidate.path))
      .filter((path) => !this.recountedContestedFolders.has(path));
    if (contested.length > 0) {
      try {
        await this.storage.recalculateFolderCounts(contested);
        for (const path of contested) this.recountedContestedFolders.add(path);
        withSyncState = attachSyncState(await this.storage.getFolders());
      } catch (error) {
        // Deciding on a stale count is still better than not deciding.
        logger.warn(
          `Could not recount folders sharing a role (${contested.join(', ')}): ${(error as Error).message}`,
        );
      }
    }

    // Where is the mail actually filed? The only measurement that separates two
    // names for one store — `Sent` holds all 1,718 rows, its `Sent Mail` alias
    // holds the 1 that happened to arrive under that name.
    withSyncState = await withFiledCounts(this.storage, withSyncState);

    const aliases = buildStandardFolderAliasMap(withSyncState);

    // Report the decision AND its inputs, once per change. Which name kept the
    // mail is the whole question, and `Sent -> Sent Mail` on its own cannot be
    // checked against anything; a role that was NOT collapsed is just as worth
    // seeing, since "no duplicate", "no proof yet" and "two real mailboxes"
    // look identical from the outside and call for opposite responses.
    const roles = describeDuplicateRoles(withSyncState);
    if (roles) {
      const decision =
        aliases.size === 0
          ? 'collapsing none (the server has not proven any two are one mailbox)'
          : `skipping ${[...aliases.keys()].join(', ')}`;
      const summary = `${roles} — ${decision}`;
      if (summary !== this.lastDuplicateRoleSummary) {
        this.lastDuplicateRoleSummary = summary;
        logger.info(`Mailboxes sharing a role — ${summary}`);
      }
    }

    if (aliases.size === 0) return unchanged;
    return { folders: folders.filter((f) => !aliases.has(f.path)), aliases };
  }

  /**
   * Filter folders by requested paths
   */
  private filterFolders(folders: IMAPFolder[], requested: string[]): IMAPFolder[] {
    const requestedLower = requested.map(f => f.toLowerCase());
    return folders.filter(f =>
      requestedLower.some(rf =>
        f.path.toLowerCase() === rf || f.path.toLowerCase().includes(rf)
      )
    );
  }

  /**
   * Emit progress update
   */
  private emitProgress(): void {
    if (this.onProgressCallback) {
      this.onProgressCallback(this.syncState.getStatus());
    }
  }
}
