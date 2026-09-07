// Connection Manager - Reliable IMAP connection lifecycle management

import { EventEmitter } from 'events';

import type { IIMAPClient, IMAPConfig } from '../types/imap';
import { logger } from '../utils/logger';
import { detectProvider, type EmailProvider } from '../utils/provider';
import { withTimeout } from '../utils/timeout';

import * as ImapErrors from './imap-errors';
import { ImapFlowClient } from './imapflow-client';

/**
 * Connection manager state (internal)
 * Note: This is different from the IMAP protocol ManagerConnectionState in types/imap.ts
 */
export type ManagerConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * Connection events
 */
export interface ConnectionEvents {
  'state-change': (state: ManagerConnectionState, prevState: ManagerConnectionState) => void;
  'connected': () => void;
  'disconnected': () => void;
  'reconnecting': (attempt: number, maxAttempts: number) => void;
  'reconnected': () => void;
  'error': (error: Error) => void;
  // Fired when the auto-reconnect ladder hits maxAttempts. Distinct
  // from 'error' so a listener can react without the EventEmitter
  // default-throw behavior on 'error' with no listener.
  'max-attempts-reached': () => void;
  // Fired when Gmail / server rejects with "too many simultaneous
  // connections". Upstream (sync-engine) tears down the pool.
  'quota-exceeded': () => void;
  // Fired when the server rejects the credentials (AUTHENTICATIONFAILED /
  // invalid credentials). TERMINAL — retrying can't fix a bad password, so
  // the reconnect ladder stops and the renderer prompts re-authentication.
  'auth-error': (error: Error) => void;
}

/**
 * Connection manager config
 */
export interface ConnectionManagerConfig {
  maxReconnectAttempts: number;
  reconnectDelay: number;
  reconnectBackoffMultiplier: number;
  maxReconnectDelay: number;
  healthCheckInterval: number;
  connectionTimeout: number;
  // Shared per-account connection-cap back-off hooks (owned by the desktop layer,
  // which knows the accountId). The pool already honours these; the reconnect
  // ladder is the LAST connect path that ignored them, so it kept opening sockets
  // against a saturated Gmail cap while the pool politely waited — the deadlock
  // that left the primary stuck in "Failed to establish connection in required
  // time" for minutes. `connectGate` returns remaining park ms (>0 = wait, don't
  // open); `onConnectError` reports a failed reconnect so the SAME window parks
  // (a connect-timeout → 2 min), pacing primary + pool in lockstep. Optional:
  // undefined = old behaviour (never parks), so the manager stays usable in tests.
  connectGate?: () => number;
  onConnectError?: (error: unknown) => void;
}

const DEFAULT_CONFIG: ConnectionManagerConfig = {
  // Bumped from 5 → 10. The post-wake "DNS still cold" window can
  // burn through 4-5 retries before name resolution catches up on
  // oauth2.googleapis.com, leaving the user staring at "Server
  // Disconnected" until the next focus event. With backoff capped at
  // 30s, 10 attempts cover ~3-4 min of flapping network.
  maxReconnectAttempts: 10,
  reconnectDelay: 2000,
  reconnectBackoffMultiplier: 1.5,
  maxReconnectDelay: 30000,
  // Health-check NOOP cadence. This NOOP shares the IDLE socket, so every probe
  // breaks and re-issues IDLE — at the old 30s it was the single biggest source
  // of IDLE churn (worse than the removed 90s refresh NOOP). Raised to 3 min:
  // a zombie socket is still caught in ~9 min (3 consecutive misses) — under the
  // 13 min socketTimeout backstop — while cutting IDLE breaks ~6x. TCP keepalive
  // + socketTimeout + ImapFlow's own maxIdleTime refresh do the rest.
  healthCheckInterval: 180000,
  connectionTimeout: 30000,
};

// Minimum reconnect delay for Gmail-class servers (see attemptReconnect): long
// enough for Gmail's per-account connection reaper to release the dropped socket
// before we reconnect, so we don't race it into "Too many simultaneous
// connections". After ±25% jitter the effective floor is ~18-31s.
const RECONNECT_FLOOR_MS_GMAIL = 25000;

/**
 * Connection Manager
 *
 * Handles:
 * - Connection lifecycle (connect, disconnect)
 * - Automatic reconnection with exponential backoff
 * - Connection health monitoring
 * - Provider detection
 */
export class ConnectionManager extends EventEmitter {
  private _client: IIMAPClient;
  private _config: ConnectionManagerConfig;
  private _imapConfig: IMAPConfig | null = null;
  private _state: ManagerConnectionState = 'disconnected';
  private _provider: EmailProvider = 'generic';
  private _reconnectAttempts = 0;
  // Sliding 1-hour window of successful-reconnect timestamps, so we can log a
  // reconnects/hour rate. A healthy daily-driver IDLE connection should sit in
  // the low single digits per hour; a spike flags flapping (and Gmail rate-limit
  // risk) before it becomes a lockout.
  private _reconnectTimes: number[] = [];
  private _reconnectTimer: NodeJS.Timeout | null = null;
  // Log-dedup latch for the shared-back-off wait: log the "reconnect paused" line
  // once per park episode, not on every re-check, so a multi-minute window doesn't
  // spam the log the way the per-item pool refusals once did.
  private _waitingOutConnectPark = false;
  private _healthCheckTimer: NodeJS.Timeout | null = null;
  // Guards against the periodic health-check NOOP being over-eager. The NOOP
  // shares the one IMAP socket with IDLE and (pre-pool) sync/body-fetch ops; a
  // single NOOP that queues behind a slower op
  // must NOT be read as a dead connection, or it triggers a reconnect that
  // re-arms the timers and flaps connected↔reconnecting forever. So: never run
  // two checks at once, and only tear down after several CONSECUTIVE failures
  // (a genuinely dropped socket also emits 'end'/'close' → handleDisconnect,
  // so fast detection doesn't depend on this backstop).
  private _healthCheckInFlight = false;
  private _healthCheckFailures = 0;
  private _isShuttingDown = false;
  private _reconnectPromise: Promise<boolean> | null = null;
  // Coalesces concurrent forceReconnect() callers. Multiple entrypoints can race
  // to force a reconnect (the connect handler's "already connected" path, the
  // periodic resetAndReconnect, and the renderer's focus/visibility/online
  // checks). Without this, a second call builds a fresh client and overwrites
  // `_client` while the first's connect() is still in flight — orphaning that
  // socket (a leak against the server's per-account cap). All callers share one
  // in-flight run instead. Mirrors `poolInitInFlight` in SyncEngine.
  private _forceReconnectInFlight: Promise<void> | null = null;
  // Resolver for _reconnectPromise so stopReconnect() can settle it —
  // otherwise ensureConnection() awaiters (IPC calls) hang forever.
  private _reconnectResolve: ((connected: boolean) => void) | null = null;
  private _maxAttemptsReachedAt: number | null = null;
  // Cooldown after exhausting maxReconnectAttempts. Short enough that a
  // user whose WiFi reconnected (or whose laptop woke from sleep) sees
  // mail flow within ~1min without needing to click anything — the
  // renderer also calls resetReconnectAttempts on online/resume/unlock
  // events to short-circuit this entirely.
  private readonly _cooldownPeriod = 60 * 1000; // 1 minute
  // Quota errors ("too many simultaneous connections") need a much
  // longer pause — Gmail only releases server-side slots after several
  // minutes, so the generic 60s cooldown just re-saturates the cap.
  private readonly _quotaCooldownPeriod = 5 * 60 * 1000; // 5 minutes
  private _quotaCooldownActive = false;
  // Set when the server rejected the credentials. While true, the manager
  // refuses to auto-reconnect (no point hammering an invalid password) —
  // cleared only by an explicit connect() with (presumably new) credentials.
  private _authFailed = false;
  // When the last auth rejection happened. Automatic reconnects (forceReconnect,
  // the periodic resetAndReconnect, health-check) are suppressed for
  // _authCooldownPeriod after this — retrying the SAME rejected credentials
  // every cycle is what tripped (and kept alive) the server's brute-force
  // lockout, which then returns "Invalid credentials" even for a correct
  // password. Mirrors the quota cooldown. After the window one retry is allowed;
  // if it fails again the timer re-arms.
  private _authFailedAt: number | null = null;
  private readonly _authCooldownPeriod = 15 * 60 * 1000; // 15 minutes
  // ImapFlow connections are single-use: once a client has connected it cannot
  // be reconnected after disconnect() (it throws "Unexpected close"). Set true
  // once the current client has been used, so the next connect() rebuilds a
  // fresh client first. This is what makes account-switching reconnects work
  // (switch-away disconnects the engine; switch-back reconnects the same one).
  private _clientDirty = false;

  constructor(config: Partial<ConnectionManagerConfig> = {}) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._client = new ImapFlowClient();
    this.setupClientListeners();
  }

  /**
   * Wire the shared per-account connection-cap back-off into the reconnect ladder.
   * Called by the owner (SyncEngine → desktop) with the SAME quotaBackoff closures
   * the pool uses, so the primary reconnect stops fighting the pool over a
   * saturated Gmail cap. Passing `undefined` clears the hooks (test/standalone).
   */
  setConnectBackoffHooks(
    connectGate?: () => number,
    onConnectError?: (error: unknown) => void,
  ): void {
    this._config.connectGate = connectGate;
    this._config.onConnectError = onConnectError;
  }

  /**
   * Get the IMAP client
   */
  get client(): IIMAPClient {
    return this._client;
  }

  /**
   * Get current connection state
   */
  get state(): ManagerConnectionState {
    return this._state;
  }

  /**
   * Get detected provider
   */
  get provider(): EmailProvider {
    return this._provider;
  }

  /**
   * Get IMAP config (if connected)
   */
  get imapConfig(): IMAPConfig | null {
    return this._imapConfig;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._state === 'connected' && this._client.isConnected();
  }

  /**
   * Resolve once the connection is usable, or false on timeout. Used to gate
   * IMAP commands (e.g. realtime IDLE) that must not run mid-handshake — issuing
   * them while state is 'connecting' throws "Connection not available". Resolves
   * immediately if already connected; otherwise waits for the next 'connected'
   * (or 'reconnected') event. Never rejects.
   */
  async waitUntilConnected(timeoutMs = 20000): Promise<boolean> {
    if (this.isConnected()) return true;
    // A dead/latched connection will never emit — don't wait pointlessly.
    if (this._state === 'error' || this._authFailed || this._isShuttingDown) return false;

    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('connected', onUp);
        this.off('reconnected', onUp);
      };
      const onUp = () => {
        cleanup();
        // isConnected() also checks the underlying socket, not just state.
        resolve(this.isConnected());
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      this.once('connected', onUp);
      this.once('reconnected', onUp);
    });
  }

  /**
   * Check if reconnecting
   */
  isReconnecting(): boolean {
    return this._state === 'reconnecting';
  }

  /**
   * Setup client event listeners
   */
  private setupClientListeners(): void {
    // Cast to unknown first to satisfy TypeScript
    const clientAsEmitter = this._client as unknown as EventEmitter;

    clientAsEmitter.on('end', () => {
      if (!this._isShuttingDown) {
        logger.warn('Connection ended unexpectedly');
        this.handleDisconnect();
      }
    });

    clientAsEmitter.on('error', (err: Error) => {
      if (!this._isShuttingDown) {
        logger.error('Connection error:', err);
        this.emit('error', err);
        // Trigger reconnection for connection-related errors
        // ('end' may not always fire after socket errors like EHOSTUNREACH)
        if (this.isConnectionError(err)) {
          this.handleDisconnect();
        }
      }
    });
  }

  /**
   * Transition to a new state
   */
  private transition(newState: ManagerConnectionState): void {
    if (newState === this._state) return;

    const prevState = this._state;
    this._state = newState;

    logger.debug(`Connection state: ${prevState} -> ${newState}`);
    this.emit('state-change', newState, prevState);
  }

  /**
   * Connect to IMAP server
   */
  async connect(config: IMAPConfig): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') {
      logger.warn('Already connected or connecting');
      return;
    }

    // A pending reconnect ladder would later spin up a second client
    // that clobbers this fresh connection — cancel it first.
    this.stopReconnect();

    this._imapConfig = config;
    this._provider = detectProvider(config.host);
    this._isShuttingDown = false;
    this._reconnectAttempts = 0;
    // A fresh connect() means new credentials may have been supplied —
    // clear the auth-failed latch and give them a chance. (Automatic reconnects
    // are gated on the auth cooldown BEFORE reaching connect(), so this only
    // clears on a genuine re-auth or a post-cooldown retry.)
    this._authFailed = false;
    this._authFailedAt = null;

    // A previously-used client can't be reconnected (ImapFlow single-use — see
    // _clientDirty). Rebuild a fresh client + listeners before reconnecting,
    // mirroring forceReconnect. The very first connect uses the constructor's
    // fresh client (dirty still false), so this only fires on reconnects.
    if (this._clientDirty) {
      const staleClient = this._client;
      (staleClient as unknown as EventEmitter).removeAllListeners();
      // CLOSE the old socket — don't just drop the reference. An abandoned
      // ImapFlow socket lingers server-side until the provider reaps it, and
      // under reconnect churn these STACK UP against the simultaneous-connection
      // cap (Gmail = 15/account) → "too many connections". forceReconnect closes
      // its old client; plain connect() used to leak it. Detached + best-effort:
      // a dead/hung socket must never delay or fail the fresh connect below.
      // setShuttingDown + a no-op 'error' listener prevent the teardown's emit
      // from becoming an uncaught exception (we just stripped all listeners).
      (staleClient as unknown as { setShuttingDown?: () => void }).setShuttingDown?.();
      (staleClient as unknown as EventEmitter).on('error', () => { /* stale teardown */ });
      void (async () => { try { await staleClient.disconnect(); } catch { /* already dead */ } })();
      this._client = new ImapFlowClient();
      this.setupClientListeners();
    }
    this._clientDirty = true;

    logger.info(`Connecting to ${config.host} (provider: ${this._provider})`);
    this.transition('connecting');

    try {
      await this._client.connect(config);
      this.transition('connected');
      this.emit('connected');
      this.startHealthCheck();
      logger.info('Connected to IMAP server');
    } catch (error) {
      this.transition('error');
      if (this.isAuthError(error)) {
        // Latch so the reconnect ladder / periodic sync won't retry a
        // known-bad password; surface for re-authentication.
        this._authFailed = true;
        this._authFailedAt = Date.now();
        this.emit('auth-error', error as Error);
      }
      this.emit('error', error as Error);
      throw error;
    }
  }

  /** True when the server rejected the saved credentials (needs re-auth). */
  get authFailed(): boolean { return this._authFailed; }

  /**
   * Disconnect from IMAP server
   */
  async disconnect(): Promise<void> {
    this._isShuttingDown = true;
    this.stopHealthCheck();
    this.stopReconnect();

    if (this._state === 'disconnected') {
      return;
    }

    logger.info('Disconnecting from IMAP server');

    try {
      // Mark client as shutting down to suppress error logging
      (this._client as any).setShuttingDown?.();
      await this._client.disconnect();
    } catch (error) {
      // Ignore disconnect errors during shutdown
      logger.debug('Disconnect error (ignored):', error);
    }

    this._imapConfig = null;
    this.transition('disconnected');
    this.emit('disconnected');
  }

  /**
   * Handle unexpected disconnect
   */
  private handleDisconnect(): void {
    if (this._isShuttingDown) return;

    // A single socket drop (e.g. ECONNRESET) makes ImapFlow fire BOTH 'error'
    // AND 'end'/'close' — each routed here. If a reconnect ladder is already
    // running, ignore the redundant event. Otherwise this second call would
    // transition state back to 'disconnected', defeating attemptReconnect's
    // re-entry guard (which checks state === 'reconnecting') and starting a
    // SECOND overlapping ladder — exactly the "Reconnecting (attempt 1/10)"
    // immediately followed by "(attempt 2/10)" seen in the logs, which inflates
    // the attempt count and races two connect attempts. `_reconnectPromise` is
    // set only while a ladder is live (cleared when it settles), so it's the
    // authoritative "already handling this disconnect" signal.
    if (this._reconnectPromise) return;

    // A connect() is still in flight. ImapFlow can emit 'end'/'error' from the
    // socket it is CURRENTLY establishing (or from the previous one tearing
    // down), and starting a ladder here would race a second client against that
    // pending attempt on the same manager — the in-flight connect then loses to
    // its own timeout ("Failed to establish connection in required time") while
    // the ladder reconnects seconds later, or vice-versa.
    //
    // The pending connect() is authoritative: it has its own timeout, so it
    // always settles, and its outcome (transition to 'connected', or throw to
    // the caller, which owns the retry) decides what happens next. Nothing to
    // recover here — just don't fight it.
    if (this._state === 'connecting') {
      logger.debug('Disconnect event during an in-flight connect — deferring to it (no ladder)');
      return;
    }

    this.transition('disconnected');
    this.emit('disconnected');

    // Don't re-enter the ladder while credentials are known-bad.
    if (this._authFailed) return;

    // Attempt reconnection if we have config
    if (this._imapConfig) {
      this.attemptReconnect();
    }
  }

  /**
   * Attempt reconnection with exponential backoff.
   *
   * Loops over attempts inside a single promise — the previous
   * recursive retry was a no-op because the re-entrancy guard saw
   * _reconnectPromise still set, so the ladder died after one attempt.
   */
  /**
   * Record a successful reconnect and return how many happened in the last hour.
   * Used purely for observability (see _reconnectTimes) so flapping is visible
   * in the logs as a rate rather than a wall of individual reconnect lines.
   */
  private recordReconnect(): number {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    this._reconnectTimes = this._reconnectTimes.filter((t) => t >= cutoff);
    this._reconnectTimes.push(now);
    return this._reconnectTimes.length;
  }

  private async attemptReconnect(): Promise<void> {
    if (this._isShuttingDown || !this._imapConfig) return;
    if (this._state === 'reconnecting' && this._reconnectPromise) {
      return; // Already reconnecting
    }

    let settle!: (connected: boolean) => void;
    const ladder = new Promise<boolean>((resolve) => { settle = resolve; });
    this._reconnectPromise = ladder;
    this._reconnectResolve = settle;

    try {
      while (!this._isShuttingDown && this._imapConfig) {
        // Honour the shared connection-cap back-off BEFORE anything else. The pool
        // and the connect handler already park this account when a connect times
        // out / hits the cap; opening a socket here during that window only
        // re-saturates the cap and times out again — the storm that kept the
        // primary stuck at "Failed to establish connection in required time".
        // Wait the window out (abortable via the ladder) WITHOUT consuming a
        // reconnect attempt, then re-check — the park may have been extended by
        // another path. A park is bounded (quotaBackoff caps it at a few minutes)
        // and counts down to 0, so this cannot wait forever.
        const parkedMs = this._config.connectGate?.() ?? 0;
        if (parkedMs > 0) {
          if (!this._waitingOutConnectPark) {
            this._waitingOutConnectPark = true;
            logger.info(`Reconnect paused — server connection-cap back-off active; waiting ${Math.round(parkedMs / 1000)}s before the next attempt`);
          }
          const proceed = await Promise.race([
            new Promise<boolean>((resolve) => {
              this._reconnectTimer = setTimeout(() => resolve(true), parkedMs + 500);
            }),
            ladder.then(() => false),
          ]);
          this._reconnectTimer = null;
          if (!proceed || this._isShuttingDown || !this._imapConfig) return;
          continue;
        }
        this._waitingOutConnectPark = false;

        // Check if we hit max attempts - if so, check cooldown period
        if (this._reconnectAttempts >= this._config.maxReconnectAttempts) {
          const cooldownMs = this._quotaCooldownActive ? this._quotaCooldownPeriod : this._cooldownPeriod;
          // If cooldown period has passed, reset and try again
          if (this._maxAttemptsReachedAt && (Date.now() - this._maxAttemptsReachedAt) >= cooldownMs) {
            logger.info('Cooldown period passed, resetting reconnect attempts');
            this._reconnectAttempts = 0;
            this._maxAttemptsReachedAt = null;
            this._quotaCooldownActive = false;
          } else {
            // Record when we first hit max attempts
            if (!this._maxAttemptsReachedAt) {
              this._maxAttemptsReachedAt = Date.now();
            }
            logger.error(`Max reconnect attempts (${this._config.maxReconnectAttempts}) reached, cooldown for ${Math.round(cooldownMs / 60000)} minutes`);
            // The ladder has given up — stop the recurring health probe too. It
            // would otherwise keep firing (no-opping via the isConnected guard)
            // for the whole cooldown; a fresh connect() re-arms it cleanly.
            this.stopHealthCheck();
            this.transition('error');
            // CRITICAL: EventEmitter throws synchronously when 'error' is
            // emitted with no listener (Node default). That was producing
            // the "Unhandled rejection: Error: Max reconnect attempts
            // reached" cascade you saw. Guard the emit so it's a no-op
            // when nothing is listening — the state transition above and
            // the dedicated 'max-attempts-reached' event below already
            // surface this condition.
            if (this.listenerCount('error') > 0) {
              this.emit('error', new Error('Max reconnect attempts reached'));
            }
            this.emit('max-attempts-reached');
            settle(false);
            return;
          }
        }

        this._reconnectAttempts++;
        let backoff = Math.min(
          this._config.reconnectDelay * Math.pow(this._config.reconnectBackoffMultiplier, this._reconnectAttempts - 1),
          this._config.maxReconnectDelay
        );
        // Gmail counts IMAP connections PER ACCOUNT (cap 15) and releases dropped
        // sockets SLOWLY (its reaper runs after minutes). Reconnecting ~2s after a
        // drop races that reaper and re-hits "Too many simultaneous connections".
        // Give a Gmail-class server a longer floor so the stale socket is released
        // before we reconnect — this intentionally overrides the normal cap.
        const host = (this._imapConfig?.host || '').toLowerCase();
        if (host.includes('gmail') || host.includes('googlemail')) {
          backoff = Math.max(backoff, RECONNECT_FLOOR_MS_GMAIL);
        }
        // Add jitter (±25%) so the primary reconnect, pool re-init, and periodic
        // sync don't back off on identical schedules and hammer the server in
        // lockstep (which can itself trip Gmail's connection cap).
        const delay = Math.round(backoff * (0.75 + Math.random() * 0.5));

        logger.info(`Reconnecting (attempt ${this._reconnectAttempts}/${this._config.maxReconnectAttempts}) in ${delay}ms`);
        this.transition('reconnecting');
        this.emit('reconnecting', this._reconnectAttempts, this._config.maxReconnectAttempts);

        // Backoff wait. stopReconnect() clears the timer and settles the
        // ladder promise, which aborts the wait via the race below.
        const proceed = await Promise.race([
          new Promise<boolean>((resolve) => {
            this._reconnectTimer = setTimeout(() => resolve(true), delay);
          }),
          ladder.then(() => false),
        ]);
        this._reconnectTimer = null;
        if (!proceed || this._isShuttingDown || !this._imapConfig) return;

        try {
          // Tear down the old client before replacing it (mirrors
          // forceReconnect): its stale 'end'/'error' listeners would
          // later fire handleDisconnect() against the healthy new
          // connection, and the old socket would leak a server-side
          // connection (Gmail quota errors).
          const oldClient = this._client;
          (oldClient as unknown as EventEmitter).removeAllListeners();
          (oldClient as any).setShuttingDown?.();
          try {
            await Promise.race([
              oldClient.disconnect(),
              new Promise(resolve => setTimeout(resolve, 3000)), // 3s cap on disconnect
            ]);
          } catch {
            // old socket may already be dead
          }

          // Create new client for reconnection
          this._client = new ImapFlowClient();
          this.setupClientListeners();

          await this._client.connect(this._imapConfig!);

          this._reconnectAttempts = 0;
          this._maxAttemptsReachedAt = null;
          this._quotaCooldownActive = false;
          this.transition('connected');
          this.emit('reconnected');
          this.startHealthCheck();
          logger.info(`Reconnected to IMAP server (${this.recordReconnect()} reconnects in last hour)`);
          settle(true);
          return;
        } catch (error) {
          // Auth failure is TERMINAL — the saved password/token is bad and
          // no number of retries will fix it. Stop the ladder immediately
          // (don't burn 10 attempts + a cooldown that the periodic sync
          // re-triggers forever) and signal the renderer to re-authenticate.
          if (this.isAuthError(error)) {
            logger.error('Authentication failed — credentials rejected by server. Stopping reconnects; re-authentication required.');
            this._authFailed = true;
            this._authFailedAt = Date.now();
            this._reconnectAttempts = 0;
            this.transition('error');
            this.emit('auth-error', error as Error);
            settle(false);
            return;
          }

          logger.error('Reconnect failed:', error);

          // Feed the shared back-off: a failed reconnect (connect-timeout = cap
          // saturation, or an explicit quota error) parks THIS account's window,
          // which the gate check at the top of the loop then waits out before the
          // next attempt — and which the pool honours too. This is what paces the
          // primary to one attempt per park instead of hammering every ~30s.
          // Safe for benign errors: parkOnError classifies and no-ops non-cap ones.
          this._config.onConnectError?.(error);

          // Quota error: Gmail says "Too many simultaneous connections".
          // Retrying immediately would add ANOTHER in-flight connect
          // against an already-saturated cap → makes it worse. Stop
          // the ladder and force the long quota cooldown so existing
          // sockets can time out server-side. Emit the special event so
          // upstream (sync-engine) can tear down the pool.
          if (this.isQuotaError(error)) {
            logger.error('Quota error detected ("too many simultaneous connections") — pausing reconnects for 5 minutes so server-side sockets time out');
            this._reconnectAttempts = this._config.maxReconnectAttempts;
            this._maxAttemptsReachedAt = Date.now();
            this._quotaCooldownActive = true;
            this.emit('quota-exceeded');
            settle(false);
            return;
          }

          // Otherwise loop continues with the next attempt
        }
      }
    } finally {
      settle(false); // no-op if already settled — awaiters never hang
      if (this._reconnectPromise === ladder) {
        this._reconnectPromise = null;
        this._reconnectResolve = null;
      }
    }
  }

  /**
   * Stop reconnection attempts
   */
  private stopReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;
    // Settle the in-flight ladder promise so ensureConnection()
    // awaiters (IPC calls) unblock; the loop sees it and bails.
    if (this._reconnectResolve) {
      this._reconnectResolve(false);
      this._reconnectResolve = null;
    }
    this._reconnectPromise = null;
  }

  /**
   * Ensure connection is established
   * Returns true if connected, false if reconnection failed
   */
  async ensureConnection(): Promise<boolean> {
    if (this.isConnected()) {
      return true;
    }

    if (!this._imapConfig) {
      // Same wake-from-sleep race as forceReconnect(): config was nulled by the
      // sleep-time disconnect() and the re-hydrating connect() hasn't run yet.
      // A no-op, not an error — report not-connected and let connect() recover.
      logger.debug('ensureConnection: no IMAP config yet (wake race) — awaiting connect()');
      return false;
    }

    // Credentials were rejected — don't auto-retry a known-bad password
    // (that's the endless AUTHENTICATIONFAILED loop). Wait for an explicit
    // connect() with new credentials.
    if (this._authFailed) {
      return false;
    }

    // Wait for existing reconnection
    if (this._reconnectPromise) {
      return this._reconnectPromise;
    }

    // Trigger reconnection
    await this.attemptReconnect();
    return this.isConnected();
  }

  /**
   * Start health check interval
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    this._healthCheckFailures = 0;
    this._healthCheckInFlight = false;

    // How many CONSECUTIVE failed probes before we treat the socket as a zombie
    // and reconnect. One slow/queued NOOP on a live-but-busy connection must not
    // trip this — only sustained unresponsiveness.
    const HEALTH_CHECK_MAX_FAILURES = 3;
    // Generous timeout: the NOOP can legitimately queue behind another command
    // on the shared socket (OP_TIMEOUT is 60s), so a short 10s budget produced
    // false "zombie" positives. Well above normal NOOP round-trips, below a
    // full op timeout.
    const NOOP_TIMEOUT_MS = 30000;

    this._healthCheckTimer = setInterval(async () => {
      if (!this.isConnected() || this._isShuttingDown) {
        return;
      }
      // Never overlap probes — if the previous NOOP is still in flight (queued
      // behind a slow op), skip this tick rather than piling on.
      if (this._healthCheckInFlight) {
        return;
      }
      this._healthCheckInFlight = true;

      const fail = (reason: string) => {
        this._healthCheckFailures += 1;
        logger.warn(`Health check probe failed (${this._healthCheckFailures}/${HEALTH_CHECK_MAX_FAILURES}): ${reason}`);
        if (this._healthCheckFailures >= HEALTH_CHECK_MAX_FAILURES) {
          logger.warn('Health check: connection unresponsive after repeated probes — reconnecting');
          this._healthCheckFailures = 0;
          this.handleDisconnect();
        }
      };

      try {
        const clientAny = this._client as any;
        if (typeof clientAny.noop === 'function') {
          const alive = await withTimeout(
            clientAny.noop() as Promise<boolean>,
            NOOP_TIMEOUT_MS,
            'Health-check NOOP timeout',
          );
          if (alive) {
            this._healthCheckFailures = 0; // healthy — reset the streak
          } else {
            fail('NOOP returned not-alive');
          }
        } else if (!this._client.isConnected()) {
          fail('client reports disconnected');
        } else {
          this._healthCheckFailures = 0;
        }
      } catch (error) {
        // A single timeout on the shared IDLE socket is NOT proof of death —
        // count it, and only reconnect after several in a row (a truly dropped
        // socket also emits 'end'/'close' → handleDisconnect immediately).
        fail((error as Error)?.message ?? String(error));
      } finally {
        this._healthCheckInFlight = false;
      }
    }, this._config.healthCheckInterval);
    // Don't let this recurring probe keep the event loop (and thus the process)
    // alive on its own — a pending reconnect/quit shouldn't wait on it.
    this._healthCheckTimer.unref?.();
  }

  /**
   * Stop health check interval
   */
  private stopHealthCheck(): void {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  /**
   * Execute operation with connection check
   */
  async withConnection<T>(operation: (client: IIMAPClient) => Promise<T>): Promise<T> {
    if (!await this.ensureConnection()) {
      throw new Error('Not connected to IMAP server');
    }

    try {
      return await operation(this._client);
    } catch (error) {
      if (this.isConnectionError(error)) {
        this.handleDisconnect();
      }
      throw error;
    }
  }

  /**
   * Check if error is connection-related
   */
  isConnectionError(error: unknown): boolean {
    return ImapErrors.isConnectionError(error);
  }

  /**
   * Check if error is a server-side per-account connection-quota
   * violation. Gmail caps each account at ~15 simultaneous IMAP
   * connections. Hitting the limit produces a "Too many simultaneous
   * connections" / "ALERT" response — and the WORST possible reaction
   * is to immediately retry, because that just adds another in-flight
   * connect attempt against an already-saturated quota.
   *
   * On detection: skip the regular reconnect ladder entirely, log
   * loudly, and let the existing sockets time out naturally before
   * trying again. The caller (sync-engine) tears down the pool so
   * future attempts have a chance of fitting under the cap.
   */
  isQuotaError(error: unknown): boolean {
    return ImapErrors.isQuotaError(error);
  }

  /** Server-requested throttling / rate limit (honor suggested backoff). */
  isRateLimited(error: unknown): boolean {
    return ImapErrors.isRateLimited(error);
  }

  /**
   * Check if error is an authentication failure (permanent until user
   * re-enters credentials). Distinct from connection errors —
   * retrying an auth-failed request just hammers the IMAP server and
   * will get the IP rate-limited or temporarily blocked by Gmail.
   */
  isAuthError(error: unknown): boolean {
    return ImapErrors.isAuthError(error);
  }

  /**
   * Reset connection state
   */
  async reset(): Promise<void> {
    await this.disconnect();
    this._reconnectAttempts = 0;
    this._maxAttemptsReachedAt = null;
    this._quotaCooldownActive = false;
    this._provider = 'generic';
  }

  /**
   * True while a "too many simultaneous connections" quota back-off is active and
   * not yet elapsed. Callers use it to avoid poking a connection-capped server
   * before its per-account slots free (Gmail = 15/account).
   */
  isInQuotaCooldown(): boolean {
    return this._quotaCooldownActive &&
      this._maxAttemptsReachedAt != null &&
      Date.now() - this._maxAttemptsReachedAt < this._quotaCooldownPeriod;
  }

  /**
   * True while an auth-failure back-off is active. The server rejected the saved
   * credentials; automatic reconnects must NOT retry the same password every
   * cycle (that hammers — and prolongs — the server's brute-force lockout, which
   * then rejects even a correct password). Clears itself after
   * _authCooldownPeriod so a later attempt can retry; an explicit connect() with
   * fresh credentials clears it immediately.
   */
  isInAuthCooldown(): boolean {
    return this._authFailed &&
      this._authFailedAt != null &&
      Date.now() - this._authFailedAt < this._authCooldownPeriod;
  }

  /**
   * Force reset reconnect attempts (allows immediate retry after max attempts).
   *
   * The renderer calls this on online/resume/unlock/focus to clear the SHORT
   * network cooldown so mail flows right after WiFi/sleep recovers. But it must
   * NOT clear an active QUOTA back-off: "too many simultaneous connections" is
   * about the SERVER's per-account connection cap, which a network blip or an
   * alt-tab does not change. Clearing it let those frequent events re-hammer a
   * capped server, re-saturating it so the slots never freed and the back-off
   * never succeeded — the 1% edge case behind a stuck "too many connections". The
   * quota cooldown clears itself after _quotaCooldownPeriod; a deliberate
   * forceReconnect() still clears it directly.
   */
  resetReconnectAttempts(): void {
    if (this.isInQuotaCooldown()) {
      logger.info('resetReconnectAttempts: quota cooldown active — preserving it (won\'t re-hammer the connection cap)');
      return;
    }
    if (this.isInAuthCooldown()) {
      logger.info('resetReconnectAttempts: auth cooldown active — preserving it (won\'t re-hammer rejected credentials)');
      return;
    }
    this._reconnectAttempts = 0;
    this._maxAttemptsReachedAt = null;
    this._quotaCooldownActive = false;
    logger.info('Reconnect attempts reset - ready for fresh connection attempt');
  }

  /**
   * Probe whether the current connection actually answers a NOOP within a
   * short timeout. Returns false for a dead/zombie socket, true for a live
   * one — WITHOUT triggering the reconnect ladder (unlike the health check).
   *
   * Callers use this to decide whether a hard forceReconnect is warranted: a
   * healthy connection must not be torn down (doing so on every window focus
   * was killing the live socket mid-sync and causing reconnect flapping).
   */
  async verifyConnection(timeoutMs = 10000): Promise<boolean> {
    if (!this.isConnected()) return false;
    const clientAny = this._client as unknown as { noop?: () => Promise<boolean> };
    if (typeof clientAny.noop !== 'function') return this._client.isConnected();
    try {
      return await withTimeout(clientAny.noop(), timeoutMs, 'verifyConnection NOOP timeout');
    } catch {
      return false;
    }
  }

  /**
   * Force a hard disconnect + reconnect, even if the current state claims
   * "connected". Use this to recover from a ZOMBIE TCP connection — the
   * socket appears open from the client's view but the server long ago
   * dropped it, so every IMAP request hangs until its timeout fires.
   *
   * Symptoms that motivate this: body fetches all timing out at 30s while
   * `isConnected()` returns true, plain `connect()` no-ops because state
   * is "connected", and the regular reconnect ladder never runs (it's
   * gated on a 'disconnected' event the zombie never emitted).
   *
   * The plain `disconnect()` method nulls out `_imapConfig` (intended for
   * shutdown), so we save it locally before the tear-down and restore for
   * the fresh connect. Times out the connect attempt so the UI doesn't
   * spin forever if the new socket also hangs.
   */
  async forceReconnect(connectTimeoutMs = 30000): Promise<void> {
    // Default budget covers a slow-but-working OAuth resolve (≤10s) PLUS the connect
    // bound (≤22s) so a legitimate reconnect isn't reported as failed just because
    // the token refresh was slow. A genuinely stuck socket is still force-closed by
    // the client's own inner connect timeout regardless of this outer value.
    //
    // Coalesce concurrent callers onto ONE in-flight reconnect so a second call
    // can't overwrite `_client` mid-connect and orphan the first socket.
    if (this._forceReconnectInFlight) return this._forceReconnectInFlight;
    const run = this._doForceReconnect(connectTimeoutMs);
    this._forceReconnectInFlight = run.finally(() => { this._forceReconnectInFlight = null; });
    return this._forceReconnectInFlight;
  }

  private async _doForceReconnect(connectTimeoutMs: number): Promise<void> {
    if (!this._imapConfig) {
      // Wake-from-sleep race, not an error: the sleep/lock-time disconnect()
      // nulled _imapConfig (see below), and the fresh connect() that re-hydrates
      // it hasn't run yet. No-op and let that pending connect() drive the real
      // reconnect. Throwing here logged a scary [ERROR] on every screen-unlock
      // while the app self-healed a few ms later.
      logger.debug('forceReconnect: no IMAP config yet (wake race) — awaiting connect()');
      return;
    }
    // Refuse while an auth back-off is active. forceReconnect always reuses the
    // saved (rejected) credentials, so retrying now just re-hammers the server's
    // brute-force lockout and keeps "Invalid credentials" alive. This is the main
    // entrypoint the periodic resetAndReconnect / connect handler use, so gating
    // here breaks the loop. Re-auth with new credentials goes through connect().
    if (this.isInAuthCooldown()) {
      logger.info('forceReconnect skipped — auth cooldown active (credentials rejected); re-authentication required');
      return;
    }
    const savedConfig = this._imapConfig;
    logger.info('forceReconnect: tearing down current (possibly zombie) connection');

    // Stop the auto-reconnect ladder and health check so they don't
    // interleave with our explicit teardown.
    this.stopReconnect();
    this.stopHealthCheck();

    // Best-effort kill of the existing socket. Swallow errors — the
    // whole point is that the connection is unreliable.
    try {
      (this._client as any).setShuttingDown?.();
      await Promise.race([
        this._client.disconnect(),
        new Promise(resolve => setTimeout(resolve, 3000)), // 3s cap on disconnect
      ]);
    } catch (err) {
      logger.debug('forceReconnect: disconnect error (expected for zombie):', err);
    }

    // Reset internal state so connect() below isn't blocked by the
    // "already connected" guard.
    this._reconnectAttempts = 0;
    this._maxAttemptsReachedAt = null;
    this._quotaCooldownActive = false;
    this._isShuttingDown = false;
    this._reconnectPromise = null;
    this.transition('disconnected');

    // Build a fresh client — the previous instance's listeners are stale
    // and may still be wired to the dead socket's events. Detach them first
    // (mirrors the reconnect ladder at the top of this class): otherwise the
    // old client's 'end'/'error' listeners could later fire handleDisconnect()
    // against the healthy new connection.
    (this._client as unknown as EventEmitter).removeAllListeners();
    this._client = new ImapFlowClient();
    this.setupClientListeners();
    // This client is freshly built + unused, so connect() below must NOT rebuild
    // it again (its dirty-client guard would otherwise discard this one).
    this._clientDirty = false;

    // Fresh connect with a hard timeout so the UI doesn't spin forever.
    logger.info(`forceReconnect: connecting (timeout ${connectTimeoutMs}ms)`);
    await withTimeout(this.connect(savedConfig), connectTimeoutMs, 'forceReconnect: connect timed out');

    // connect() above emits 'connected' (the initial-connect signal), which the
    // renderer does NOT listen for — it only flips the UI back on 'reconnected'.
    // forceReconnect is definitionally a RE-connect (zombie recovery), so emit
    // 'reconnected' too; otherwise the socket comes back live (IDLE running,
    // syncs completing) while the UI stays stuck on "Disconnected".
    this.emit('reconnected');
  }

  /**
   * Type-safe event subscription
   */
  on<K extends keyof ConnectionEvents>(event: K, listener: ConnectionEvents[K]): this {
    return super.on(event, listener);
  }

  emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
}
