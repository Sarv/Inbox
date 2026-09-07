import { Mail, Loader2, Check, X, Trash2, Send, Pencil, Plus, ChevronRight } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

import { useEmailStore } from '../../store/email-store';
import { accountHost, isAccountEmailDuplicated, effectiveSmtpConfig } from '../../store/helpers';
import { AddAccountModal } from '../AddAccountModal';
import { SmtpConfigForm } from '../SmtpConfigForm';
import { Tooltip } from '../Tooltip';
import { VaultPasswordField } from '../VaultPasswordField';

import { AliasEditor } from './AliasEditor';
import type { SettingsTabProps } from './types';

type EmailOAuthProviderId = 'gmail' | 'microsoft' | 'yahoo';

// Friendly provider names for the "Signed in with …" auth badge.
const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Google',
  microsoft: 'Microsoft',
  yahoo: 'Yahoo',
};

export function AccountsTab({ settings, updateSetting, openAddAccount, onAddAccountConsumed }: SettingsTabProps & { openAddAccount?: boolean; onAddAccountConsumed?: () => void }) {
  // IMAP Account settings
  const { connected, imapConfig, connect, disconnect, connectionStatus, smtpConfigured, smtpConfig, accounts, activeAccountId, selectAccount, removeAccountById, removeSmtp, setAccountIdentities, deletingAccountIds, accountActionError } = useEmailStore();
  const [showSmtpForm, setShowSmtpForm] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [showSmtpRemoveConfirm, setShowSmtpRemoveConfirm] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Which account the popup is showing. Kept separate from activeAccountId so the
  // popup renders the CLICKED account immediately, even while selectAccount's
  // async switch (which updates imapConfig/connected) is still in flight —
  // otherwise it briefly shows the previously-active account.
  const [detailsAccountId, setDetailsAccountId] = useState<string | null>(null);

  // Auto-open the add-account wizard when navigated here with that intent (the
  // sidebar switcher / mailbox empty state route through Settings → Accounts so
  // every "Add account" entry behaves identically).
  useEffect(() => {
    if (openAddAccount) {
      setShowAddAccount(true);
      onAddAccountConsumed?.();
    }
  }, [openAddAccount, onAddAccountConsumed]);

  // Inspecting an account here opens its details popup, which switches the
  // active account so the popup shows live status and the SMTP form edits the
  // right account. But that must NOT change which mailbox the HOMEPAGE shows:
  // remember the account active when this tab opened and restore it on leave,
  // so "check another account's connection" never hijacks your home mailbox.
  // (Switching is instant via adopt, so the restore is seamless.)
  const homeAccountRef = useRef<string | null>(null);
  useEffect(() => {
    homeAccountRef.current = useEmailStore.getState().activeAccountId;
    return () => {
      const s = useEmailStore.getState();
      const home = homeAccountRef.current;
      if (home && s.activeAccountId !== home && s.accounts.some((a) => a.id === home)) {
        void s.selectAccount(home);
      }
    };
  }, []);
  const [imapForm, setImapForm] = useState({
    host: '',
    port: '993',
    username: '',
    password: '',
  });
  const [imapLoading, setImapLoading] = useState(false);
  const [imapError, setImapError] = useState('');
  const [imapSuccess, setImapSuccess] = useState(false);
  // Inline "edit IMAP" form on the active account's card — updates the password
  // (and port) and reconnects, persisting the new secret to the vault.
  const [showImapEdit, setShowImapEdit] = useState(false);

  const handleSaveImap = async () => {
    if (!imapConfig) return;
    setImapError('');
    setImapLoading(true);
    try {
      await connect({
        ...imapConfig,
        ...(imapForm.host.trim() ? { host: imapForm.host.trim() } : {}),
        port: parseInt(imapForm.port) || imapConfig.port || 993,
        ...(imapForm.password ? { password: imapForm.password } : {}),
      });
      setShowImapEdit(false);
      setImapForm((prev) => ({ ...prev, password: '' }));
    } catch (err) {
      setImapError((err as Error).message || 'Failed to update IMAP');
    } finally {
      setImapLoading(false);
    }
  };
  const [oauthProviders, setOauthProviders] = useState<Array<{ id: EmailOAuthProviderId; label: string; configured: boolean }>>([]);
  const [oauthLoading, setOauthLoading] = useState<EmailOAuthProviderId | null>(null);
  // A saved-but-not-connected account (e.g. a wrong port refuses the socket, so
  // `connected` is false). Surfacing it lets the user fix the port + reconnect
  // instead of the panel reading "No account connected" and forcing a re-setup.
  const [savedAccount, setSavedAccount] = useState<any | null>(null);

  // Load OAuth provider list — scoped to email-purpose providers only.
  // Sarv (llm-purpose) lives in the AI Providers settings tab.
  useEffect(() => {
    (async () => {
      try {
        const res = await window.electronAPI.oauth.listProviders();
        if (res.success && res.data) {
          setOauthProviders(
            res.data
              .filter((p) => p.purpose === 'email' || p.purpose === 'both')
              .map((p) => ({ id: p.id as EmailOAuthProviderId, label: p.label, configured: p.configured })),
          );
        }
      } catch {
        // no-op
      }
    })();
  }, []);

  const handleOAuthSignIn = async (providerId: EmailOAuthProviderId) => {
    setImapError('');
    setOauthLoading(providerId);
    try {
      const res = await window.electronAPI.oauth.startFlow(providerId);
      if (!res.success || !res.data) {
        throw new Error(res.error || 'Sign-in failed');
      }
      const { email, imap } = res.data;
      if (!imap) {
        throw new Error(`${providerId} returned no IMAP config`);
      }
      // Kick off IMAP connect using OAuth — main process will inject the token.
      await connect({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        username: email,
        password: '',
        authMethod: 'oauth2',
        oauthProvider: providerId,
      } as any);
      setImapSuccess(true);
      setTimeout(() => setImapSuccess(false), 3000);
    } catch (err) {
      setImapError((err as Error).message || 'OAuth sign-in failed');
    } finally {
      setOauthLoading(null);
    }
  };

  // Load IMAP config into form when available
  useEffect(() => {
    if (imapConfig) {
      setImapForm({
        host: imapConfig.host || 'imap.gmail.com',
        port: String(imapConfig.port || 993),
        username: imapConfig.username || '',
        password: imapConfig.password || '',
      });
    }
  }, [imapConfig]);

  // When there's no live connection, pull the encrypted saved account (main
  // process) so a disconnected account stays visible and editable rather than
  // vanishing. Cleared once connected so the live panel takes over.
  useEffect(() => {
    if (connected) {
      setSavedAccount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await window.electronAPI.imap.getSavedConfig();
        if (!cancelled) setSavedAccount(res?.success && res.data ? res.data : null);
      } catch {
        if (!cancelled) setSavedAccount(null);
      }
    })();
    return () => { cancelled = true; };
  }, [connected]);

  // Seed the editable form from the saved account (so the port can be fixed).
  useEffect(() => {
    if (savedAccount) {
      setImapForm({
        host: savedAccount.host || '',
        port: String(savedAccount.port || 993),
        username: savedAccount.username || '',
        password: savedAccount.password || '',
      });
    }
  }, [savedAccount]);

  // Reconnect the saved account with the (possibly corrected) port. Spreads the
  // saved config so OAuth accounts keep authMethod/oauthProvider and the main
  // process refreshes their token.
  const handleReconnectSaved = async () => {
    if (!savedAccount) return;
    setImapError('');
    setImapLoading(true);
    setImapSuccess(false);
    try {
      await connect({
        ...savedAccount,
        ...(imapForm.host.trim() ? { host: imapForm.host.trim() } : {}),
        port: parseInt(imapForm.port) || savedAccount.port,
        secure: savedAccount.secure ?? true,
        ...(imapForm.password ? { password: imapForm.password } : {}),
      });
      setImapForm((prev) => ({ ...prev, password: '' }));
      setImapSuccess(true);
      setTimeout(() => setImapSuccess(false), 3000);
    } catch (err) {
      setImapError((err as Error).message || 'Failed to reconnect');
    } finally {
      setImapLoading(false);
    }
  };

  // Forget the saved account and fall back to the sign-in / manual UI.
  const handleForgetSaved = async () => {
    try {
      await window.electronAPI.imap.clearSavedConfig();
    } catch {
      // best-effort; still drop it from the UI
    }
    setSavedAccount(null);
  };

  const handleImapDisconnect = async () => {
    // Remove the account the popup is showing (falls back to the active one).
    const targetId = detailsAccountId || activeAccountId;
    try {
      const cfg = imapConfig as any;
      // Only sign OAuth out when we're removing the currently-active account
      // (imapConfig belongs to it). Fire-and-forget: it's best-effort token
      // revocation, and awaiting it delayed the "Deleting…" state (removeAccountById
      // is what sets it) behind a network round-trip.
      if (targetId === activeAccountId && cfg?.authMethod === 'oauth2' && cfg.oauthProvider && cfg.username) {
        void window.electronAPI.oauth.signOut(cfg.oauthProvider, cfg.username).catch(() => {});
      }
      if (targetId) await removeAccountById(targetId);
      else await disconnect();
      setImapForm({ host: 'imap.gmail.com', port: '993', username: '', password: '' });
    } catch (err) {
      setImapError((err as Error).message || 'Failed to disconnect');
    }
  };

  // Disambiguate the same address connected via different providers (sarv vs
  // gmail IMAP): show the IMAP host when an email appears more than once. Shared
  // helpers (store/helpers) — single source, consistent with everywhere else.
  const isDupEmail = (a: (typeof accounts)[number]) => isAccountEmailDuplicated(accounts, a.email);
  const hostOf = (a: (typeof accounts)[number]) => accountHost(a);

  // Open the details popup for an account. Switching (selectAccount) makes it
  // active so the popup shows live status and the SMTP form edits the right
  // account. The popup renders from detailsAccountId, so it shows the clicked
  // account immediately even before the async switch lands.
  const openDetails = (id: string) => {
    setDetailsAccountId(id);
    if (id !== activeAccountId) selectAccount(id);
    setShowSmtpForm(false);
    setDetailsOpen(true);
  };
  const closeDetails = () => { setDetailsOpen(false); setShowSmtpForm(false); };

  // The account the popup is showing, and whether we have its LIVE (active +
  // connected) state yet. Until the switch lands we render its stored config.
  const detailAccount = accounts.find((a) => a.id === detailsAccountId) || null;
  const detailIsActive = !!detailAccount && detailAccount.id === activeAccountId;
  const detailLive = detailIsActive && connected && !!imapConfig;
  const dImap: any = detailLive ? imapConfig : detailAccount?.imapConfig ?? null;
  // Show the EFFECTIVE sending config: OAuth accounts always resolve to their
  // provider's SMTP (smtp.gmail.com), never a stale/crossed stored password
  // config — this is what fixes the "Gmail account shows smtp.sarv.com" display.
  const dSmtpConfig = detailLive
    ? (smtpConfigured ? smtpConfig : null)
    : effectiveSmtpConfig(detailAccount);
  const dSmtpConfigured = detailLive ? smtpConfigured : !!dSmtpConfig;

  // How the shown account signs in. OAuth accounts have no editable IMAP/SMTP
  // credentials (host/port/token are provider-managed), so we hide the edit
  // affordances and label the sign-in method instead.
  const dOauthProvider: string | undefined = dImap?.oauthProvider;
  const dIsOAuth = dImap?.authMethod === 'oauth2' || !!dOauthProvider;
  const dOauthLabel = dOauthProvider ? (OAUTH_PROVIDER_LABELS[dOauthProvider] ?? 'OAuth') : 'OAuth';
  const authBadge = dIsOAuth ? `Signed in with ${dOauthLabel}` : 'Password sign-in';

  return (
    <div className="space-y-6">
      {/* Top action: add another mailbox via the 3-step wizard */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Accounts</h2>
        <button
          onClick={() => setShowAddAccount(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add account
        </button>
      </div>
      {showAddAccount && <AddAccountModal onClose={() => setShowAddAccount(false)} />}

      {/* Remove-account confirmation — destructive, so confirm first and spell
          out that sending (SMTP) + locally cached mail go with it. */}
      {showRemoveConfirm && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => setShowRemoveConfirm(false)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-2">Remove account?</h2>
            <p className="text-sm text-muted-foreground mb-5">
              This disconnects <span className="font-medium text-foreground">{detailAccount?.email || imapConfig?.username}</span> and removes its sending (SMTP) settings. Locally cached mail for this account will be cleared. You can add it again anytime.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setShowRemoveConfirm(false)} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50">Cancel</button>
              <button
                onClick={() => { setShowRemoveConfirm(false); setDetailsOpen(false); handleImapDisconnect(); }}
                disabled={deletingAccountIds.includes(detailsAccountId || activeAccountId || '')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-destructive text-white rounded-md hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="h-4 w-4" /> Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove-SMTP confirmation — destructive, so confirm first. */}
      {showSmtpRemoveConfirm && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => setShowSmtpRemoveConfirm(false)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-2">Remove sending (SMTP)?</h2>
            <p className="text-sm text-muted-foreground mb-5">
              <span className="font-medium text-foreground">{detailAccount?.email}</span> will keep receiving mail, but you won't be able to send until you set up SMTP again. Any outgoing messages wait in the Outbox.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setShowSmtpRemoveConfirm(false)} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50">Cancel</button>
              <button
                onClick={() => { setShowSmtpRemoveConfirm(false); removeSmtp(); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-destructive text-white rounded-md hover:bg-destructive/90 transition-colors"
              >
                <Trash2 className="h-4 w-4" /> Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        /* No accounts yet — provider sign-in; manual entry via "+ Add account" */
        <div className="space-y-4 border-b border-border pb-6">
          <div className="flex items-center gap-3 p-4 bg-muted/50 border border-border rounded-lg max-w-md">
            <div className="p-2 bg-muted rounded-full">
              <Mail className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="font-medium">No account connected</div>
              <div className="text-sm text-muted-foreground">Sign in with your provider, or use "Add account".</div>
            </div>
          </div>
          <div className="space-y-2 max-w-md">
            {oauthProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => handleOAuthSignIn(p.id)}
                disabled={!p.configured || oauthLoading !== null}
                title={p.configured ? '' : 'Not configured — see OAUTH_SETUP.md'}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-background border border-input rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {oauthLoading === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                <span className="text-sm font-medium">Sign in with {p.label}</span>
                {!p.configured && <span className="text-xs text-muted-foreground">(not configured)</span>}
              </button>
            ))}
          </div>
          {imapError && (
            <div className="max-w-md flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
              <X className="h-4 w-4 flex-shrink-0" />
              {imapError}
            </div>
          )}
          {imapSuccess && (
            <div className="max-w-md flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-md text-sm text-green-600">
              <Check className="h-4 w-4 flex-shrink-0" />
              Successfully connected!
            </div>
          )}
        </div>
      ) : (
        /* Connected accounts — click one to open its details popup. */
        <div className="border-b border-border pb-6">
          <div className="space-y-1 max-w-sm">
            {accounts.map((a) => {
              // Highlight ONLY the account whose details popup is currently open
              // — never the "active" account. Opening Settings shows no selection,
              // and closing the popup clears it.
              const isOpen = detailsOpen && a.id === detailsAccountId;
              // While a removal is in flight the row shows "Deleting…" and is
              // disabled — the teardown can block for the op timeout on a wedged
              // connection, and clicking a half-removed account is what looked
              // like "still connected, then it vanishes".
              const isDeleting = deletingAccountIds.includes(a.id);
              const removeError = accountActionError?.id === a.id ? accountActionError.message : null;
              return (
                <button
                  key={a.id}
                  onClick={() => { if (!isDeleting) openDetails(a.id); }}
                  disabled={isDeleting}
                  aria-busy={isDeleting}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left transition-colors ${isOpen ? 'bg-primary/10 text-primary' : 'hover:bg-muted/60'} disabled:opacity-60 disabled:cursor-not-allowed`}
                >
                  <span
                    className="h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 text-white"
                    style={{ backgroundColor: a.color ?? '#2563eb' }}
                  >
                    {(a.email?.[0] || '?').toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-sm">{a.email}</span>
                    {isDeleting ? (
                      <span className="block truncate text-[11px] text-muted-foreground">Deleting…</span>
                    ) : removeError ? (
                      <span className="block truncate text-[11px] text-destructive">{removeError}</span>
                    ) : isDupEmail(a) && (
                      <span className="block truncate text-[11px] text-muted-foreground">{hostOf(a)}</span>
                    )}
                  </span>
                  {isDeleting ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <ChevronRight className={`h-4 w-4 shrink-0 ${isOpen ? 'text-primary' : 'text-muted-foreground'}`} />
                  )}
                </button>
              );
            })}
            <button
              onClick={() => setShowAddAccount(true)}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-sm text-primary hover:bg-muted/60 text-left"
            >
              <Plus className="h-4 w-4" /> Add account
            </button>
          </div>
        </div>
      )}

      {/* Account details popup — IMAP + SMTP side by side; widens when the SMTP
          edit form is open so everything fits without a page scroll. */}
      {detailsOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={closeDetails}>
          <div
            className={`w-full ${showSmtpForm ? 'max-w-5xl' : 'max-w-3xl'} rounded-lg border border-border bg-background p-6 shadow-xl max-h-[85vh] overflow-y-auto transition-[max-width] duration-200`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold truncate">{detailAccount?.email || 'Account'}</h2>
              <button type="button" onClick={closeDetails} aria-label="Close" className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {detailIsActive && !connected && savedAccount && savedAccount.username === detailAccount?.email ? (
              /* Active account currently disconnected — fix port + reconnect.
                 Gated on the saved config MATCHING the viewed account so the
                 legacy single-account savedAccount can't render another
                 account's host/username here. */
              <div className="space-y-4 max-w-md">
                <div className="flex items-center gap-3 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <div className="p-2 bg-yellow-500/20 rounded-full"><Mail className="h-5 w-5 text-yellow-600 dark:text-yellow-400" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-yellow-700 dark:text-yellow-400">
                      {connectionStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'}
                    </div>
                    <div className="text-sm text-muted-foreground truncate">{savedAccount.username}</div>
                  </div>
                  <button onClick={handleForgetSaved} className="flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded-md transition-colors">
                    <Trash2 className="h-4 w-4" /> Remove
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1">IMAP server</label>
                    <input
                      type="text"
                      value={imapForm.host}
                      onChange={(e) => setImapForm(prev => ({ ...prev, host: e.target.value }))}
                      placeholder="imap.example.com"
                      className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Port</label>
                    <input
                      type="number"
                      value={imapForm.port}
                      onChange={(e) => setImapForm(prev => ({ ...prev, port: e.target.value }))}
                      placeholder="993"
                      className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <VaultPasswordField
                  accountId={detailsAccountId}
                  kind="imap"
                  value={imapForm.password}
                  onChange={(v) => setImapForm(prev => ({ ...prev, password: v }))}
                  label="Password"
                  firstTimeHint="Enter a new password if it changed or expired; leave blank to reuse the saved one."
                />
                <p className="text-xs text-muted-foreground">Wrong port or a changed password are the usual causes of a refused connection — fix here and reconnect.</p>
                {imapError && (
                  <div className="flex items-center gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
                    <X className="h-4 w-4 flex-shrink-0" /> {imapError}
                  </div>
                )}
                <button
                  onClick={handleReconnectSaved}
                  disabled={imapLoading}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {imapLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> Reconnecting…</> : 'Reconnect'}
                </button>
              </div>
            ) : dImap ? (
              /* Details for the CLICKED account (dImap/dSmtp*). Config shows
                 immediately from the registry; live status + editing light up
                 once the switch to this account lands (detailLive). */
              <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                {/* IMAP (Incoming) */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">IMAP (Incoming)</h3>
                  <div className="flex items-center gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                    <div className="p-2 bg-green-500/20 rounded-full"><Mail className="h-5 w-5 text-green-500" /></div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{dImap.username}</div>
                      <div className="text-xs text-muted-foreground truncate">{authBadge}</div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      {/* OAuth accounts have provider-managed credentials — nothing to edit. */}
                      {!dIsOAuth && (
                        <Tooltip content="Edit incoming (IMAP host / port / password)" delayMs={40}>
                          <button
                            onClick={() => { setImapError(''); setImapForm((prev) => ({ ...prev, host: String(dImap.host || ''), port: String(dImap.port || 993), password: '' })); setShowImapEdit((v) => !v); }}
                            disabled={!detailIsActive}
                            aria-label="Edit incoming (IMAP)"
                            className="p-1.5 text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content="Remove account" delayMs={40}>
                        <button
                          onClick={() => setShowRemoveConfirm(true)}
                          aria-label="Remove account"
                          className="p-1.5 text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                  {showImapEdit && detailIsActive && (
                    <div className="space-y-3 p-3 border border-border rounded-lg bg-muted/20">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className="block text-sm font-medium mb-1">IMAP server</label>
                          <input
                            type="text"
                            value={imapForm.host}
                            onChange={(e) => setImapForm((prev) => ({ ...prev, host: e.target.value }))}
                            placeholder="imap.example.com"
                            className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium mb-1">Port</label>
                          <input
                            type="number"
                            value={imapForm.port}
                            onChange={(e) => setImapForm((prev) => ({ ...prev, port: e.target.value }))}
                            placeholder="993"
                            className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                      </div>
                      <VaultPasswordField
                        accountId={detailsAccountId}
                        kind="imap"
                        value={imapForm.password}
                        onChange={(v) => setImapForm((prev) => ({ ...prev, password: v }))}
                        label="New password"
                        firstTimeHint="Enter your mailbox (IMAP) password."
                      />
                      {imapError && (
                        <div className="flex items-center gap-2 p-2 bg-destructive/10 border border-destructive/20 rounded-md text-xs text-destructive">
                          <X className="h-4 w-4 flex-shrink-0" /> {imapError}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleSaveImap}
                          disabled={imapLoading}
                          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                        >
                          {imapLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save & reconnect'}
                        </button>
                        <button onClick={() => setShowImapEdit(false)} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md">Cancel</button>
                      </div>
                    </div>
                  )}
                  <div className="grid gap-1">
                    <div className="flex items-center justify-between py-1">
                      <span className="text-sm text-muted-foreground">IMAP Server</span>
                      <span className="text-sm font-medium">{dImap.host}:{dImap.port}</span>
                    </div>
                    <div className="flex items-center justify-between py-1">
                      <span className="text-sm text-muted-foreground">Status</span>
                      <span className={`text-sm font-medium ${detailLive ? 'text-green-500' : 'text-muted-foreground'}`}>
                        {detailLive ? 'Connected' : 'Connecting…'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* SMTP (Sending) */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">SMTP (Sending)</h3>
                  <div className={`flex items-center gap-3 p-4 rounded-lg border ${dSmtpConfigured ? 'bg-green-500/10 border-green-500/20' : 'bg-yellow-500/10 border-yellow-500/20'}`}>
                    <div className={`p-2 rounded-full ${dSmtpConfigured ? 'bg-green-500/20' : 'bg-yellow-500/20'}`}>
                      <Send className={`h-5 w-5 ${dSmtpConfigured ? 'text-green-500' : 'text-yellow-600 dark:text-yellow-400'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{dSmtpConfig?.from || dSmtpConfig?.username || dImap.username || ''}</div>
                      {dIsOAuth ? (
                        <div className="text-xs text-muted-foreground truncate">{authBadge}</div>
                      ) : !dSmtpConfigured && (
                        <div className="text-sm text-muted-foreground truncate">Outgoing mail stays queued until you set this up.</div>
                      )}
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      {showSmtpForm ? (
                        <button
                          onClick={() => setShowSmtpForm(false)}
                          className="px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                        >
                          Cancel
                        </button>
                      ) : dSmtpConfigured ? (
                        <>
                          {/* OAuth sending is provider-managed — nothing to edit. */}
                          {!dIsOAuth && (
                            <Tooltip content="Edit sending (SMTP)" delayMs={40}>
                              <button
                                onClick={() => setShowSmtpForm(true)}
                                disabled={!detailIsActive}
                                aria-label="Edit sending (SMTP)"
                                className="p-1.5 text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                            </Tooltip>
                          )}
                          {/* OAuth sending is provider-managed and inseparable from
                              the account — there's no standalone SMTP credential to
                              drop, so hide Remove too (removing the account covers it). */}
                          {!dIsOAuth && (
                            <Tooltip content="Remove sending (SMTP)" delayMs={40}>
                              <button
                                onClick={() => setShowSmtpRemoveConfirm(true)}
                                disabled={!detailIsActive}
                                aria-label="Remove sending (SMTP)"
                                className="p-1.5 text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </Tooltip>
                          )}
                        </>
                      ) : (
                        <button
                          onClick={() => setShowSmtpForm(true)}
                          disabled={!detailIsActive}
                          title={detailIsActive ? '' : 'Switching to this account…'}
                          className="px-3 py-1.5 text-sm text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Set up
                        </button>
                      )}
                    </div>
                  </div>
                  {dSmtpConfigured && !showSmtpForm && (
                    <div className="grid gap-1">
                      <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-muted-foreground">SMTP Server</span>
                        <span className="text-sm font-medium">{dSmtpConfig?.host}:{dSmtpConfig?.port}</span>
                      </div>
                      <div className="flex items-center justify-between py-1">
                        <span className="text-sm text-muted-foreground">Status</span>
                        <span className={`text-sm font-medium ${detailLive ? 'text-green-500' : 'text-muted-foreground'}`}>
                          {detailLive ? 'Connected' : 'Connecting…'}
                        </span>
                      </div>
                    </div>
                  )}
                  {/* Gate on detailIsActive (stable), NOT detailLive — otherwise a
                      transient connection flicker (connected→reconnecting) would
                      unmount the form mid-entry and wipe what you typed. */}
                  {showSmtpForm && detailIsActive && (
                    <div>
                      <SmtpConfigForm onVerified={() => setShowSmtpForm(false)} submitLabel="Verify & Save" />
                    </div>
                  )}
                </div>
              </div>
              {/* Send-as aliases — full width below IMAP/SMTP. */}
              {detailAccount && (
                <div className="border-t border-border pt-6">
                  <AliasEditor
                    accountEmail={detailAccount.email}
                    identities={detailAccount.identities}
                    onChange={(aliases) => setAccountIdentities(detailAccount.id, aliases)}
                  />
                </div>
              )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
                <Loader2 className="h-4 w-4 animate-spin" /> Connecting…
              </div>
            )}
          </div>
        </div>
      )}

      {/* Profile Information */}
      <div className="pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Profile Information
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          This information is used by AI to personalize your emails
        </p>

        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-sm font-medium mb-1">Full Name</label>
            <input
              type="text"
              value={settings.profileName}
              onChange={(e) => updateSetting('profileName', e.target.value)}
              placeholder="John Doe"
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Job Title</label>
            <input
              type="text"
              value={settings.profileTitle}
              onChange={(e) => updateSetting('profileTitle', e.target.value)}
              placeholder="Software Engineer"
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Company</label>
            <input
              type="text"
              value={settings.profileCompany}
              onChange={(e) => updateSetting('profileCompany', e.target.value)}
              placeholder="Acme Inc."
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={settings.profileEmail}
              onChange={(e) => updateSetting('profileEmail', e.target.value)}
              placeholder="john@example.com"
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Phone</label>
            <input
              type="tel"
              value={settings.profilePhone}
              onChange={(e) => updateSetting('profilePhone', e.target.value)}
              placeholder="+1 (555) 123-4567"
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
