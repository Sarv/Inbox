// IMAP client implementation using ImapFlow (actively maintained, async/await).
//
// This is the app's sole IMAP client. It implements the `IIMAPClient` contract
// plus the extra surface the connection manager / pool rely on (EventEmitter
// 'error'/'end' events, `noop()`, `setShuttingDown()`).
//
// ImapFlow serializes commands internally via mailbox locks and handles
// unsolicited `* FETCH` responses correctly, giving a modern Promise/
// async-iterator API with a stable response pipeline.

import { EventEmitter } from 'events';

import type {
  ImapFlowOptions,
  FetchMessageObject,
  MessageStructureObject,
  MessageAddressObject,
  ListResponse,
  SearchObject,
  ExistsEvent,
  ExpungeEvent,
  FlagsEvent,
} from 'imapflow';
import { ImapFlow } from 'imapflow';

import type {
  IIMAPClient,
  IMAPConfig,
  IMAPFolder,
  FolderStatus,
  IMAPMessage,
  FetchOptions,
  SearchCriteria,
  IMAPEvent,
  ConnectionState,
  EmailAddress,
  BodyStructure,
  FlagChange,
} from '../types/imap';
import { IMAPError } from '../types/imap';
import { logger } from '../utils/logger';
import { withTimeout, withStallTimeout, isTimeoutError } from '../utils/timeout';

import { acquireConnectionSlot, type ConnectionPriority } from './connection-budget';
import { isConnectionError, isAuthError } from './imap-errors';
import { TOKEN_REQUEST_TIMEOUT_MS } from '../oauth/token-refresher';

// Max time to wait for the OAuth bearer resolver (token refresh) during connect.
// It runs before any socket opens; a hung DNS/OAuth window must fail fast into the
// reconnect ladder instead of stalling the whole connect. Kept modest so
// resolveBearer + the connect bound below stays within callers' outer timeouts.
//
// DERIVED, not a second magic number: the token POST now aborts ITSELF at
// TOKEN_REQUEST_TIMEOUT_MS, and this race must stay strictly LARGER or it would
// fire first — rejecting us while leaving the HTTP request running, which is
// precisely the orphaned-refresh bug that got a rotating session revoked. This
// is now only a backstop for a resolver that hangs OUTSIDE the HTTP call (a
// wedged token-store read/write).
const RESOLVE_BEARER_TIMEOUT_MS = TOKEN_REQUEST_TIMEOUT_MS + 2_000;
// Ceiling for the whole-connect bound (socket + greeting + AUTHENTICATE). Caps the
// derived `connectionTimeout*2` so the inner connect timeout can't be configured
// above the callers' outer budgets (foreground/background/forceReconnect ~25s+),
// keeping the force-close-on-stall the first thing to fire in the common case.
const CONNECT_TIMEOUT_CEILING_MS = 22000;
// Max time to wait for a per-account connection slot before failing the connect
// (treated as a connection error → backoff). A held slot frees when its socket
// closes (force-closed on the connect timeout above), so a wait resolves quickly.
const CONNECT_BUDGET_WAIT_MS = 20000;

interface IdleHandlers {
  exists: (data: ExistsEvent) => void;
  flags: (data: FlagsEvent) => void;
  expunge: (data: ExpungeEvent) => void;
}

/**
 * Whether to open an IMPLICIT-TLS connection (SSL on port 993). The first-class
 * `security` field is authoritative when present; otherwise fall back to the
 * legacy `secure` boolean. Only 'ssl' means implicit TLS — 'starttls'/'none'
 * connect plain and ImapFlow upgrades via STARTTLS when the server offers it.
 * Pure + exported so the ssl/starttls/none mapping is unit-testable.
 */
export function resolveImplicitTls(config: { security?: 'ssl' | 'starttls' | 'none'; secure: boolean }): boolean {
  return config.security ? config.security === 'ssl' : config.secure;
}

export class ImapFlowClient extends EventEmitter implements IIMAPClient {
  private client: ImapFlow | null = null;
  private currentFolder: string | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private capabilities: string[] = [];
  private shuttingDown = false;
  private idleHandlers: IdleHandlers | null = null;
  /** Host of the last connect() config — see IIMAPClient.host. */
  private connectedHost: string | null = null;
  // Releases this connection's per-account budget slot (see connection-budget).
  // Set on acquire (before connect), cleared on any close path. Idempotent.
  private releaseBudget: (() => void) | null = null;
  // Connection-governor priority for THIS client's socket. The user-facing primary
  // / IDLE connection is 'foreground' (full cap, jumps the queue); pool bulk work
  // (drain/backfill/labels/prefetch) constructs with 'background' so it yields the
  // reserved headroom and never starves the primary. See connection-budget.ts.
  private readonly role: ConnectionPriority;
  get host(): string | null { return this.connectedHost; }

  constructor(options: { role?: ConnectionPriority } = {}) {
    super();
    this.role = options.role ?? 'foreground';
  }

  /** Suppress error logging/emission during intentional shutdown. */
  setShuttingDown(): void {
    this.shuttingDown = true;
  }

  // ========== Connection ==========

  async connect(config: IMAPConfig): Promise<void> {
    if (this.connectionState === 'connected' || this.connectionState === 'authenticated' || this.connectionState === 'selected') {
      logger.warn('Already connected to IMAP server');
      return;
    }
    // Re-entrancy guard: a second connect() while one is already in flight would
    // build a SECOND ImapFlow and overwrite this.client, orphaning the first
    // socket mid-handshake (a leaked connection against the per-account cap).
    // Callers must disconnect() first to reconnect; a concurrent connect is a bug.
    if (this.connectionState === 'connecting') {
      logger.warn('connect() called while already connecting — ignoring the duplicate');
      return;
    }

    if (config.authMethod === 'oauth2' && !config.accessToken && !config.resolveBearer) {
      throw new IMAPError('OAuth2 auth requested but no accessToken or resolveBearer', 'OAUTH_MISSING_TOKEN');
    }

    // Resolve a FRESH bearer per connect for OAuth accounts (done here, before
    // flipping to 'connecting', so a refresh failure leaves the client cleanly
    // disconnected). This is what makes pooled worker connections and reconnects
    // authenticate with a currently-valid token instead of the one captured when
    // the pool was first built — the root of the "Invalid or expired token"
    // pool failures. Falls back to the static accessToken when no resolver.
    let oauthAccessToken = config.accessToken;
    if (config.authMethod === 'oauth2' && config.resolveBearer) {
      try {
        // Bound the OAuth resolve: it runs BEFORE any socket opens, and a cold /
        // wedged DNS window (e.g. transient ENOTFOUND for the OAuth host) can make
        // it HANG rather than throw — which would stall the whole connect until the
        // caller's outer timeout, wasting a reconnect slot. Fail fast into the ladder.
        oauthAccessToken = await withTimeout(config.resolveBearer(), RESOLVE_BEARER_TIMEOUT_MS, 'OAuth token refresh timed out');
      } catch (err) {
        throw new IMAPError(
          `OAuth token refresh failed: ${(err as Error).message}`,
          'OAUTH_REFRESH_FAILED',
        );
      }
    }

    try {
      await this.establishWithToken(config, oauthAccessToken);
    } catch (err) {
      // The server REJECTED our token at AUTHENTICATE even though the lazy gate
      // handed us one it thought valid — clock skew, or a revoke-then-reissue on
      // the OAuth server. Force a token refresh and retry the connect ONCE (the
      // IMAP analog of the SMTP refresh-on-send). Only for OAuth accounts that can
      // refresh, and only on a genuine auth error — quota ("too many
      // connections"), connection, and timeout failures propagate unchanged so
      // the connection manager's own backoff/ladder handles them.
      if (config.authMethod === 'oauth2' && config.resolveBearer && isAuthError(err)) {
        logger.warn('IMAP auth rejected — force-refreshing the OAuth token and retrying connect once');
        let freshToken: string | undefined;
        try {
          freshToken = await withTimeout(config.resolveBearer(true), RESOLVE_BEARER_TIMEOUT_MS, 'OAuth token refresh timed out');
        } catch (refreshErr) {
          throw new IMAPError(`OAuth token refresh failed: ${(refreshErr as Error).message}`, 'OAUTH_REFRESH_FAILED');
        }
        await this.establishWithToken(config, freshToken);
      } else {
        throw err;
      }
    }
  }

  /**
   * Build the ImapFlow client for a resolved access token (or password) and
   * connect it. Split out of connect() so an OAuth auth rejection can retry it
   * once with a force-refreshed token without duplicating the setup.
   */
  private async establishWithToken(config: IMAPConfig, oauthAccessToken: string | undefined): Promise<void> {
    this.connectedHost = config.host;
    this.connectionState = 'connecting';

    // Connection security: when the first-class `security` field is set it is
    // authoritative; otherwise fall back to the legacy `secure` boolean. Only
    // 'ssl' means implicit TLS (port 993). For 'starttls'/'none' we pass
    // secure:false — ImapFlow then upgrades via STARTTLS when the server
    // advertises it (a plain-TCP connect for a server that doesn't). We never
    // downgrade below what the user asked for.
    const useImplicitTls = resolveImplicitTls(config);

    const options: ImapFlowOptions = {
      host: config.host,
      port: config.port,
      secure: useImplicitTls,
      auth: config.authMethod === 'oauth2'
        ? { user: config.username, accessToken: oauthAccessToken }
        : { user: config.username, pass: config.password },
      // ImapFlow is noisy by default; route nothing unless we opt in.
      logger: false,
      // Enable QRESYNC (RFC 7162) when the server advertises it: ImapFlow then
      // ENABLEs it (a safe no-op otherwise), makes EXPUNGE responses carry the
      // UID, and — on a SELECT with (changedSince, uidValidity) — surfaces
      // `VANISHED (EARLIER)` as `expunge` events. That's how we detect messages
      // deleted while the app was away without a full-folder UID diff.
      qresync: true,
      connectionTimeout: config.connectionTimeout || 10000,
      greetingTimeout: config.connectionTimeout || 10000,
      // Keepalive: ImapFlow auto-IDLEs in the background while a mailbox is
      // open and re-issues IDLE every maxIdleTime — this is the ONLY keepalive
      // we rely on (the realtime manager no longer fires its own NOOP, which
      // used to break IDLE every 90s and cause reconnect flapping). 10 min sits
      // comfortably under the RFC 2177 ~29 min server IDLE timeout while keeping
      // the TCP path + NAT mapping warm, and matches how Apple Mail/Thunderbird
      // pace their refresh.
      maxIdleTime: 10 * 60 * 1000,
      // Backstop for a dead socket: no bytes from the server for this long tears
      // the connection down so ConnectionManager rebuilds it. Must exceed
      // maxIdleTime (10 min) so a healthy IDLE refresh always resets it first;
      // 13 min gives the refresh room without letting a wedged socket linger.
      socketTimeout: 13 * 60 * 1000,
      tls: config.tlsOptions
        ? { rejectUnauthorized: config.tlsOptions.rejectUnauthorized }
        : undefined,
    };

    logger.info('IMAP config (ImapFlow)', {
      host: options.host,
      port: options.port,
      secure: options.secure,
      security: config.security ?? (config.secure ? 'ssl' : 'starttls'),
    });

    const client = new ImapFlow(options);
    this.client = client;

    // Connection-level errors after connect() resolves are surfaced as events
    // (the connection manager listens and decides whether to reconnect).
    client.on('error', (err: Error) => {
      if (!this.shuttingDown) {
        // A connection-level drop ("Unexpected close", socket reset, etc.) is
        // expected on flaky networks/startup and the connection manager
        // reconnects (logging its own attempt) — log concisely at debug rather
        // than an ERROR + stack. Genuine (non-connection) errors stay loud.
        if (isConnectionError(err)) {
          logger.debug(`IMAP connection error (reconnecting): ${err.message}`);
        } else {
          logger.error('IMAP error (ImapFlow):', err);
        }
        this.connectionState = 'error';
        this.emit('error', new IMAPError(err.message, 'CONNECTION_ERROR', err.message));
      }
    });

    client.on('close', () => {
      logger.info('IMAP connection closed (ImapFlow)');
      this.connectionState = 'disconnected';
      // Free this account's connection slot the moment the socket closes — the
      // one reliable release point (fires on graceful disconnect, force-close, and
      // server drop alike). Idempotent, so the catch below can also call it.
      this.releaseBudget?.();
      this.releaseBudget = null;
      this.emit('end');
    });

    try {
      // Acquire a per-account connection slot BEFORE opening the socket. This is
      // the ONE bound on the TOTAL sockets to this account (primary + pool + IDLE +
      // background + reconnect overlap) — it's what actually keeps Gmail under its
      // ~15 cap, instead of each source capping only itself. Rejects (→ treated as
      // a connection error, backed off) if no slot frees in time, rather than
      // opening past the cap.
      this.releaseBudget = await acquireConnectionSlot(config.host, config.username, CONNECT_BUDGET_WAIT_MS, this.role);

      // Bound the WHOLE connect, not just the socket+greeting. ImapFlow's
      // connectionTimeout/greetingTimeout (10s) cover the socket and server
      // greeting, but the AUTHENTICATE phase after that is bounded only by the
      // 13-minute socketTimeout. Near a server's per-account connection cap (Gmail
      // ~15) AUTH stalls, so a caller's outer withTimeout would fire and ABANDON
      // this await — leaving the socket half-open for up to 13 min, holding a slot
      // and deepening the "too many connections / Unexpected close" spiral. Timing
      // out here routes into the catch below, which force-closes the socket so a
      // stalled connect releases its slot immediately.
      //
      // IMPORTANT: this force-close is the AUTHORITATIVE leak-prevention and runs
      // whenever this inner timer fires — it does NOT depend on firing before any
      // outer caller timeout. Even if an outer withTimeout wins the race and
      // abandons the await, this timer still fires later and closes the socket, so
      // the slot is always reclaimed. The `min(...)` just keeps it at/under the
      // callers' budget (foreground/background/forceReconnect all use ≥ this) so in
      // the common case the specific "IMAP connect timed out" reason surfaces.
      const connectTimeoutMs = Math.min((config.connectionTimeout || 10000) * 2, CONNECT_TIMEOUT_CEILING_MS);
      await withTimeout(client.connect(), connectTimeoutMs, 'IMAP connect timed out');
    } catch (err) {
      this.connectionState = 'error';
      // Edge case for the "too many connections" spiral (rare but real): the
      // connect may have opened the TCP/TLS socket BEFORE failing — e.g. rejected
      // at AUTHENTICATE with "Too many simultaneous connections", or timed out
      // mid-AUTH (above) — and ImapFlow does not guarantee that socket is torn
      // down. Force-close it (logout() is wrong here — unauthenticated, and would
      // hang), drop its listeners so the dead socket can't fire a late
      // 'close'/'error' into the manager, and clear our ref. Without this a FAILED
      // or TIMED-OUT attempt can LEAK its own socket, which itself counts against
      // the server's per-account cap and deepens the spiral.
      try { client.close(); } catch { /* socket already gone */ }
      try { (client as unknown as EventEmitter).removeAllListeners(); } catch { /* ignore */ }
      // ImapFlow runs its greeting→AUTH sequence DETACHED (startSession is fired
      // without an await), so a connect we force-close here can still reject that
      // out-of-band chain a tick LATER — typically AuthenticationFailure("Already
      // logged out"). ImapFlow routes such a post-settlement error through
      // emitError → `emit('error')`; with the line above having removed every
      // listener, a listener-less 'error' emit THROWS (Node EventEmitter contract)
      // inside that fire-and-forget catch and surfaces as a process-level
      // "Unhandled rejection: Error: Already logged out". Re-attach a silent sink so
      // the dead client's late error is absorbed — we still detached from the
      // connection manager above, so this causes no spurious reconnect.
      try {
        (client as unknown as EventEmitter).on('error', () => {
          /* dead connect: ImapFlow's out-of-band teardown error, already handled */
        });
      } catch { /* ignore */ }
      this.client = null;
      // removeAllListeners above dropped the 'close' handler, so release the
      // connection slot here too (idempotent) — a failed/timed-out attempt must
      // never leak its slot against the account's budget.
      this.releaseBudget?.();
      this.releaseBudget = null;
      // The connect sequence runs several commands (CAPABILITY, LOGIN, ENABLE
      // QRESYNC/CONDSTORE, NAMESPACE, ID…). A bare "Command failed" hides WHICH
      // one — route through toImapError so the message carries the server's
      // response text + the executed command (e.g. "NO … (cmd: A ENABLE …)").
      throw this.toImapError(err, 'CONNECTION_ERROR');
    }

    this.connectionState = 'authenticated';
    this.capabilities = [...client.capabilities.keys()].map((c) => c.toUpperCase());

    // Enable TCP-level keepalive on the underlying socket so the OS holds the
    // NAT/firewall mapping open with cheap probes (first probe after 60s idle),
    // instead of relying on application-level command traffic. This is what lets
    // a laptop that's "on and connected but idle" keep a live IDLE connection
    // rather than silently losing it to a middlebox timeout. Best-effort: guard
    // for older ImapFlow internals that may not expose the socket.
    try {
      (client as unknown as { socket?: { setKeepAlive?: (enable: boolean, initialDelay: number) => void } })
        .socket?.setKeepAlive?.(true, 60_000);
    } catch {
      // ignore — keepalive is an optimization, not required for correctness
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client || this.connectionState === 'disconnected') {
      return;
    }

    // logout() can hang on a dead socket — cap it, then force-close.
    try {
      await Promise.race([
        client.logout(),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // ignore — falling through to force close
    }
    try {
      client.close();
    } catch {
      // socket already gone
    }

    // Release the connection slot NOW rather than waiting for the async 'close'
    // event — so a follow-on reconnect can reuse the slot immediately instead of
    // waiting out the budget. Idempotent with the 'close' handler.
    this.releaseBudget?.();
    this.releaseBudget = null;

    this.client = null;
    this.currentFolder = null;
    this.connectionState = 'disconnected';
  }

  isConnected(): boolean {
    if (this.connectionState !== 'authenticated' && this.connectionState !== 'selected') return false;
    // The socket can die out from under our state machine. A wedged FETCH is
    // recycled by close()ing the client (see op()), and until ImapFlow's 'close'
    // event lands our own `connectionState` still reads 'authenticated'. Callers
    // that gate on isConnected() then act on a corpse: background sync logs
    // "re-armed IDLE (socket alive)" and both IDLE and its polling fallback fail
    // with ImapFlow's own "Connection not available" — every cycle, for the life
    // of the session, leaving that account with NO live monitoring at all.
    //
    // So trust the client's own usability as well. `undefined` means a client
    // that doesn't report it (or a test double), which stays connected.
    const usable = (this.client as { usable?: boolean } | null | undefined)?.usable;
    return usable !== false;
  }

  private ensureConnected(): void {
    if (!this.isConnected() || !this.client) {
      throw new IMAPError('Not connected to IMAP server', 'NOT_CONNECTED');
    }
  }

  /**
   * Convert an ImapFlow command error into an IMAPError that preserves the
   * server's real reason. ImapFlow throws a generic `Error('Command failed')`
   * for any tagged NO/BAD response and hangs the actual detail off
   * `responseStatus` (NO/BAD), `responseText` (server text) and
   * `executedCommand` (the command we sent). Without this those are lost and
   * every failure just reads "Command failed".
   */
  // Per-operation timeout. Every IMAP command is raced against this so a
  // half-dead socket can't hang a sync/flag/fetch for minutes. Kept well under
  // the socket timeout; the connection manager's reconnect ladder recovers.
  private static readonly OP_TIMEOUT_MS = 60_000;

  // Lightweight metadata commands (STATUS, and other cheap folder peeks) return
  // in well under a second on a healthy server — they don't fetch a byte of body.
  // Racing them at the full bulk-FETCH budget means a WEDGED metadata command
  // sits for a whole minute before the op() catch recycles the socket. Half the
  // budget still clears a genuinely slow-but-alive Gmail STATUS (seconds, not
  // tens of seconds) while cutting wedge-detection latency in half.
  private static readonly META_OP_TIMEOUT_MS = 30_000;

  // A command that STREAMS a message body (FETCH ... BODY[]) is the one command
  // whose duration is a property of the data, not of the server's health: a
  // 40 MB message cannot arrive in 60 seconds on any ordinary link. Racing it
  // against the flat budget above made every such message permanently
  // un-fetchable — the download was killed at 60s, the socket recycled as
  // "wedged", the item re-queued, and the next attempt restarted from byte zero
  // and died at exactly the same point, forever. So a streaming fetch is judged
  // on whether bytes are still ARRIVING rather than on the clock: silence for
  // STREAM_STALL_MS is a wedge, while a transfer that keeps delivering is left
  // alone up to STREAM_MAX_MS. Both are enforced by `withStallTimeout`.
  private static readonly STREAM_STALL_MS = 30_000;

  private static readonly STREAM_MAX_MS = 5 * 60_000;

  /** Race an ImapFlow command against OP_TIMEOUT_MS so nothing hangs forever. */
  private op<T>(label: string, promise: Promise<T>, ms = ImapFlowClient.OP_TIMEOUT_MS): Promise<T> {
    return this.guard(label, withTimeout(promise, ms, `IMAP ${label} timed out after ${ms}ms`));
  }

  /**
   * Race a command that STREAMS message data against a stall, not a deadline.
   * Use this for the one command whose duration scales with the size of what it
   * downloads; every other command is fixed-size work and belongs on `op`.
   *
   * Progress is the connection's cumulative received-byte counter. On a pooled
   * connection — which serves one fetch at a time — that is exactly this
   * transfer. On the shared primary, another command's bytes can also read as
   * progress; that can only ever DELAY a give-up, never cause a premature one,
   * and STREAM_MAX_MS still bounds it.
   */
  private opStreaming<T>(label: string, promise: Promise<T>): Promise<T> {
    return this.guard(label, withStallTimeout(promise, {
      stallMs: ImapFlowClient.STREAM_STALL_MS,
      maxMs: ImapFlowClient.STREAM_MAX_MS,
      progress: () => this.bytesReceived(),
      message: `IMAP ${label} timed out`,
    }));
  }

  /** Wedge-detection + tracing shared by `op` and `opStreaming`. */
  private guard<T>(label: string, wrapped: Promise<T>): Promise<T> {
    const started = Date.now();
    // A timed-out command is STILL in-flight on the socket (ImapFlow serializes
    // commands per connection), so every command queued behind it also times out
    // at ${ms}ms — for minutes, until the 3-min health-check / 13-min socket
    // timeout finally recycles. That is the "heavy-account timeout cascade".
    // Recycle the wedged connection immediately: close() drops the socket so
    // ImapFlow rejects the queued commands (fail-fast, not 60s each), the pool
    // evicts it, and the primary reconnects (rate-limited by the reconnect
    // backoff). Only on a TIMEOUT, never mid-shutdown or on an already-dead socket.
    void wrapped.catch((err) => {
      if (this.shuttingDown || this.connectionState === 'disconnected') return;
      if (!isTimeoutError(err)) return;
      logger.warn(`${(err as Error).message} — recycling the wedged connection`);
      try { this.client?.close(); } catch { /* socket already gone */ }
    });
    // Trace EVERY IMAP command we issue, with timing. TRACE-level (the full
    // firehose): during a sync this fires per FETCH/SELECT/STATUS and would flood
    // even the debug log, so it's off at debug and only shows at
    // SARV_LOG_LEVEL=trace — the complete IMAP record for the mail-server team.
    // Separate (void) subscription: it only observes; the caller still gets
    // `wrapped` and owns the error, so this adds no unhandled rejection.
    if (logger.isLevelEnabled('trace')) {
      void wrapped.then(
        () => logger.trace(`IMAP ${label} (${Date.now() - started}ms)`),
        (e) => logger.trace(`IMAP ${label} FAILED (${Date.now() - started}ms): ${(e as Error)?.message ?? e}`),
      );
    }
    return wrapped;
  }

  private toImapError(err: unknown, code: string): IMAPError {
    const e = err as Error & {
      code?: string;
      responseStatus?: string;
      responseText?: string;
      executedCommand?: string;
      throttleReset?: number;
    };
    const detail = [
      e?.responseStatus ? `${e.responseStatus}` : null,
      e?.responseText ?? null,
    ]
      .filter(Boolean)
      .join(' ');
    const cmd = e?.executedCommand ? ` (cmd: ${e.executedCommand})` : '';
    const message = detail ? `${e.message}: ${detail}${cmd}` : (e?.message ?? 'IMAP command failed');
    // Preserve ImapFlow's throttle signal so callers can honor the server's
    // suggested backoff instead of retrying blindly. ETHROTTLE wins over the
    // generic caller-supplied code.
    const imapError = new IMAPError(
      message,
      e?.code === 'ETHROTTLE' ? 'ETHROTTLE' : code,
      e?.responseText,
      e?.executedCommand,
      e?.responseStatus,
    );
    if (typeof e?.throttleReset === 'number') {
      (imapError as IMAPError & { throttleReset?: number }).throttleReset = e.throttleReset;
    }
    return imapError;
  }

  /**
   * Send NOOP to verify the connection is alive and reset the server idle timer.
   * Returns false instead of throwing so callers can use it as a liveness probe.
   */
  async noop(): Promise<boolean> {
    if (!this.client || !this.isConnected()) {
      return false;
    }
    try {
      await this.client.noop();
      return true;
    } catch (err) {
      logger.warn('NOOP failed:', (err as Error).message);
      return false;
    }
  }

  /**
   * Bytes read off this socket so far, from ImapFlow's own counter. Cumulative
   * and never reset here, so a caller can sample it to tell a transfer that is
   * merely slow from one that has hung — see `withStallTimeout`. Returns NaN
   * (deliberately not 0) when there is no client to ask: a constant would look
   * like a permanent stall, whereas NaN is read as "no reading available".
   */
  bytesReceived(): number {
    try {
      return this.client?.stats().received ?? Number.NaN;
    } catch {
      return Number.NaN;
    }
  }

  // ========== Folder Operations ==========

  async listFolders(): Promise<IMAPFolder[]> {
    this.ensureConnected();
    const list = await this.op('LIST', this.client!.list());
    return this.buildFolderTree(list);
  }

  private buildFolderTree(list: ListResponse[]): IMAPFolder[] {
    const byPath = new Map<string, IMAPFolder>();
    for (const item of list) {
      byPath.set(item.path, {
        name: item.name,
        path: item.path,
        delimiter: item.delimiter || '/',
        specialUse: item.specialUse || (item.flags?.has('\\Inbox') ? '\\Inbox' : null),
        subscribed: item.subscribed ?? false,
        selectable: !item.flags?.has('\\Noselect'),
        children: [],
      });
    }

    const roots: IMAPFolder[] = [];
    for (const item of list) {
      const node = byPath.get(item.path)!;
      const parent = item.parentPath ? byPath.get(item.parentPath) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async selectFolder(folderPath: string): Promise<FolderStatus> {
    this.ensureConnected();
    return this.openFolder(folderPath);
  }

  async selectFolderWithCondstore(folderPath: string): Promise<FolderStatus> {
    this.ensureConnected();
    // ImapFlow auto-enables CONDSTORE when available, so mailboxOpen already
    // returns highestModseq — no separate code path needed.
    const status = await this.openFolder(folderPath);
    if (status.highestModseq) {
      logger.debug(`CONDSTORE: ${folderPath} highestModseq=${status.highestModseq}`);
    }
    return status;
  }

  /**
   * Cheapest possible "make sure this mailbox is selected" for latency-sensitive
   * flag ops (read/star). Two round-trips are shaved vs. `selectFolder`:
   *  - if the live connection is ALREADY open on this exact mailbox, no-op (skip
   *    the redundant SELECT) — uses ImapFlow's own `mailbox.path` as the truth so
   *    it stays correct across reconnects (a dropped socket clears `mailbox`);
   *  - otherwise SELECT but skip the follow-up STATUS(unseen) round-trip, which a
   *    flag op never reads.
   */
  async ensureFolderSelected(folderPath: string): Promise<void> {
    this.ensureConnected();
    const openMailbox = (this.client as any)?.mailbox;
    if (openMailbox && openMailbox.path === folderPath) return;
    await this.openFolder(folderPath, undefined, { withUnseen: false });
  }

  private async openFolder(
    folderPath: string,
    extraOpts?: { changedSince?: bigint; uidValidity?: bigint },
    opts?: { withUnseen?: boolean },
  ): Promise<FolderStatus> {
    let mbox;
    try {
      mbox = await this.op('SELECT', this.client!.mailboxOpen(folderPath, { readOnly: false, ...extraOpts }));
    } catch (err) {
      throw this.toImapError(err, 'SELECT_FOLDER_ERROR');
    }
    this.currentFolder = folderPath;
    this.connectionState = 'selected';

    // mailboxOpen doesn't report unseen; fetch it via STATUS (best-effort).
    // Latency-sensitive callers that don't need the count (flag ops via
    // ensureFolderSelected) pass withUnseen:false to skip this extra round-trip.
    let unseen = 0;
    if (opts?.withUnseen !== false) {
      try {
        const st = await this.op(
          'STATUS',
          this.client!.status(folderPath, { unseen: true }),
          ImapFlowClient.META_OP_TIMEOUT_MS,
        );
        unseen = st.unseen ?? 0;
      } catch {
        // some servers reject STATUS on the selected mailbox — leave at 0
      }
    }

    return {
      path: folderPath,
      uidValidity: Number(mbox.uidValidity),
      uidNext: mbox.uidNext,
      messages: mbox.exists,
      recent: 0,
      unseen,
      permanentFlags: mbox.permanentFlags ? [...mbox.permanentFlags] : [],
      readOnly: mbox.readOnly ?? false,
      highestModseq: mbox.highestModseq ? Number(mbox.highestModseq) : undefined,
    };
  }

  getCurrentFolder(): string | null {
    return this.currentFolder;
  }

  async getFolderStatus(
    folderPath: string,
  ): Promise<{ uidNext: number; messages: number; uidValidity: number; unseen: number; highestModseq?: number }> {
    this.ensureConnected();
    const st = await this.op('STATUS', this.client!.status(folderPath, {
      messages: true,
      uidNext: true,
      uidValidity: true,
      unseen: true,
      // CONDSTORE (RFC 7162). This is the only STATUS item that moves on a
      // \Flagged change: `unseen` and `messages` are both blind to a star being
      // removed in webmail, which left non-INBOX folders unable to notice it at
      // all (IDLE watches INBOX only). Safe to request unconditionally —
      // ImapFlow drops the item unless the server advertises CONDSTORE, so a
      // server without it still answers the other four rather than failing the
      // whole STATUS.
      highestModseq: true,
    }), ImapFlowClient.META_OP_TIMEOUT_MS);
    return {
      uidNext: st.uidNext ?? 0,
      messages: st.messages ?? 0,
      uidValidity: Number(st.uidValidity ?? 0),
      unseen: st.unseen ?? 0,
      // BigInt on the wire; narrowed to number for parity with the rest of the
      // codebase (FolderRecord.highestModseq, getCurrentMailboxState). Modseqs
      // scale with mailbox activity, so 2^53 is not a practical ceiling.
      highestModseq: st.highestModseq ? Number(st.highestModseq) : undefined,
    };
  }

  /**
   * Mailbox storage quota (RFC 2087). ImapFlow returns `storage.usage`/`.limit`
   * already converted to BYTES (it multiplies the 1024-byte wire units), or
   * `false` when QUOTA isn't advertised. Best-effort: a server that NOs the
   * command must NOT error the caller — we just report "no quota info" (null).
   */
  async getQuota(path = 'INBOX'): Promise<{ used: number; limit: number } | null> {
    this.ensureConnected();
    try {
      const res: any = await this.op('QUOTA', this.client!.getQuota(path));
      const storage = res && res.storage;
      if (!storage) return null;
      const used = Number(storage.usage) || 0;
      const limit = Number(storage.limit) || 0;
      if (limit <= 0) return null; // unlimited / not meaningful — nothing to show
      return { used, limit };
    } catch (err) {
      logger.debug(`getQuota failed (ignored): ${(err as Error)?.message ?? err}`); // low-frequency call
      return null;
    }
  }

  // ========== Message Fetch ==========

  async fetchMessages(range: string, options?: FetchOptions): Promise<IMAPMessage[]> {
    this.ensureCurrentFolder();
    return this.fetchInternal(range, false, options);
  }

  async fetchMessagesByUID(uids: number[], options?: FetchOptions): Promise<IMAPMessage[]> {
    this.ensureCurrentFolder();
    if (uids.length === 0) return [];
    return this.fetchInternal(uids, true, options);
  }

  async getNewMessages(sinceUID: number, options?: FetchOptions): Promise<IMAPMessage[]> {
    this.ensureCurrentFolder();
    return this.fetchInternal(`${sinceUID + 1}:*`, true, options);
  }

  /**
   * Fetch messages in the closed UID range `[loUid, hiUid]` (inclusive). The
   * BOUNDED, downward counterpart to getNewMessages — the historical backfill
   * pages older mail by fetching one bounded UID window at a time. A bounded
   * `UID FETCH lo:hi` is served fine even by servers that reject an unbounded
   * `FETCH 1:*` (see fetchFlagsOnly). Empty ranges (loUid > hiUid) short-circuit.
   */
  async fetchMessagesByUidRange(loUid: number, hiUid: number, options?: FetchOptions): Promise<IMAPMessage[]> {
    this.ensureCurrentFolder();
    if (loUid > hiUid || hiUid < 1) return [];
    return this.fetchInternal(`${Math.max(1, loUid)}:${hiUid}`, true, options);
  }

  async fetchMessage(uid: number, options?: FetchOptions): Promise<IMAPMessage | null> {
    const messages = await this.fetchMessagesByUID([uid], options);
    return messages.length > 0 ? messages[0] : null;
  }

  private ensureCurrentFolder(): void {
    this.ensureConnected();
    if (!this.currentFolder) {
      throw new IMAPError('No folder selected', 'NO_FOLDER_SELECTED');
    }
  }

  private async fetchInternal(
    range: string | number[],
    useUid: boolean,
    options?: FetchOptions,
  ): Promise<IMAPMessage[]> {
    let messages;
    try {
      const fetching = this.client!.fetchAll(
        range,
        {
          uid: true,
          flags: true,
          internalDate: true,
          size: true,
          envelope: true,
          bodyStructure: options?.fetchBodyStructure !== false,
          source: !!options?.fetchBody,
          // Gmail labels (X-GM-LABELS). On Gmail, ONE message lives in every
          // mailbox it is labelled with, so the historical download runs over the
          // All Mail superset once instead of re-fetching it per label — but
          // without the labels every such message is filed under All Mail ONLY
          // and is invisible in INBOX, Starred and the user's own labels. This is
          // the metadata that puts it in the right folders. Free on a fetch we
          // are already issuing, and only requested when the server advertises
          // the extension (never sent to a plain IMAP server).
          ...(this.supportsGmailLabels() ? { labels: true } : {}),
          // Fetch the key headers alongside the parsed envelope. ImapFlow's
          // `envelope` is occasionally empty (some servers return an ENVELOPE
          // this parser can't map) — without a fallback that stores blank
          // from/subject and a synthetic message-id. toIMAPMessage falls back
          // to these raw headers. (References is also envelope-omitted and
          // needed for threading.)
          headers: ['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'list-id', 'list-unsubscribe', 'precedence'],
        },
        { uid: useUid },
      );
      // `source` above turns this into a whole-message download, whose duration
      // is a property of the message rather than of the server's health — so it
      // is judged on stalls, not on a flat clock. See `opStreaming`.
      messages = await (options?.fetchBody
        ? this.opStreaming('FETCH (body)', fetching)
        : this.op('FETCH', fetching));
    } catch (err) {
      throw this.toImapError(err, 'FETCH_ERROR');
    }

    const mapped = messages.map((m) => this.toIMAPMessage(m));

    // ImapFlow has no markSeen option on fetch, so emulate it by adding \Seen.
    if (options?.markSeen && mapped.length > 0) {
      try {
        await this.op('STORE +\\Seen', this.client!.messageFlagsAdd(
          mapped.map((m) => m.uid),
          ['\\Seen'],
          { uid: true },
        ));
        mapped.forEach((m) => {
          if (!m.flags.includes('\\Seen')) m.flags.push('\\Seen');
        });
      } catch (err) {
        logger.warn('markSeen failed:', (err as Error).message);
      }
    }

    return mapped;
  }

  private toIMAPMessage(m: FetchMessageObject): IMAPMessage {
    const env = m.envelope || {};
    const headers = m.headers;

    // Envelope-first, with a raw-header fallback for the fields ImapFlow drops
    // when it can't parse a server's ENVELOPE. Names/subject stay raw here —
    // message-processor decodes RFC2047 encoded-words downstream.
    let from = env.from?.length ? this.mapAddresses(env.from) : this.headerAddresses(headers, 'from');
    // Recover a display name that an unquoted comma split across ENVELOPE entries
    // (e.g. `From: Google Cloud Platform, and APIs <addr>`), the way Gmail/webmail
    // do — from the RAW From header. See recoverFromDisplayName.
    from = this.recoverFromDisplayName(this.headerValue(headers, 'from'), from);
    const to = env.to?.length ? this.mapAddresses(env.to) : this.headerAddresses(headers, 'to');
    const cc = env.cc?.length ? this.mapAddresses(env.cc) : this.headerAddresses(headers, 'cc');
    const bcc = env.bcc?.length ? this.mapAddresses(env.bcc) : this.headerAddresses(headers, 'bcc');
    const replyTo = env.replyTo?.length ? this.mapAddresses(env.replyTo) : this.headerAddresses(headers, 'reply-to');
    const envDate = env.date ? new Date(env.date) : this.headerDate(headers);

    return {
      uid: m.uid,
      seqNo: m.seq,
      flags: m.flags ? [...m.flags] : [],
      date: m.internalDate ? new Date(m.internalDate) : (envDate ?? new Date()),
      size: m.size ?? 0,
      // Bulk/list mail signal (RFC 2919/2369/2076). Gmail suppresses its
      // subject-based thread fallback for bulk mail so recurring newsletters /
      // digests with identical subjects never collapse into one giant thread.
      // We carry the flag through to threading (see thread-resolver Path 3).
      isBulk: this.detectBulk(headers),
      // Gmail labels, when the server sent them. ImapFlow surfaces X-GM-LABELS
      // as a Set; normalise to a plain array so downstream code (and the fake
      // server in tests) can treat it as data. Absent on non-Gmail servers.
      ...(m.labels ? { labels: [...m.labels] } : {}),
      envelope: {
        messageId: env.messageId || this.headerValue(headers, 'message-id') || '',
        inReplyTo: this.normalizeInReplyTo(env.inReplyTo ?? this.headerValue(headers, 'in-reply-to') ?? undefined),
        references: this.parseReferences(headers),
        subject: env.subject ?? this.headerValue(headers, 'subject'),
        from,
        replyTo,
        to,
        cc,
        bcc,
        date: envDate,
      },
      bodyStructure: m.bodyStructure
        ? this.convertBodyStructure(m.bodyStructure)
        : ({} as BodyStructure),
      // LOSSLESS byte preservation: the raw MIME source is bytes in the message's
      // OWN charset(s)/transfer-encoding — decoding it as UTF-8 here destroys any
      // non-UTF-8 body (Windows-1252, ISO-8859-1, CJK, binary CTE) into mojibake
      // BEFORE mailparser can decode the declared charset. 'latin1' maps each byte
      // 1:1 to a char, so the exact bytes survive; the parser reconstructs them via
      // Buffer.from(body, 'latin1') and decodes the real charset.
      body: m.source ? m.source.toString('latin1') : undefined,
      bodyParts: {},
    };
  }

  private mapAddresses(addrs?: MessageAddressObject[]): EmailAddress[] {
    if (!addrs) return [];
    return addrs.map((a) => ({ name: a.name ?? null, address: a.address || '' }));
  }

  private normalizeInReplyTo(value?: string): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.startsWith('<') ? trimmed : `<${trimmed.replace(/^<|>$/g, '')}>`;
  }

  /**
   * Extract a single header's value from the raw header block, unfolding
   * continuation lines. Returns null when absent. Shared by every header
   * fallback so the folded-line handling lives in one place.
   */
  /**
   * Recover a From display name that an unquoted comma split across ENVELOPE
   * entries. An RFC-violating header like
   *   From: Google Cloud Platform, and APIs <CloudPlatform-noreply@google.com>
   * makes the server's ENVELOPE parse the name as two addresses, so reading
   * `from[0]` shows a truncated "and APIs". Mail clients (Gmail, our webmail)
   * instead read the RAW header: with a SINGLE `<addr>`, the display name is
   * everything before it — commas and all. So when the raw From line resolves to
   * exactly one address, rebuild a single sender {name-before-<, addr}.
   *
   * Guarded: only fires for a single `<addr>` whose address matches the
   * envelope's sender (or when the envelope found no address at all), so a
   * genuine multi-address From (rare) is left untouched. The name is kept RAW —
   * envelope-mapper RFC2047-decodes it downstream.
   */
  private recoverFromDisplayName(rawFrom: string | null, envFrom: EmailAddress[]): EmailAddress[] {
    if (!rawFrom) return envFrom;
    const firstLt = rawFrom.indexOf('<');
    const lastLt = rawFrom.lastIndexOf('<');
    if (firstLt < 0 || firstLt !== lastLt) return envFrom; // 0 or >1 addresses → leave as-is
    const gt = rawFrom.indexOf('>', lastLt);
    if (gt < 0) return envFrom;
    const address = rawFrom.slice(lastLt + 1, gt).trim();
    if (!address || !address.includes('@')) return envFrom;
    const envAddr = (envFrom.find((a) => a.address)?.address || '').toLowerCase();
    if (envAddr && envAddr !== address.toLowerCase()) return envFrom; // different sender → leave
    let name = rawFrom.slice(0, firstLt).trim().replace(/,\s*$/, '').trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).trim();
    return [{ name: name || null, address }];
  }

  /**
   * True when the message carries mailing-list / bulk-mail headers (RFC 2919
   * List-Id, RFC 2369 List-Unsubscribe, or a bulk/list/junk Precedence). Used to
   * suppress the subject-based thread fallback for newsletters/digests (Gmail
   * parity), so many same-subject bulk mails never merge into one thread.
   */
  private detectBulk(headers: Buffer | undefined): boolean {
    if (!headers) return false;
    if (this.headerValue(headers, 'list-id')) return true;
    if (this.headerValue(headers, 'list-unsubscribe')) return true;
    const prec = (this.headerValue(headers, 'precedence') || '').toLowerCase();
    return prec === 'bulk' || prec === 'list' || prec === 'junk';
  }

  private headerValue(headers: Buffer | undefined, name: string): string | null {
    if (!headers) return null;
    const text = headers.toString('utf8');
    // Anchor the header name at the start of the block or after a newline, but
    // do NOT use the `m` flag: with `m`, `$` matches every physical line-end, so
    // the lazy capture stops at the FIRST line and a folded multi-line value
    // (e.g. a To/Cc list wrapped across lines) is truncated to its first
    // recipient. Without `m`, the capture runs until the next UNFOLDED newline
    // (a `\n` not followed by whitespace = the next header) or end of input, so
    // continuation lines are captured and then unfolded below.
    const match = text.match(new RegExp(`(?:^|\\r?\\n)${name}:\\s*([\\s\\S]*?)(?:\\r?\\n(?!\\s)|$)`, 'i'));
    if (!match) return null;
    return match[1].replace(/\r?\n\s+/g, ' ').trim() || null;
  }

  private parseReferences(headers?: Buffer): string[] {
    const value = this.headerValue(headers, 'references');
    if (!value) return [];
    return value
      .split(/\s+/)
      .map((r) => r.trim())
      .filter((r) => r.startsWith('<'));
  }

  /**
   * Parse an address-list header (e.g. From) into EmailAddress[]. Raw names
   * are decoded downstream. Used only as an envelope fallback.
   */
  private headerAddresses(headers: Buffer | undefined, name: string): EmailAddress[] {
    const value = this.headerValue(headers, name);
    if (!value) return [];
    return value
      .split(',')
      .map((part) => this.parseSingleAddress(part))
      .filter((a): a is EmailAddress => a !== null);
  }

  private parseSingleAddress(raw: string): EmailAddress | null {
    const s = raw.trim();
    if (!s) return null;
    const withName = s.match(/^(.*?)<([^>]+)>\s*$/);
    if (withName) {
      const name = withName[1].trim().replace(/^"|"$/g, '').trim();
      return { name: name || null, address: withName[2].trim() };
    }
    if (s.includes('@')) return { name: null, address: s.replace(/^"|"$/g, '').trim() };
    return null;
  }

  private headerDate(headers?: Buffer): Date | null {
    const value = this.headerValue(headers, 'date');
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  /**
   * Convert ImapFlow's MessageStructureObject (type is full "text/plain") into
   * our BodyStructure (separate type/subtype, parts instead of childNodes).
   */
  private convertBodyStructure(node: MessageStructureObject): BodyStructure {
    const [type, subtype] = (node.type || 'text/plain').split('/');
    const isMultipart = type === 'multipart' || Array.isArray(node.childNodes);
    return {
      type: type || 'text',
      subtype: subtype || (isMultipart ? 'mixed' : 'plain'),
      params: node.parameters || {},
      id: node.id || null,
      description: node.description || null,
      encoding: node.encoding || '7bit',
      size: node.size || 0,
      lines: node.lineCount,
      disposition: node.disposition
        ? { type: node.disposition, params: node.dispositionParameters || {} }
        : null,
      // Part number for a later BODY[part] fetch of just this attachment.
      part: (node as { part?: string }).part,
      parts: node.childNodes
        ? node.childNodes.map((c) => this.convertBodyStructure(c))
        : undefined,
    };
  }

  /**
   * Download one MIME part by number (BODY[part]) for a UID, returning DECODED
   * bytes. ImapFlow's `download` already reverses the transfer-encoding, so the
   * collected stream IS the raw file — no base64/QP handling here. The folder
   * must already be selected by the caller. Returns null if the part is missing.
   */
  async downloadPart(uid: number, part: string): Promise<Buffer | null> {
    this.ensureConnected();
    const dl: any = await this.op('DOWNLOAD', this.client!.download(String(uid), part, { uid: true }));
    const content = dl && dl.content;
    if (!content) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of content as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // ========== Flag-only fetches ==========

  /**
   * Flags for a known UID set, fetched in bounded batches.
   *
   * Batched because the servers this exists for are exactly the ones that
   * reject an unbounded fetch: imap.sarv.com answers "Command failed" to
   * `FETCH 1:*` on a 2.8k-message INBOX while serving ranges fine. Passing the
   * whole UID set as one command hit the same wall.
   *
   * Each batch is addressed as a UID RANGE (`min:max` of the slice) rather than
   * a comma-joined list, so the command stays short whatever the batch size;
   * UIDs missing from the range simply return nothing. Sorting keeps the ranges
   * tight.
   *
   * A failing batch is logged and skipped rather than aborting the call — every
   * batch that lands still reconciles its slice, which beats the all-or-nothing
   * behaviour this replaces.
   */
  async fetchFlagsOnly(
    uids: number[],
    onBatch?: () => void,
  ): Promise<Array<{ uid: number; flags: string[] }>> {
    this.ensureCurrentFolder();
    if (uids.length === 0) return [];

    const BATCH = 500;
    const sorted = [...uids].sort((a, b) => a - b);
    const out: Array<{ uid: number; flags: string[] }> = [];
    let failedBatches = 0;

    for (let i = 0; i < sorted.length; i += BATCH) {
      // The connection can be recycled mid-loop (STATUS-wedge recycle, socket
      // end): `this.client` goes null and every remaining batch would just
      // null-deref `.fetchAll` — the "Cannot read properties of null" spam. Once
      // the socket is gone the whole set must be re-read after reconnect, so stop
      // and surface ONE clean connection error the caller re-queues, instead of
      // logging a cryptic crash per batch. Capture a stable non-null ref for the
      // call (no `!` that lies about the runtime state).
      const client = this.client;
      if (!client || !this.isConnected()) {
        throw new IMAPError('Not connected to IMAP server', 'NOT_CONNECTED');
      }
      const slice = sorted.slice(i, i + BATCH);
      const range = `${slice[0]}:${slice[slice.length - 1]}`;
      try {
        const list = await this.op(
          'FETCH flags (batch)',
          client.fetchAll(range, { uid: true, flags: true }, { uid: true }),
        );
        for (const m of list) {
          if (m.uid > 0) out.push({ uid: m.uid, flags: m.flags ? [...m.flags] : [] });
        }
        // Progress heartbeat for a pooled caller: a batch completed, so the
        // connection is alive and making progress — refresh stuck-eviction.
        onBatch?.();
      } catch (err) {
        // A CONNECTION error mid-batch (socket dropped, op timeout) means the rest
        // would fail identically — abort the whole call so the caller re-queues,
        // rather than logging one warn per doomed batch. A per-batch SERVER error
        // ("Command failed" on a range) is isolated: skip it, keep what lands.
        if (isConnectionError(err)) throw err;
        failedBatches++;
        logger.warn(`Batched FLAGS fetch failed for UID range ${range}: ${(err as Error)?.message ?? err}`);
      }
    }

    if (failedBatches > 0) {
      logger.warn(
        `Batched FLAGS fetch on ${this.currentFolder}: ${failedBatches} batch(es) failed; `
        + `got flags for ${out.length}/${uids.length} uids`,
      );
    }
    return out;
  }

  /**
   * Gmail labels for the whole open mailbox (`FETCH 1:* (X-GM-LABELS)`).
   *
   * Deliberately labels-ONLY: it exists to REPAIR rows that were downloaded from
   * the All Mail superset before labels were fetched, and are therefore filed
   * under All Mail alone — present on disk but missing from INBOX, Starred and
   * the user's own labels. Re-downloading those messages would cost a full sync;
   * their labels cost a few bytes each. Empty array on a non-Gmail server so the
   * caller needs no capability check.
   */
  async fetchAllLabels(): Promise<Array<{ uid: number; labels: string[] }>> {
    this.ensureCurrentFolder();
    if (!this.supportsGmailLabels()) return [];
    try {
      const list = await this.op(
        'FETCH labels',
        this.client!.fetchAll('1:*', { uid: true, labels: true } as any, { uid: false }),
      );
      return list
        .filter((m) => m.uid > 0)
        .map((m) => ({ uid: m.uid, labels: (m as { labels?: Set<string> }).labels ? [...(m as { labels: Set<string> }).labels] : [] }));
    } catch (err) {
      throw this.toImapError(err, 'FETCH_LABELS_ERROR');
    }
  }

  async fetchAllFlags(): Promise<Array<{ uid: number; flags: string[] }>> {
    this.ensureCurrentFolder();
    try {
      const list = await this.op('FETCH flags', this.client!.fetchAll('1:*', { uid: true, flags: true }, { uid: false }));
      return list
        .filter((m) => m.uid > 0)
        .map((m) => ({ uid: m.uid, flags: m.flags ? [...m.flags] : [] }));
    } catch (err) {
      throw this.toImapError(err, 'FETCH_FLAGS_ERROR');
    }
  }

  async fetchAllUIDs(): Promise<number[]> {
    this.ensureCurrentFolder();
    // Prefer a real `UID SEARCH ALL` — it returns the complete UID set in one
    // compact response and is far lighter than streaming a `FETCH 1:*` over the
    // whole (possibly 20k+) mailbox. Some servers (observed on Sarv's INBOX)
    // reject the large sequence `FETCH 1:*` with "Command failed" while happily
    // answering SEARCH. Fall back to the FETCH form if SEARCH is unavailable.
    try {
      const uids = await this.op('UID SEARCH ALL', this.client!.search({ all: true }, { uid: true }));
      if (Array.isArray(uids)) return uids.filter((u) => u > 0);
      // search() returns false when nothing matches an open-but-empty mailbox.
      return [];
    } catch (searchErr) {
      const msg = (searchErr as Error)?.message ?? String(searchErr);
      // On a TIMEOUT (heavy/slow account), the connection is already struggling —
      // escalating to the far heavier whole-mailbox `FETCH 1:*` just times out too
      // (another 60s that stays in-flight and wedges every command queued behind
      // it → the "heavy-account timeout cascade"). Abort instead: deletion
      // reconcile is a best-effort background pass and safely retries next cycle
      // (a PARTIAL uid set is never used, so skipping is the correct/safe choice).
      if ((searchErr as { isTimeout?: boolean })?.isTimeout === true || /timed out/i.test(msg)) {
        logger.warn(`UID SEARCH ALL timed out — skipping whole-folder UID enumeration this cycle (not escalating to FETCH 1:*)`);
        throw this.toImapError(searchErr, 'FETCH_UIDS_ERROR');
      }
      // SEARCH was REJECTED (some servers don't implement SEARCH ALL). Fall back to
      // FETCH, but CHUNK by UID range so no single command enumerates the whole
      // (possibly huge) mailbox in one 60s-bounded op.
      logger.warn(`UID SEARCH ALL failed (rejected) — falling back to chunked UID FETCH: ${msg}`);
      return await this.fetchAllUidsChunked();
    }
  }

  /** Enumerate every UID via ranged `UID FETCH` chunks (bounded per op), for
   *  servers that reject `SEARCH ALL` / `FETCH 1:*`. A chunk failure throws — the
   *  caller must never diff local rows against a PARTIAL server set (missing uids
   *  read as mass deletions). */
  private async fetchAllUidsChunked(): Promise<number[]> {
    const uidNext = (this.client as { mailbox?: { uidNext?: number } })?.mailbox?.uidNext;
    const hi = typeof uidNext === 'number' && uidNext > 1 ? uidNext - 1 : 0;
    if (hi <= 0) {
      // No known upper bound — one bounded attempt at the whole range.
      const list = await this.op('FETCH uids', this.client!.fetchAll('1:*', { uid: true }, { uid: false }));
      return list.map((m) => m.uid).filter((u) => u > 0);
    }
    const CHUNK = 3000;
    const out: number[] = [];
    for (let lo = 1; lo <= hi; lo += CHUNK) {
      const range = `${lo}:${Math.min(lo + CHUNK - 1, hi)}`;
      const list = await this.op(`FETCH uids ${range}`, this.client!.fetchAll(range, { uid: true }, { uid: true }));
      for (const m of list) if (m.uid > 0) out.push(m.uid);
    }
    return out;
  }

  /**
   * `UID SEARCH SINCE <date>` — the complete UID set of messages received on or
   * after `since` in the current folder. The windowed counterpart to
   * fetchAllUIDs: for large mailboxes we reconcile only the recent window, where
   * the whole-mailbox SEARCH ALL / FETCH 1:* returns partial lists or times out.
   * SEARCH SINCE stays compact (a month of mail) so it completes reliably.
   */
  async fetchUidsSince(since: Date): Promise<number[]> {
    this.ensureCurrentFolder();
    try {
      const uids = await this.op('UID SEARCH SINCE', this.client!.search({ since }, { uid: true }));
      if (Array.isArray(uids)) return uids.filter((u) => u > 0);
      // search() returns false when nothing matches (empty window).
      return [];
    } catch (err) {
      throw this.toImapError(err, 'FETCH_UIDS_SINCE_ERROR');
    }
  }

  /**
   * Map every message's Message-ID → UID for the current folder, by fetching
   * envelopes directly. This is the RELIABLE way to locate a message by its
   * Message-ID on servers whose HEADER MESSAGE-ID SEARCH is unsupported/unindexed
   * (e.g. some Dovecot/custom IMAPs return no hits) — which otherwise leaves
   * deleted-locally messages on the server to be re-synced back. Keys are the
   * bracket-stripped, lower-cased id so both `<id>` and `id` forms match.
   */
  async fetchMessageIdToUidMap(): Promise<Map<string, number>> {
    this.ensureCurrentFolder();
    const list = await this.op('FETCH msgid-map', this.client!.fetchAll('1:*', { uid: true, envelope: true }, { uid: false }));
    const map = new Map<string, number>();
    for (const m of list) {
      const mid = (m.envelope?.messageId || '').replace(/[<>]/g, '').trim().toLowerCase();
      if (mid && m.uid > 0) map.set(mid, m.uid);
    }
    return map;
  }

  // ========== CONDSTORE ==========

  supportsCondstore(): boolean {
    return this.capabilities.includes('CONDSTORE');
  }

  supportsQresync(): boolean {
    return this.capabilities.includes('QRESYNC');
  }

  /**
   * QRESYNC (RFC 7162) resynchronising SELECT: opens `folderPath` passing the
   * client's last-known `(uidValidity, modseq)` so the server replies with
   * `VANISHED (EARLIER) <uids>` for every message expunged since — i.e. deletions
   * that happened while the app was away. ImapFlow surfaces those as `expunge`
   * events (with `uid`), which we collect for the duration of the open. Returns
   * the folder status plus the vanished UIDs so the caller can delete them
   * locally without a whole-folder UID diff. Only meaningful when
   * supportsQresync() is true and a prior modseq exists.
   */
  async selectFolderWithQresync(
    folderPath: string,
    uidValidity: number,
    modseq: number,
  ): Promise<{ status: FolderStatus; vanishedUids: number[] }> {
    this.ensureConnected();
    const vanishedUids: number[] = [];
    const onExpunge = (payload: { uid?: number; vanished?: boolean } | undefined): void => {
      // During a QRESYNC SELECT every expunge event is a server-side deletion to
      // reflect (VANISHED EARLIER). Collect the UID; ignore seq-only events.
      if (payload && typeof payload.uid === 'number' && payload.uid > 0) {
        vanishedUids.push(payload.uid);
      }
    };
    this.client!.on('expunge', onExpunge);
    try {
      const status = await this.openFolder(folderPath, {
        changedSince: BigInt(modseq),
        uidValidity: BigInt(uidValidity),
      });
      return { status, vanishedUids };
    } finally {
      this.client!.removeListener('expunge', onExpunge);
    }
  }

  /**
   * CONDSTORE state of the CURRENTLY-open mailbox: its `highestModseq` and
   * `uidValidity` as reported at SELECT time. Read straight off ImapFlow's live
   * `mailbox` object (the same one `mailboxOpen` returned), so it always
   * reflects the folder syncFlags is about to reconcile. Returns null when no
   * mailbox is open or the server didn't report a modseq — callers treat that
   * as "delta not eligible" and take the full path.
   */
  getCurrentMailboxState(): { path?: string; highestModseq?: number; uidValidity?: number; exists?: number } | null {
    const mbox = this.client?.mailbox;
    if (!mbox) return null;
    return {
      // The path of the mailbox ACTUALLY selected on this connection. Callers
      // compare it to the folder they think they're syncing — a mismatch means a
      // folder-selection race (e.g. IDLE re-selected INBOX under a sync), and any
      // flag/deletion reconciliation would run against the WRONG folder's data.
      path: typeof mbox.path === 'string' ? mbox.path : undefined,
      highestModseq: mbox.highestModseq ? Number(mbox.highestModseq) : undefined,
      uidValidity: mbox.uidValidity ? Number(mbox.uidValidity) : undefined,
      // Current message count in the open mailbox (kept live by EXISTS events).
      // Lets deletion detection tell a COMPLETE server UID list from a truncated
      // fetch: when we received as many UIDs as the mailbox claims to hold, the
      // fetch didn't get cut short.
      exists: typeof mbox.exists === 'number' ? mbox.exists : undefined,
    };
  }

  async fetchFlagsChangedSince(modseq: number): Promise<FlagChange[]> {
    this.ensureCurrentFolder();
    if (!this.supportsCondstore()) {
      throw new IMAPError('Server does not support CONDSTORE', 'CONDSTORE_NOT_SUPPORTED');
    }
    const list = await this.op('FETCH CHANGEDSINCE', this.client!.fetchAll(
      '1:*',
      { uid: true, flags: true },
      { uid: false, changedSince: BigInt(modseq) },
    ));
    const results = list
      .filter((m) => m.uid > 0)
      .map((m) => ({
        uid: m.uid,
        flags: m.flags ? [...m.flags] : [],
        modseq: m.modseq ? Number(m.modseq) : 0,
      }));
    logger.debug(`CONDSTORE: ${results.length} messages changed since modseq ${modseq}`);
    return results;
  }

  // ========== Append ==========

  async appendMessage(
    folderPath: string,
    rawMessage: string | Buffer,
    flags?: string[],
  ): Promise<number | undefined> {
    this.ensureConnected();
    const res = await this.op('APPEND', this.client!.append(
      folderPath,
      rawMessage,
      flags && flags.length > 0 ? flags : undefined,
    ));
    return res && res.uid ? res.uid : undefined;
  }

  // ========== Message Flags ==========

  async addFlags(uids: number[], flags: string[]): Promise<void> {
    this.ensureConnected();
    const matched = await this.op('STORE +FLAGS', this.client!.messageFlagsAdd(uids, flags, { uid: true }));
    // Custom-keyword (category-label) STOREs only — log the exact command and the
    // server's tagged result so keyword-label application is visible. The filter
    // skips the hot system-flag path (\Seen/\Deleted during sync), so this never
    // floods. Set SARV_DEBUG_KEYWORDS=1 to ALSO fetch the flags back and show
    // what the server actually persisted — the definitive check for a keyword the
    // webmail simply doesn't render.
    const keywords = flags.filter((f) => !f.startsWith('\\'));
    if (keywords.length > 0) {
      const folder = (this.client as any)?.mailbox?.path ?? '?';
      logger.info(`[IMAP] UID STORE ${uids.join(',')} +FLAGS (${keywords.join(' ')}) in "${folder}" → matched=${matched}`);
      if (process.env.SARV_DEBUG_KEYWORDS === '1') {
        try {
          const list = await this.client!.fetchAll(uids.join(','), { uid: true, flags: true }, { uid: true });
          const back = list.map((m: any) => `uid ${m.uid}: [${[...(m.flags ?? [])].join(' ')}]`);
          logger.info(`[IMAP] server FLAGS after STORE → ${back.join('; ') || '(no messages returned)'}`);
        } catch (e) {
          logger.warn(`[IMAP] keyword verify FETCH failed: ${(e as Error).message}`);
        }
      }
    }
  }

  async removeFlags(uids: number[], flags: string[]): Promise<void> {
    this.ensureConnected();
    await this.op('STORE -FLAGS', this.client!.messageFlagsRemove(uids, flags, { uid: true }));
  }

  /**
   * Remove one or more GMAIL LABELS from messages, in place, WITHOUT deleting
   * them (Gmail's `STORE -X-GM-LABELS`, via ImapFlow's `useLabels`). This is the
   * clean way to strip a stale category label (e.g. a "Sarv Inbox/Reminders" left
   * behind after re-categorisation) — the message stays in All Mail and every
   * other label is untouched. Removing a label a message doesn't have is a no-op.
   * Gmail-only; the caller must have already SELECTed the folder the uids live in.
   */
  async removeGmailLabels(uids: number[], labels: string[]): Promise<void> {
    this.ensureConnected();
    if (uids.length === 0 || labels.length === 0) return;
    await this.op('STORE -X-GM-LABELS', this.client!.messageFlagsRemove(uids, labels, { uid: true, useLabels: true } as any));
  }

  async setFlags(uids: number[], flags: string[]): Promise<void> {
    this.ensureConnected();
    await this.op('STORE FLAGS', this.client!.messageFlagsSet(uids, flags, { uid: true }));
  }

  // ========== Message Operations ==========

  async moveMessages(uids: number[], destinationFolder: string): Promise<Map<number, number> | null> {
    this.ensureConnected();
    // ImapFlow's messageMove resolves to a CopyResponseObject carrying `uidMap`
    // (source UID -> destination UID) when the server answers with COPYUID
    // (MOVE + UIDPLUS). Surface it so the caller can re-home the local rows'
    // UIDs; return null when unavailable (server lacks UIDPLUS) or the command
    // reported no move (false).
    const res = await this.op('MOVE', this.client!.messageMove(uids, destinationFolder, { uid: true }));
    return res && res.uidMap ? res.uidMap : null;
  }

  async copyMessages(uids: number[], destinationFolder: string): Promise<void> {
    this.ensureConnected();
    await this.op('COPY', this.client!.messageCopy(uids, destinationFolder, { uid: true }));
  }

  /**
   * Create a mailbox (a plain folder, or a Gmail label — Gmail exposes labels as
   * mailboxes). Idempotent: an ALREADYEXISTS response is treated as success, and
   * nested parents in `path` are auto-created by ImapFlow. Used by the
   * category-label strategies (Gmail copy-to-label, and the folder fallback).
   */
  async createMailbox(path: string): Promise<void> {
    this.ensureConnected();
    try {
      await this.op('CREATE', this.client!.mailboxCreate(path));
    } catch (e: any) {
      const msg = e?.message || '';
      if (!/exist/i.test(msg) && e?.serverResponseCode !== 'ALREADYEXISTS') throw e;
    }
  }

  /** Subscribe (LSUB) to a mailbox so it appears in the subscribed folder list. */
  async subscribeMailbox(path: string): Promise<void> {
    this.ensureConnected();
    await this.op('SUBSCRIBE', this.client!.mailboxSubscribe(path));
  }

  /** Unsubscribe from a mailbox — the folder still exists, just not in LSUB. */
  async unsubscribeMailbox(path: string): Promise<void> {
    this.ensureConnected();
    await this.op('UNSUBSCRIBE', this.client!.mailboxUnsubscribe(path));
  }

  /** Rename a mailbox (label rename). */
  async renameMailbox(oldPath: string, newPath: string): Promise<void> {
    this.ensureConnected();
    await this.op('RENAME', this.client!.mailboxRename(oldPath, newPath));
  }

  /** Delete a mailbox. Idempotent — a "doesn't exist" response is a no-op. */
  async deleteMailbox(path: string): Promise<void> {
    this.ensureConnected();
    try {
      await this.op('DELETE mailbox', this.client!.mailboxDelete(path));
    } catch (e: any) {
      if (!/not.*exist|no.*such|nonexistent/i.test(e?.message || '')) throw e;
    }
  }

  /** Flat list of every mailbox path (for finding a label subtree). */
  async listMailboxPaths(): Promise<string[]> {
    this.ensureConnected();
    const list = await this.op('LIST paths', this.client!.list());
    return list.map((m: any) => m.path).filter(Boolean);
  }

  /** True when the server speaks the Gmail IMAP extension (native labels). */
  supportsGmailLabels(): boolean {
    return this.capabilities.includes('X-GM-EXT-1');
  }

  /**
   * Whether `folderPath` accepts arbitrary custom keywords — i.e. its
   * PERMANENTFLAGS advertises `\*`. That's the signal a server can hold in-place
   * keyword-labels (sarv, Fastmail, most Dovecot). Selecting the folder is cheap
   * and gives us its permanentFlags.
   */
  async supportsKeywords(folderPath = 'INBOX'): Promise<boolean> {
    const status = await this.selectFolder(folderPath);
    return (status.permanentFlags || []).some((f) => f === '\\*');
  }

  /** The server's mailbox hierarchy delimiter (for nesting `Sarv Inbox/<x>`). */
  async getHierarchyDelimiter(): Promise<string> {
    this.ensureConnected();
    try {
      const list = await this.op('LIST delimiter', this.client!.list());
      const inbox = list.find((m: any) => (m.path || '').toUpperCase() === 'INBOX') ?? list[0];
      return (inbox as any)?.delimiter || '/';
    } catch {
      return '/';
    }
  }

  async deleteMessages(uids: number[]): Promise<void> {
    await this.addFlags(uids, ['\\Deleted']);
  }

  /**
   * Atomically set \Deleted AND expunge the given UIDs in a single command
   * (ImapFlow messageDelete = STORE \Deleted + EXPUNGE those UIDs). Use this for
   * draft deletion so there's NO window where the messages are flagged-but-not-
   * purged — otherwise a concurrent sync pulls the \Deleted copies into the local
   * DB as orphan rows right before they vanish from the server.
   */
  async deleteAndExpunge(uids: number[]): Promise<void> {
    if (!uids || uids.length === 0) return;
    this.ensureCurrentFolder();
    await this.op('DELETE+EXPUNGE', this.client!.messageDelete(uids, { uid: true }));
  }

  async expunge(): Promise<void> {
    this.ensureCurrentFolder();
    // ImapFlow has no standalone EXPUNGE; purge the \Deleted messages, which
    // messageDelete does (STORE \Deleted already set + EXPUNGE just those).
    const deleted = await this.op('SEARCH deleted', this.client!.search({ deleted: true }, { uid: true }));
    if (deleted && deleted.length > 0) {
      await this.op('EXPUNGE', this.client!.messageDelete(deleted, { uid: true }));
    }
  }

  // ========== IDLE Support ==========

  supportsIdle(): boolean {
    return this.capabilities.includes('IDLE');
  }

  async startIdle(callback: (event: IMAPEvent) => void): Promise<void> {
    this.ensureConnected();
    if (!this.supportsIdle()) {
      throw new IMAPError('Server does not support IDLE', 'IDLE_NOT_SUPPORTED');
    }

    // Replace any prior handlers to avoid accumulation.
    this.detachIdleHandlers();

    const handlers: IdleHandlers = {
      exists: (data) => callback({ type: 'new', uid: data.count }),
      flags: (data) =>
        callback({ type: 'update', seqNo: data.seq, uid: data.uid, flags: [...data.flags] }),
      expunge: (data) => callback({ type: 'expunge', seqNo: data.seq, uid: data.uid }),
    };
    this.idleHandlers = handlers;

    // ImapFlow auto-idles in the background while a mailbox is open and emits
    // these events — no explicit IDLE command needed.
    this.client!.on('exists', handlers.exists);
    this.client!.on('flags', handlers.flags);
    this.client!.on('expunge', handlers.expunge);
  }

  async stopIdle(): Promise<void> {
    this.detachIdleHandlers();
  }

  private detachIdleHandlers(): void {
    if (!this.idleHandlers || !this.client) {
      this.idleHandlers = null;
      return;
    }
    this.client.removeListener('exists', this.idleHandlers.exists);
    this.client.removeListener('flags', this.idleHandlers.flags);
    this.client.removeListener('expunge', this.idleHandlers.expunge);
    this.idleHandlers = null;
  }

  // ========== Search ==========

  async search(criteria: SearchCriteria): Promise<number[]> {
    this.ensureCurrentFolder();
    const query = this.buildSearchObject(criteria);
    const result = await this.op('SEARCH', this.client!.search(query, { uid: true }));
    return result || [];
  }

  private buildSearchObject(criteria: SearchCriteria): SearchObject {
    const s: SearchObject = {};

    if (criteria.all) s.all = true;
    if (criteria.unseen) s.seen = false;
    if (criteria.seen) s.seen = true;
    if (criteria.flagged) s.flagged = true;
    if (criteria.unflagged) s.flagged = false;
    if (criteria.deleted) s.deleted = true;
    if (criteria.undeleted) s.deleted = false;
    if (criteria.draft) s.draft = true;
    if (criteria.undraft) s.draft = false;
    if (criteria.answered) s.answered = true;
    if (criteria.unanswered) s.answered = false;
    if (criteria.new) s.new = true;
    if (criteria.old) s.old = true;
    if (criteria.recent) s.recent = true;

    if (criteria.from) s.from = criteria.from;
    if (criteria.to) s.to = criteria.to;
    if (criteria.cc) s.cc = criteria.cc;
    if (criteria.bcc) s.bcc = criteria.bcc;
    if (criteria.subject) s.subject = criteria.subject;
    if (criteria.body) s.body = criteria.body;
    if (criteria.text) s.text = criteria.text;

    if (criteria.before) s.before = criteria.before;
    if (criteria.since) s.since = criteria.since;
    if (criteria.sentBefore) s.sentBefore = criteria.sentBefore;
    if (criteria.sentSince) s.sentSince = criteria.sentSince;

    if (criteria.larger) s.larger = criteria.larger;
    if (criteria.smaller) s.smaller = criteria.smaller;

    if (criteria.uid) s.uid = criteria.uid.join(',');

    if (criteria.header) {
      const header: { [key: string]: boolean | string } = {};
      for (const h of criteria.header) header[h.name] = h.value;
      s.header = header;
    }

    return s;
  }

  // ========== Server Capabilities ==========

  async getCapabilities(): Promise<string[]> {
    return this.capabilities;
  }

  hasCapability(capability: string): boolean {
    return this.capabilities.includes(capability.toUpperCase());
  }
}
