// Realtime Manager - IDLE and Polling for real-time email updates

import { EventEmitter } from 'events';

import type { IIMAPClient, IMAPEvent } from '../types/imap';
import type { IEmailStorage } from '../types/storage';
import { logger } from '../utils/logger';
import { createMutex, type Mutex } from '../utils/mutex';

import { isConnectionError } from './imap-errors';
import { fetchNewMessagesWindowed } from './incremental-fetch';
import { MessageProcessor } from './message-processor';
import { withFolderSelected } from './with-folder';

/**
 * Real-time event types
 */
export interface RealtimeEvent {
  type: 'new' | 'flagsChanged' | 'deleted';
  folderPath: string;
  emailId?: string;
  uid?: number;
  flags?: string[];
  count?: number;
  /** Owning account of this event (multi-account IDLE-for-all). Added by the
   *  main-process idle bridge; undefined = the active account. */
  accountId?: string;
}

/**
 * Realtime manager events
 */
export interface RealtimeEvents {
  'event': (event: RealtimeEvent) => void;
  'new-messages': (count: number, folderPath: string) => void;
  'flags-changed': (emailId: string, flags: string[]) => void;
  'message-deleted': (emailId: string) => void;
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: Error) => void;
}

/**
 * Realtime manager configuration
 */
export interface RealtimeConfig {
  pollingIntervalMs: number;       // Polling interval (default: 30s)
  periodicSyncIntervalMs: number;  // Periodic full sync (default: 5min)
  minPollIntervalMs: number;       // Minimum between polls (debounce)
  maxNewMessagesBatch: number;     // Max messages to fetch at once
  reconnectAttempts: number;       // Max reconnect attempts
  reconnectDelayMs: number;        // Base reconnect delay
  idleUpgradeIntervalMs: number;   // Retry cadence for polling -> IDLE upgrade
}

const DEFAULT_CONFIG: RealtimeConfig = {
  pollingIntervalMs: 30000,
  periodicSyncIntervalMs: 300000,
  minPollIntervalMs: 5000,
  maxNewMessagesBatch: 20,
  reconnectAttempts: 3,
  reconnectDelayMs: 5000,
  idleUpgradeIntervalMs: 120000,
};

/**
 * Realtime sync mode
 */
export type RealtimeMode = 'idle' | 'polling' | 'none';

/** Distinguishes the log lines of the N per-account managers that all write to
 *  the one shared app log (they used to be indistinguishable, which made
 *  "3 IDLE loops started in 700ms" look like one connection running three
 *  loops when it was three accounts restarting after a shared network drop). */
let instanceCounter = 0;

/**
 * Realtime Manager
 *
 * Provides clean, unified real-time email updates:
 * - IDLE when supported by server
 * - Polling fallback when IDLE not available
 * - Periodic sync for comprehensive updates
 */
export class RealtimeManager extends EventEmitter {
  private config: RealtimeConfig;
  private messageProcessor: MessageProcessor;
  private readonly instanceId = ++instanceCounter;

  // State
  private mode: RealtimeMode = 'none';
  private monitoredFolder: string | null = null;

  /**
   * Monotonic epoch for the current monitoring session; every teardown bumps it.
   *
   * Async work (periodic sync, coalesced flag sync, new-message handling)
   * captures the epoch it was started in and bails on every resume point where
   * the epoch no longer matches. Without this, work that was in flight when a
   * reconnect tore the session down would resume against the NEW session and:
   *  - re-arm `periodicSyncTimer` / `flagSyncTimer` after stop() cleared them,
   *    orphaning the new session's handle (a timer chain that can never be
   *    cleared again — the overnight accumulation), and
   *  - issue a SELECT on the freshly-restarted IDLE connection, yanking the
   *    mailbox out from under IDLE.
   */
  private epoch = 0;

  /** Serializes start()/stop()/updateClient() so two callers can't interleave
   *  their awaits and end up with two half-built sessions. */
  private readonly lifecycleMutex: Mutex = createMutex();

  // IDLE state. Keepalive is owned entirely by ImapFlow (maxIdleTime) plus TCP
  // keepalive on the socket — we no longer run an app-level NOOP timer, which
  // used to break IDLE every 90s and cause the reconnect flapping.
  private idleActive = false;

  // Polling state
  private pollingTimer: NodeJS.Timeout | null = null;
  private pollingInProgress = false;
  private lastPollTime = 0;
  // When IDLE-start loses a race against sync on the shared connection (SELECT
  // times out), we fall back to polling. This timer periodically retries the
  // upgrade so a transient stall doesn't leave the session on polling forever.
  private idleUpgradeTimer: NodeJS.Timeout | null = null;
  // Consecutive failed upgrade attempts, for exponential backoff. Reset to 0 on
  // each fresh polling fallback and on a successful upgrade.
  private idleUpgradeAttempts = 0;
  private static readonly IDLE_UPGRADE_MAX_MS = 15 * 60_000; // backoff cap: 15 min

  /**
   * The folder the caller ASKED us to monitor — kept even when no session is up,
   * and cleared only by an explicit stop().
   *
   * When BOTH IDLE and polling failed to start (a busy/wedged shared connection),
   * `mode` stayed 'none', so `isActive()` was false and nothing ever tried again:
   * the account received no live mail for the rest of the session, while the UI
   * showed it connected. That is the
   *   Realtime: Failed to start IDLE: Connection not available
   *   Realtime: Failed to start monitoring (rt#N)
   * pair in the logs. This records the intent so the retry below — and a
   * reconnect handing us a new client — can resurrect the session.
   */
  private startIntent: string | null = null;
  private monitorRetryTimer: NodeJS.Timeout | null = null;
  private monitorRetryAttempts = 0;
  private static readonly MONITOR_RETRY_BASE_MS = 30_000;
  private static readonly MONITOR_RETRY_MAX_MS = 5 * 60_000;
  // Debounce IDLE flag pushes into ONE folder reconciliation. A per-event
  // fetch on the IDLE connection serialized badly under a flag storm ("mark all
  // read" from webmail = many FLAGS pushes) and could hang → the 60s FETCH
  // timeout. Coalescing runs the proven select+syncFlags path once per burst.
  private flagSyncTimer: NodeJS.Timeout | null = null;
  private flagSyncInProgress = false;

  // Per-folder trailing debounce for the folder-count backstop. recalculate-
  // FolderCounts is a FULL emails-table pass (tags membership can't be indexed),
  // so calling it once per IDLE event was catastrophic on a burst: a webmail bulk
  // delete surfaces as a storm of per-UID expunge events (seen: "deleted ... x161"),
  // and each one fired its own full-table recount — ~10s of synchronous main-thread
  // stalls. The per-email `deleted`/`new` events already update the UI badge in
  // place, so the DB recount is only the authoritative backstop and can safely
  // coalesce: one recount per folder per burst instead of N.
  private folderRecountTimers = new Map<string, NodeJS.Timeout>();
  private static readonly FOLDER_RECOUNT_DEBOUNCE_MS = 1000;

  // Periodic sync state
  private periodicSyncTimer: NodeJS.Timeout | null = null;

  // Dependencies
  private client: IIMAPClient | null = null;
  private storage: IEmailStorage | null = null;
  private onSyncRequest: ((folders?: string[]) => Promise<void>) | null = null;

  constructor(config: Partial<RealtimeConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.messageProcessor = new MessageProcessor({ headersOnly: true });
    this.setMaxListeners(20);
  }

  /** Forward the pending-flag-op source so the IDLE-poll syncFlags doesn't
   * revert un-synced local flag changes. */
  setPendingUidsProvider(fn: (folderPath: string) => Promise<Set<number>>): void {
    this.messageProcessor.setPendingUidsProvider(fn);
  }

  /**
   * Initialize with dependencies
   */
  initialize(deps: {
    client: IIMAPClient;
    storage: IEmailStorage;
    onSyncRequest?: (folders?: string[]) => Promise<void>;
  }): void {
    // The engine re-initializes components with the NEW client BEFORE calling
    // updateClient(), so by the time updateClient() tears the session down
    // `this.client` already points at the replacement and the outgoing client
    // keeps its IDLE listeners forever. Detach them here, while we still hold
    // the reference.
    const previousClient = this.client;
    if (previousClient && previousClient !== deps.client) {
      void Promise.resolve(previousClient.stopIdle()).catch(() => { /* dead socket */ });
      this.idleActive = false;
    }
    this.client = deps.client;
    this.storage = deps.storage;
    this.onSyncRequest = deps.onSyncRequest || null;
  }

  /**
   * Get current mode
   */
  getMode(): RealtimeMode {
    return this.mode;
  }

  /**
   * Get monitored folder
   */
  getMonitoredFolder(): string | null {
    return this.monitoredFolder;
  }

  /**
   * Check if realtime is active
   */
  isActive(): boolean {
    return this.mode !== 'none';
  }

  /**
   * Start realtime monitoring
   * Tries IDLE first, falls back to polling
   */
  async start(folderPath: string = 'INBOX'): Promise<RealtimeMode> {
    if (!this.client || !this.storage) {
      throw new Error('RealtimeManager not initialized');
    }
    return this.runExclusive(() => this.startInternal(folderPath));
  }

  /**
   * Stop realtime monitoring
   */
  async stop(): Promise<void> {
    await this.runExclusive(() => this.teardown('explicit stop'));
  }

  /**
   * Run a lifecycle transition with exclusive access.
   *
   * start()/stop()/updateClient() each contain several awaits. Concurrent
   * callers (the renderer's imap:startIdle, the ConnectionManager 'reconnected'
   * handler, and the Tier-B background sweep's stop→sync→start cycle all reach
   * this class) used to interleave those awaits and leave `mode` /
   * `monitoredFolder` describing one session while the timers belonged to
   * another. Serializing them makes each transition atomic.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.lifecycleMutex.runExclusive(fn);
  }

  /**
   * Tear the current session down. Bumping the epoch FIRST invalidates every
   * in-flight continuation so none of them can re-arm a timer we are about to
   * clear.
   *
   * `reason` is logged at info only for an explicit stop; the implicit teardown
   * inside startInternal() logs at debug. Previously both logged "Realtime:
   * Stopped", so a single restart emitted two of them — the 1.8:1
   * Stopped:IDLE-started ratio in the logs was this, not lost sessions.
   */
  private async teardown(reason: 'explicit stop' | 'restart'): Promise<void> {
    this.epoch++;
    this.clearIdleUpgradeTimer();
    this.clearMonitorRetryTimer();
    await this.stopIdle();
    this.stopPolling();
    this.stopPeriodicSync();
    this.clearFlagSyncTimer();
    this.clearFolderRecountTimers();
    this.mode = 'none';
    this.monitoredFolder = null;
    if (reason === 'explicit stop') {
      // Only an explicit stop revokes the intent — a restart is still meant to
      // end up monitoring, so the retry ladder must survive it.
      this.startIntent = null;
      logger.info(`Realtime: Stopped (rt#${this.instanceId})`);
    } else {
      logger.debug(`Realtime: Stopped for restart (rt#${this.instanceId})`);
    }
  }

  /** start() body — must only run inside runExclusive(). */
  private async startInternal(folderPath: string): Promise<RealtimeMode> {
    if (!this.client || !this.storage) {
      throw new Error('RealtimeManager not initialized');
    }

    // Stop any existing monitoring
    await this.teardown('restart');

    const epoch = this.epoch;
    this.monitoredFolder = folderPath;
    this.startIntent = folderPath;

    // Try IDLE first
    if (await this.startIdle(folderPath)) {
      if (epoch !== this.epoch) {
        // Superseded while IDLE was coming up — don't leave it attached.
        await this.stopIdle();
        return 'none';
      }
      this.mode = 'idle';
      this.monitorRetryAttempts = 0;
      this.startPeriodicSync();
      // Reconcile deletions that happened while we WEREN'T monitoring this folder
      // (deleted from webmail / another client while the app was closed, or while
      // we were on a different folder). IDLE only pushes FUTURE events, so without
      // this the pre-existing deletions never get noticed — the reported "mail
      // deleted on webmail still shows in the app INBOX".
      this.scheduleFlagSync();
      logger.info(`Realtime: IDLE started for ${folderPath} (rt#${this.instanceId})`);
      return 'idle';
    }

    if (epoch !== this.epoch) return 'none';

    // Fall back to polling
    if (await this.startPolling(folderPath)) {
      if (epoch !== this.epoch) {
        this.stopPolling();
        return 'none';
      }
      this.mode = 'polling';
      this.monitorRetryAttempts = 0;
      this.startPeriodicSync();
      // IDLE start failed (typically its SELECT lost a race against a heavy sync
      // on the shared connection). Keep trying to upgrade to IDLE in the
      // background so we self-heal once the connection quiesces — instead of
      // sitting on 30s polling until the next reconnect. Fresh cycle → reset the
      // backoff so the first retry is prompt.
      this.idleUpgradeAttempts = 0;
      this.scheduleIdleUpgrade();
      logger.info(`Realtime: Polling started for ${folderPath} (rt#${this.instanceId})`);
      return 'polling';
    }

    // Neither IDLE nor polling came up — usually the shared connection is busy
    // or was just recycled. Keep the intent and retry with backoff instead of
    // going silent until something else happens to restart us.
    logger.warn(`Realtime: Failed to start monitoring (rt#${this.instanceId}) — retrying`);
    this.scheduleMonitorRetry();
    return 'none';
  }

  /** Re-arm the single-shot retry for a session that failed to start AT ALL.
   *  Same shape as scheduleIdleUpgrade: single-shot (a slow SELECT can't overlap
   *  its own retry), exponential backoff so a persistently busy connection isn't
   *  hammered, jittered so N accounts don't retry in lockstep. */
  private scheduleMonitorRetry(): void {
    this.clearMonitorRetryTimer();
    const capped = Math.min(
      RealtimeManager.MONITOR_RETRY_BASE_MS * 2 ** this.monitorRetryAttempts,
      RealtimeManager.MONITOR_RETRY_MAX_MS,
    );
    const delay = Math.round(capped * (0.75 + Math.random() * 0.5));
    this.monitorRetryAttempts++;
    this.monitorRetryTimer = setTimeout(() => {
      void this.runExclusive(async () => {
        const folderPath = this.startIntent;
        // Someone stopped us, or a session came up by another route.
        if (!folderPath || this.mode !== 'none') return;
        logger.info(`Realtime: retrying monitoring for ${folderPath} (rt#${this.instanceId})`);
        await this.startInternal(folderPath);
      });
    }, delay);
    this.monitorRetryTimer.unref?.();
  }

  private clearMonitorRetryTimer(): void {
    if (this.monitorRetryTimer) {
      clearTimeout(this.monitorRetryTimer);
      this.monitorRetryTimer = null;
    }
  }

  // ========== IDLE ==========

  /**
   * Start IDLE monitoring
   */
  private async startIdle(folderPath: string, quiet = false): Promise<boolean> {
    if (!this.client?.isConnected()) {
      return false;
    }

    if (!this.client.supportsIdle()) {
      logger.info('Realtime: Server does not support IDLE');
      return false;
    }

    // Belt-and-braces against a second IDLE loop on one manager. With
    // start()/stop() serialized through runExclusive() this should be
    // unreachable; if it ever fires it is the concrete double-trigger and is
    // worth seeing in the log rather than silently double-attaching.
    if (this.idleActive) {
      logger.warn(`Realtime: startIdle while IDLE already active — detaching previous loop (rt#${this.instanceId})`);
      await this.stopIdle();
    }

    try {
      // IDLE watches the SELECTED mailbox, so the select and the IDLE command
      // are one section — a re-select landing between them silently monitors
      // the wrong folder and this account simply stops seeing new mail.
      await withFolderSelected(this.client, folderPath, () =>
        this.client!.startIdle((event) => this.handleIdleEvent(event)));
      this.idleActive = true;
      return true;
    } catch (error) {
      // `quiet` on the background polling->IDLE upgrade retries: a still-busy
      // connection is expected to fail, so log at debug to avoid spamming the
      // same error every retry. The initial start still logs at error (visible).
      if (quiet) logger.debug('Realtime: IDLE upgrade attempt failed (still on polling):', (error as Error)?.message ?? error);
      else logger.error('Realtime: Failed to start IDLE:', error);
      return false;
    }
  }

  // ===== polling -> IDLE auto-upgrade =====

  /** Re-arm a single-shot timer that retries upgrading a polling session to IDLE.
   *  setTimeout (re-armed on each attempt) rather than setInterval so a slow
   *  (up-to-60s) SELECT can never overlap its own next attempt.
   *
   *  Exponential backoff + jitter: each failed attempt doubles the delay (capped)
   *  so we don't hammer a connection that keeps failing IDLE — e.g. a saturated
   *  Gmail account, where retrying every 2min just adds churn toward its
   *  per-account connection cap. `idleUpgradeAttempts` is reset to 0 whenever a
   *  fresh polling fallback begins (see startInternal). */
  private scheduleIdleUpgrade(): void {
    this.clearIdleUpgradeTimer();
    const base = this.config.idleUpgradeIntervalMs;
    const capped = Math.min(base * 2 ** this.idleUpgradeAttempts, RealtimeManager.IDLE_UPGRADE_MAX_MS);
    // +/-25% jitter so many accounts don't retry in lockstep after a shared event.
    const delay = Math.round(capped * (0.75 + Math.random() * 0.5));
    this.idleUpgradeAttempts++;
    this.idleUpgradeTimer = setTimeout(() => {
      void this.runExclusive(() => this.tryUpgradeToIdle());
    }, delay);
    this.idleUpgradeTimer.unref?.();
  }

  private clearIdleUpgradeTimer(): void {
    if (this.idleUpgradeTimer) {
      clearTimeout(this.idleUpgradeTimer);
      this.idleUpgradeTimer = null;
    }
  }

  /** Attempt to promote an active polling session to IDLE. Runs inside
   *  runExclusive() so it can't race start()/stop(). Re-arms itself while still
   *  polling; stops trying once upgraded, torn down, or IDLE is unsupported. */
  private async tryUpgradeToIdle(): Promise<void> {
    // Only relevant while we're actively polling a folder.
    if (this.mode !== 'polling' || !this.monitoredFolder) { this.clearIdleUpgradeTimer(); return; }
    if (!this.client?.isConnected()) { this.scheduleIdleUpgrade(); return; }
    if (!this.client.supportsIdle()) { this.clearIdleUpgradeTimer(); return; } // never going to upgrade

    const folderPath = this.monitoredFolder;
    const epoch = this.epoch;
    if (await this.startIdle(folderPath, /* quiet */ true)) {
      if (epoch !== this.epoch) { await this.stopIdle(); return; } // superseded mid-attempt
      // Won the upgrade: drop polling and become IDLE. Reconcile flags like the
      // initial IDLE start does (catches changes missed while polling).
      this.stopPolling();
      this.mode = 'idle';
      this.scheduleFlagSync();
      this.clearIdleUpgradeTimer();
      this.idleUpgradeAttempts = 0;
      logger.info(`Realtime: upgraded polling -> IDLE for ${folderPath} (rt#${this.instanceId})`);
      return;
    }
    // Still couldn't start IDLE (connection busy) — keep polling, try again later.
    this.scheduleIdleUpgrade();
  }

  /**
   * Stop IDLE monitoring
   */
  private async stopIdle(): Promise<void> {
    // Unconditional: handleReconnect() clears `idleActive` WITHOUT detaching, so
    // gating on the flag left the IDLE listeners attached to that client for
    // good. client.stopIdle() is an idempotent listener-detach, so calling it
    // when nothing is attached is free.
    if (!this.client) {
      this.idleActive = false;
      return;
    }
    try {
      await this.client.stopIdle();
    } catch {
      // Ignore stop errors
    }
    this.idleActive = false;
  }

  /**
   * Handle IDLE event from server
   */
  private async handleIdleEvent(event: IMAPEvent): Promise<void> {
    if (!this.monitoredFolder) return;

    try {
      switch (event.type) {
        case 'new':
          await this.handleNewMessages();
          break;

        case 'update':
          // Coalesce flag pushes into a debounced folder reconciliation instead
          // of a per-event fetch on the IDLE connection (see scheduleFlagSync).
          this.scheduleFlagSync();
          break;

        case 'expunge':
          // A server-side expunge (message deleted / moved to Trash from webmail
          // or another client) means a row is gone from this folder.
          //
          // FAST PATH: with QRESYNC the server reports the vanished message by UID
          // (ImapFlow surfaces it as event.uid), so we can remove exactly that
          // local row NOW and emit a per-email `deleted` event the renderer can
          // apply in place — no waiting on the throttled Phase-2 SEARCH-ALL diff
          // (which is also blocked by the mass-deletion ratio guard on drifted
          // folders). handleExpunge does the work; only fall back to the coalesced
          // folder sync when we DON'T have a UID (non-QRESYNC / seq-only expunge),
          // where the bodyless event just tells the renderer "something changed".
          // Require QRESYNC too, not just a numeric event.uid: only under QRESYNC
          // does ImapFlow guarantee `.uid` is a real UID. Without it, a bare
          // sequence number in `.uid` could collide with a different message's UID
          // and unlink the wrong row — so fall back to the completeness-guarded
          // Phase-2 sync instead of trusting the number.
          if (typeof event.uid === 'number' && event.uid > 0 && this.client?.supportsQresync?.()) {
            await this.handleExpunge(event.uid);
          } else {
            this.scheduleFlagSync();
            this.emitEvent({
              type: 'deleted',
              folderPath: this.monitoredFolder,
            });
          }
          break;
      }
    } catch (error) {
      logger.error('Realtime: Error handling IDLE event:', error);
      // EventEmitter throws synchronously on 'error' with no listener
      if (this.listenerCount('error') > 0) this.emit('error', error as Error);
    }
  }

  // ========== Polling ==========

  /**
   * Start polling
   */
  private async startPolling(_folderPath: string): Promise<boolean> {
    if (!this.client?.isConnected()) {
      return false;
    }

    this.stopPolling();

    // Initial poll
    await this.poll();

    // Set up interval
    this.pollingTimer = setInterval(async () => {
      await this.poll();
    }, this.config.pollingIntervalMs);

    return true;
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.pollingInProgress = false;
  }

  /**
   * Single poll iteration
   */
  private async poll(): Promise<void> {
    const epoch = this.epoch;
    if (!this.client || !this.storage || !this.monitoredFolder) {
      return;
    }

    // Prevent concurrent polling
    if (this.pollingInProgress) {
      return;
    }

    // Debounce rapid polls
    const now = Date.now();
    if (now - this.lastPollTime < this.config.minPollIntervalMs) {
      return;
    }

    this.pollingInProgress = true;
    this.lastPollTime = now;

    try {
      if (!this.client.isConnected()) {
        await this.handleReconnect();
        return;
      }

      const folder = await this.storage.getFolderByPath(this.monitoredFolder);
      if (!folder || epoch !== this.epoch) return;

      // Check folder status
      const status = await this.client.selectFolder(this.monitoredFolder);
      if (epoch !== this.epoch) return;
      const lastUID = folder.lastSyncUid || 0;
      const storedCount = (folder as any).lastKnownMessageCount || 0;

      // Check for new messages
      const hasNewMessages = status.uidNext > lastUID + 1 ||
        (status.messages > storedCount && storedCount > 0);

      if (hasNewMessages) {
        logger.info(`Polling: New messages detected in ${this.monitoredFolder}`);
        await this.handleNewMessages();
      }

      // Sync flags and detect deletions during polling. syncFlags issues many
      // commands against the CURRENTLY selected mailbox over a long window, and
      // the foreground (drain, reconcile, queued ops) shares this socket — so
      // the selection is HELD for the whole pass, not merely set before it.
      const flagsResult = await withFolderSelected(this.client, this.monitoredFolder, () =>
        this.messageProcessor.syncFlags(
          this.client!,
          folder,
          this.storage!,
          (emailId, uid, flags) => {
            this.emitEvent({
              type: 'flagsChanged',
              folderPath: this.monitoredFolder!,
              emailId,
              uid,
              flags,
            });
          },
          (emailId, uid) => {
            this.emitEvent({
              type: 'deleted',
              folderPath: this.monitoredFolder!,
              emailId,
              uid,
            });
          }
        ));

      if (flagsResult.updated > 0) {
        logger.info(`Polling: ${flagsResult.updated} flags updated`);
      }

      if (epoch !== this.epoch) return;
      // A server-driven flag change or deletion alters the folder's unread
      // count. Recompute it (this folder) so the sidebar badge doesn't sit
      // stale while the rows re-render from the reconciled DB — the "rows go
      // bold but the count stays 1" bug. Mirrors the coalesced/IDLE path.
      if (flagsResult.updated > 0 || flagsResult.deleted > 0) {
        try {
          await this.storage.recalculateFolderCounts([this.monitoredFolder!]);
        } catch (err) {
          logger.warn(`Polling: recalculateFolderCounts failed: ${(err as Error).message}`);
        }
      }
      // Record what the SERVER holds. Only that — `totalCount` is the number of
      // rows WE hold (folder-repository recounts it from the folder tag), and
      // writing the server's EXISTS over it makes the two fields say the same
      // thing while meaning opposite ones. That is what put "1–1 of 1,719" over
      // a Sent folder holding one message: the list counter is
      // max(totalCount, serverMessageCount), so both halves were the server's
      // number and nothing was left to disagree with it. It also silently
      // defeats every "do we have them all?" comparison, and it misreported
      // which of two aliased mailboxes actually holds the mail.
      await this.storage.updateFolder(folder.id, {
        lastKnownMessageCount: status.messages,
      } as any);
    } catch (error) {
      if (this.isConnectionError(error)) {
        logger.warn('Polling: Connection error');
        this.emit('disconnected');
        await this.handleReconnect();
      } else {
        logger.error('Polling: Error:', error);
        if (this.listenerCount('error') > 0) this.emit('error', error as Error);
      }
    } finally {
      this.pollingInProgress = false;
    }
  }

  /**
   * Handle a detected disconnect.
   *
   * The shared client is OWNED by the ConnectionManager — calling
   * connect()/disconnect() on it here fought CM's reconnect ladder
   * (two live connections, orphaned monitors). Just pause our own
   * loops; CM's 'reconnected' event flows to updateClient() via the
   * engine, which restarts monitoring on the new client. Keep mode +
   * monitoredFolder set so that restart actually happens.
   */
  private async handleReconnect(): Promise<void> {
    logger.warn(`Realtime: Connection lost — pausing monitoring until ConnectionManager reconnects (rt#${this.instanceId})`);
    // Actually detach the IDLE listeners instead of only clearing the flag —
    // the flag-only version left them bound to the dead client (and stopIdle()
    // used to skip the detach because the flag said "not idling").
    await this.stopIdle();
    this.stopPolling();
    // A debounce armed just before the drop would otherwise fire into the
    // reconnect and log "coalesced flag sync failed: Connection not available".
    this.clearFlagSyncTimer();
  }

  // ========== Periodic Sync ==========

  /**
   * Start periodic full sync
   */
  private startPeriodicSync(): void {
    this.stopPeriodicSync();

    // The chain belongs to THIS session. A tick that was awaiting onSyncRequest
    // when the session was torn down used to fall through to the re-arm below
    // and overwrite `periodicSyncTimer` with its own handle — orphaning the
    // handle of the session that had meanwhile started, so that chain could
    // never be cleared again. One extra self-perpetuating sync chain per
    // reconnect-during-sync, forever: the overnight churn with no user present.
    const epoch = this.epoch;

    const interval = this.config.periodicSyncIntervalMs;
    // ±20% jitter on every tick so N accounts drift out of lockstep instead of
    // all firing (and all reconnecting) on the same instant.
    const nextDelay = () => interval * (0.8 + Math.random() * 0.4);

    const runSync = async () => {
      if (epoch !== this.epoch) return;
      const folderPath = this.monitoredFolder;
      // Skip while the connection is down: attempting a sync mid-reconnect only
      // throws "Connection not available" and adds churn — the ConnectionManager
      // reconnect path resyncs on its own once it's back.
      if (this.onSyncRequest && folderPath && this.client?.isConnected()) {
        logger.info(`Periodic sync: Starting (rt#${this.instanceId})`);
        try {
          await this.onSyncRequest([folderPath]);
          logger.info('Periodic sync: Completed');
        } catch (error) {
          // A periodic tick that lands WHILE a sync is already running is benign:
          // the in-flight sync (e.g. one still draining a slow 60s FETCH) already
          // covers this folder, so this tick simply has nothing to do. Log it as a
          // quiet skip, not a scary ERROR — only genuine failures are errors.
          if (error instanceof Error && error.message.includes('Sync already in progress')) {
            logger.debug('Periodic sync: skipped (a sync is already in progress)');
          } else {
            logger.error('Periodic sync: Failed:', error);
          }
        }
        // The sync above can run for a minute; the session may be gone now.
        if (epoch !== this.epoch) return;
        // onSyncRequest (syncAll) downloads NEW mail but does not reconcile
        // deletions. Run the deletion/flag reconciliation too so mail deleted
        // elsewhere (webmail) is removed even on a quiet folder with no IDLE
        // events — a periodic backstop to the IDLE expunge trigger.
        this.scheduleFlagSync();
      } else {
        logger.debug('Periodic sync: skipped (disconnected)');
      }
      // Self-reschedule (not setInterval) so the guard + jitter apply every tick.
      // Only ever re-arm the chain we still own.
      if (epoch !== this.epoch) return;
      this.periodicSyncTimer = setTimeout(runSync, nextDelay());
    };

    this.periodicSyncTimer = setTimeout(runSync, nextDelay());
  }

  /**
   * Stop periodic sync
   */
  private stopPeriodicSync(): void {
    if (this.periodicSyncTimer) {
      clearTimeout(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
  }

  // ========== Event Handlers ==========

  /**
   * Handle new messages
   */
  private async handleNewMessages(): Promise<void> {
    // Same epoch/binding discipline as syncMonitoredFolderFlags: this runs from
    // an IDLE callback and must not keep driving a client/folder that a
    // reconnect has already replaced.
    const epoch = this.epoch;
    const client = this.client;
    const storage = this.storage;
    const folderPath = this.monitoredFolder;
    if (!client || !storage || !folderPath) return;

    try {
      const folder = await storage.getFolderByPath(folderPath);
      if (!folder || epoch !== this.epoch) return;

      const lastUid = folder.lastSyncUid || 0;
      // The status drives the fetch window and the fetch consumes it, so both
      // must run against the SAME mailbox — one held section covers the select,
      // the status it returns and every FETCH the window issues.
      //
      // Bounded, windowed fetch — NEVER an unbounded `lastUid+1:*`. On this
      // LARGE/slow account the single unbounded fetch blew the 60s op timeout
      // every cycle and new mail never landed (see incremental-fetch.ts). Cap
      // per-cycle work so a big backlog drains across cycles (backfill/periodic
      // sync cover the rest) instead of one command that can't finish in time.
      const messages = await withFolderSelected(client, folderPath, async () => {
        const status = await client.selectFolder(folderPath);
        if (epoch !== this.epoch) return [];
        return fetchNewMessagesWindowed(
          client,
          lastUid,
          status.uidNext,
          { fetchHeaders: true, fetchBody: false, fetchBodyStructure: true },
          { maxMessages: this.config.maxNewMessagesBatch * 100 },
        );
      });
      if (epoch !== this.epoch) return;

      if (messages.length === 0) return;

      // Process ALL fetched messages (header-level — cheap). Truncating
      // to the newest N while still advancing lastSyncUid past the
      // dropped ones permanently skipped those emails from incremental
      // sync.
      if (messages.length > this.config.maxNewMessagesBatch) {
        logger.info(`Realtime: Large batch of ${messages.length} new messages — processing all`);
      }

      // Process messages
      const result = await this.messageProcessor.processBatch(
        messages,
        folder,
        storage
      );

      // Always update lastSyncUid to the highest UID we've seen,
      // even if nothing was inserted (avoids re-fetching the entire mailbox)
      // reduce(), NOT Math.max(...spread): a very large IDLE burst (thousands of
      // new UIDs) would overflow the call-argument limit and throw RangeError —
      // after processBatch already inserted the rows, so lastSyncUid wouldn't
      // advance and the next cycle would needlessly re-fetch them.
      const maxSeenUid = messages.reduce((m: number, x: any) => Math.max(m, x.uid || 0), 0);
      if (maxSeenUid > (folder.lastSyncUid || 0)) {
        await storage.updateFolder(folder.id, {
          lastSyncUid: maxSeenUid,
        });
      }

      if (result.inserted > 0) {
        // Emit one event per inserted email so the renderer gets the
        // emailId and can do a smooth in-place merge into the list.
        // The legacy count-only event was a no-op downstream because
        // sync-engine's handleRealtimeEvent guards on `event.emailId`
        // — so prior behavior was: rows hit the DB but the UI never
        // refreshed until the user reloaded.
        for (const emailId of result.insertedIds) {
          this.emitEvent({
            type: 'new',
            folderPath,
            emailId,
          });
        }

        this.emit('new-messages', result.inserted, folderPath);
        logger.info(`Realtime: Added ${result.inserted} new messages (emitted ${result.insertedIds.length} new-email events)`);

        // New arrivals raise the folder's unread/total counts, but the insert
        // path above never touched folders.unread_count — so the sidebar badge
        // sat stale (e.g. showed 4/5 while 10 unread had actually landed) until a
        // folder switch forced a full recount. The flag-sync (syncMonitoredFolder-
        // Flags) and poll paths already recount after server-driven changes; the
        // new-mail path was the one gap. Recount AFTER emitting so the list merge
        // stays instant; scoped to this folder, gated on real inserts (infrequent),
        // and self-healing (same unread definition as recalculateFolderCounts).
        if (epoch === this.epoch) {
          // Coalesced: a fast run of inserts recounts once, not per batch.
          this.scheduleFolderRecount(folderPath);
        }
      }

      // A move-BACK into this (monitored) folder — e.g. Trash→Inbox in webmail —
      // relinks the row here but leaves its now-stale tag on the SOURCE folder.
      // That source isn't live-monitored, so without this its copy lingers until a
      // periodic reconcile (the "moved to Inbox but still in Trash" report).
      // Reconcile those source folders promptly via the engine's targeted sync
      // (onSyncRequest → syncAll, off the pool — NOT this IDLE connection); its
      // deletion pass drops the vanished source membership. A reconcile (not a
      // blind tag drop) is model-safe: a Gmail label that still applies survives.
      // Fire-and-forget so a slow source sync never stalls the IDLE handler.
      const sources = (result.relinkedFromFolders || []).filter((f) => f && f !== folderPath);
      if (epoch === this.epoch && this.onSyncRequest && sources.length > 0) {
        logger.info(`Realtime: move-back into ${folderPath} — reconciling source folder(s): ${sources.join(', ')}`);
        void this.onSyncRequest(sources).catch((err) =>
          logger.warn(`Realtime: source-folder reconcile after move-back failed: ${(err as Error).message}`),
        );
      }
    } catch (error) {
      logger.error('Realtime: Error handling new messages:', error);
      if (this.listenerCount('error') > 0) this.emit('error', error as Error);
    }
  }

  /**
   * Handle a QRESYNC expunge (for IDLE). The server named the vanished message by
   * UID, so remove exactly that local row and emit a per-email `deleted` event —
   * the renderer removes it in place, no full folder reload. Same epoch/binding
   * discipline as handleNewMessages: this runs from an IDLE callback and must not
   * touch a client/folder a reconnect has already replaced.
   */
  private async handleExpunge(uid: number): Promise<void> {
    const epoch = this.epoch;
    const storage = this.storage;
    const folderPath = this.monitoredFolder;
    if (!storage || !folderPath) return;

    try {
      const folder = await storage.getFolderByPath(folderPath);
      if (!folder || epoch !== this.epoch) return;

      const email = await storage.getEmailByFolderAndUid(folder.id, uid);
      if (!email) return; // already gone locally, or never had it — nothing to do

      // Unlink-or-delete rather than a blind delete: a row that vanished from THIS
      // folder but still belongs to another (a webmail move BACK, or a Gmail label)
      // is only unlinked here, not destroyed — mirrors the Phase-2 deletion path.
      const { deleted } = await storage.unlinkOrDeleteEmailsFromFolder([email.id], folder.id);
      if (epoch !== this.epoch) return;

      // A removal changes the folder's unread/total counts; keep the sidebar badge
      // in step (same scoped, self-healing recount the new-mail path uses). Coalesced
      // per folder so a bulk webmail delete (a storm of per-UID expunges) triggers
      // ONE full-table recount, not one per message.
      this.scheduleFolderRecount(folderPath);

      // Per-email event so the renderer drops this exact row (list + filtered view
      // + badge) in place — the whole point of the QRESYNC fast path.
      this.emitEvent({ type: 'deleted', folderPath, emailId: email.id, uid });
      logger.info(`Realtime: IDLE expunge — removed uid=${uid} locally (${deleted ? 'deleted' : 'unlinked, kept in another folder'})`);
    } catch (error) {
      logger.warn(`Realtime: handleExpunge failed for uid ${uid}: ${(error as Error).message}`);
    }
  }

  /**
   * Handle flags update (for IDLE)
   */
  /**
   * Debounce an IDLE flag push into ONE folder reconciliation. Many pushes in a
   * burst (a webmail "mark all read") collapse to a single select+syncFlags run
   * once the burst settles — instead of a per-event fetch on the IDLE connection
   * that serialized poorly under load and hung (the 60s FETCH timeout).
   */
  private scheduleFlagSync(): void {
    // Never arm on a torn-down manager. Two callers (the post-sync backstop in
    // runSync, and the "already in progress" retry in
    // syncMonitoredFolderFlags) fire from async continuations that can outlive
    // stop() — they used to re-arm this timer immediately after stop() cleared
    // it, so a stopped manager kept waking up and touching IMAP.
    if (this.mode === 'none' || !this.monitoredFolder) return;
    const epoch = this.epoch;
    this.clearFlagSyncTimer();
    this.flagSyncTimer = setTimeout(() => {
      this.flagSyncTimer = null;
      if (epoch !== this.epoch) return;
      void this.syncMonitoredFolderFlags(epoch);
    }, 1500);
  }

  private clearFlagSyncTimer(): void {
    if (this.flagSyncTimer) {
      clearTimeout(this.flagSyncTimer);
      this.flagSyncTimer = null;
    }
  }

  /**
   * Coalesce a folder-count recount to once per burst (see folderRecountTimers).
   * Safe because the per-email `deleted`/`new` events already move the UI badge in
   * place — this only refreshes the authoritative DB count, which need not be
   * per-event. Epoch-guarded so a recount armed before a teardown never runs
   * against a replaced connection/folder.
   */
  private scheduleFolderRecount(folderPath: string): void {
    if (this.mode === 'none' || !this.storage) return;
    const storage = this.storage;
    const epoch = this.epoch;
    const existing = this.folderRecountTimers.get(folderPath);
    if (existing) clearTimeout(existing);
    this.folderRecountTimers.set(folderPath, setTimeout(() => {
      this.folderRecountTimers.delete(folderPath);
      if (epoch !== this.epoch) return;
      void storage.recalculateFolderCounts([folderPath]).catch((err) =>
        logger.warn(`Realtime: debounced recount failed for ${folderPath}: ${(err as Error).message}`),
      );
    }, RealtimeManager.FOLDER_RECOUNT_DEBOUNCE_MS));
  }

  private clearFolderRecountTimers(): void {
    for (const t of this.folderRecountTimers.values()) clearTimeout(t);
    this.folderRecountTimers.clear();
  }

  /**
   * Reconcile flags (and deletions) for the monitored folder via the SHARED
   * `syncFlags` path — the same one polling uses (CONDSTORE-optimized, IDLE-aware
   * because ImapFlow breaks/resumes its auto-IDLE around the commands). Serialized
   * against itself; a push arriving mid-run re-arms the debounce so nothing is
   * lost. Replaces the old per-seqNo fetch that caused the IDLE/FETCH contention.
   */
  private async syncMonitoredFolderFlags(epoch: number = this.epoch): Promise<void> {
    // Bind the client + folder for the whole run. Reading `this.client` /
    // `this.monitoredFolder!` across awaits meant a run that started before a
    // reconnect finished against the REPLACEMENT client — issuing a SELECT on
    // the connection IDLE had just been armed on (IDLE only watches the
    // selected mailbox), and emitting events with `folderPath: null` once
    // stop() had nulled the field.
    const client = this.client;
    const storage = this.storage;
    const folderPath = this.monitoredFolder;
    if (!client || !storage || !folderPath) return;
    if (epoch !== this.epoch) return;
    if (this.flagSyncInProgress) { this.scheduleFlagSync(); return; }
    if (!client.isConnected()) return;
    this.flagSyncInProgress = true;
    try {
      const folder = await storage.getFolderByPath(folderPath);
      if (!folder || epoch !== this.epoch) return;
      const readFlips: Array<{ emailId: string; nowRead: boolean }> = [];
      // Held, not merely set: syncFlags runs a long multi-command pass against
      // the selected mailbox while the foreground shares this socket. This is
      // the pass that was aborting with MAILBOX_MISMATCH — i.e. not reconciling
      // at all — whenever a drain or reconcile re-selected underneath it.
      const result = await withFolderSelected(client, folderPath, () =>
        this.messageProcessor.syncFlags(
        client,
        folder,
        storage,
        (emailId, uid, flags) => {
          if (epoch !== this.epoch) return;
          this.emitEvent({ type: 'flagsChanged', folderPath, emailId, uid, flags });
          this.emit('flags-changed', emailId, flags);
        },
        (emailId, uid) => {
          if (epoch !== this.epoch) return;
          this.emitEvent({ type: 'deleted', folderPath, emailId, uid });
        },
        undefined,
        (emailId, nowRead) => {
          if (epoch !== this.epoch) return;
          readFlips.push({ emailId, nowRead });
        },
        ));
      if (epoch !== this.epoch) return;
      // A server-driven change alters folder unread counts; refresh so the
      // sidebar badge doesn't sit stale for the IDLE session. Deletions change a
      // message count too, so those still need the full recount; a flag-only sync
      // gets the precise, scan-free read delta instead.
      const batchDelta = (storage as { applyReadFlagToFolderCountsBatch?: (f: Array<{ emailId: string; nowRead: boolean }>) => Promise<void> }).applyReadFlagToFolderCountsBatch;
      try {
        if (result.deleted === 0 && readFlips.length > 0 && typeof batchDelta === 'function') {
          await batchDelta.call(storage, readFlips);
        } else if (result.updated > 0 || result.deleted > 0) {
          await storage.recalculateFolderCounts([folderPath]);
        }
      } catch (err) {
        logger.warn('Realtime: folder unread refresh after flag change failed:', err);
      }
    } catch (error) {
      logger.warn(`Realtime: coalesced flag sync failed for ${folderPath}: ${(error as Error).message}`);
    } finally {
      this.flagSyncInProgress = false;
    }
  }

  /**
   * Emit realtime event
   */
  private emitEvent(event: RealtimeEvent): void {
    this.emit('event', event);
  }

  /**
   * Check if error is connection-related
   */
  private isConnectionError(error: unknown): boolean {
    return isConnectionError(error);
  }

  /**
   * Update the IMAP client reference (e.g. after reconnect creates a new client)
   * and restart monitoring if it was active.
   */
  async updateClient(client: IIMAPClient): Promise<void> {
    await this.runExclusive(async () => {
      // A session that FAILED to start has mode 'none' and no monitoredFolder,
      // but its intent is still live — a brand-new client is exactly what it was
      // waiting for, so restart on that too instead of dropping the account to
      // no monitoring until its (much slower) retry timer fires.
      const previousFolder = this.monitoredFolder ?? this.startIntent;
      const previousMode = this.mode;

      // Stop current monitoring (clears old client listeners). Uses the
      // internal teardown so a restart logs at debug — one reconnect used to
      // emit TWO "Realtime: Stopped" INFO lines (here and again inside start()),
      // which is the whole 1.8:1 Stopped:IDLE-started ratio.
      await this.teardown(previousFolder ? 'restart' : 'explicit stop');

      // Update client reference
      this.client = client;

      // Restart monitoring if it was active, or was trying to be
      if (previousFolder) {
        const what = previousMode === 'none' ? 'failed' : previousMode;
        logger.info(`Realtime: Restarting ${what} monitoring on new client for ${previousFolder} (rt#${this.instanceId})`);
        await this.startInternal(previousFolder);
      }
    });
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<RealtimeConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart polling if active with new interval
    if (this.mode === 'polling' && this.monitoredFolder) {
      this.stopPolling();
      // startPolling() does an initial poll — a floating rejection here would
      // surface as an unhandled rejection in the main process.
      void this.startPolling(this.monitoredFolder).catch((err) => {
        logger.warn('Realtime: restart polling after setConfig failed:', err);
      });
    }
  }

  /**
   * Type-safe event subscription
   */
  on<K extends keyof RealtimeEvents>(event: K, listener: RealtimeEvents[K]): this {
    return super.on(event, listener);
  }

  emit<K extends keyof RealtimeEvents>(event: K, ...args: Parameters<RealtimeEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}
