// IMAP Connection Pool for parallel folder sync

import type { IMAPConfig, IIMAPClient } from '../types/imap';
import { logger } from '../utils/logger';
import { isTimeoutError, withTimeout } from '../utils/timeout';

import { isConnectionError } from './imap-errors';
import { ImapFlowClient } from './imapflow-client';

// A pooled connection that has sat unused longer than this is REVALIDATED with a
// NOOP before it is handed out again. Gmail silently drops idle sockets while
// `isConnected()` still reads true, so reusing one without a probe fails the
// caller's op (which then reads as connect churn). A freshly-released connection
// is trusted without the round-trip. Mirrors K-9's RealImapStore.getConnection.
const STALE_REVALIDATE_MS = 30_000;
// Bound the validation NOOP so a zombie (half-open) socket that never answers
// can't wedge acquire() — a hung probe is treated as a dead connection.
const NOOP_VALIDATE_TIMEOUT_MS = 10_000;

/**
 * Connection state in the pool
 */
interface PooledConnection {
  client: IIMAPClient;
  inUse: boolean;
  lastUsed: number;
  acquiredAt: number; // When the connection was last acquired (for stuck detection)
  id: number;
  // Set when the last operation threw/timed out. A command may still be in
  // flight on the socket, leaving the response pipeline in an uncertain state —
  // reusing such a connection risks a scrambled next SELECT/FETCH. A poisoned
  // connection is closed + dropped on release instead of handed out again.
  poisoned: boolean;
}

/**
 * Pool configuration options
 */
export interface ConnectionPoolConfig {
  maxConnections: number; // Maximum concurrent connections (default: 4)
  connectionTimeout: number; // Timeout for acquiring connection (default: 30000ms)
  idleTimeout: number; // Close idle connections after this time (default: 60000ms)
  /**
   * Optional shared connect gate. Returns the remaining connection back-off for
   * THIS account in ms; when > 0 the pool refuses to open a NEW socket and fails
   * the acquire fast instead. The pool is the fourth independent connect path
   * (after imap:connect, resetAndReconnect and backgroundSync) and, without this,
   * it kept hammering a saturated per-account cap during backfill/drain — every
   * new pool socket against a full cap re-saturates it and PROLONGS the lockout.
   * Wiring the SAME back-off instance the other paths use means the pool honours
   * the same park window rather than fighting it. Omitted = never parked (old
   * behaviour), so the pool stays usable standalone / in tests.
   */
  connectGate?: () => number;
  /**
   * Optional: report a failed connect (quota/timeout/etc.) so the owner can park
   * the account in the shared back-off. Called with the raw error; the owner
   * classifies it (only quota/timeout errors actually park). Paired with
   * {@link connectGate} — one records the park, the other honours it.
   */
  onConnectError?: (error: unknown) => void;
}

// Max time a connection can be in-use before considered stuck (2 minutes)
const STUCK_CONNECTION_TIMEOUT = 120000;

/**
 * Thrown by createConnection() when the shared connect gate reports the account
 * is parked. Distinct from a real connect failure so acquire() can log it as an
 * expected back-off (info), not an error, and so callers can tell "we chose not
 * to connect" from "the connect attempt failed".
 */
export class PoolConnectionParkedError extends Error {
  constructor(public readonly remainingMs: number) {
    super(`Connection pool parked — ${Math.round(remainingMs / 1000)}s of server-connection-cap back-off left`);
    this.name = 'PoolConnectionParkedError';
  }
}

/**
 * IMAP Connection Pool
 *
 * Manages multiple IMAP connections for parallel folder operations.
 * Implements checkout/checkin pattern for connection reuse.
 */
export class IMAPConnectionPool {
  private connections: PooledConnection[] = [];
  private imapConfig: IMAPConfig | null = null;
  private nextConnectionId = 1;
  private closed = false;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  // In-flight createConnection() count. acquire() awaits the socket BEFORE the
  // connection is pushed, so without reserving the slot up front, concurrent
  // acquires all see the same pre-push length and over-provision past
  // maxConnections — dangerous against Gmail's ~15-connection cap.
  private pendingCreations = 0;

  constructor(private config: ConnectionPoolConfig = {
    maxConnections: 4,
    connectionTimeout: 30000,
    idleTimeout: 60000,
  }) {}

  /**
   * Initialize pool with IMAP configuration
   */
  async initialize(imapConfig: IMAPConfig): Promise<void> {
    this.imapConfig = imapConfig;
    this.closed = false;

    // Best-effort warm-up. The pool is a THROUGHPUT optimization layered on top of
    // the already-established primary connection — the caller connects AND validates
    // the config before initializing the pool — so failing to open the first pooled
    // socket must NOT fail the account connect. This legitimately fails on transient
    // conditions acquire() recovers from on demand: the per-account connection budget
    // momentarily saturated (the cold-start ramp, or a reconnect holding slots) or
    // parked for back-off. It used to throw, and the whole imap:connect handler then
    // logged a CONNECTION_ERROR and PARKED the account even though the primary was
    // connected and healthy. Start empty instead; acquire() opens pooled connections
    // on demand once a slot frees.
    try {
      const conn = await this.createConnection();
      this.connections.push(conn);
      logger.info(`Connection pool initialized (max: ${this.config.maxConnections})`);
    } catch (error) {
      // Only TRANSIENT/backpressure failures are swallowed: the connection budget
      // momentarily saturated (cold-start ramp / reconnect holding slots — surfaces
      // as a CONNECTION_ERROR "…timed out…"), a park for back-off, or a connect
      // blip — all of which acquire() recovers from on demand. A PERMANENT failure
      // (bad credentials, auth) still surfaces to the caller, so a genuinely broken
      // account is never masked as "connected".
      if (!isConnectionError(error) && !(error instanceof PoolConnectionParkedError)) {
        throw error;
      }
      logger.info(
        `Connection pool warm-up deferred (${(error as Error).message}) — starting empty; ` +
          `pooled connections open on demand (max: ${this.config.maxConnections})`,
      );
    }

    // Start idle connection cleanup
    this.startIdleCleanup();
  }

  /**
   * Evict dead and stuck connections from the pool so new ones can be created.
   * - Dead: not in use but disconnected (server dropped the connection)
   * - Stuck: in use for longer than STUCK_CONNECTION_TIMEOUT (leaked/hung)
   */
  private evictBadConnections(): number {
    const now = Date.now();
    const toEvict: PooledConnection[] = [];

    for (const conn of this.connections) {
      // Dead idle connection — disconnected while sitting in pool
      if (!conn.inUse && !conn.client.isConnected()) {
        logger.warn(`Pool: evicting dead idle connection #${conn.id}`);
        toEvict.push(conn);
        continue;
      }

      // Stuck connection — acquired too long ago, likely leaked or hung
      if (conn.inUse && (now - conn.acquiredAt) > STUCK_CONNECTION_TIMEOUT) {
        logger.warn(`Pool: evicting stuck connection #${conn.id} (in use for ${Math.round((now - conn.acquiredAt) / 1000)}s)`);
        conn.inUse = false; // Force-release so closeConnection doesn't skip it
        toEvict.push(conn);
        continue;
      }
    }

    for (const conn of toEvict) this.dropConnection(conn);

    return toEvict.length;
  }

  /**
   * Remove a connection from the pool SYNCHRONOUSLY, then disconnect it
   * fire-and-forget. Splicing before the (async) disconnect resolves is what
   * prevents a re-eviction/re-acquire loop: unlike `closeConnection` (which
   * splices only AFTER awaiting disconnect), the entry is gone from
   * `this.connections` the instant this returns, so neither the acquire find()
   * nor a following `evictBadConnections` can re-see and re-drop the same socket.
   */
  private dropConnection(conn: PooledConnection): void {
    const index = this.connections.indexOf(conn);
    if (index >= 0) {
      this.connections.splice(index, 1);
    }
    conn.client.disconnect().catch(() => {});
  }

  /**
   * Probe a pooled connection with a NOOP to prove it is really alive before
   * reuse. Returns false on a dead/erroring/hung socket (the timeout guards a
   * half-open connection that never answers). Any throw is treated as dead — the
   * caller drops the connection and opens a fresh one.
   */
  private async validateConnection(client: IIMAPClient): Promise<boolean> {
    if (typeof client.noop !== 'function') return true;
    try {
      return await withTimeout(client.noop(), NOOP_VALIDATE_TIMEOUT_MS, 'Pool NOOP validation timeout');
    } catch {
      return false;
    }
  }

  /**
   * Acquire a connection from the pool
   * Creates new connection if pool not at max capacity
   * Waits for available connection if at capacity
   */
  async acquire(): Promise<{ client: IIMAPClient; release: () => void; poison: () => void; touch: () => void }> {
    if (this.closed) {
      throw new Error('Connection pool is closed');
    }

    if (!this.imapConfig) {
      throw new Error('Connection pool not initialized');
    }

    const startTime = Date.now();

    for (;;) {
      // Check for available connection. Skip poisoned ones — they're mid
      // close/removal after an error and must never be handed out again.
      const available = this.connections.find(c => !c.inUse && !c.poisoned && c.client.isConnected());

      if (available) {
        // Reserve the slot BEFORE any await below, or a concurrent acquire could
        // see the same connection as free and hand it out twice.
        const idleMs = Date.now() - available.lastUsed;
        available.inUse = true;
        available.acquiredAt = Date.now();

        // Gmail silently drops idle sockets while isConnected() still reads true.
        // A connection that has sat idle past the staleness window is proven live
        // with a NOOP before reuse; a stale-but-dead one is dropped and we loop to
        // open a fresh one, instead of failing the caller's op (which reads as
        // churn). A recently-used connection is trusted without the round-trip.
        if (idleMs > STALE_REVALIDATE_MS && typeof available.client.noop === 'function') {
          const alive = await this.validateConnection(available.client);
          if (!alive) {
            logger.warn(`Pool: idle connection #${available.id} failed NOOP validation — dropping, will reacquire`);
            // Drop SYNCHRONOUSLY (splice now, disconnect fire-and-forget) so the
            // next loop iteration can't re-find or re-evict this known-dead socket
            // while its async close is still in flight — one probe, one drop.
            this.dropConnection(available);
            continue; // find another free connection or open a fresh one
          }
        }

        available.lastUsed = Date.now();
        // TRACE, not debug: this fires TWICE per pooled operation (acquire +
        // release), so a body-prefetch or backfill pass emits thousands of lines
        // in a burst — each one a synchronous write, tee'd to app.log in dev.
        // Same class as the per-command `IMAP <label> (Nms)` trace in
        // imapflow-client. Turn the pair on with SARV_LOG_LEVEL=trace.
        logger.trace(`Pool: acquired connection #${available.id}`);

        return {
          client: available.client,
          release: () => this.release(available),
          poison: () => { available.poisoned = true; },
          touch: () => { available.acquiredAt = Date.now(); },
        };
      }

      // Before giving up or waiting, evict dead/stuck connections to free slots
      const evicted = this.evictBadConnections();
      if (evicted > 0) {
        logger.info(`Pool: evicted ${evicted} bad connections, retrying acquire`);
        // Loop back immediately — slots are now free for new connections
        continue;
      }

      // Create new connection if under max. Count in-flight creations toward
      // the cap and reserve the slot BEFORE awaiting, so concurrent acquires
      // can't all pass this check and over-provision past maxConnections.
      if (this.connections.length + this.pendingCreations < this.config.maxConnections) {
        this.pendingCreations++;
        try {
          const conn = await this.createConnection();
          conn.inUse = true;
          conn.acquiredAt = Date.now();
          this.connections.push(conn);
          logger.debug(`Pool: created new connection #${conn.id} (total: ${this.connections.length})`);

          return {
            client: conn.client,
            release: () => this.release(conn),
            poison: () => { conn.poisoned = true; },
            touch: () => { conn.acquiredAt = Date.now(); },
          };
        } catch (error) {
          // A park is an expected, deliberate back-off, not a failure — log it as
          // info so it doesn't read as a connect-error storm during a long drain.
          if (error instanceof PoolConnectionParkedError) {
            logger.info(`Pool: not opening a new connection — ${Math.round(error.remainingMs / 1000)}s of server-connection-cap back-off left`);
          } else if (isConnectionError(error)) {
            // A TRANSIENT connect failure under load (Gmail rate/cap: "connect
            // timed out", "in required time", socket blip) is EXPECTED and
            // recovered from — the caller re-queues and the pool opens a fresh
            // connection on demand. Log at WARN with a retry framing so a flaky-
            // network moment doesn't read as an unrecoverable ERROR storm. Mirrors
            // the primary connection's 'error' handling in imapflow-client.ts.
            logger.warn(`Pool: connection attempt failed, will retry on demand: ${(error as Error)?.message ?? error}`);
          } else {
            // A genuine/unexpected failure (bad credentials, protocol error) is
            // NOT retryable the same way — keep it loud so it gets attention.
            logger.error('Pool: failed to create connection:', error);
          }
          throw error;
        } finally {
          this.pendingCreations--;
        }
      }

      // Check timeout
      if (Date.now() - startTime > this.config.connectionTimeout) {
        const stats = this.getStats();
        logger.error(`Pool: acquire timeout — total: ${stats.total}, inUse: ${stats.inUse}, available: ${stats.available}`);
        throw new Error('Timeout waiting for available connection');
      }

      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Release a connection back to the pool
   */
  private release(conn: PooledConnection): void {
    // If connection died while in use, remove it from pool
    if (!conn.client.isConnected()) {
      logger.warn(`Pool: releasing dead connection #${conn.id}, removing from pool`);
      conn.inUse = false;
      this.closeConnection(conn);
      return;
    }

    // Poisoned = the last op threw/timed out with a command potentially still
    // in flight, leaving the connection in an uncertain state. Drop it (a fresh
    // one is created on demand by the next acquire) rather than handing a
    // possibly-scrambled connection to the next task.
    if (conn.poisoned) {
      logger.warn(`Pool: discarding poisoned connection #${conn.id} (dirty pipeline after error/timeout)`);
      conn.inUse = false;
      this.closeConnection(conn);
      return;
    }

    conn.inUse = false;
    conn.lastUsed = Date.now();
    // TRACE for the same reason as the matching acquire above.
    logger.trace(`Pool: released connection #${conn.id}`);
  }

  /**
   * Create a new IMAP connection
   */
  private async createConnection(): Promise<PooledConnection> {
    if (!this.imapConfig) {
      throw new Error('No IMAP config available');
    }

    // Shared back-off gate: if this account recently hit the server's connection
    // cap (or a connect timeout, the same saturated condition), do NOT open
    // another socket — that only re-saturates the cap and prolongs the lockout.
    // Fail fast with a typed park error so the drain/backfill task backs off and
    // retries once the window elapses, in lockstep with the other connect paths.
    const parkedMs = this.config.connectGate?.() ?? 0;
    if (parkedMs > 0) {
      throw new PoolConnectionParkedError(parkedMs);
    }

    // Pool sockets are bulk/background work — tag them so the connection governor
    // gives the user-facing primary/IDLE its reserved headroom and priority.
    const client = new ImapFlowClient({ role: 'background' });
    try {
      await client.connect(this.imapConfig);
    } catch (error) {
      // Let the owner park the account on a quota/timeout failure so the very
      // next pool acquire (and every other connect path) sees the gate closed.
      this.config.onConnectError?.(error);
      throw error;
    }

    return {
      client,
      inUse: false,
      lastUsed: Date.now(),
      acquiredAt: 0,
      id: this.nextConnectionId++,
      poisoned: false,
    };
  }

  /**
   * Start periodic cleanup of idle and dead connections
   */
  private startIdleCleanup(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    this.idleCheckInterval = setInterval(() => {
      const now = Date.now();

      // First, evict any dead or stuck connections
      this.evictBadConnections();

      // Keep at least one connection
      if (this.connections.length <= 1) return;

      // Find idle connections to close
      const toClose = this.connections.filter(c =>
        !c.inUse &&
        (now - c.lastUsed) > this.config.idleTimeout
      );

      // Keep at least one connection
      const closeCount = Math.min(toClose.length, this.connections.length - 1);

      for (let i = 0; i < closeCount; i++) {
        const conn = toClose[i];
        this.closeConnection(conn);
      }

      if (closeCount > 0) {
        logger.debug(`Pool: closed ${closeCount} idle connections (remaining: ${this.connections.length})`);
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Close a single connection
   */
  private async closeConnection(conn: PooledConnection): Promise<void> {
    try {
      await conn.client.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    const index = this.connections.indexOf(conn);
    if (index >= 0) {
      this.connections.splice(index, 1);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): { total: number; inUse: number; available: number } {
    const inUse = this.connections.filter(c => c.inUse).length;
    return {
      total: this.connections.length,
      inUse,
      available: this.connections.length - inUse,
    };
  }

  /**
   * Check if pool is initialized
   */
  isInitialized(): boolean {
    return this.imapConfig !== null && !this.closed;
  }

  /**
   * Remaining shared connection-cap back-off for this account, in ms (0 = the
   * gate is open). Lets a drain loop pause the WHOLE queue for the park window
   * instead of pulling every item and having each refused at `acquire()` — which
   * both burns retry budget and floods the log one line per item.
   */
  remainingParkMs(): number {
    return Math.max(0, this.config.connectGate?.() ?? 0);
  }

  /**
   * Close all connections and shutdown pool
   */
  async close(): Promise<void> {
    this.closed = true;

    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    // Close all connections
    await Promise.all(
      this.connections.map(conn => this.closeConnection(conn))
    );

    this.connections = [];
    this.imapConfig = null;

    logger.info('Connection pool closed');
  }

  /**
   * Execute a function with a pooled connection
   * Automatically acquires and releases connection
   */
  async withConnection<T>(fn: (client: IIMAPClient, touch: () => void) => Promise<T>): Promise<T> {
    const { client, release, poison, touch } = await this.acquire();

    try {
      // `touch` lets a legitimately-long task (e.g. the folder drain: fetchAllUIDs
      // + many 60s FETCH batches) signal progress per sub-step, refreshing the
      // connection's acquiredAt so stuck-eviction (STUCK_CONNECTION_TIMEOUT) can't
      // pull the socket out from under it mid-run and churn a replacement.
      return await fn(client, touch);
    } catch (error) {
      // Discard the connection if the SOCKET is broken OR the operation timed
      // out. A command-level rejection (server NO/BAD — e.g. SELECT of an
      // unselectable folder) leaves the connection healthy; poisoning there
      // would churn sockets in a tight retry loop, so we reuse it.
      //
      // A TIMEOUT is different: withTimeout only stops us awaiting — the
      // underlying ImapFlow SELECT/FETCH is still in flight on the socket. The
      // socket still looks connected, so the old `!isConnected()` check missed
      // this and released the connection dirty. Reusing it overlapped a new
      // SELECT/FETCH on top of the abandoned command, scrambling ImapFlow's
      // response pipeline until the server dropped the socket ("Unexpected
      // close") and triggered a mass reconnect. Poison on timeout so the
      // dangling command dies with the closed connection instead.
      if (!client.isConnected() || isTimeoutError(error)) {
        poison();
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Execute multiple functions in parallel using pool connections.
   * Each function gets its own connection.
   *
   * The result is INDEX-ALIGNED with `tasks`: slot i holds task i's value, or
   * `undefined` if it failed or was cancelled by a pool close. It used to be
   * `.filter(r => r !== undefined)`-ed, which conflated "this task failed" with
   * "this task legitimately returned undefined" and silently compacted the array
   * so no caller could line results up with the folders it passed in.
   */
  async parallel<T>(
    tasks: Array<(client: IIMAPClient) => Promise<T>>,
    concurrency?: number
  ): Promise<Array<T | undefined>> {
    // Check if pool is closed before starting
    if (this.closed) {
      logger.warn('Pool: parallel called on closed pool, skipping');
      return [];
    }

    const maxConcurrency = concurrency || this.config.maxConnections;
    const results: Array<T | undefined> = new Array(tasks.length).fill(undefined);
    const errors: Error[] = [];
    // Once the shared connection-cap gate closes mid-run, EVERY remaining task
    // would be refused at acquire() with the same PoolConnectionParkedError. The
    // old code logged each as an ERROR and kept pulling — 11 folder-sync tasks
    // became 11 error lines for a single park window (the "tons of errors" flood).
    // Treat the first park as a signal to STOP this run: leave the un-run tasks as
    // undefined (the caller retries on its next tick, when the window may be open)
    // and log ONCE, not once per task. A park is a back-off, not a failure.
    let parked = false;
    // Carry each task's index with it. `tasks.indexOf(task)` resolved every
    // duplicate function reference to the SAME index (a caller that passes the
    // same closure twice, or `Array(n).fill(fn)`), so those tasks overwrote one
    // another's result and left holes elsewhere.
    const taskQueue = tasks.map((task, index) => ({ task, index }));
    const inProgress: Promise<void>[] = [];

    const runNext = async (): Promise<void> => {
      // Skip if pool was closed during execution, or the gate parked this run.
      if (this.closed || parked || taskQueue.length === 0) return;

      const { task, index } = taskQueue.shift()!;

      try {
        const result = await this.withConnection(task);
        results[index] = result;
      } catch (error) {
        // Don't throw if pool was closed - this is expected during shutdown
        if (this.closed || (error as Error).message?.includes('pool is closed')) {
          logger.debug(`Pool: task ${index} cancelled due to pool closure`);
          return;
        }
        // Shared connection-cap back-off closed the gate: not a failure, and every
        // remaining task would hit the same wall. Stop the run silently (one info
        // line, no error), drain the queue so no new task starts, and let the
        // caller retry after the window. Must be caught here (not counted as an
        // error) or it re-creates the per-task flood this guard exists to prevent.
        if (error instanceof PoolConnectionParkedError) {
          if (!parked) {
            parked = true;
            logger.info(`Pool: parallel paused — ${Math.round(error.remainingMs / 1000)}s of server-connection-cap back-off left; ${taskQueue.length} task(s) deferred to the next tick`);
          }
          taskQueue.length = 0; // cancel the rest of this run
          return;
        }
        logger.error(`Pool: parallel task ${index} failed:`, error);
        errors.push(error as Error);
        // Don't throw - continue with other tasks
      }
    };

    // Start initial batch
    while (inProgress.length < maxConcurrency && taskQueue.length > 0 && !this.closed && !parked) {
      const promise = runNext().then(() => {
        inProgress.splice(inProgress.indexOf(promise), 1);
      });
      inProgress.push(promise);
    }

    // Process remaining tasks as slots become available
    while ((taskQueue.length > 0 || inProgress.length > 0) && !this.closed && !parked) {
      if (inProgress.length > 0) {
        await Promise.race(inProgress);
      }

      while (inProgress.length < maxConcurrency && taskQueue.length > 0 && !this.closed && !parked) {
        const promise = runNext().then(() => {
          inProgress.splice(inProgress.indexOf(promise), 1);
        });
        inProgress.push(promise);
      }
    }

    // Wait for remaining in-progress tasks
    if (inProgress.length > 0) {
      await Promise.all(inProgress);
    }

    // Log if there were errors but we continued
    if (errors.length > 0) {
      logger.warn(`Pool: parallel completed with ${errors.length} errors`);
    }

    return results;
  }
}
