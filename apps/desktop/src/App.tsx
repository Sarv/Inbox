import { useEffect, useState, useCallback, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { AgentDashboard } from './components/agent/AgentDashboard';
import { AIStatusBanner } from './components/AIStatusBanner';
import { AppSidebar, AppSection } from './components/AppSidebar';
import { ComposeEmail } from './components/ComposeEmail';
import { ConnectionDialog } from './components/ConnectionDialog';
import { Contacts } from './components/Contacts';
import { EmailDetail } from './components/email-detail';
import { EmailList } from './components/email-list';
import { ExtensionManager } from './components/ExtensionManager';
import { GlobalConfirmDialog } from './components/GlobalConfirmDialog';
import { InAppNotification } from './components/InAppNotification';
import { NoAccountEmptyState } from './components/NoAccountEmptyState';
import { Onboarding } from './components/onboarding/Onboarding';
import { OAuthSessionBanner } from './components/OAuthSessionBanner';
import { ReauthBanner } from './components/ReauthBanner';
import { SecurityStatusBanner } from './components/SecurityStatusBanner';
import { Settings } from './components/settings';
import { AISettings } from './components/settings/ai';
import { OutboxTab } from './components/settings/OutboxTab';
import { ShortcutsHelpModal } from './components/ShortcutsHelpModal';
import { Sidebar } from './components/Sidebar';
import { SmtpSetup } from './components/SmtpSetup';
import { SyncTroubleBanner } from './components/SyncTroubleBanner';
import { UndoDeleteToast } from './components/UndoDeleteToast';
import { UndoSendToast } from './components/UndoSendToast';
import { useAppVersion } from './hooks/useAppVersion';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotificationBridge } from './hooks/useNotificationBridge';
import { pushAgentSettingsToBackend, pushCategoryLabelSetting } from './services/agent-settings';
import { makeAICompletion, getDefaultProvider, hydrateAiSecrets, syncAIProviderToMain, pruneOrphanedOAuthProviders } from './services/ai-service';
import { installEnrichmentBatchListener } from './services/contact-enrichment-service';
import { initializeBackgroundExtractionListener, removeBackgroundExtractionListener } from './services/conversation-service';
import { requestConfirm } from './store/confirm-service';
import { useEmailStore } from './store/email-store';
import { migrateCredentialsToVault, canonicalizeAccountIds } from './store/helpers';
import { shouldShowOnboarding, shouldShowNoAccountEmptyState } from './utils/app-gates';

function App() {
  // Shallow slice-select so App only re-renders when one of these fields
  // changes, not on every unrelated store mutation.
  const { connected, imapConfig, hasAccounts, needsReauth, smtpConfigured, activeAccountId, connect, loadFolders, loadLabels, checkConnection, checkingConnection, compose, closeCompose, handleDisconnection, viewMode, selectedEmailId, selectedVirtualFolder, restoreDraft, clearRestoreDraft } = useEmailStore(
    useShallow((s) => ({
      connected: s.connected,
      imapConfig: s.imapConfig,
      // Durable "an account exists" signal. imapConfig is a transient runtime
      // field: it's null at cold start (accounts now live in the main-owned DB,
      // not localStorage — so hydrateAccountsFromDb restores `accounts` but not
      // imapConfig) and it's nulled on disconnect. Gating the onboarding /
      // no-account screens on `!imapConfig` therefore flashed "No account
      // connected" for the ~2s between hydrate and the auto-connect landing.
      // The registry length is the truth for whether the user has an account.
      hasAccounts: s.accounts.length > 0,
      needsReauth: s.needsReauth,
      smtpConfigured: s.smtpConfigured,
      activeAccountId: s.activeAccountId,
      connect: s.connect,
      loadFolders: s.loadFolders,
      loadLabels: s.loadLabels,
      checkConnection: s.checkConnection,
      checkingConnection: s.checkingConnection,
      compose: s.compose,
      closeCompose: s.closeCompose,
      handleDisconnection: s.handleDisconnection,
      viewMode: s.viewMode,
      selectedEmailId: s.selectedEmailId,
      selectedVirtualFolder: s.selectedVirtualFolder,
      restoreDraft: s.restoreDraft,
      clearRestoreDraft: s.clearRestoreDraft,
    })),
  );
  const [activeSection, setActiveSection] = useState<AppSection>('mail');
  // When set, the Settings screen opens directly on this tab (e.g. the
  // no-account empty state deep-links to "accounts"). Cleared on any manual
  // section switch so the gear normally opens General.
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  // On-demand re-auth dialog, opened from the (non-blocking) ReauthBanner. An
  // auth rejection no longer takes over the whole app — the cached mailbox and
  // other accounts stay usable; this only opens when the user clicks Reconnect.
  const [showReauth, setShowReauth] = useState(false);
  // Deep-link the AI Settings screen to a specific tab (e.g. the "Fix" button in
  // the AI-inactive banner opens Providers, where the provider is configured).
  const [aiSettingsInitialTab, setAiSettingsInitialTab] = useState<string | undefined>(undefined);
  // One-shot: open the add-account wizard once AccountsTab mounts. Set by the
  // shared add-account flow so every entry point (sidebar switcher, mailbox
  // empty state, in-tab button) lands on Settings → Accounts with the wizard open.
  const [openAddAccountOnMount, setOpenAddAccountOnMount] = useState(false);
  // Debounces transient IMAP connection blips so the sidebar/status doesn't
  // flicker connected↔reconnecting: a "down" state is applied only if it
  // OUTLASTS this window; a reconnect within it cancels the pending flip and
  // the UI stays "Connected". Especially important with multiple accounts,
  // where a background account's brief drop shouldn't paint the whole UI red.
  const connectionBlipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focusable app root. When the window regains OS focus (fullscreen / external
  // monitor / a macOS hot-corner or Mission Control blur), Chromium doesn't
  // deliver keydown to the document until something in the page is focused — so
  // the arrow-key / j-k shortcuts go dead until the user clicks. Re-focusing this
  // root on window 'focus' resumes them without a click.
  const appRootRef = useRef<HTMLDivElement>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(() => {
    return localStorage.getItem('sarvinbox-onboarding-complete') === 'true';
  });

  // Keep keyboard shortcuts alive across window-focus loss. On regaining focus
  // (and once on mount), if nothing meaningful is focused, focus the app root so
  // Chromium delivers keydown to the document again. Guarded so we never steal
  // focus from an input/textarea/contenteditable the user is typing in.
  useEffect(() => {
    const restoreFocus = () => {
      const active = document.activeElement as HTMLElement | null;
      // A real element already has focus (input, button, list item) — leave it.
      if (active && active !== document.body) return;
      appRootRef.current?.focus({ preventScroll: true });
    };
    // Defer the initial focus so it doesn't beat autofocus on a mounted field.
    const t = setTimeout(restoreFocus, 0);
    window.addEventListener('focus', restoreFocus);
    return () => { clearTimeout(t); window.removeEventListener('focus', restoreFocus); };
  }, []);

  const focusSearch = useCallback(() => {
    (document.querySelector('input[placeholder="Search emails..."]') as HTMLInputElement)?.focus();
  }, []);

  // Unsaved-changes guard for the Settings / AI Settings screens (which have an
  // explicit "Save Changes" button). The screens report their dirty state here;
  // a user-initiated section switch (sidebar, keyboard) while dirty prompts to
  // discard before leaving, so edits aren't silently lost.
  const settingsDirtyRef = useRef(false);

  // Perform the actual section switch, clearing any deep-link tab hints.
  const doNavigate = useCallback((next: AppSection) => {
    setSettingsInitialTab(undefined);
    setAiSettingsInitialTab(undefined);
    setActiveSection(next);
  }, []);

  // Guarded navigation: confirm discard when leaving a dirty settings screen.
  const requestSection = useCallback((next: AppSection) => {
    const leavingSettings = activeSection === 'settings' || activeSection === 'ai-settings';
    if (leavingSettings && next !== activeSection && settingsDirtyRef.current) {
      void requestConfirm({
        title: 'Discard changes?',
        message: 'Your changes have not been saved. Discard changes?',
        confirmLabel: 'Discard',
        cancelLabel: 'Cancel',
      }).then((ok) => {
        if (ok) {
          settingsDirtyRef.current = false;
          doNavigate(next);
        }
      });
      return; // stay put until the user answers
    }
    doNavigate(next);
  }, [activeSection, doNavigate]);

  // Single entry to the add-account flow: go to Settings → Accounts and open the
  // wizard there, so every "Add account" affordance behaves identically.
  const openAddAccountFlow = useCallback(() => {
    setSettingsInitialTab('accounts');
    setOpenAddAccountOnMount(true);
    setActiveSection('settings');
  }, []);

  // The sidebar account switcher (rendered deep in the tree) triggers the flow
  // via this event since it has no direct access to app navigation.
  useEffect(() => {
    const handler = () => openAddAccountFlow();
    document.addEventListener('sarvinbox:add-account', handler);
    return () => document.removeEventListener('sarvinbox:add-account', handler);
  }, [openAddAccountFlow]);

  // "Manage Inbox settings" from a section's 3-dot menu → Settings → Inbox tab.
  useEffect(() => {
    const handler = (e: Event) => {
      setSettingsInitialTab((e as CustomEvent).detail?.tab || 'inbox');
      setActiveSection('settings');
    };
    document.addEventListener('sarvinbox:open-settings', handler);
    return () => document.removeEventListener('sarvinbox:open-settings', handler);
  }, []);

  // Clicking a new-mail notification (from any section) → switch to the Mail
  // view so the email the bridge just selected is actually shown.
  useEffect(() => {
    const handler = () => setActiveSection('mail');
    document.addEventListener('sarvinbox:open-mail', handler);
    return () => document.removeEventListener('sarvinbox:open-mail', handler);
  }, []);

  // The user CLICKED the "Sign in again" OS notification — an explicit request
  // to be taken to Settings → Accounts. Deliberately NOT wired to the failure
  // itself: a refresh that fails while the user is reading mail shows the
  // OAuthSessionBanner instead of yanking them into Settings.
  useEffect(() => {
    const api = window.electronAPI?.notifications;
    if (!api?.onReauthOpenSettings) return;
    const off = api.onReauthOpenSettings(() => {
      setSettingsInitialTab('accounts');
      setActiveSection('settings');
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);

  useKeyboardShortcuts({ setActiveSection: requestSection, focusSearch });
  useNotificationBridge();

  // Load user-defined labels once on mount (local DB — no connection needed).
  useEffect(() => {
    void loadLabels();
  }, [loadLabels]);

  // Pull AI provider API keys from the main-process safeStorage vault into memory
  // (and migrate any legacy plaintext keys out of localStorage). Runs before any
  // AI feature is user-triggered. CRUCIAL: once the keys are hydrated, RE-PUSH the
  // provider config to the main pipeline — the earlier synchronous push (below)
  // may have sent an empty key because the vault IPC hadn't resolved yet. Without
  // this re-push the pipeline categorizes with no key until a lucky sync/restart.
  useEffect(() => {
    void hydrateAiSecrets().then(() => syncAIProviderToMain());
  }, []);

  // Log app version from main process
  const appVersion = useAppVersion();
  useEffect(() => {
    if (appVersion) {
      console.log('==============================================');
      console.log('[App] Sarv Inbox Version:', appVersion);
      console.log('==============================================');
    }
  }, [appVersion]);

  // Push Profile Information to the main-process pipeline so the AI reply
  // drafter writes as the real user ("I will…") instead of treating them as
  // a third party. Runs once on mount; Settings.saveSettings() re-pushes
  // whenever the profile changes.
  useEffect(() => {
    try {
      const stored = localStorage.getItem('sarvinbox-settings');
      if (!stored) return;
      const s = JSON.parse(stored);
      if (!s.profileName && !s.profileTitle && !s.profileCompany) return;
      window.electronAPI?.agent?.setConfig?.({
        userName: s.profileName || '',
        profileTitle: s.profileTitle || '',
        profileCompany: s.profileCompany || '',
      } as any).catch(() => {});
    } catch {}
  }, []);

  // Restore AI Assist state (esp. the `enabled` master switch) into the
  // main-process pipeline at STARTUP, in its OWN effect so it can never be
  // blocked by an exception in the larger connection/setup effect below. The
  // pipeline boots disabled every launch and previously only heard the user's
  // real setting when the Email Agent settings tab mounted — so on a plain
  // restart new mail wasn't categorized until that tab was opened. Main mirrors
  // what it receives to agent-config.json so it survives subsequent restarts.
  useEffect(() => {
    pushAgentSettingsToBackend();
    pushCategoryLabelSetting();
  }, []);

  useEffect(() => {
    console.log('[App] Component mounted');
    console.log('[App] Connected:', connected);
    console.log('[App] Checking Connection:', checkingConnection);
    console.log('[App] IMAP Config exists:', !!imapConfig);
    console.log('[App] IMAP Config:', imapConfig ? { host: imapConfig.host, username: imapConfig.username } : 'null');

    // Auto-connect on mount if credentials exist
    const autoConnect = async () => {
      // One-time: migrate any plaintext IMAP/SMTP secrets out of localStorage
      // into the encrypted main-process vault BEFORE we connect, so even the
      // "adopt an already-live main session" path leaves no plaintext behind.
      // Pass the IN-MEMORY accounts (they still carry the secrets even after the
      // module-load registry migration stripped localStorage). Runs BEFORE the
      // id canonicalization below so secrets are vaulted (under the current id)
      // before that step re-keys them and strips localStorage.
      await migrateCredentialsToVault(useEmailStore.getState().accounts);

      // One-time: canonicalize any legacy (host-less) account ids to the current
      // acct-<email>--<host> scheme BEFORE anything opens/connects an account —
      // main re-keys each account's DB file, vault, primary pointer and runtime,
      // and we reflect the new ids into the running store so THIS session opens
      // the right (renamed) DB. Idempotent + backed by the read-time fallback.
      try {
        const migrated = await canonicalizeAccountIds();
        if (migrated) {
          useEmailStore.setState({ accounts: migrated.accounts, activeAccountId: migrated.activeAccountId });
        }
      } catch (e) {
        console.warn('[App] Account-id canonicalization failed (continuing):', (e as Error)?.message ?? e);
      }

      // Hydrate the registry from the DURABLE DB (main-owned source of truth)
      // FIRST — this restores ANY account (password or OAuth) that a lost/corrupt
      // localStorage dropped, because the DB was mirrored while localStorage was
      // intact and main also seeds it from its own durable stores. Runs before
      // reconcile/auto-connect so a recovered account can reconnect this session.
      try {
        await useEmailStore.getState().hydrateAccountsFromDb();
      } catch (e) {
        console.warn('[App] DB registry hydrate failed (continuing):', (e as Error)?.message ?? e);
      }

      // Self-heal OAuth mail accounts: re-add any Gmail/Outlook/Yahoo account the
      // main process still knows about but the local registry lost (e.g. after a
      // corrupt localStorage read rebuilt the list from only the legacy password
      // creds). Runs BEFORE auto-connect/activation so the recovered account can
      // reconnect this session. Reuses its existing DB (deterministic id).
      try {
        await useEmailStore.getState().reconcileOAuthAccounts();
      } catch (e) {
        console.warn('[App] OAuth account reconcile failed (continuing):', (e as Error)?.message ?? e);
      }

      // Self-heal orphaned AI providers: once the account registry is authoritative,
      // drop any OAuth AI provider whose backing mail account is gone. Without this,
      // an account deleted by an older build leaves the provider behind and the
      // extraction/body-rewrite loop retries a dead OAuth session forever, locking
      // up the UI. Re-sync the main pipeline gate only when something was pruned.
      try {
        const pruned = pruneOrphanedOAuthProviders(useEmailStore.getState().accounts);
        if (pruned > 0) void syncAIProviderToMain();
      } catch (e) {
        console.warn('[App] orphaned AI provider prune failed (continuing):', (e as Error)?.message ?? e);
      }

      // First, check if main process already has an active connection
      console.log('[App] Checking connection status with main process...');
      const isConnected = await checkConnection();

      if (isConnected) {
        console.log('[App] Main process is already connected, loading folders...');
        await loadFolders();
      } else if (imapConfig) {
        // No active connection, but we have saved credentials - try to connect
        try {
          console.log('[App] Auto-connecting with saved credentials...');
          await connect(imapConfig);
          console.log('[App] Auto-connect successful!');
        } catch (error) {
          // Downgraded from console.error: a failed initial auto-connect is
          // expected on flaky startup and self-heals via the reconnect ladder.
          // Keep it concise; genuine auth rejections are flagged below.
          console.warn('[App] Auto-connect failed (reconnect will retry):', (error as Error)?.message ?? error);
          // Only FORGET the saved login on a DEFINITIVE auth rejection
          // (wrong password / revoked or expired token). A transient
          // startup failure — network not ready, slow/zombie server, an
          // OAuth refresh hiccup — must NOT wipe credentials: doing so
          // forced a full re-login on the next launch after any flaky
          // connect. For transient errors we keep the creds; the
          // focus/online/IDLE reconnect paths retry on their own.
          const msg = String((error as Error)?.message || error).toLowerCase();
          const authRejected = /authenticationfailed|invalid credentials|invalid login|password not accepted|application-specific password|invalid_grant|unauthorized|\b40[13]\b|auth\w*\s*fail/.test(msg);
          // NEVER delete the saved credentials. On a genuine auth rejection
          // flag for re-auth (shows the dialog, pre-fillable); on a transient
          // failure just keep them and let the reconnect paths retry — the
          // cached inbox stays visible, no blocking dialog.
          if (authRejected) {
            console.warn('[App] Server rejected credentials — flagging for re-authentication');
            useEmailStore.setState({ needsReauth: true });
          } else {
            console.log('[App] Transient auto-connect failure — keeping credentials for retry');
          }
          // Connect failed, but the account's mail is already in the local DB —
          // load it so the cached mailbox renders behind the (non-blocking)
          // ReauthBanner. Without this an auth rejection left the list empty.
          try { await loadFolders(); } catch { /* DB not ready yet — sidebar retries */ }
        }
      } else {
        // No localStorage credentials — try to recover the last-good config
        // the main process persisted (survives localStorage loss). This is
        // what keeps a wiped/cleared renderer profile from forcing a full
        // re-login when the account is still known to main.
        try {
          const saved = await window.electronAPI.imap.getSavedConfig?.();
          if (saved?.success && saved.data) {
            console.log('[App] Recovered saved IMAP config from main — auto-connecting…');
            await connect(saved.data);
            console.log('[App] Recovery connect successful!');
          } else {
            console.log('[App] No saved credentials found, showing connection dialog');
          }
        } catch (error) {
          const msg = String((error as Error)?.message || error).toLowerCase();
          const authRejected = /authenticationfailed|invalid credentials|invalid login|password not accepted|application-specific password|invalid_grant|unauthorized|\b40[13]\b|auth\w*\s*fail/.test(msg);
          if (authRejected) {
            console.warn('[App] Recovered credentials rejected — clearing them');
            window.electronAPI.imap.clearSavedConfig?.().catch(() => {});
          } else {
            console.log('[App] Recovery connect failed transiently — will retry:', msg);
          }
        }
      }
    };

    autoConnect();

    // Debounce transient "down" transitions: hold the flip for a short window;
    // if a reconnect lands first, cancel it so the UI never flickers. Sized to
    // outlast a self-healing reconnect on a FLAPPING server (observed recoveries
    // of a few seconds up to ~8s) — a genuine outage still surfaces once the
    // window elapses, but the common "drop → reconnect a few seconds later" churn
    // no longer strobes the sidebar between "Reconnecting…" and "Live".
    const CONNECTION_BLIP_MS = 8000;
    const clearPendingDown = () => {
      if (connectionBlipTimerRef.current) {
        clearTimeout(connectionBlipTimerRef.current);
        connectionBlipTimerRef.current = null;
      }
    };
    const scheduleDown = (apply: () => void) => {
      clearPendingDown();
      connectionBlipTimerRef.current = setTimeout(() => {
        connectionBlipTimerRef.current = null;
        apply();
      }, CONNECTION_BLIP_MS);
    };

    // Listen for disconnection events from main process
    const handleDisconnect = () => {
      console.log('[App] Received disconnection event from main process');
      scheduleDown(() => handleDisconnection());
    };

    // Set up disconnection listener if available
    if (window.electronAPI?.imap?.onDisconnected) {
      window.electronAPI.imap.onDisconnected(handleDisconnect);
    }

    // Positive recovery signal: main's reconnect ladder self-heals
    // without renderer involvement — flip the sidebar back to connected.
    // Cancels any pending "down" flip so a quick blip never surfaces.
    if (window.electronAPI?.imap?.onReconnected) {
      window.electronAPI.imap.onReconnected(() => {
        console.log('[App] Received reconnection event from main process');
        clearPendingDown();
        useEmailStore.getState().handleReconnection?.();
      });
    }

    // In-progress retry signal: the ladder is between attempts. Only surface a
    // distinct "reconnecting" state if the retry OUTLASTS the blip window —
    // fast self-heals stay silent (no flicker).
    if (window.electronAPI?.imap?.onReconnecting) {
      window.electronAPI.imap.onReconnecting(() => {
        console.log('[App] Received reconnecting event from main process');
        scheduleDown(() => useEmailStore.getState().setConnectionStatus?.('reconnecting'));
      });
    }

    // Terminal auth failure: the server rejected the password/token. Flag
    // for re-auth (which surfaces the sign-in dialog) but DO NOT delete the
    // saved credentials — keeping them means a transient blip mis-tagged as
    // auth can't wipe the account, and the dialog can pre-fill. The user
    // overwrites them by submitting a new password.
    if (window.electronAPI?.imap?.onAuthError) {
      window.electronAPI.imap.onAuthError(() => {
        console.warn('[App] IMAP auth failed — flagging for re-authentication');
        useEmailStore.getState().handleDisconnection?.();
        useEmailStore.setState({ needsReauth: true });
      });
    }

    // Initialize background conversation extraction listener
    initializeBackgroundExtractionListener();
    // Handle contact enrichment batches pushed from the main-process
    // scheduler — runs LLM calls serially in the renderer.
    installEnrichmentBatchListener();
    // Notify main process whether AI provider is configured. Optional-chained
    // like the rest of this effect: window.electronAPI is injected by the
    // preload bridge and can be absent early / in a non-Electron context —
    // an unguarded access here would just relocate the contactEnrichment crash.
    window.electronAPI?.ai?.setProviderConfigured?.(!!getDefaultProvider());

    // Configure the unified agent pipeline at STARTUP, independent of sync.
    // Previously the pipeline's AI provider + userEmail were pushed only by
    // startAutoAICategorization, which runs after a *successful* sync — so on
    // a slow/disconnected start the pipeline sat with hasAI=false/userEmail=""
    // and silently marked needs_response emails done WITHOUT ever drafting a
    // reply (the "needs_response but 0 drafts" bug). Push here so drafting
    // works as soon as the app opens.
    try {
      const prov = getDefaultProvider();
      if (prov) {
        window.electronAPI.agent.setAIConfig({
          type: prov.type,
          apiKey: prov.apiKey,
          model: prov.model,
          baseUrl: prov.baseUrl,
          authMethod: prov.authMethod,
          oauthProvider: prov.oauthProvider,
          oauthEmail: prov.oauthEmail,
        }).catch(() => {});
        let ue = '';
        try {
          const s = localStorage.getItem('sarvinbox-settings');
          if (s) ue = JSON.parse(s).profileEmail || '';
          if (!ue) {
            const c = localStorage.getItem('sarvinbox-credentials');
            if (c) ue = JSON.parse(c).username || '';
          }
        } catch { /* ignore */ }
        if (ue) window.electronAPI.agent.setConfig({ userEmail: ue } as any).catch(() => {});
      }
    } catch { /* best effort — startAutoAICategorization re-pushes after sync */ }

    // Set up AI bridge listener for extension backend
    // When extensions in main process need AI, they send requests here
    if (window.electronAPI?.extensions?.onAICompleteRequest) {
      window.electronAPI.extensions.onAICompleteRequest(async (request) => {
        console.log('[AI Bridge] Received AI completion request:', request.requestId);
        try {
          const result = await makeAICompletion({
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            maxTokens: request.maxTokens,
          });
          window.electronAPI.extensions.sendAICompleteResponse({
            requestId: request.requestId,
            success: true,
            result,
          });
        } catch (error) {
          console.error('[AI Bridge] AI completion failed:', error);
          window.electronAPI.extensions.sendAICompleteResponse({
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
      });
    }

    return () => {
      // Cleanup listeners
      if (window.electronAPI?.imap?.removeDisconnectedListener) {
        window.electronAPI.imap.removeDisconnectedListener();
      }
      if (window.electronAPI?.imap?.removeReconnectedListener) {
        window.electronAPI.imap.removeReconnectedListener();
      }
      if (window.electronAPI?.imap?.removeReconnectingListener) {
        window.electronAPI.imap.removeReconnectingListener();
      }
      if (window.electronAPI?.imap?.removeAuthErrorListener) {
        window.electronAPI.imap.removeAuthErrorListener();
      }
      if (window.electronAPI?.extensions?.removeAICompleteListener) {
        window.electronAPI.extensions.removeAICompleteListener();
      }
      removeBackgroundExtractionListener();
    };
  }, []); // Run only once on mount

  // Check connection and sync on window focus / visibility change / Cmd+R.
  //
  // Reconnect-attempt gating policy:
  //   1. navigator.onLine === false           → skip + queue a pending
  //      check that fires when the OS sends an "online" event.
  //   2. Online but just transitioned (focus / visibility / online)
  //      → wait NETWORK_SETTLE_MS so DNS has time to come up. We've
  //      seen ENOTFOUND on oauth2.googleapis.com when reconnects
  //      fire immediately after a Wi-Fi reattach or wake-from-sleep
  //      — the OS reports onLine=true before resolver is ready, and
  //      the backend then burns through its 5-attempt reconnect cap.
  //   3. After settle, do a lightweight reachability probe before
  //      poking the backend. If the probe fails we re-queue and try
  //      again on the next online/focus event.
  useEffect(() => {
    let lastCheckTime = 0;
    let pendingCheck: ReturnType<typeof setTimeout> | null = null;
    let pendingWhenOnline = false;
    const MIN_CHECK_INTERVAL = 30_000; // Debounce: at most once per 30s
    const NETWORK_SETTLE_MS = 2000;    // Let DNS / route table settle

    const probeNetwork = async (): Promise<boolean> => {
      // Cheap reachability probe — no-cors HEAD against a 204 endpoint.
      // Aborts at 3s. Used to verify DNS+route actually works before
      // we ask the backend to reconnect.
      try {
        const ctrl = new AbortController();
        const tmo = setTimeout(() => ctrl.abort(), 3000);
        await fetch('https://www.google.com/generate_204', {
          method: 'HEAD',
          mode: 'no-cors',
          cache: 'no-store',
          signal: ctrl.signal,
        });
        clearTimeout(tmo);
        return true;
      } catch {
        return false;
      }
    };

    const runCheck = async (reason: string) => {
      const state = useEmailStore.getState();
      if (!state.imapConfig) return;

      // WEAK triggers (alt-tab / tab-visible): if the connection is already live
      // — connected AND IDLE running — it is proven alive, so don't fire a NOOP
      // liveness probe + sync on every focus. The probe shares (and briefly
      // breaks) the IDLE socket, and a busy-socket false-positive forces a
      // needless reconnect — a real driver of reconnect flapping. STRONG triggers
      // (network online / OS resume / screen unlock) can invalidate a socket that
      // still "looks" live, so they always run the check.
      const isWeakTrigger = reason === 'focus' || reason === 'visibility';
      if (isWeakTrigger && state.connected && state.idleActive) {
        return;
      }

      // Hard gate: OS says we're offline. Mark pending; the 'online'
      // listener fires this check when network comes back.
      if (!navigator.onLine) {
        console.log(`[App] ${reason} — but navigator.onLine=false, deferring until network returns`);
        pendingWhenOnline = true;
        state.handleDisconnection?.();
        return;
      }

      // Soft gate: probe before pulling the trigger. Catches the
      // "onLine flipped to true but DNS still cold" window.
      const reachable = await probeNetwork();
      if (!reachable) {
        console.log(`[App] ${reason} — reachability probe failed, deferring`);
        pendingWhenOnline = true;
        return;
      }

      lastCheckTime = Date.now();
      pendingWhenOnline = false;
      // Reset backend reconnect counter so we don't immediately hit
      // "Max reconnect attempts reached" from earlier failed attempts
      // that piled up while the network was down.
      try {
        await window.electronAPI?.imap?.resetAndReconnect?.();
      } catch {
        // resetAndReconnect itself does a sync — if it fails, fall
        // through to ensureConnectionAndSync which has its own retry
        // path. Either way we tried.
      }
      state.ensureConnectionAndSync();
    };

    const scheduleCheck = (reason: string) => {
      const now = Date.now();
      if (now - lastCheckTime < MIN_CHECK_INTERVAL && !pendingWhenOnline) {
        return; // debounced
      }
      if (pendingCheck) clearTimeout(pendingCheck);
      pendingCheck = setTimeout(() => {
        pendingCheck = null;
        void runCheck(reason);
      }, NETWORK_SETTLE_MS);
    };

    const handleFocus = () => {
      console.log('[App] Window focused — checking connection');
      scheduleCheck('focus');
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        console.log('[App] Tab became visible — checking connection');
        scheduleCheck('visibility');
      }
    };

    const handleOnline = () => {
      console.log('[App] Network online — re-running connection check');
      // Force the next runCheck through regardless of debounce —
      // a network transition is exactly what we've been waiting for.
      lastCheckTime = 0;
      scheduleCheck('online');
    };

    const handleOffline = () => {
      console.log('[App] Network offline — marking disconnected, pausing checks');
      pendingWhenOnline = true;
      if (pendingCheck) {
        clearTimeout(pendingCheck);
        pendingCheck = null;
      }
      useEmailStore.getState().handleDisconnection?.();
    };

    // Cmd/Ctrl+R to refresh (check connection + sync)
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        console.log('[App] Manual refresh (Cmd+R) — checking connection');
        lastCheckTime = 0; // bypass debounce for manual refresh
        scheduleCheck('manual-refresh');
      }
    };

    // Electron powerMonitor → system events from the main process.
    // Catches laptop sleep/wake before any window/focus event fires.
    const handleSuspend = () => {
      console.log('[App] System suspending — pausing reconnect attempts');
      pendingWhenOnline = true;
      if (pendingCheck) {
        clearTimeout(pendingCheck);
        pendingCheck = null;
      }
      useEmailStore.getState().handleDisconnection?.();
    };

    const handleResume = () => {
      console.log('[App] System resumed — scheduling network-gated reconnect');
      // Force through debounce; network just came back.
      lastCheckTime = 0;
      scheduleCheck('resume');
    };

    const handleUnlock = () => {
      console.log('[App] Screen unlocked — scheduling network-gated reconnect');
      lastCheckTime = 0;
      scheduleCheck('unlock');
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.electronAPI?.system?.onSuspend?.(handleSuspend);
    window.electronAPI?.system?.onResume?.(handleResume);
    window.electronAPI?.system?.onUnlock?.(handleUnlock);

    return () => {
      if (pendingCheck) clearTimeout(pendingCheck);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.electronAPI?.system?.removeAllListeners?.();
    };
  }, []);

  // Render content based on active section
  const renderContent = () => {
    switch (activeSection) {
      case 'mail':
        // Outbox is a virtual view (the send-queue) — show it full-pane in the
        // mail area, keeping the folder sidebar, regardless of split mode.
        if (selectedVirtualFolder === 'virtual-outbox') {
          return (
            <>
              <Sidebar />
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto p-6">
                  <OutboxTab />
                </div>
              </div>
            </>
          );
        }
        // Different layouts based on view mode
        if (viewMode === 'no-split') {
          // No split: Show list or detail (not both)
          return (
            <>
              <Sidebar />
              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedEmailId ? <EmailDetail /> : <EmailList />}
              </div>
            </>
          );
        } else if (viewMode === 'horizontal') {
          // Horizontal split: List on top, detail below
          return (
            <>
              <Sidebar />
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="h-1/2 border-b border-border overflow-hidden flex flex-col">
                  <EmailList />
                </div>
                <div className="h-1/2 overflow-hidden">
                  <EmailDetail />
                </div>
              </div>
            </>
          );
        } else {
          // Vertical split (default): List on left, detail on right
          return (
            <>
              <Sidebar />
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <div className="flex flex-1 min-w-0 overflow-hidden">
                  <EmailList />
                  <EmailDetail />
                </div>
              </div>
            </>
          );
        }
      case 'contacts':
        return <Contacts
          onSearchMail={(query: string) => {
            useEmailStore.getState().search(query);
            setActiveSection('mail');
          }}
        />;
      case 'settings':
        return <Settings initialTab={settingsInitialTab as any} openAddAccount={openAddAccountOnMount} onAddAccountConsumed={() => setOpenAddAccountOnMount(false)} onDirtyChange={(d) => { settingsDirtyRef.current = d; }} />;
      case 'ai-settings':
        return <AISettings initialTab={aiSettingsInitialTab as any} onDirtyChange={(d) => { settingsDirtyRef.current = d; }} />;
      case 'agent':
        return <AgentDashboard
          onNavigateToEmail={(emailId: string) => {
            useEmailStore.getState().selectEmail(emailId);
            setActiveSection('mail');
          }}
          onNavigateToContacts={() => setActiveSection('contacts')}
        />;
      case 'extensions':
        return <ExtensionManager />;
      case 'teams':
      case 'chat':
      case 'meet':
      case 'webinar':
      case 'drive':
      case 'calendar':
        return (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <h2 className="text-xl font-semibold mb-2 capitalize">{activeSection}</h2>
              <p>Coming soon</p>
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div ref={appRootRef} tabIndex={-1} className="flex h-screen overflow-hidden bg-background outline-none">
      {/* Establish the SMTP session once IMAP is connected and SMTP is
          configured, so the outbox drains (queued messages send) on startup
          instead of waiting for the next compose. Best-effort. */}
      <SmtpConnector connected={connected} smtpConfigured={smtpConfigured} />
      {/* Bind the main process to the active account on startup so the primary
          account claims its existing DB (sarvinbox.db) before any 2nd account
          is added — otherwise switching back to it would open an empty DB. */}
      <AccountActivator activeAccountId={activeAccountId} />
      {/* Tier B: periodically refresh inactive accounts' INBOX so unread badges
          and All Inboxes stay current without keeping every account live. */}
      <BackgroundSyncScheduler />

      {/* Onboarding — first-time users only (genuinely no account in the
          registry, not merely a transient null imapConfig during boot/reconnect). */}
      {shouldShowOnboarding({ checkingConnection, onboardingComplete, hasAccounts, needsReauth, activeSection }) && (
        <Onboarding onComplete={() => setOnboardingComplete(true)} />
      )}

      {/* Re-auth is NO LONGER a blocking gate. When the server rejects auth
          (needsReauth), the cached mailbox stays readable and other accounts stay
          switchable; a non-blocking ReauthBanner (in the banner stack below)
          offers Reconnect / Account settings. This dialog opens ONLY on demand
          (Reconnect), and closes itself on a successful reconnect. */}
      {showReauth && <ConnectionDialog onClose={() => setShowReauth(false)} />}

      {/* SMTP setup is NO LONGER a blocking gate. An IMAP-connected account is
          fully usable without SMTP (mail queues in the Outbox), so sending is
          set up on demand: the compose/reply banner's "Set up sending" opens the
          dismissible SmtpSetup modal (mounted below, listening for the event). */}

      {/* App Sidebar - Icon Navigation */}
      <AppSidebar activeSection={activeSection} onSectionChange={requestSection} />

      {/* Main Layout */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Security warning — only shows if the OS keychain is unavailable and
            credentials can't be encrypted at rest (never on macOS/Windows). */}
        <SecurityStatusBanner />
        {/* AI inactive banner — "Fix" jumps to AI provider settings, where a
            passing Test reactivates AI. */}
        <AIStatusBanner onFix={() => { setAiSettingsInitialTab('providers'); setActiveSection('ai-settings'); }} />
        {/* Non-blocking account re-auth prompt (replaces the old full-screen gate). */}
        <ReauthBanner
          onReconnect={() => setShowReauth(true)}
          onFix={() => { setSettingsInitialTab('accounts'); setActiveSection('settings'); }}
        />
        {/* An OAuth session that could not be refreshed. Separate from the
            password banner above: the remedy is the provider's sign-in, not a
            password prompt. Shown regardless of whether the OS notification
            was ever seen. */}
        <OAuthSessionBanner
          onFix={() => { setSettingsInitialTab('accounts'); setActiveSection('settings'); }}
        />
        {/* Socket up but mail sync failing — tells the user instead of showing a
            reassuring green "Live" while nothing arrives. Hidden when re-auth is
            needed (that banner takes over). */}
        <SyncTroubleBanner />
        <div className="flex flex-1 min-w-0 overflow-hidden">
          {/* No account + on the mail view → show the empty state. Only overrides
              the mail section so Settings (and other sections) stay reachable and
              the user can add/configure there. "Add account" deep-links to
              Settings → Accounts rather than opening a popup. */}
          {shouldShowNoAccountEmptyState({ checkingConnection, onboardingComplete, hasAccounts, needsReauth, activeSection })
            ? <NoAccountEmptyState onAddAccount={openAddAccountFlow} />
            : renderContent()}
        </div>
      </div>

      {/* Compose Email Modal */}
      {compose.isOpen && (
        <ComposeEmail
          mode={compose.mode}
          replyToEmail={compose.replyToEmail}
          draftBody={compose.draftBody}
          draft={compose.draft ?? (restoreDraft?.isInline === false ? restoreDraft : undefined)}
          onClose={() => { clearRestoreDraft(); closeCompose(); }}
        />
      )}

      {/* Keyboard Shortcuts Help Modal (? key) */}
      <ShortcutsHelpModal />

      {/* App-wide confirmation prompt — backs requestConfirm() so store-level
          guards (e.g. bulk delete) can prompt regardless of entry point. */}
      <GlobalConfirmDialog />

      {/* Set-up-sending (SMTP) modal — dismissible, opened on demand via the
          'sarvinbox:open-smtp-setup' event from the compose/reply banner. */}
      <SmtpSetup />



      {/* Undo Delete Toast — top-level so it's visible in all views */}
      <UndoDeleteToast />

      {/* Undo Send Toast — 5-second delay before actually sending */}
      <UndoSendToast />

      {/* In-app notification toasts — fallback when native OS toasts can't show
          (dev build / no notification daemon). */}
      <InAppNotification />
    </div>
  );
}

/** Establishes the SMTP session (and thus drains the outbox) whenever IMAP is
 *  connected and SMTP is configured. Rendered as a child so it doesn't add a
 *  hook to App's own body. */
function SmtpConnector({ connected, smtpConfigured }: { connected: boolean; smtpConfigured: boolean }) {
  useEffect(() => {
    if (connected && smtpConfigured) {
      useEmailStore.getState().connectSmtp().catch(() => { /* lazy send will retry */ });
    }
  }, [connected, smtpConfigured]);
  return null;
}

/** Points the main process at the active account (claims its DB slot) whenever
 *  the active account changes, including on startup. */
function AccountActivator({ activeAccountId }: { activeAccountId: string | null }) {
  useEffect(() => {
    if (activeAccountId) {
      window.electronAPI?.accounts?.setActive(activeAccountId).catch(() => { /* best effort */ });
    }
  }, [activeAccountId]);
  return null;
}

/** Multi-account liveness driver. Shortly after startup (and periodically as a
 *  FALLBACK) it ensures every inactive account is connected + on IMAP IDLE (and
 *  catches up its INBOX). New mail then arrives in real time via each account's
 *  own IDLE push — this interval re-ensures liveness after a dropped socket /
 *  sleep-resume. It's cheap now that backgroundSync short-circuits when an
 *  account is already live (connected + IDLE), so it runs often enough to
 *  re-IDLE a background account promptly if the reconnect ladder ever misses a
 *  drop — instead of leaving it dark for up to 15 min. Disabled with 0/1
 *  accounts; interval cleared on unmount (no leak); the cycle is overlap-guarded. */
const BACKGROUND_SYNC_INTERVAL_MS = 2 * 60 * 1000;
function BackgroundSyncScheduler() {
  const accountCount = useEmailStore((s) => s.accounts.length);
  const runBackgroundSyncCycle = useEmailStore((s) => s.runBackgroundSyncCycle);
  useEffect(() => {
    if (accountCount <= 1) return;
    const initial = setTimeout(() => { runBackgroundSyncCycle(); }, 15_000);
    const interval = setInterval(() => { runBackgroundSyncCycle(); }, BACKGROUND_SYNC_INTERVAL_MS);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [accountCount, runBackgroundSyncCycle]);
  return null;
}

export default App;
