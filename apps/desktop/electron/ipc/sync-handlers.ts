/**
 * Sync/IMAP IPC Handlers
 *
 * Handles IMAP connection, sync operations, and real-time updates.
 */

import { ipcMain } from 'electron';
import type { IMAPConfig, SyncEngineOptions } from '@sarvinbox/core';
import { withTimeout, resolveTlsOptions, accountIdFor, ImapFlowClient, isAuthError, isQuotaError, createLogger, LogAggregator, planFolderDrift, applyFolderDrift } from '@sarvinbox/core';

// Per-account connection back-off after a "too many simultaneous connections"
// quota error (or a connect timeout, usually the same saturated condition). ONE
// shared instance so EVERY connect path — the active `imap:connect`,
// `imap:resetAndReconnect`, and background sync — parks the same account for the
// same window; otherwise the active path kept re-hammering a cap the background
// path was already waiting out (the reconnect storm). See quota-backoff.ts.
import { createQuotaBackoff } from '../services/quota-backoff';
const quotaBackoff = createQuotaBackoff();
import { getStorage, getSyncEngine, getMainWindow, requireSyncEngine, requireStorage, sendToWindow, getCurrentAccountId, getStorageFor, getSyncEngineFor, getIsQuitting, getSystemSuspended, setCurrentAccount } from '../shared';
import { ensureAccountRuntime, accountInboxUnread, accountDbExists } from '../services/accounts-runtime';
import { getValidAccessToken, attachImapBearer } from '../services/oauth-service';
// Static import (not require()): the bundled main.js has no on-disk services
// file, so a runtime require() throws "Cannot find module".
import { kickBodyPrefetchScheduler } from '../services/body-prefetch-scheduler';
import { kickBackfillScheduler } from '../services/backfill-scheduler';
import { markConnectionUnstable } from '../services/connection-health';
import { saveImapAccount, loadImapAccount, clearImapAccount } from '../services/imap-account-store';
import { getAccountSecrets } from '../services/secure-credential-store';
import { identifyClient } from '../sentry';
import {
  getPipelineUserEmail,
  setPipelineUserProfile,
  provisionCategoryLabelsOnConnect,
  retryPipelineInitOnConnect,
} from '../services/unified-pipeline-service';
const logger = createLogger('sync-handlers');

// IDLE event logging is aggregated, never per-event. The server emits one
// event PER MESSAGE, so a flag reconcile produces hundreds of them in a burst;
// a console.log each meant hundreds of synchronous writes on the main thread
// (and hundreds of lines burying everything else). Count them instead and emit
// at most one summary line per second.
const IDLE_LOG_INTERVAL_MS = 1_000;
const idleEvents = new LogAggregator({
  windowMs: IDLE_LOG_INTERVAL_MS,
  emit: (summary) => logger.info('[IDLE] events:', summary),
});

const noteIdleEvent = (key: string): void => idleEvents.note(key);

// Engines whose 'disconnected' event is already bridged to the renderer.
// imap:connect runs on startup AND on every reconnect (focus/online); each
// call used to stack another raw listener (onDisconnect is a plain
// EventEmitter.on, never removed), so one real disconnect fanned out K
// events → reconnect amplification. WeakSet keys on the engine instance.
const disconnectBridged = new WeakSet<object>();

/**
 * Resolve an account's IMAP password from the encrypted vault, trying the id
 * the caller holds PLUS the host-derived and email-only ids — a legacy account
 * may have been vaulted under any of them (the `accountIdFor` variants used over
 * time). Single source of truth so the active/reconnect AND background-sync
 * connect paths agree: the background path used to look up only the exact id and
 * silently failed on legacy-keyed accounts ("No password configured") while the
 * active path found them. Returns undefined if no vaulted password matches.
 */
async function resolveVaultImapPassword(
  accountId: string | undefined,
  username: string,
  host?: string,
): Promise<string | undefined> {
  const ids = [accountId, accountIdFor(username, host), accountIdFor(username)];
  const tried = new Set<string>();
  for (const id of ids) {
    if (!id || tried.has(id)) continue;
    tried.add(id);
    const secrets = await getAccountSecrets(id);
    if (secrets?.imap?.password) return secrets.imap.password;
  }
  return undefined;
}

/**
 * Resolve the vault password as a PROMISE that settles the instant the data is
 * available, then the caller proceeds — no fixed delay. At app launch the connect
 * can fire before the OS keychain / vault is readable, so the first read may miss;
 * there's no OS "keychain ready" event to await, so we re-check on a short tick and
 * RESOLVE THE MOMENT the read succeeds (1s if it's ready in 1s, 5s if 5s). A
 * `timeoutMs` ceiling means a genuinely-missing password (needs re-auth) still
 * settles to undefined instead of blocking forever. Caller: `const pw = await …`.
 */
function resolveVaultImapPasswordWaiting(
  accountId: string | undefined,
  username: string,
  host?: string,
  { timeoutMs = 10_000, pollMs = 150 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = async () => {
      const pw = await resolveVaultImapPassword(accountId, username, host);
      if (pw) return resolve(pw);                                  // got it → proceed now
      if (Date.now() - started >= timeoutMs) return resolve(undefined); // give up → re-auth
      setTimeout(attempt, pollMs);
    };
    void attempt();
  });
}

/**
 * Prove a fully-resolved config can authenticate, WITHOUT touching the active
 * SyncEngine, account runtime, vault or saved config. Spins up a throwaway
 * ImapFlowClient, connects, logs out. Read-only by construction: a failure here
 * can never disturb a working account.
 *
 * Callers must resolve credentials (OAuth token / vault password) themselves —
 * this probes exactly what it is handed, so the contract stays "can THESE
 * credentials connect?".
 *
 * Shared by the `imap:probeCredentials` IPC (gating account overwrites) and the
 * oauth2→password self-heal in `imap:connect`.
 */
async function probeImapCredentials(config: IMAPConfig): Promise<{ success: boolean; error?: string }> {
  const client = new ImapFlowClient();
  // A probe reports its outcome purely through connect()'s resolve/reject, so
  // silence the client's own error channel BEFORE connecting. This is not
  // cosmetic: the client emits 'error' on a connection-level failure, and an
  // 'error' emitted on an EventEmitter with no listener is an uncaught
  // exception — fatal in the main process. setShuttingDown() suppresses that
  // emit (it gates nothing else), and the no-op listener is belt-and-braces
  // for any future emit path that doesn't check the flag.
  client.setShuttingDown();
  client.on('error', () => { /* reported via the returned error instead */ });
  try {
    await withTimeout(
      client.connect({ ...config, tlsOptions: resolveTlsOptions(config) }),
      PROBE_CREDENTIALS_TIMEOUT_MS,
      'Connection probe timed out',
    );
    return { success: true };
  } catch (error) {
    // Expected outcome for bad credentials — log at info, not error.
    logger.info('[Main] probeCredentials rejected:', (error as Error).message);
    return { success: false, error: (error as Error).message };
  } finally {
    // Never leave the probe socket open, even when connect() threw midway.
    try { await client.disconnect(); } catch { /* nothing to tear down */ }
  }
}

// Upper bound for a single imap:sync invocation. Generous enough for a
// real multi-folder first sync, short enough that a hung connection can't
// hold the IPC reply open indefinitely (→ "reply was never sent").
const SYNC_HANDLER_TIMEOUT_MS = 120_000;
// A BACKGROUND account's catch-up sync runs with its IDLE paused, so this bounds
// how long real-time push is offline per cycle. Kept short: IDLE resumes right
// after and detects any mail the capped catch-up didn't reach.
const BACKGROUND_CATCHUP_TIMEOUT_MS = 40_000;
// Bound for imap:ensureConnection so the IPC always replies even if the
// reconnect ladder runs long. Comfortably past one connect attempt (~25s).
const ENSURE_CONNECTION_TIMEOUT_MS = 30_000;
// Bound for a credential probe. One connect+auth round trip only (no mailbox
// work), so this is deliberately tighter than the sync/connect budgets — the
// user is staring at a spinner in the add-account modal while it runs.
const PROBE_CREDENTIALS_TIMEOUT_MS = 20_000;

// How often the ACTIVE account re-polls its non-INBOX folders for server-side
// deletions (see the timer in registerSyncHandlers). 5 min matches the background
// account cadence; the sweep is cheap (STATUS counts) and only content-syncs a
// folder when it detects the server shrank.
const ACTIVE_RECONCILE_INTERVAL_MS = 5 * 60_000;

/**
 * Last `STATUS unseen` we observed per folder, keyed `<account>:<folderId>`.
 * The FALLBACK half of the flag-reconcile trigger, for servers without
 * CONDSTORE: a CHANGE in the SERVER's own number between two sweeps — the only
 * like-for-like comparison available, since our stored unread is a thread count
 * and the server's is a message count (see planFolderDrift). In-memory on
 * purpose: after a restart the first sweep re-baselines, and the
 * unit-independent first-look check still catches an outright disagreement.
 *
 * On a CONDSTORE server the primary trigger is `HIGHESTMODSEQ` vs the folder
 * record's synced modseq — durable, and the only signal that sees a star change.
 */
const lastServerUnseen = new Map<string, number>();

/** Bound for one folder's flag reconcile. Generous (a big folder's FETCH FLAGS
 *  is slow) but far below the sweep's own cadence so it can never pile up. */
const FLAG_RECONCILE_TIMEOUT_MS = 60_000;

/**
 * STATUS-then-reconcile sweep across an engine's NON-INBOX folders: STATUS each (a
 * cheap count query — NO download), then reconcile what the counts say drifted —
 * flags when the server's unread moved, content when the server holds FEWER
 * messages than we do (which runs the safety-guarded deletion detection).
 *
 * This is the ONLY way non-INBOX folders learn about ANY server-side change: IMAP
 * IDLE watches INBOX only, and CONDSTORE is a pull-efficiency tool, not a push — so
 * a webmail delete, a mail read or STARRED/UNSTARRED in webmail, a retention
 * auto-expiry, or a Trash→Inbox move in another folder is invisible to us until
 * this sweep polls it.
 * Per-folder try/catch + timeout so one slow/bad folder never stalls the cycle;
 * INBOX is skipped (IDLE + its own sync cover it).
 *
 * It deliberately does NOT write the server's `unseen` into our `unreadCount`: that
 * is a message count where ours is a distinct-thread count, so it disagreed with
 * the list it labels and the next recount flipped it straight back. We reconcile
 * the ROWS and recount from them — one source of truth — then tell the renderer
 * which folder moved so an open list re-runs its query instead of showing
 * pre-reconcile read state under a fresh badge.
 */
async function reconcileNonInboxDeletions(
  engine: NonNullable<ReturnType<typeof getSyncEngine>>,
  storage: NonNullable<ReturnType<typeof getStorage>>,
  accountId?: string,
): Promise<void> {
  const folders = await storage.getFolders();
  for (const f of folders) {
    const isInbox = f.specialUse === '\\Inbox' || (f.path || '').toLowerCase() === 'inbox';
    if (isInbox) continue;
    try {
      const st = await withTimeout(engine.getFolderStatus(f.path), 15_000, 'STATUS timed out');
      const seenKey = `${accountId ?? '__active__'}:${f.id}`;
      const plan = planFolderDrift({
        previousUnseen: lastServerUnseen.get(seenKey),
        currentUnseen: st.unseen ?? 0,
        serverMessages: st.messages ?? 0,
        localTotal: f.totalCount ?? 0,
        localUnread: f.unreadCount ?? 0,
        // CONDSTORE baselines come from the FOLDER RECORD, not this sweep's
        // memory: `syncFlags` advances `highestModseq` once it has applied every
        // change up to it, so "server ahead of stored" survives a restart and
        // clears itself after one reconcile. This is what sees a star removed in
        // webmail — no count does.
        serverModseq: st.highestModseq,
        syncedModseq: f.highestModseq,
        serverUidValidity: st.uidValidity,
        localUidValidity: f.uidValidity,
      });
      lastServerUnseen.set(seenKey, st.unseen ?? 0);
      if (plan.reconcileFlags) {
        logger.info(
          `[Accounts] flag drift in ${f.path} (server unseen ${st.unseen ?? 0}, ` +
          `modseq ${st.highestModseq ?? '-'} vs synced ${f.highestModseq ?? '-'}) — reconciling`,
        );
      }

      // The order and the gates live in applyFolderDrift (unit-tested); this
      // supplies the I/O — each operation timeout-bounded so one slow folder
      // can never stall the sweep — plus the log and the renderer channel.
      await applyFolderDrift(plan, f, {
        refreshFolderFlags: (path) => withTimeout(
          engine.refreshFolderFlags(path),
          FLAG_RECONCILE_TIMEOUT_MS,
          'folder flag reconcile timed out',
        ),
        // Server has FEWER messages than we hold locally → messages were deleted
        // or moved on the server (webmail delete, retention expiry, Trash→Inbox
        // move). A content sync of just this folder runs the guarded deletion
        // detection that notices them.
        syncFolderContent: async (path) => {
          await withTimeout(
            engine.syncAll({ folders: [path], maxMessages: 50, parallelSync: false, skipUnchanged: true }),
            SYNC_HANDLER_TIMEOUT_MS,
            'folder deletion-reconcile timed out',
          );
        },
        recount: (path) => storage.recalculateFolderCounts([path]),
        readCounts: (path) => storage.getFolderByPath(path),
        // refreshFolderFlags emits no per-email events, so name the folder: the
        // renderer re-runs that folder's list query, not just the badges.
        notify: (path) => sendToWindow('folders:updated', { accountId, folderPath: path }),
        onError: (stage, path, error) =>
          logger.warn(`[Accounts] ${stage} reconcile failed for`, path, error.message),
      });
    } catch { /* skip this folder */ }
  }
}

export function registerSyncHandlers(): void {
  // ---- IDLE-for-all: per-account event bridges --------------------------------
  // Every account can run IMAP IDLE at once. Each SyncEngine has its OWN per-engine
  // sync-state, so events are isolated; we key bridges by accountId and tag every
  // forwarded event with it, so the renderer attributes new mail / flag changes to
  // the correct account (and refreshes the right badge + the unified view).
  const idleBridgesByAccount = new Map<string, { engine: any; listeners: { event: string; handler: (...args: any[]) => void }[] }>();
  const registerIdleBridges = (accountId: string | null, engine: any): void => {
    const key = accountId ?? '__active__';
    const tag = accountId ?? undefined; // undefined → renderer treats as the active account
    const prev = idleBridgesByAccount.get(key);
    if (prev) {
      for (const { event, handler } of prev.listeners) prev.engine.removeListener(event, handler);
    }
    // Resolve the live window at send-time via sendToWindow — these listeners
    // outlive a renderer reload; a captured window would point at the destroyed one.
    const bridge = (type: 'new' | 'flagsChanged' | 'deleted') => (emailId: string, folderPath: string) => {
      noteIdleEvent(`${type} account=${tag ?? '(active)'} folder=${folderPath}`);
      sendToWindow('idle:event', { type, emailId, folderPath, accountId: tag });
    };
    const onNewEmail = bridge('new');
    const onEmailUpdated = bridge('flagsChanged');
    const onEmailDeleted = bridge('deleted');
    engine.on('new-email', onNewEmail);
    engine.on('email-updated', onEmailUpdated);
    engine.on('email-deleted', onEmailDeleted);
    idleBridgesByAccount.set(key, {
      engine,
      listeners: [
        { event: 'new-email', handler: onNewEmail },
        { event: 'email-updated', handler: onEmailUpdated },
        { event: 'email-deleted', handler: onEmailDeleted },
      ],
    });
  };

  // ---- Active-account non-INBOX deletion reconcile (main-process timer) -----------
  // backgroundSync runs reconcileNonInboxDeletions for BACKGROUND accounts but SKIPS
  // the active one (its getCurrentAccountId guard). The active account only has IDLE
  // (INBOX-only) + the renderer's folder-open sync, which is skipped whenever a sync
  // is in progress — so its non-INBOX folders (Trash especially) would NEVER learn
  // about server-side deletions (webmail trash-delete, retention expiry, Trash→Inbox
  // move). Run the same sweep here on a main-process timer a busy renderer can't skip.
  // Guarded so it never contends with an in-flight sync; unref'd so it never holds the
  // process open. First pass ~60s after startup to clear anything missed while offline.
  let activeReconcileRunning = false;
  const runActiveReconcile = async (): Promise<void> => {
    if (getIsQuitting() || getSystemSuspended() || activeReconcileRunning) return;
    const engine = getSyncEngine();
    const storage = getStorage();
    if (!engine || !storage || !getCurrentAccountId()) return;
    if (!engine.isConnected() || engine.isSyncing()) return; // don't fight an active sync
    activeReconcileRunning = true;
    try {
      await reconcileNonInboxDeletions(engine, storage, getCurrentAccountId() ?? undefined);
    } catch (e) {
      logger.warn('[Accounts] active-account reconcile sweep failed:', (e as Error).message);
    } finally {
      activeReconcileRunning = false;
    }
  };
  const activeReconcileKick = setTimeout(() => void runActiveReconcile(), 60_000);
  activeReconcileKick.unref?.();
  const activeReconcileTimer = setInterval(() => void runActiveReconcile(), ACTIVE_RECONCILE_INTERVAL_MS);
  activeReconcileTimer.unref?.();

  /**
   * Connect to IMAP server
   */
  ipcMain.handle('imap:connect', async (_event, config: IMAPConfig, accountId?: string) => {
    // App is shutting down — refuse to (re)establish connections. The renderer's
    // periodic timers keep firing during teardown; without this they resurrect
    // the IMAP connection AFTER we disconnected it, so the process can't settle.
    if (getIsQuitting()) return { success: false, error: 'App is quitting' };
    // Set when the oauth2→password self-heal below fires, so the renderer can
    // persist the correction instead of re-healing on every launch.
    let healedAuthMethod: 'password' | undefined;
    try {
      // Self-activate the account if storage/engine isn't up yet. Main defers
      // storage to accounts:setActive, but if the renderer boots without its
      // active-account pointer (e.g. its localStorage registry was lost), that
      // never runs and EVERY IPC fails "Storage not initialized" — the app bricks
      // despite the account's DB being safe on disk. The renderer still hands us
      // the accountId here, so activate it ourselves. Guarded by accountDbExists
      // so we only REUSE an existing DB, never create a blank one.
      if (!getSyncEngine() && accountId && accountDbExists(accountId)) {
        await ensureAccountRuntime(accountId);
        setCurrentAccount(accountId);
        logger.info(`[Main] imap:connect self-activated account ${accountId} (storage was uninitialized)`);
      }
      const syncEngine = requireSyncEngine();
      const storage = getStorage();

      // Quota back-off: this account recently hit "too many simultaneous
      // connections" (or a connect timeout, the same saturated condition). This
      // handler fires on window focus / online / periodic reconnect — none of
      // which free the server's per-account cap — and then opens a fresh primary +
      // a multi-connection pool. Retrying now just re-hammers the saturated cap
      // and PROLONGS the lockout (the reconnect storm). Skip WITHOUT connecting
      // until the shared window elapses; the next focus/timer tick retries.
      const quotaKey = accountId ?? getCurrentAccountId();
      const parkedMs = quotaBackoff.remainingMs(quotaKey);
      if (parkedMs > 0) {
        logger.info(`[Main] connect skipped for ${quotaKey} — quota back-off active (server connection cap); ${Math.round(parkedMs / 1000)}s left`);
        return { success: false, error: 'Connection paused (server connection cap) — retrying shortly', retryable: true };
      }

      // Attribute every subsequent error/breadcrumb to this client + mailbox.
      // Set BEFORE connecting so a failed connect is also attributed correctly.
      identifyClient({
        email: config.username,
        provider: config.oauthProvider ?? 'imap',
        host: config.host,
        port: config.port,
      });

      // OAuth2: fetch a valid access token — refreshing if needed — so the
      // renderer never has to handle token lifecycle. Tokens live in the
      // main-process safeStorage-backed store.
      if (config.authMethod === 'oauth2') {
        if (!config.oauthProvider) {
          throw new Error('authMethod=oauth2 requires oauthProvider');
        }
        // SELF-HEAL an account that was converted to oauth2 in place. Signing in
        // with OAuth to an address already connected by app password used to
        // rewrite that account's authMethod (addAccount dedupes on email+host).
        // Where the mail server can't actually do OAuth, every sync then dies at
        // AUTH and the mailbox silently goes stale.
        //
        // A vaulted password on an account marked oauth2 is the signature of that
        // conversion — and the only thing there is to fall back to. A genuine
        // OAuth-only account stores no password, so it never pays for the probe
        // below and can never be downgraded. Once healed the account is no longer
        // oauth2, so this runs at most once.
        const vaultPw = await resolveVaultImapPassword(accountId, config.username, config.host);

        // Why the OAuth path is unusable, if it is — covers BOTH failure modes:
        // no token obtainable (missing/refresh rejected), or a token the mail
        // server won't accept.
        let oauthFailure: string | undefined;
        try {
          config = {
            ...config,
            accessToken: await getValidAccessToken(config.oauthProvider, config.username),
          };
          if (vaultPw) {
            const probe = await probeImapCredentials(config);
            // Only an AUTH rejection justifies the fallback — a network/TLS blip
            // must not silently downgrade a working OAuth account.
            if (!probe.success && isAuthError(new Error(probe.error ?? ''))) {
              oauthFailure = probe.error;
            }
          }
        } catch (tokenErr) {
          // Without a password to fall back to this stays terminal, as before.
          if (!vaultPw) throw tokenErr;
          oauthFailure = (tokenErr as Error).message;
        }

        if (vaultPw && oauthFailure) {
          logger.warn(
            `[Main] connect: OAuth unusable for ${config.username} on ${config.host} `
            + `(${oauthFailure}) — falling back to the vaulted app password and repairing the account`,
          );
          config = {
            ...config,
            authMethod: 'password',
            password: vaultPw,
            accessToken: undefined,
            // Drop the provider link too, matching what the renderer persists —
            // an account left as password-auth WITH an oauthProvider is
            // ambiguous state that later reads have to second-guess.
            oauthProvider: undefined,
          };
          healedAuthMethod = 'password';
        }
      } else if (!config.password) {
        // Password auth: the renderer no longer ships the password (it's stripped
        // from localStorage), so pull it from the encrypted vault via the shared
        // multi-id lookup (handles legacy account-key variants). Wait briefly for
        // the vault to become readable — at cold start this connect can beat it.
        const pw = await resolveVaultImapPasswordWaiting(accountId, config.username, config.host);
        if (pw) config = { ...config, password: pw };
      }

      // Never connect a password-auth account with no password. It fails with
      // "No password configured" AND connection-manager latches the config, so
      // every subsequent auto-reconnect re-hammers the same password-less config
      // (the startup "No password configured" loop). Bail retriably instead — the
      // renderer's reconnect flow tries again once credentials are available.
      if (config.authMethod !== 'oauth2' && !config.password) {
        logger.warn(`[Main] connect: no password available yet for ${config.username}@${config.host} — deferring connect (retriable)`);
        return { success: false, error: 'Credentials not ready — will retry', retryable: true };
      }

      // TLS verification ON by default (resolveTlsOptions); insecure only when
      // the account explicitly opts in via allowInsecureTLS. attachImapBearer
      // wires a fresh-token resolver for OAuth so the pool + reconnects never
      // authenticate with a token that expired after pool init (no-op for
      // password auth). This single config flows into both connect() and
      // initializePool(), and is what connection-manager stores for reconnects.
      const connectConfig = attachImapBearer({
        ...config,
        tlsOptions: resolveTlsOptions(config),
      });

      // If we already think we're connected, that may be a ZOMBIE
      // (TCP socket open but server dropped) — the user clicking
      // reconnect is the signal to distrust the current state and
      // force a fresh socket. Plain disconnect+connect reuses the
      // same client instance whose internal state may be corrupted
      // by the dead socket; forceReconnect builds a fresh client
      // (and tears down the pool's stale sockets).
      if (syncEngine.isConnected()) {
        logger.info('[Main] connect: already connected — forcing fresh socket via forceReconnect');
        try {
          // 35s outer > forceReconnect's own ~30s budget (resolveBearer ≤10s +
          // connect ≤22s) so this wrapper doesn't preempt a legit slow reconnect;
          // the client still force-closes any stalled socket on its inner timeout.
          await withTimeout(syncEngine.forceReconnect(), 35000, 'Force-reconnect timed out (35s)');
        } catch (frErr) {
          logger.warn('[Main] connect: forceReconnect failed, falling through to plain connect:', frErr);
          // Try a clean teardown then fall through to plain connect
          // below. This is the last-resort path.
          try { await syncEngine.disconnect(); } catch { /* ignore */ }
        }
      }

      // Plain connect (after the above teardown if needed, or fresh
      // app start). Timeout-wrap so the IPC doesn't hang the
      // renderer's reconnect spinner forever on a flaky network.
      if (!syncEngine.isConnected()) {
        await withTimeout(syncEngine.connect(connectConfig), 25000, 'IMAP connect timed out (25s)');
      }

      // Initialize connection pool for parallel sync. Gmail-aware sizing: the
      // per-account connection budget (see connection-budget.ts) caps the TOTAL
      // sockets, so keep the pool small enough that primary(1) + pool + IDLE stays
      // UNDER that budget with headroom for a transient reconnect — otherwise the
      // pool alone could consume the whole budget and starve the primary/IDLE.
      await syncEngine.initializePool(connectConfig, {
        maxConnections: /gmail|googlemail/i.test(connectConfig.host || '') ? 3 : 4,
        connectionTimeout: 60000,
        idleTimeout: 120000,
        // Share the SAME back-off this account's active/background connect paths
        // use, so the pool stops hammering a saturated cap during backfill/drain.
        // The pool was the one connect path with no back-off awareness — the
        // source of the "Failed to establish connection in required time" storm
        // on [Gmail]/All Mail. Gate reads the remaining park; onConnectError parks
        // on a quota/timeout connect failure (quotaBackoff classifies the error).
        connectGate: () => quotaBackoff.remainingMs(quotaKey),
        onConnectError: (error) => { quotaBackoff.parkOnError(quotaKey, error); },
      });
      logger.info('[Main] Connection pool initialized for parallel sync');

      // Set up disconnect handler to notify UI — exactly once per engine
      // (see disconnectBridged above). Resolve the window at emit time so
      // the bridge survives window close/reopen.
      if (!disconnectBridged.has(syncEngine)) {
        disconnectBridged.add(syncEngine);
        // Multi-account: every account has its own SyncEngine, but the renderer
        // has a single shared connection status. Only forward events from the
        // engine that is CURRENTLY active — otherwise a background/paused
        // account's health-check ladder flickers the active account's status
        // (and a paused account's disconnect clobbers the newly-switched one).
        const isActiveEngine = () => getSyncEngine() === syncEngine;
        syncEngine.onDisconnect(() => {
          // Record for EVERY engine (not just the active one) so a background
          // account's churn backs its OWN bulk work off — the renderer forward
          // below stays active-only.
          markConnectionUnstable(syncEngine);
          if (!isActiveEngine()) return;
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('imap:disconnected');
          }
        });
        // The reconnect ladder self-heals in main — without this positive
        // signal the renderer stays on "Server Disconnected" forever.
        syncEngine.onReconnect(() => {
          // The ladder self-healed — a slot is genuinely free again. Clear the
          // shared park + escalation ladders so the account isn't held down by
          // earlier piled-up timeout/quota failures and the next hiccup starts at
          // rung 1 instead of a stale high rung. Runs for EVERY engine (not just
          // the active one) so a background account resets its own back-off too.
          quotaBackoff.clear(quotaKey);
          if (!isActiveEngine()) return;
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('imap:reconnected');
          }
          // Connection is back → RESUME downloading immediately instead of waiting
          // out the backfill/prefetch idle interval (up to 30 min). This is what
          // makes the app "start downloading the moment the link returns" rather
          // than appearing stuck. Both kicks are no-ops if a tick is already running.
          try { kickBackfillScheduler(); } catch { /* best-effort */ }
          try { kickBodyPrefetchScheduler({ resetBackoff: true }); } catch { /* best-effort */ }
        });
        // Fired on every backoff attempt WHILE the ladder is retrying, so the
        // renderer can show a distinct "Reconnecting…" (retry) state instead
        // of red "Disconnected" for the whole self-healing window.
        syncEngine.onReconnecting(() => {
          // A retry attempt is itself an instability incident — count it so a
          // connect-time drop (which may not fire onDisconnect) still registers
          // as churn and throttles bulk work.
          markConnectionUnstable(syncEngine);
          if (!isActiveEngine()) return;
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('imap:reconnecting');
          }
        });
        // Ladder gave up (hit max attempts, now in cooldown). Fall the UI back
        // to a definitive disconnected state until the ladder resumes.
        syncEngine.onReconnectFailed(() => {
          if (!isActiveEngine()) return;
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('imap:disconnected');
          }
        });
        // Credentials rejected (terminal). Forget the bad saved config so
        // startup recovery can't re-supply it, and tell the renderer to
        // prompt re-authentication.
        syncEngine.onAuthError(() => {
          clearImapAccount().catch(() => {});
          const win = getMainWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send('imap:auth-error');
          }
        });
      }

      // Process any pending operations from previous session
      syncEngine.processPendingOps().catch(() => {});

      // Fix any sent emails showing as unread
      if (storage) {
        storage.markSentEmailsAsRead().catch((err) => {
          logger.error('Failed to mark sent emails as read:', err);
        });
      }

      // Ensure the unified pipeline knows who "we" are, so auto-drafts get a
      // valid From address even before the Sent folder has ever synced and
      // before the renderer pushes Settings → Profile.
      if (!getPipelineUserEmail() && config.username) {
        setPipelineUserProfile({ userEmail: config.username });
        logger.info('[Main] Pipeline userEmail set from IMAP credentials:', config.username);
      }

      // Persist the last-good config (main-process, encrypted) so the
      // session survives renderer-localStorage loss. Strip the volatile
      // accessToken (OAuth re-fetches it on each connect); keep only the
      // reconnect-able shape.
      // Persist last-good ONLY when we actually have a usable credential. A
      // password-auth config with an empty password used to POISON this store
      // (startup recovery then connected with no password → "No password
      // configured"); skip it so a good copy is never overwritten by a blank one.
      const hasUsableCred = config.authMethod === 'oauth2' || !!(config as any).password;
      if (hasUsableCred) {
        saveImapAccount({
          host: config.host,
          port: config.port,
          secure: (config as any).secure,
          username: config.username,
          password: (config as any).password ?? '',
          authMethod: config.authMethod,
          oauthProvider: config.oauthProvider,
          tlsOptions: (config as any).tlsOptions,
        }).catch((e) => logger.error('[Main] saveImapAccount failed:', e));
      }

      // Connected — a slot was free, so clear any escalating quota/timeout
      // back-off for this account (shared with the background path).
      quotaBackoff.clear(quotaKey);

      return { success: true, healedAuthMethod };
    } catch (error) {
      logger.error('IMAP connect error:', error);
      const quotaKey = accountId ?? getCurrentAccountId();
      // Quota ("too many simultaneous connections"): tear our engine down so a
      // pool/primary from a prior successful connect doesn't sit counted against
      // the per-account cap while the user retries. Mirrors backgroundSync's
      // quota handling. Best-effort.
      if (isQuotaError(error)) {
        try { await getSyncEngine()?.disconnect?.(); } catch { /* best effort */ }
      }
      // Park this account so the renderer's focus/online/periodic reconnects stop
      // re-hammering a saturated cap (quota escalates 45s→5m; a connect timeout
      // parks for a shorter flat window). Shared with backgroundSync/resetAndReconnect.
      const parked = quotaBackoff.parkOnError(quotaKey, error);
      if (parked.reason === 'quota') {
        logger.warn(`[Main] connect: quota hit for ${quotaKey} (too many connections) — backing off ${Math.round(parked.backoffMs / 1000)}s (attempt ${parked.attempt})`);
      } else if (parked.reason === 'timeout') {
        logger.warn(`[Main] connect: timed out for ${quotaKey} — backing off ${Math.round(parked.backoffMs / 60000)}m (attempt ${parked.attempt})`);
      }
      return {
        success: false,
        error: (error as Error).message,
        retryable: parked.reason !== null,
      };
    }
  });

  /**
   * Prove a candidate set of credentials can actually authenticate, WITHOUT
   * touching the active SyncEngine, account runtime, vault or saved config.
   *
   * Spins up a throwaway ImapFlowClient, connects, and logs out again. This is
   * a read-only probe by construction: a failure can never disturb a working
   * account. The add-account flow calls this BEFORE it is allowed to overwrite
   * an existing account, so a token the mail server rejects can't convert a
   * healthy app-password account into a broken OAuth one.
   *
   * Probes exactly what it is handed (no vault fallback) — the contract is
   * "can THESE credentials connect?". OAuth is the one exception: the renderer
   * never holds tokens, so we resolve it from the main-process store here.
   */
  ipcMain.handle('imap:probeCredentials', async (_event, config: IMAPConfig) => {
    let probeConfig = config;
    if (config.authMethod === 'oauth2') {
      if (!config.oauthProvider) {
        return { success: false, error: 'authMethod=oauth2 requires oauthProvider' };
      }
      try {
        probeConfig = {
          ...config,
          accessToken: await getValidAccessToken(config.oauthProvider, config.username),
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    return probeImapCredentials(probeConfig);
  });

  /**
   * Disconnect from IMAP server
   */
  ipcMain.handle('imap:disconnect', async () => {
    try {
      const syncEngine = requireSyncEngine();
      await syncEngine.disconnect();
      // Explicit disconnect = forget the saved account too, so startup
      // recovery doesn't silently reconnect after the user signed out.
      clearImapAccount().catch(() => {});
      return { success: true };
    } catch (error) {
      logger.error('IMAP disconnect error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Return the last-good IMAP config persisted in the main process, for
   * startup recovery when the renderer's localStorage credentials are gone.
   */
  ipcMain.handle('imap:getSavedConfig', async () => {
    try {
      return { success: true, data: await loadImapAccount() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Forget the persisted IMAP config (definitive auth rejection). */
  ipcMain.handle('imap:clearSavedConfig', async () => {
    try {
      await clearImapAccount();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Reset reconnect attempts and force a new connection attempt
   * Use this when connection is stuck after max reconnect attempts
   */
  ipcMain.handle('imap:resetAndReconnect', async () => {
    if (getIsQuitting()) return { success: true, data: { connected: false } };
    try {
      const syncEngine = requireSyncEngine();

      // Respect an active "too many simultaneous connections" quota back-off. This
      // handler fires on focus / tab-visible / network-online — none of which free
      // the server's per-account connection cap. Poking it now (reset + a
      // forceReconnect below) just re-hits the cap and keeps it saturated so the
      // 5-min back-off never succeeds. Let it elapse.
      if (syncEngine.isInQuotaCooldown?.()) {
        logger.info('[Main] resetAndReconnect skipped — quota cooldown active (server connection cap); letting it elapse');
        return { success: true, data: { connected: syncEngine.isConnected() } };
      }

      // Same rationale for an auth back-off: the server rejected the credentials,
      // and this focus/visibility/online-driven handler retrying the SAME password
      // every cycle is exactly what hammers (and prolongs) the server's lockout —
      // which then returns "Invalid credentials" even for a correct password. Let
      // the cooldown elapse; re-auth happens via an explicit reconnect.
      if (syncEngine.isInAuthCooldown?.()) {
        logger.info('[Main] resetAndReconnect skipped — auth cooldown active (credentials rejected); re-authentication required');
        return { success: true, data: { connected: syncEngine.isConnected() } };
      }

      // Also honor the shared quota back-off. The core cooldown above only trips
      // from the reconnect LADDER; a quota failure on the direct `imap:connect`
      // path parks the account here instead. This handler fires on
      // focus/visibility/online — none of which free the cap — so a forceReconnect
      // now would re-hit it and keep it saturated. Let the window elapse.
      const activeId = getCurrentAccountId();
      const parkedMs = quotaBackoff.remainingMs(activeId);
      if (parkedMs > 0) {
        logger.info(`[Main] resetAndReconnect skipped — quota back-off active for ${activeId} (server connection cap); ${Math.round(parkedMs / 1000)}s left`);
        return { success: true, data: { connected: syncEngine.isConnected() } };
      }

      // This fires on window focus / tab-visible / network-online. The caller
      // believes the network is back, so always clear the backoff counter — a
      // fresh attempt shouldn't be blocked by earlier piled-up failures.
      syncEngine.resetReconnectAttempts();

      // Liveness probe BEFORE any teardown. An unconditional forceReconnect
      // here was tearing down a perfectly healthy socket on every focus/
      // visibility change (→ "Connection ended unexpectedly" flapping and
      // duplicate syncs). Only force a fresh socket when the current one
      // fails to answer a NOOP — i.e. it's a real zombie.
      const alive = await syncEngine.verifyConnection();
      if (alive) {
        // Healthy — leave it alone. The renderer runs its own
        // ensureConnectionAndSync right after this, so don't kick a
        // duplicate sync from here.
        return { success: true, data: { connected: true } };
      }

      // Zombie/dead: hard teardown, fresh client, re-init pool, clear the
      // body-fetch blacklist, then resync.
      await syncEngine.forceReconnect();

      // forceReconnect may have no-op'd (wake-from-sleep race: config not yet
      // re-hydrated). Only sync when we actually hold a live connection —
      // otherwise syncAll just fails and warns for nothing; the pending
      // connect() will sync once it lands.
      if (!syncEngine.isConnected()) {
        return { success: true, data: { connected: false } };
      }

      // Run a sync against the fresh connection, timeout-wrapped so the IPC
      // doesn't hang the renderer if the new connection also misbehaves.
      try {
        await withTimeout(syncEngine.syncAll({ maxMessages: 50 }), 45000, 'Post-reconnect sync timed out (45s)');
      } catch (syncErr) {
        logger.warn('[Main] resetAndReconnect: sync after reconnect failed:', syncErr);
        // Don't fail the IPC — the reconnect itself succeeded, sync
        // can run later via IDLE or another user action.
      }

      return {
        success: true,
        data: { connected: syncEngine.isConnected() }
      };
    } catch (error) {
      logger.error('Reset and reconnect error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Ensure IMAP connection is alive, reconnect if needed
   * Returns { connected: boolean, reconnected: boolean }
   */
  ipcMain.handle('imap:ensureConnection', async () => {
    if (getIsQuitting()) return { success: true, data: { connected: false, reconnected: false } };
    try {
      const syncEngine = getSyncEngine();
      if (!syncEngine) {
        return { success: true, data: { connected: false, reconnected: false } };
      }

      if (syncEngine.isConnected()) {
        return { success: true, data: { connected: true, reconnected: false } };
      }

      // Not connected — try to reconnect via ensureConnection. Bound it so
      // the IPC ALWAYS replies: the reconnect ladder can retry for minutes
      // (or hang on a zombie socket), and an unbounded await never settles
      // the invoke → "reply was never sent" in the renderer. On timeout we
      // report not-connected; the ladder keeps going in the background and
      // the imap:reconnected event flips the UI when it actually succeeds.
      logger.info('[Main] Connection lost, attempting reconnect...');
      let ecTimer: ReturnType<typeof setTimeout> | null = null;
      const ecTimeout = new Promise<boolean>((resolve) => {
        ecTimer = setTimeout(() => resolve(false), ENSURE_CONNECTION_TIMEOUT_MS);
      });
      let reconnected: boolean;
      try {
        reconnected = await Promise.race([syncEngine.ensureConnection(), ecTimeout]);
      } finally {
        if (ecTimer) clearTimeout(ecTimer);
      }
      return { success: true, data: { connected: reconnected, reconnected } };
    } catch (error) {
      logger.error('Ensure connection error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Sync emails
   */
  ipcMain.handle('imap:sync', async (_event, options?: SyncEngineOptions) => {
    try {
      const syncEngine = requireSyncEngine();

      const syncOptions: SyncEngineOptions = {
        ...options,
        maxMessages: options?.maxMessages || 100,
        parallelSync: options?.parallelSync !== false,
        skipUnchanged: options?.skipUnchanged !== false,
        onProgress: (status: any) => {
          sendToWindow('sync:progress', status);
        },
      };

      logger.info('[Main] Starting sync with options:', {
        maxMessages: syncOptions.maxMessages,
        parallelSync: syncOptions.parallelSync,
        skipUnchanged: syncOptions.skipUnchanged,
        folders: syncOptions.folders,
      });

      // Bound the sync so the IPC handler ALWAYS replies. The folder-sync
      // path (ensureConnection + selectFolder + header fetch) has no
      // per-op timeout, so a zombie/half-open connection — common right
      // after a folder switch — can make syncAll hang forever. An
      // unbounded await here never settles the ipcRenderer.invoke, which
      // surfaces in the renderer as "reply was never sent" and a stuck
      // folder. Race against a generous cap; on timeout, reset the engine
      // (stopSync clears isSyncing so the NEXT sync isn't blocked for the
      // 5-min stale watchdog) and return a normal error reply.
      await withTimeout(syncEngine.syncAll(syncOptions), SYNC_HANDLER_TIMEOUT_MS, 'Sync timed out');
      // Sync just delivered fresh headers — wake the body-prefetch
      // scheduler so it doesn't wait the full ACTIVE_INTERVAL_MS /
      // IDLE_INTERVAL_MS before fetching the new bodies. Without this
      // the scheduler can sit on a stale idle-interval and downloads
      // appear "stuck" until the user restarts the app (which fires a
      // separate one-shot via emails:downloadBodies on the renderer).
      try {
        kickBodyPrefetchScheduler?.();
      } catch { /* best-effort */ }

      // Self-heal rows stored with an empty envelope (blank sender/subject, a
      // synthetic "<missing-...>" id) from an earlier partial fetch — those are
      // skipped by incremental sync and never recover on their own. Bounded and
      // fire-and-forget so it never blocks the reply.
      syncEngine.repairIncompleteEmails().catch(() => {});

      return { success: true };
    } catch (error) {
      const message = (error as Error).message || String(error);
      if (message.includes('Sync already in progress')) {
        // Benign collision: another sync (startup auto-sync, realtime
        // poller) is mid-flight and the engine refused the duplicate.
        // The renderer treats this string as a no-op — don't print a
        // stack trace for it.
        logger.info('[Main] Sync request skipped — a sync is already running');
        return { success: false, error: message, alreadyRunning: true };
      }
      if (message.includes('Sync timed out')) {
        // Hung folder sync (likely a zombie connection). Reset the
        // engine's sync state so it's not wedged for the 5-min watchdog,
        // and kick a reconnect so the next attempt has a live socket.
        logger.warn('[Main] Sync timed out — resetting sync state and reconnecting');
        try { requireSyncEngine().stopSync(); } catch { /* ignore */ }
        try { requireSyncEngine().forceReconnect().catch(() => {}); } catch { /* ignore */ }
        return { success: false, error: message, timedOut: true };
      }
      logger.error('IMAP sync error:', error);
      return {
        success: false,
        error: message,
      };
    }
  });

  /**
   * Pull ONE bounded chunk of older mail for a folder (header-only, a bounded UID
   * window) via the background backfill mechanism. The renderer calls this from
   * scroll-to-bottom when the local page is exhausted but the server holds older
   * mail — instead of the old growing, blocking `fullSync`. It yields to any
   * foreground sync (returns null) and is cheap; the background backfill scheduler
   * covers the same ground continuously, so this is just an on-demand nudge.
   */
  ipcMain.handle('imap:backfillChunk', async (_event, folderPath: string) => {
    try {
      const syncEngine = requireSyncEngine();
      const result = await withTimeout(
        syncEngine.backfillOlderChunk(folderPath),
        SYNC_HANDLER_TIMEOUT_MS,
        'Backfill chunk timed out',
      );
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message || String(error) };
    }
  });

  /**
   * Stop sync
   */
  ipcMain.handle('imap:stopSync', async () => {
    try {
      const syncEngine = getSyncEngine();
      if (syncEngine) {
        await syncEngine.stopSync();
      }
      return { success: true };
    } catch (error) {
      logger.error('Stop sync error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Get sync status
   */
  ipcMain.handle('imap:status', async () => {
    try {
      const syncEngine = getSyncEngine();
      if (!syncEngine) {
        return {
          success: true,
          data: {
            connected: false,
            syncing: false,
            lastSync: null,
          },
        };
      }

      return {
        success: true,
        data: {
          connected: syncEngine.isConnected(),
          syncing: syncEngine.isSyncing(),
          lastSync: null, // Last sync time tracked at folder level, not engine level
        },
      };
    } catch (error) {
      logger.error('Get status error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Check if connected to IMAP server
   */
  ipcMain.handle('imap:isConnected', async () => {
    try {
      const syncEngine = getSyncEngine();
      if (!syncEngine) {
        return { success: true, data: false };
      }
      return { success: true, data: syncEngine.isConnected() };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // ========== IDLE (Real-time Updates) ==========

  /**
   * Start real-time sync monitoring
   */
  ipcMain.handle('imap:startIdle', async (_event, folderPath: string, _pollingIntervalMs?: number) => {
    try {
      const syncEngine = requireSyncEngine();
      // Tag the active account's IDLE events with its id, just like every other
      // account (IDLE-for-all). Each engine has its own per-engine sync-state,
      // so bridges never cross accounts.
      registerIdleBridges(getCurrentAccountId(), syncEngine);
      provisionCategoryLabelsOnConnect(getCurrentAccountId());
      retryPipelineInitOnConnect();
      const mode = await syncEngine.startRealTime(folderPath);

      if (mode) {
        logger.info(`[Main] Real-time sync started using: ${mode} for ${folderPath}`);
      }

      return { success: true, data: !!mode, mode };
    } catch (error) {
      logger.error('Start real-time sync error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Stop real-time sync monitoring
   */
  ipcMain.handle('imap:stopIdle', async () => {
    try {
      const syncEngine = requireSyncEngine();
      await syncEngine.stopRealTime();
      return { success: true };
    } catch (error) {
      logger.error('Stop real-time sync error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Check if real-time sync is active
   */
  ipcMain.handle('imap:isIdleActive', async () => {
    try {
      const syncEngine = getSyncEngine();
      if (!syncEngine) {
        return { success: true, data: false };
      }
      return { success: true, data: syncEngine.isRealTimeActive() };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Refresh flags for a folder
   */
  ipcMain.handle('imap:refreshFlags', async (_event, folderPath: string) => {
    try {
      const syncEngine = requireSyncEngine();
      const updatedCount = await syncEngine.refreshFolderFlags(folderPath);
      return { success: true, data: updatedCount };
    } catch (error) {
      logger.error('Refresh flags error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Get storage stats
   */
  ipcMain.handle('storage:stats', async () => {
    try {
      const storage = requireStorage();
      const stats = await storage.getStats();
      return { success: true, data: stats };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // ===== Tier B: background freshness for INACTIVE accounts =================
  // Renderer-driven: a periodic renderer loop calls this once per opted-in,
  // non-active account (passing its IMAP config). We sync ONLY that account's
  // INBOX into its own DB and return its unread count for the sidebar badges.
  // The active account is untouched (it has its own IDLE). New-email events from
  // this sync flow through the shared emitter but are filtered out by the active
  // idle-bridge's belongsToActive guard, so they never disturb the active view.
  ipcMain.handle('accounts:backgroundSync', async (_event, opts: { accountId: string; config: IMAPConfig }) => {
    if (getIsQuitting()) return { success: true, data: { skipped: true } };
    const { accountId, config } = opts ?? ({} as { accountId: string; config: IMAPConfig });
    // Unread for the "All Inboxes" badge / account switcher — INBOX distinct-thread
    // count only, matching the inbox list (see accountInboxUnread).
    const totalUnread = async (storage: ReturnType<typeof getStorage>): Promise<number> => {
      if (!storage) return 0;
      return accountInboxUnread(await storage.getFolders());
    };
    try {
      if (!accountId || !config) return { success: false, error: 'accountId + config required' };

      // System suspended (asleep, incl. a macOS Power Nap dark-wake): do NOT open
      // a connection. It would freeze the moment the Mac drops back to sleep and
      // become a Gmail-cap zombie. Cleared on the next real user wake.
      if (getSystemSuspended()) {
        return { success: true, data: { skipped: true, suspended: true } };
      }

      // Quota back-off: this account recently hit "too many simultaneous
      // connections". Skip WITHOUT opening a connection until the window passes —
      // retrying now would just add another connect against the saturated cap.
      const quotaBackoffMs = quotaBackoff.remainingMs(accountId);
      if (quotaBackoffMs > 0) {
        return { success: true, data: { skipped: true, quotaBackoffMs } };
      }

      // Never sync the active account here — it drives its own IDLE/sync.
      if (getCurrentAccountId() === accountId) {
        return { success: true, data: { unread: await totalUnread(getStorageFor(accountId) ?? getStorage()), skipped: true } };
      }

      const rt = await ensureAccountRuntime(accountId);
      if (!rt?.storage || !rt.syncEngine) return { success: false, error: 'Runtime unavailable' };
      const engine = rt.syncEngine;

      // FAST PATH: the account is ALREADY live (connected + IDLE running). The
      // full path below tears IDLE DOWN (stopRealTime → catch-up sync → STATUS
      // sweep → startRealTime) every cycle — so a background Gmail loses real-time
      // push for up to a minute each 15-min tick, and new mail lags. If IDLE is
      // already up it's covering INBOX in real time (~1-2s), so don't disturb it:
      // just refresh the local unread count and return. Any true drop fails the
      // isConnected() check and falls through to the full re-establish.
      if (engine.isConnected() && engine.isRealTimeActive?.()) {
        // Healthy again (recovered via another path) — clear quota escalation.
        quotaBackoff.clear(accountId);
        return { success: true, data: { unread: await totalUnread(rt.storage), live: true } };
      }

      // MIDDLE PATH: the SOCKET is alive but IDLE dropped (marginal — a NOOP blip,
      // a transient IDLE error). Just RE-ARM IDLE — do NOT run the full teardown +
      // catch-up sync + STATUS sweep below. Those exist to recover mail MISSED
      // while the account was genuinely DISCONNECTED; on a still-connected socket
      // there was no dark window, so re-issuing IDLE restores real-time push
      // cheaply. Without this, a marginal-but-connected account paid the whole
      // heavy re-establish every background cycle — a primary source of the
      // reconnect/IDLE flapping.
      if (engine.isConnected()) {
        registerIdleBridges(accountId, engine);
        try {
          const mode = await engine.startRealTime('INBOX');
          logger.info('[IDLE] backgroundSync re-armed IDLE (socket alive) for', accountId, '→', mode);
        } catch (e) {
          logger.warn('[IDLE] backgroundSync IDLE re-arm failed for', accountId, (e as Error).message);
        }
        return { success: true, data: { unread: await totalUnread(rt.storage), live: true, reidled: true } };
      }

      // Connect if this account has no live connection yet. We LEAVE it connected
      // afterwards (matches the "background connections stay alive for instant
      // switching" model) — with per-engine sync-state this never disturbs the
      // active account. Skips the connect on subsequent cycles.
      if (!engine.isConnected()) {
        let cfg = config;
        if (cfg.authMethod === 'oauth2' && cfg.oauthProvider) {
          cfg = { ...cfg, accessToken: await getValidAccessToken(cfg.oauthProvider, cfg.username) };
        } else if (!cfg.password) {
          // Password auth: the renderer no longer ships the password (stripped
          // from localStorage), so inject it from the encrypted vault via the
          // SAME multi-id lookup the active/reconnect path uses — a single-id
          // lookup here silently missed legacy-keyed accounts ("No password
          // configured") while the active path found them. Wait briefly for the
          // vault at cold start (same startup race as the foreground path).
          const pw = await resolveVaultImapPasswordWaiting(accountId, cfg.username, cfg.host);
          if (pw) cfg = { ...cfg, password: pw };
        }
        // Don't connect password-less (fails "No password configured" and latches
        // that config for auto-reconnect to hammer). Skip this cycle; the next
        // background tick retries once the vault is readable.
        if (cfg.authMethod !== 'oauth2' && !cfg.password) {
          logger.warn(`[Accounts] backgroundSync: no password available yet for ${accountId} — skipping connect this cycle`);
          return { success: false, error: 'Credentials not ready', retryable: true };
        }
        await withTimeout(engine.connect(attachImapBearer({ ...cfg, tlsOptions: resolveTlsOptions(cfg) })), 25_000, 'Background connect timed out');
        // Connected — a slot was free, so clear any escalating quota backoff.
        quotaBackoff.clear(accountId);
      }

      // Pause any prior IDLE so the INBOX sync + STATUS sweep own the connection
      // (they run STATUS/SELECT commands); we restart IDLE right after.
      try { await engine.stopRealTime(); } catch { /* not running */ }

      // INBOX catch-up sync (covers mail that arrived while this account had no
      // live connection). No progress callback (per-engine state; nothing sent to
      // the shared UI). BEST-EFFORT: a slow/huge mailbox can time this out, but a
      // timeout must NOT skip the "go LIVE (IDLE)" step below — otherwise the
      // account is stranded with no real-time push for up to SYNC_HANDLER_TIMEOUT_MS
      // + a whole cycle, and new mail (e.g. a background Gmail while Sarv is
      // active) lags badly. IDLE is the fast path; keeping it alive is what counts.
      try {
        // Shorter than SYNC_HANDLER_TIMEOUT_MS (120s): this is the window IDLE is
        // DOWN while the catch-up runs. On a huge mailbox the deletion/flag
        // reconcile (UID SEARCH ALL) can take a minute+, so cap it — IDLE picks up
        // anything the catch-up misses the moment it's back live.
        await withTimeout(
          engine.syncAll({ folders: ['INBOX'], maxMessages: 100, parallelSync: false, skipUnchanged: true }),
          BACKGROUND_CATCHUP_TIMEOUT_MS,
          'Background sync timed out',
        );
      } catch (e) {
        logger.warn('[Accounts] background INBOX catch-up sync failed (going LIVE anyway) for', accountId, (e as Error).message);
      }

      // STATUS-then-reconcile sweep across this account's non-INBOX folders (fresh
      // unread badges + server-side deletion detection). Shared with the active-
      // account timer — see reconcileNonInboxDeletions.
      try {
        await reconcileNonInboxDeletions(engine, rt.storage, accountId);
      } catch (e) {
        logger.warn('[Accounts] STATUS sweep failed for', accountId, (e as Error).message);
      }

      // Go LIVE: tagged IDLE bridges + real-time push. Idempotent.
      registerIdleBridges(accountId, engine);
      // Now that this account is connected, provision its category labels
      // (once per session) — reliable regardless of connect timing.
      provisionCategoryLabelsOnConnect(accountId);
      retryPipelineInitOnConnect();
      try {
        const mode = await engine.startRealTime('INBOX');
        logger.info('[IDLE] backgroundSync startRealTime for', accountId, '→ mode:', mode);
      } catch (e) {
        logger.warn('[IDLE] startRealTime FAILED for', accountId, (e as Error).message);
      }

      return { success: true, data: { unread: await totalUnread(rt.storage) } };
    } catch (error) {
      // ALWAYS release OUR sockets on any failure. A timed-out connect is the
      // worst case: withTimeout abandons the await, but ImapFlow keeps completing
      // the connect in the background, so that socket lands against the server's
      // connection cap moments later (the "connection closed / too many
      // connections" that fires seconds after the timeout). Disconnecting
      // aborts/closes it so it releases back to the server instead of leaking.
      try { await getSyncEngineFor(accountId)?.disconnect?.(); } catch { /* best effort */ }

      // "Too many simultaneous connections" (or a connect timeout, usually the
      // same saturated condition) — park this account via the shared back-off so
      // the next cycles (and the active-account path) don't keep hammering the
      // saturated cap, which prolongs the lockout and risks a real rate-limit.
      const parked = quotaBackoff.parkOnError(accountId, error);
      if (parked.reason === 'quota') {
        logger.warn(`[Accounts] backgroundSync: quota hit for ${accountId} (too many connections) — backing off ${Math.round(parked.backoffMs / 1000)}s (attempt ${parked.attempt})`);
        return { success: false, error: (error as Error).message, quotaExceeded: true };
      }
      if (parked.reason === 'timeout') {
        logger.warn(`[Accounts] backgroundSync: connect timed out for ${accountId} — backing off ${Math.round(parked.backoffMs / 60000)}m`);
        return { success: false, error: (error as Error).message };
      }
      logger.warn('[Accounts] backgroundSync failed for', accountId, (error as Error).message);
      return { success: false, error: (error as Error).message };
    }
  });
}
