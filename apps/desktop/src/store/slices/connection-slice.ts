import type { SMTPConfig } from '@sarvinbox/core';
import { createSingleFlight } from '@sarvinbox/core/single-flight';

import { EMAIL_PROVIDERS } from '../../config/email-providers';
import { removeOAuthProvidersForAccount, syncAIProviderToMain } from '../../services/ai-service';
import { loadSavedCredentials, loadSavedSmtpCredentials, saveCredentials, clearCredentials, saveSmtpCredentials, clearSmtpCredentials, deriveSmtpFromImap, loadSmtpConfigured, saveSmtpConfigured, migrateAccounts, upsertAccount, removeAccount, saveAccounts, saveActiveAccountId, accountIdFor, normalizeAccount, findAccountByEmailHost, extractSecrets, fetchVaultSecrets, effectiveSmtpConfig, clearImageAllowedCache, loadQuotaCache, saveQuotaCache } from '../helpers';
import type { ConnectionSlice, EmailStore, SliceCreator, StoredAccount } from '../types';

// Concurrent connects to the SAME account join one run.
//
// Mount, window focus, network-online and the reconnect ladder all reach for the
// connection independently, and React's StrictMode double-invokes the mount
// effect in development — so two connects to the same account overlapped on
// every cold start. The second one entered the main process while the first was
// still opening ("Already connected or connecting"), which force-reconnected the
// half-open socket out from under it and surfaced as a spurious startup error:
//
//   Already connected or connecting
//   forceReconnect: tearing down current (possibly zombie) connection
//   IMAP connect error: IMAPError: Unexpected close
//
// It also ran this function's side effects twice — a vault write, a credential
// save, a registry upsert and a background sync per duplicate call. Keyed by
// ACCOUNT id, so switching accounts still connects both.
const connectInFlight = createSingleFlight<void>();

const initialAccounts = migrateAccounts();
const initialActiveAccount =
  initialAccounts.accounts.find((a) => a.id === initialAccounts.activeAccountId) ?? null;

// The active account's OWN sending config — never the shared legacy global key,
// which is per-app (not per-account) and would leak another account's SMTP.
// An account that hasn't verified SMTP has no config (null), so the setup form
// prefills from its IMAP rather than a foreign host.
const initialSmtpConfigured = initialActiveAccount
  ? initialActiveAccount.smtpConfigured
  : loadSmtpConfigured();
const initialSmtpConfig = initialActiveAccount
  ? effectiveSmtpConfig(initialActiveAccount)
  : loadSavedSmtpCredentials();

// Last-known storage usage per account, so the sidebar bar is populated on the
// first paint instead of appearing a round-trip later.
const initialQuotaCache = loadQuotaCache();

/**
 * One connect attempt for one account — the body of `connect()`, lifted out so
 * the slice method is just "resolve the identity, then coalesce". It is
 * deliberately NOT re-entrant per account: it writes the vault, localStorage
 * credentials, the account registry and the active-account pointer, none of
 * which tolerates a concurrent second pass over the same account.
 */
async function doConnect(
  acctId: string,
  config: Parameters<ConnectionSlice['connect']>[0],
  set: (partial: Partial<EmailStore>) => void,
  get: () => EmailStore,
): Promise<void> {
  console.log('[Store] connect() called with:', { host: config.host, username: config.username });
  // Rehydrate secrets from the encrypted vault when handed a stripped config
  // (loaded from localStorage after migration). In-memory only — never re-saved
  // to disk. If the caller already supplied a secret (login form), use it as-is.
  let connectConfig = config;
  const hasSecret = !!(config.password || config.accessToken || config.refreshToken);
  if (!hasSecret) {
    // Try the registry id AND the host-derived id — a legacy account's secret
    // may be vaulted under either (its id can predate host-keying).
    const secrets = await fetchVaultSecrets([acctId, accountIdFor(config.username, config.host)]);
    if (secrets?.imap) connectConfig = { ...config, ...secrets.imap };
  }
  try {
    // Pass the account id so main can inject the vault password itself if the
    // renderer-side rehydration missed it (belt-and-suspenders — main owns the vault).
    const result = await window.electronAPI.imap.connect(connectConfig, acctId);
    console.log('[Store] IPC connect result:', result);

    if (result.success) {
      console.log('[Store] Connection successful, updating state...');

      // Main repaired an account that was marked oauth2 but whose server
      // rejected the token (it reconnected using the vaulted app password).
      // Adopt the correction here so every persistence path below — vault,
      // localStorage credentials, registry — records it and the repair sticks
      // instead of re-running on every launch.
      if (result.healedAuthMethod) {
        console.warn(`[Store] Account auth repaired: oauth2 → ${result.healedAuthMethod}`);
        connectConfig = {
          ...connectConfig,
          authMethod: result.healedAuthMethod,
          accessToken: undefined,
          refreshToken: undefined,
          oauthProvider: undefined,
        };
      }

      set({
        connected: true,
        imapConfig: connectConfig,
        connectionStatus: 'connected',
        showConnectedMessage: true,
        needsReauth: false,
      });

      // Hide connected message after 5 seconds
      setTimeout(() => {
        set({ showConnectedMessage: false });
      }, 5000);

      // Persist the secret to the encrypted vault (keyed by account id), then
      // save the NON-secret config to localStorage (saveCredentials strips).
      try {
        await window.electronAPI.secureCreds.set(acctId, { imap: extractSecrets(connectConfig) });
      } catch (e) {
        console.warn('[Store] Failed to store IMAP secret in vault:', (e as Error)?.message);
      }
      saveCredentials(connectConfig);

      // Register/refresh this account in the multi-account registry and make
      // it the active one.
      // Sending config is PER-ACCOUNT: take it from this account's existing
      // registry entry, NOT from the shared global store field (which may hold
      // another account's SMTP). An account that hasn't verified SMTP carries
      // none (null) — connectSmtp/markSmtpConfigured are the only writers of a
      // real config. This also cleans any earlier cross-account contamination:
      // an unconfigured account is re-stamped with null here.
      const existing = get().accounts.find((a) => a.id === acctId);
      const isReconnectOfActive = !!existing && existing.id === get().activeAccountId;
      const isOauth = (connectConfig as { authMethod?: string }).authMethod === 'oauth2';
      // PRESERVE sending (SMTP) across an IMAP (re)connect. Re-authing IMAP —
      // e.g. after a webmail password change — must NEVER wipe or reset the
      // account's SMTP. Prefer the account's own stored config; for a reconnect
      // of the ACTIVE account, fall back to the live store value so an entry
      // that held SMTP only under the legacy global key isn't dropped. OAuth
      // accounts still DERIVE their SMTP (immune to the same-email crossing).
      const preservedConfigured = existing?.smtpConfigured || (isReconnectOfActive && get().smtpConfigured) || false;
      const preservedConfig = existing?.smtpConfig ?? (isReconnectOfActive ? get().smtpConfig : null) ?? null;
      const acctSmtpConfig = isOauth
        ? effectiveSmtpConfig({ ...(existing ?? ({} as StoredAccount)), imapConfig: connectConfig })
        : (preservedConfigured ? preservedConfig : null);
      const acctSmtpConfigured = isOauth ? !!acctSmtpConfig : preservedConfigured;
      const account: StoredAccount = {
        id: acctId,
        email: config.username,
        imapConfig: connectConfig,
        smtpConfig: acctSmtpConfig,
        smtpConfigured: acctSmtpConfigured,
      };
      // Switching to a different account? Drop the per-account image allowlist
      // so it re-warms from the new account's DB (harmless no-op on reconnect).
      if (acctId !== get().activeAccountId) clearImageAllowedCache();
      saveActiveAccountId(acctId);
      // Keep the global store fields + legacy localStorage in sync with THIS
      // account, so the SMTP form and banner read the active account's own
      // sending config (not a leftover from another account).
      saveSmtpConfigured(acctSmtpConfigured);
      if (acctSmtpConfig) saveSmtpCredentials(acctSmtpConfig);
      // NEVER clear SMTP on an IMAP reconnect — only a brand-new account (never
      // seen before) starts with a clean SMTP slate. This is what stopped an
      // IMAP re-auth from wiping a working SMTP config.
      else if (!existing) clearSmtpCredentials();
      set({
        accounts: upsertAccount(get().accounts, account),
        activeAccountId: acctId,
        smtpConfig: acctSmtpConfig,
        smtpConfigured: acctSmtpConfigured,
      });

      // A successful connection means this account is set up — mark
      // onboarding complete so a later credential loss surfaces the
      // lightweight reconnect dialog, NOT the full first-run wizard
      // (Sign in with Sarv / Connect Email / Shortcuts). Previously the
      // flag was only set at the END of the wizard, so users who
      // connected mid-wizard had it stuck false and saw the whole
      // wizard again whenever creds went missing.
      try { localStorage.setItem('sarvinbox-onboarding-complete', 'true'); } catch { /* ignore */ }

      // Set up sync progress listener (remove old first to prevent accumulation)
      window.electronAPI.imap.removeSyncProgressListener();
      window.electronAPI.imap.onSyncProgress((status) => {
        get().handleSyncProgress(status);
      });

      console.log('[Store] Loading folders...');
      await get().loadFolders();

      // Kick the full multi-folder email sync in the BACKGROUND — do NOT await
      // it. The connection is established and the folder list is loaded, so the
      // account is usable now; emails stream into the view via the
      // sync-progress listener above + the per-folder section reloads. Awaiting
      // it here made EVERY connect path block on a potentially long, contended
      // sync — the "Sign in with Sarv" / "Verify & Continue" button stayed
      // spinning long after the account had actually connected, worst while other
      // accounts were mid background-sync on the shared main thread. A sync
      // failure is not a connect failure (the socket is up), so it's logged, not
      // thrown.
      console.log('[Store] Starting sync of all folders (background)...');
      void get().syncEmails().catch((e) =>
        console.warn('[Store] background syncEmails failed:', (e as Error)?.message),
      );
    } else {
      throw new Error(result.error || 'Failed to connect');
    }
  } catch (error) {
    // Transient startup/connection failures self-heal via the main-process
    // reconnect ladder — log concisely (not a console.error + stack). The
    // throw still propagates so callers (manual connect) can react.
    console.warn('[Store] Connect failed (reconnect will retry):', (error as Error)?.message ?? error);
    throw error;
  }
}

export const createConnectionSlice: SliceCreator<ConnectionSlice> = (set, get) => ({
  connected: false,
  // Derive from the ACTIVE ACCOUNT's own config (secrets stripped — the vault
  // re-hydrates them on connect), NOT the legacy single-account `loadSavedCredentials`
  // store. That legacy store is per-app, not per-account: removing one account can
  // leave it empty/stale, which nulled imapConfig even though activeAccountId still
  // resolved to a valid account — the app then flashed the inbox then "No account
  // connected". Fall back to the legacy store only when there's no active account
  // record yet (first-run / pre-migration). Mirrors the SMTP config above.
  imapConfig: initialActiveAccount?.imapConfig ?? loadSavedCredentials(),
  accounts: initialAccounts.accounts,
  activeAccountId: initialAccounts.activeAccountId,
  deletingAccountIds: [],
  accountActionError: null,
  checkingConnection: true,
  connectionStatus: 'disconnected',
  // True only after a DEFINITIVE auth rejection — the one case where we
  // prompt the user to re-enter the password. Transient disconnects never
  // set this, so they show the cached inbox + background reconnect instead
  // of a blocking sign-in dialog.
  needsReauth: false,
  showConnectedMessage: false,
  quota: initialActiveAccount ? (initialQuotaCache[initialActiveAccount.id] ?? null) : null,
  quotaByAccount: initialQuotaCache,
  quotaLoading: false,
  smtpConnected: false,
  smtpConfig: initialSmtpConfig,
  smtpConfigured: initialSmtpConfigured,

  loadQuota: async (accountId) => {
    const target = accountId ?? get().activeAccountId ?? undefined;
    // Marks the bar as refreshing so it can hold its place (last-known value, or
    // a placeholder on the very first look) instead of vanishing and popping back.
    set({ quotaLoading: true });
    try {
      const res = await window.electronAPI.emails.getQuota?.(target);
      // An account switch may have landed while this was in flight. The answer
      // describes `target`, so applying it to whoever is active NOW would show
      // one mailbox's usage under another — the exact confusion this fixes.
      // The newer load owns `quotaLoading`; don't clear it on its behalf.
      if (get().activeAccountId !== (target ?? null)) return;
      if (res?.success) {
        const quota = res.data ?? null;
        // Remember it per account: switching back paints instantly, and a cold
        // start opens with the last-known number already on screen. A null is
        // recorded too — "this server has no quota" is an answer, and knowing it
        // is what keeps the placeholder from reappearing on every refresh.
        const quotaByAccount = { ...get().quotaByAccount };
        if (target) quotaByAccount[target] = quota;
        saveQuotaCache(quotaByAccount);
        set({ quota, quotaByAccount });
      }
      set({ quotaLoading: false });
    } catch {
      /* best-effort — quota is informational, never fail loudly */
      if (get().activeAccountId === (target ?? null)) set({ quotaLoading: false });
    }
  },

  checkConnection: async () => {
    console.log('[Store] checkConnection() called');
    set({ checkingConnection: true });
    try {
      const result = await window.electronAPI.imap.isConnected();
      console.log('[Store] checkConnection result:', result);
      if (result.success && result.data) {
        console.log('[Store] Main process reports connected, updating state');
        set({ connected: true, checkingConnection: false, connectionStatus: 'connected', needsReauth: false });

        // Set up sync progress listener if connected (remove old first to prevent accumulation)
        window.electronAPI.imap.removeSyncProgressListener();
        window.electronAPI.imap.onSyncProgress((status) => {
          get().handleSyncProgress(status);
        });

        return true;
      }
      set({ checkingConnection: false });
      return false;
    } catch (error) {
      console.error('[Store] Failed to check connection:', error);
      set({ checkingConnection: false });
      return false;
    }
  },

  connect: async (config) => {
    // The account id (also its vault key). Match an existing account by email +
    // IMAP host so a reconnect reuses its stored id + DB, while the SAME address
    // on a DIFFERENT provider becomes a separate account. Resolved BEFORE the
    // single-flight join because it is this connect's identity — what decides
    // whether another caller is asking for the same thing.
    const acctId = findAccountByEmailHost(get().accounts, config.username, config.host)?.id
      ?? accountIdFor(config.username, config.host);

    const pending = connectInFlight.pending(acctId);
    if (pending) {
      console.log(`[Store] connect() already in flight for ${acctId} — joining it`);
      return pending;
    }

    return connectInFlight.run(acctId, () => doConnect(acctId, config, set, get));
  },

  disconnect: async () => {
    try {
      // Stop IDLE before disconnecting
      if (get().idleActive) {
        await get().stopIdle();
      }
      window.electronAPI.imap.removeSyncProgressListener();
      const result = await window.electronAPI.imap.disconnect();
      if (result.success) {
        // Plain disconnect of the active connection. Full account REMOVAL (drop
        // from the registry, switch to another) is removeAccountById.
        set({ connected: false, imapConfig: null, syncStatus: null, smtpConnected: false, smtpConfigured: false });
        clearCredentials();
        saveSmtpConfigured(false);
      }
    } catch (error) {
      console.error('Failed to disconnect:', error);
      throw error;
    }
  },

  reconnect: async () => {
    const { imapConfig, connectionStatus } = get();
    if (!imapConfig || connectionStatus === 'reconnecting') {
      return;
    }

    console.log('[Store] Attempting to reconnect...');
    set({ connectionStatus: 'reconnecting' });

    try {
      // Rehydrate the secret from the vault if the in-memory config is stripped
      // (e.g. a manual reconnect on a cold start that never ran connect()).
      let cfg = imapConfig;
      if (!(imapConfig.password || (imapConfig as any).accessToken || (imapConfig as any).refreshToken)) {
        const secrets = await fetchVaultSecrets([
          findAccountByEmailHost(get().accounts, imapConfig.username, imapConfig.host)?.id,
          accountIdFor(imapConfig.username, imapConfig.host),
        ]);
        if (secrets?.imap) cfg = { ...imapConfig, ...secrets.imap };
      }
      const reconnectAcctId = findAccountByEmailHost(get().accounts, imapConfig.username, imapConfig.host)?.id
        ?? accountIdFor(imapConfig.username, imapConfig.host);
      const result = await window.electronAPI.imap.connect(cfg, reconnectAcctId);
      if (result.success) {
        console.log('[Store] Reconnection successful');
        set({
          connected: true,
          connectionStatus: 'connected',
          showConnectedMessage: true,
          needsReauth: false,
        });

        // Set up sync progress listener (remove old first to prevent accumulation)
        window.electronAPI.imap.removeSyncProgressListener();
        window.electronAPI.imap.onSyncProgress((status) => {
          get().handleSyncProgress(status);
        });

        // Hide connected message after 5 seconds
        setTimeout(() => {
          set({ showConnectedMessage: false });
        }, 5000);

        // Reload folders
        await get().loadFolders();

        // Restart IDLE
        await get().startIdle('INBOX');
      } else {
        throw new Error(result.error || 'Reconnection failed');
      }
    } catch (error) {
      console.error('[Store] Reconnection failed:', error);
      set({ connectionStatus: 'disconnected' });
    }
  },

  handleDisconnection: () => {
    console.log('[Store] Handling disconnection');
    set({
      connected: false,
      connectionStatus: 'disconnected',
      idleActive: false,
      idleFolder: null,
      syncing: false,
    });
  },

  handleReconnection: () => {
    // Main's reconnect ladder self-healed; mirror the manual reconnect()
    // success path so the sidebar stops claiming "Server Disconnected".
    console.log('[Store] Main process reconnected — restoring connection state');
    set({
      connected: true,
      connectionStatus: 'connected',
      needsReauth: false,
      showConnectedMessage: true,
      // A fresh socket gets a clean sync-health slate: drop the failure streak and
      // any "Sync issue" surface. If sync keeps failing on the new connection it
      // re-raises after the usual threshold, so this can't hide a persistent fault.
      syncTrouble: false,
      syncFailStreak: 0,
      // Bodies that failed while the connection was flapping (e.g. "Body fetch
      // returned empty result") were marked failed to stop a retry loop. On a
      // fresh connection they're retryable again — clear the ledger so the open
      // email and prefetch re-fetch instead of dead-ending on "Unable to load".
      failedBodies: new Set<string>(),
    });
    setTimeout(() => {
      set({ showConnectedMessage: false });
    }, 5000);
    // Catch up on whatever landed while the renderer thought it was
    // offline; main already resumed sync/IDLE internally.
    get().loadFolders().catch(() => {});
    get().startIdle('INBOX').catch(() => {});
    get().loadQuota?.();
  },

  setConnectionStatus: (status) => {
    set({ connectionStatus: status });
    if (status === 'connected') {
      set({ showConnectedMessage: true });
      setTimeout(() => {
        set({ showConnectedMessage: false });
      }, 5000);
    }
  },

  connectSmtp: async (explicit?: SMTPConfig) => {
    const { imapConfig, smtpConfig, activeAccountId } = get();
    // Prefer an explicitly supplied config (from the SMTP setup form), then the
    // saved SMTP config, then a best-effort derivation from IMAP.
    let config: SMTPConfig | null =
      explicit ?? smtpConfig ?? (imapConfig ? deriveSmtpFromImap(imapConfig) : null);
    if (!config) throw new Error('No IMAP or SMTP config available');

    // SMTP secrets are stored in the vault under the OWNING account's id.
    const acctId = activeAccountId
      ?? (imapConfig ? accountIdFor(imapConfig.username, imapConfig.host) : null);
    // Rehydrate the SMTP secret from the vault when the config is stripped and
    // the caller didn't supply one (e.g. reconnecting a saved account).
    if (acctId && !(config.password || (config as any).accessToken || (config as any).refreshToken)) {
      const secrets = await fetchVaultSecrets([
        acctId,
        imapConfig ? accountIdFor(imapConfig.username, imapConfig.host) : null,
      ]);
      if (secrets?.smtp) config = { ...config, ...secrets.smtp };
    }

    // Nothing to authenticate with. nodemailer turns this into
    // `Missing credentials for "LOGIN"` plus a full stack trace — and because
    // SmtpConnector re-runs on every IMAP connect, that fired on every startup.
    // Fail fast and quietly instead: sending genuinely isn't set up, so the
    // "Set up sending" affordance is the real fix, not a doomed connection.
    const hasSmtpCredential = !!(
      config.password
      || (config as any).accessToken
      || (config as any).refreshToken
      || config.authMethod === 'oauth2'
    );
    if (!hasSmtpCredential) {
      throw new Error(`No sending credentials stored for ${config.host} — set up sending for this account.`);
    }

    try {
      console.log('[Store] Connecting to SMTP server:', config.host);
      const result = await window.electronAPI.smtp.connect(config);

      if (result.success) {
        // Store the SMTP secret in the encrypted vault; state/disk keep metadata only.
        if (acctId) {
          try { await window.electronAPI.secureCreds.set(acctId, { smtp: extractSecrets(config as any) }); }
          catch (e) { console.warn('[Store] Failed to store SMTP secret in vault:', (e as Error)?.message); }
        }
        set({ smtpConnected: true, smtpConfig: config });
        saveSmtpCredentials(config);
        // Persist the SMTP config onto the ACTIVE account in the registry, so
        // switching away and back (or reconnecting) restores it from the DB
        // instead of re-prompting. connect() only stamps the account at
        // IMAP-connect time (before SMTP setup), so without this the entry
        // stays stale and selectAccount would wipe sending config.
        const { accounts, activeAccountId } = get();
        const acct = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;
        if (acct) set({ accounts: upsertAccount(accounts, { ...acct, smtpConfig: config }) });
        console.log('[Store] SMTP connected');
      } else {
        throw new Error(result.error || 'Failed to connect to SMTP server');
      }
    } catch (error) {
      console.error('[Store] Failed to connect to SMTP:', error);
      throw error;
    }
  },

  disconnectSmtp: async () => {
    try {
      await window.electronAPI.smtp.disconnect();
      set({ smtpConnected: false });
      console.log('[Store] SMTP disconnected');
    } catch (error) {
      console.error('[Store] Failed to disconnect SMTP:', error);
    }
  },

  markSmtpConfigured: (value = true) => {
    set({ smtpConfigured: value });
    saveSmtpConfigured(value);
    // Mirror the configured flag onto the active account's registry entry so it
    // survives account switches / reconnects (see connectSmtp for the rationale).
    const { accounts, activeAccountId, smtpConfig } = get();
    const acct = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;
    if (acct) {
      set({ accounts: upsertAccount(accounts, { ...acct, smtpConfigured: value, smtpConfig: smtpConfig ?? acct.smtpConfig }) });
    }
  },

  removeSmtp: async () => {
    // Drop the live SMTP session (best-effort — may not be open).
    try { await window.electronAPI.smtp.disconnect(); } catch { /* ignore */ }
    // Clear the global store fields + legacy localStorage keys...
    saveSmtpConfigured(false);
    clearSmtpCredentials();
    // ...and the active account's own registry entry, so it stays removed across
    // switches and restarts (the persisted registry is the source of truth).
    const { accounts, activeAccountId } = get();
    const acct = activeAccountId ? accounts.find((a) => a.id === activeAccountId) : null;
    const patch: any = { smtpConnected: false, smtpConfigured: false, smtpConfig: null };
    if (acct) patch.accounts = upsertAccount(accounts, { ...acct, smtpConfigured: false, smtpConfig: null });
    set(patch);
    console.log('[Store] SMTP removed for active account');
  },

  setAccountIdentities: (accountId, aliases) => {
    const { accounts } = get();
    const acct = accounts.find((a) => a.id === accountId);
    if (!acct) return;
    // Store the raw aliases; upsertAccount → normalizeAccount canonicalises them
    // (own address first, trimmed, invalid dropped, deduped). saveAccounts mirrors
    // the result to localStorage + the durable DB registry.
    const next = upsertAccount(accounts, { ...acct, identities: aliases });
    set({ accounts: next });
    saveAccounts(next);
  },

  selectAccount: async (accountId) => {
    const { accounts, activeAccountId } = get();
    if (accountId === activeAccountId) return;
    const acct = accounts.find((a) => a.id === accountId);
    if (!acct) return;

    // Point the main process at this account (creates its runtime if needed).
    try {
      await window.electronAPI.accounts.setActive(accountId);
    } catch (e) {
      console.error('[Store] setActive failed:', e);
    }

    // Make this account's credentials the "current" ones and reset the mailbox
    // view so the previous account's folders/emails don't linger. The image
    // auto-load allowlist is per-account — drop it so it re-warms for this one.
    clearImageAllowedCache();
    saveActiveAccountId(accountId);
    saveCredentials(acct.imapConfig);
    // Resolve the account's REAL sending config: OAuth accounts always send via
    // their provider's SMTP (derived, immune to the same-email crossing);
    // password accounts use their verified stored config. An unconfigured
    // password account carries none (not a stale/foreign one).
    const acctSmtpConfig = effectiveSmtpConfig(acct);
    const acctSmtpConfigured = !!acctSmtpConfig;
    if (acctSmtpConfig) saveSmtpCredentials(acctSmtpConfig); else clearSmtpCredentials();
    saveSmtpConfigured(acctSmtpConfigured);
    // Reset the SELECTION + stale mail (so the previous account's messages never
    // show under this one, and this account's INBOX auto-selects), but DON'T
    // blank `folders` — loadFolders() below replaces them atomically, avoiding a
    // "No folders yet" flash. connectionStatus 'reconnecting' (not
    // 'disconnected') so a normal switch never flashes "Server Disconnected".
    // Don't force connectionStatus to 'reconnecting' on switch — an already-live
    // background connection stays 'connected' (no "Connecting…" flash). The
    // status is confirmed/updated by the adopt-or-connect step below.
    set({
      activeAccountId: accountId,
      imapConfig: acct.imapConfig,
      smtpConfig: acctSmtpConfig,
      smtpConfigured: acctSmtpConfigured,
      smtpConnected: false,
      emails: [],
      selectedFolderId: null,
      selectedEmailId: null,
      selectedVirtualFolder: null,
      viewingSnoozed: false,
      viewingAICategory: null,
      sectionData: {},
      // Storage usage is per-account. Show THIS account's last-known figure
      // straight away (kept per account, so a switch back is instant) rather
      // than the account we're leaving. With no cached figure the bar holds its
      // place as a placeholder — `quotaLoading` — and fills in when the server
      // answers, so the sidebar never reflows.
      quota: get().quotaByAccount[accountId] ?? null,
      quotaLoading: true,
    });

    // Show this account's cached mailbox IMMEDIATELY from its own local DB — no
    // network wait. loadFolders() lists folders, auto-selects INBOX, and loads
    // its cached emails; both reads hit the (now-active) account's SQLite file.
    await get().loadFolders();
    await get().loadLabels();
    // Re-read THIS account's quota. Nothing else on the switch path does: the
    // adopt branch below returns early, and only a full syncEmails() or a fresh
    // connect refreshes it — so without this the bar kept the previous
    // account's numbers for as long as the app stayed up.
    get().loadQuota?.(accountId);

    // ADOPT an already-live background connection instead of tearing it down and
    // reconnecting. Every account keeps its own connection alive, so switching
    // BACK is instant and never flashes "Connecting…". Only when this account
    // isn't currently connected do we run a real (background) connect.
    try {
      const r = await window.electronAPI.imap.isConnected();
      if (r?.success && r.data) {
        set({ connected: true, connectionStatus: 'connected' });
        get().startIdle('INBOX').catch(() => {});
        // Light freshness pull — no teardown/reconnect.
        get().syncSingleFolder('INBOX').catch(() => {});
        return;
      }
    } catch { /* fall through to a real connect */ }

    set({ connectionStatus: 'reconnecting' });
    get().connect(acct.imapConfig).catch((e) => {
      console.error('[Store] selectAccount background connect failed:', e);
    });
  },

  addAccount: async (imapConfig, opts) => {
    // Reuse the existing account if this exact email + IMAP host is already
    // connected (avoids a duplicate); otherwise mint an id keyed by email + host
    // so the same address on a different provider gets its own account + DB.
    const id = findAccountByEmailHost(get().accounts, imapConfig.username, imapConfig.host)?.id
      ?? accountIdFor(imapConfig.username, imapConfig.host);

    // VERIFY BEFORE PERSISTING. Everything below mutates durable state (active
    // account, localStorage credentials, the main-process runtime) and — when
    // the id above matched an existing account — OVERWRITES that account in
    // place. Proving the credentials first means a failed add can no longer
    // damage a working mailbox: an unverified oauth2 config used to be written
    // to localStorage before connect() was even attempted, so one failed
    // sign-in permanently converted a live app-password account and every sync
    // after it died at AUTH.
    if (!opts?.alreadyVerified) {
      const probe = await window.electronAPI.imap.probeCredentials(imapConfig as any);
      if (!probe.success) {
        throw new Error(probe.error || 'Could not sign in with those settings');
      }
    }

    // The probe passed, so a commit is expected to succeed — but snapshot what
    // we're about to replace anyway, so a late failure restores the previous
    // account rather than stranding the app on a half-added one.
    const prev = {
      activeAccountId: get().activeAccountId,
      imapConfig: get().imapConfig,
      smtpConfig: get().smtpConfig,
      smtpConfigured: get().smtpConfigured,
      smtpConnected: get().smtpConnected,
      connected: get().connected,
      folders: get().folders,
      emails: get().emails,
      selectedFolderId: get().selectedFolderId,
      selectedEmailId: get().selectedEmailId,
      sectionData: get().sectionData,
    };

    // Ask main to spin up a fresh runtime (its own DB) and point to it BEFORE
    // connecting, so the new account's data lands in its own database.
    try {
      await window.electronAPI.accounts.setActive(id);
    } catch (e) {
      console.error('[Store] setActive (add) failed:', e);
    }
    saveActiveAccountId(id);
    saveCredentials(imapConfig);
    saveSmtpConfigured(false);
    set({
      activeAccountId: id,
      imapConfig,
      smtpConfig: null,
      smtpConfigured: false,
      smtpConnected: false,
      connected: false,
      folders: [],
      emails: [],
      selectedFolderId: null,
      selectedEmailId: null,
      sectionData: {},
    });

    try {
      // connect() upserts the account into the registry, loads folders, syncs.
      // The SMTP overlay then prompts for this account's sending setup.
      await get().connect(imapConfig);
    } catch (error) {
      // Put the previous account back — both the durable pointers and the view
      // state — so a failed add leaves the app exactly as it found it.
      console.error('[Store] addAccount: connect failed after a passing probe — rolling back');
      if (prev.activeAccountId) {
        try {
          await window.electronAPI.accounts.setActive(prev.activeAccountId);
        } catch (e) {
          console.error('[Store] setActive (rollback) failed:', e);
        }
      }
      saveActiveAccountId(prev.activeAccountId);
      if (prev.imapConfig) saveCredentials(prev.imapConfig);
      else clearCredentials();
      saveSmtpConfigured(prev.smtpConfigured);
      set(prev);
      throw error;
    }

    await get().loadLabels();
  },

  // Self-heal OAuth mail accounts. OAuth accounts are stored durably by the main
  // process (oauth-accounts.json / oauth:listAccounts) AND in the renderer
  // registry. If the renderer registry is lost/corrupted (e.g. migrateAccounts
  // rebuilds from only the legacy password creds after a bad read), an OAuth
  // account like Gmail silently disappears from the list even though its DB +
  // tokens survive. Reconciling from main on startup re-adds any missing one.
  // The id is accountIdFor(email, host) — the SAME id the original add used — so
  // it reuses the existing per-id DB (no re-download). Skips 'sarv' (its mailbox
  // is password-based; a sarv OAuth entry may be an AI sign-in, not a mailbox).
  reconcileOAuthAccounts: async () => {
    try {
      const res = await window.electronAPI?.oauth?.listAccounts?.();
      if (!res?.success || !Array.isArray(res.data) || res.data.length === 0) return;
      let accounts = get().accounts;
      let changed = false;
      for (const oa of res.data) {
        if (oa.provider !== 'gmail' && oa.provider !== 'microsoft' && oa.provider !== 'yahoo') continue;
        const preset = EMAIL_PROVIDERS.find((p) => p.oauthProviderId === oa.provider);
        if (!preset) continue;
        const id = accountIdFor(oa.email, preset.imapHost);
        const already = accounts.some((a) =>
          a.id === id ||
          ((a.email || '').toLowerCase() === oa.email.toLowerCase() &&
            ((a.imapConfig?.host as string) || '').toLowerCase() === preset.imapHost.toLowerCase()));
        if (already) continue;
        const account = normalizeAccount({
          id,
          email: oa.email,
          imapConfig: {
            host: preset.imapHost,
            port: preset.imapPort,
            secure: preset.imapSecurity === 'ssl',
            username: oa.email,
            authMethod: 'oauth2',
            oauthProvider: oa.provider,
          },
          smtpConfig: null,
          smtpConfigured: false,
        } as StoredAccount, accounts);
        accounts = upsertAccount(accounts, account);
        changed = true;
        console.warn(`[Store] Re-hydrated OAuth account ${oa.email} (${oa.provider}) from main — it was missing from the local registry`);
      }
      if (changed) {
        const activeAccountId = get().activeAccountId || accounts[0]?.id || null;
        set({ accounts, activeAccountId });
        saveAccounts(accounts);
        if (activeAccountId) saveActiveAccountId(activeAccountId);
      }
    } catch (e) {
      console.warn('[Store] reconcileOAuthAccounts failed:', (e as Error)?.message);
    }
  },

  // Hydrate the in-memory registry from the DURABLE DB registry (the main-owned
  // accounts table — the new source of truth). Merges any account the DB knows
  // about that the local (localStorage-derived) registry is missing, so a lost
  // or corrupt localStorage can no longer make an account disappear: the DB was
  // mirrored while localStorage was still intact, and main also seeds it from
  // its own durable stores (oauth-accounts.json / imap-account.json). Existing
  // in-memory entries are kept as-is (they may carry live session config); the
  // DB only ADDS. Runs once at startup, BEFORE reconcile/auto-connect. Phase 1:
  // localStorage remains the fallback and is refreshed from the merged result.
  hydrateAccountsFromDb: async () => {
    try {
      const api = window.electronAPI?.accounts;
      if (!api?.list) return;
      const res = await api.list();
      if (!res?.success || !Array.isArray(res.data)) return;

      let accounts = get().accounts;
      let changed = false;
      for (const dto of res.data) {
        if (!dto?.id || !dto.email) continue;
        const already = accounts.some((a) =>
          a.id === dto.id ||
          ((a.email || '').toLowerCase() === dto.email.toLowerCase() &&
            ((a.imapConfig?.host as string) || '').toLowerCase() === ((dto.imapConfig?.host as string) || '').toLowerCase()));
        if (already) continue;
        const account = normalizeAccount({
          id: dto.id,
          email: dto.email,
          name: dto.name,
          imapConfig: dto.imapConfig,
          smtpConfig: (dto.smtpConfig as SMTPConfig | null) ?? null,
          smtpConfigured: !!dto.smtpConfigured,
          color: dto.color,
          includeInUnified: dto.includeInUnified,
          backgroundSync: dto.backgroundSync,
          notify: dto.notify,
        } as StoredAccount, accounts);
        accounts = upsertAccount(accounts, account);
        changed = true;
        console.warn(`[Store] Hydrated account ${dto.email} from the durable DB registry — it was missing locally`);
      }

      // Resolve the active account: prefer the current in-memory pointer, else
      // the DB's persisted one, else the first account.
      let activeAccountId = get().activeAccountId;
      if (!activeAccountId || !accounts.some((a) => a.id === activeAccountId)) {
        try {
          const act = await api.getActive?.();
          if (act?.success && act.data && accounts.some((a) => a.id === act.data)) {
            activeAccountId = act.data;
            changed = true;
          }
        } catch { /* ignore */ }
        if (!activeAccountId && accounts[0]) { activeAccountId = accounts[0].id; changed = true; }
      }

      if (changed) {
        set({ accounts, activeAccountId });
        saveAccounts(accounts);
        if (activeAccountId) saveActiveAccountId(activeAccountId);
      }
    } catch (e) {
      console.warn('[Store] hydrateAccountsFromDb failed:', (e as Error)?.message);
    }
  },

  removeAccountById: async (accountId) => {
    const { accounts, activeAccountId } = get();
    // Nothing to do if it's gone, or already being removed (guards a double-click
    // that slips past the disabled button).
    if (!accounts.some((a) => a.id === accountId)) return;
    if (get().deletingAccountIds.includes(accountId)) return;

    // Mark "deleting" IMMEDIATELY — before any await — and keep the row in the
    // list. Removal awaits imap/smtp.disconnect(), which can BLOCK for the whole
    // op timeout when the connection is wedged (a flapping account is the common
    // case for removal), so without this the row stayed visible, clickable and
    // "connected" until the teardown finally landed. The row now shows
    // "Deleting…" and is disabled for the entire teardown instead.
    set({
      deletingAccountIds: [...get().deletingAccountIds, accountId],
      // Clear any stale failure from a previous attempt at this account.
      accountActionError: get().accountActionError?.id === accountId ? null : get().accountActionError,
    });

    const removedAccount = accounts.find((a) => a.id === accountId);
    const remaining = removeAccount(accounts, accountId);
    try {
      if (accountId === activeAccountId) {
        // Tear down BOTH sessions for the removed account — previously only IMAP
        // was disconnected, so the SMTP session could linger after removal.
        try { await window.electronAPI.imap.disconnect(); } catch { /* ignore */ }
        try { await window.electronAPI.smtp.disconnect(); } catch { /* ignore */ }
      }

      // Permanently wipe the account's local footprint: its DB file (the legacy
      // sarvinbox.db if it was the primary — deleted so it's never recreated),
      // in-memory runtime, and vaulted secrets. Idempotent. Falls back to the
      // vault-only delete on an older main that lacks the fuller handler. This is
      // the failure-prone step; if it fails we surface it and KEEP the account
      // so the user can retry rather than being left half-removed. The main
      // handler RESOLVES with `{ success:false }` rather than rejecting, so a
      // silent false must be turned into a throw or the failure path is skipped.
      if (window.electronAPI.accounts.remove) {
        const res = await window.electronAPI.accounts.remove(accountId);
        if (res && res.success === false) throw new Error(res.error || 'Failed to remove account');
      } else {
        await window.electronAPI.secureCreds.delete(accountId);
      }

      // If this account also backed an OAuth AI provider (Sarv is mailbox AND
      // LLM), prune that provider now. Otherwise getDefaultProvider() keeps
      // returning it and the extraction/body-rewrite loop retries forever against
      // a dead OAuth session ("No OAuth account for …"), spinning the event loop
      // until the app becomes unresponsive. Re-sync the main pipeline gate only
      // when a provider was actually removed.
      const oauthProvider = removedAccount?.imapConfig?.oauthProvider;
      if (oauthProvider && removedAccount?.email) {
        const pruned = removeOAuthProvidersForAccount(oauthProvider, removedAccount.email);
        if (pruned > 0) { void syncAIProviderToMain(); }
      }

      // Forget its cached storage figure with it, so re-adding the same address
      // can't briefly show the deleted account's usage.
      if (accountId in get().quotaByAccount) {
        const quotaByAccount = { ...get().quotaByAccount };
        delete quotaByAccount[accountId];
        saveQuotaCache(quotaByAccount);
        set({ quotaByAccount });
      }

      // Only now that the durable wipe succeeded do we drop the row and move the
      // active account away.
      if (accountId === activeAccountId) {
        const next = remaining[0];
        set({ accounts: remaining });
        if (next) {
          // Force a switch: activeAccountId still points at the removed one, so
          // selectAccount won't early-return. (selectAccount restores the next
          // account's own saved SMTP creds.)
          await get().selectAccount(next.id);
        } else {
          saveActiveAccountId(null);
          clearCredentials();
          // Clear the saved SMTP creds too (not just the configured flag), so a
          // later account can't inherit a stale sending config.
          clearSmtpCredentials();
          saveSmtpConfigured(false);
          set({
            activeAccountId: null,
            connected: false,
            imapConfig: null,
            smtpConfig: null,
            smtpConfigured: false,
            smtpConnected: false,
            folders: [],
            emails: [],
            selectedFolderId: null,
            selectedEmailId: null,
            sectionData: {},
          });
        }
      } else {
        set({ accounts: remaining });
      }
    } catch (err) {
      // Keep the account and re-enable its row with an inline error, so a failed
      // remove is recoverable instead of a stuck "Deleting…".
      set({
        accountActionError: {
          id: accountId,
          message: (err as Error)?.message || 'Failed to remove account',
        },
      });
      throw err;
    } finally {
      set({ deletingAccountIds: get().deletingAccountIds.filter((id) => id !== accountId) });
    }
  },
});
