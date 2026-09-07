import { Check, Eye, EyeOff, Loader2, Mail, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { EMAIL_PROVIDERS, defaultPort, type ConnectionSecurity, type EmailProviderPreset } from '../config/email-providers';
import { requestConfirm } from '../store/confirm-service';
import { useEmailStore } from '../store/email-store';
import { findAccountByEmailHost } from '../store/helpers';

import { SmtpConfigForm } from './SmtpConfigForm';
import { Tooltip } from './Tooltip';

// Sarv is our own provider — surface it FIRST in the pill row and pre-select it
// when the modal opens, so "Add account" defaults to connecting a Sarv mailbox.
const SARV_PRESET: EmailProviderPreset | null =
  EMAIL_PROVIDERS.find((p) => p.id === 'sarv') ?? null;
const ORDERED_PROVIDERS: EmailProviderPreset[] = SARV_PRESET
  ? [SARV_PRESET, ...EMAIL_PROVIDERS.filter((p) => p.id !== 'sarv')]
  : EMAIL_PROVIDERS;

/**
 * Add a mailbox via a single 3-step wizard: Email + provider → Incoming (IMAP,
 * verified) → Sending (SMTP, OPTIONAL). IMAP success alone connects the account
 * (`addAccount`); SMTP can be skipped and set up later — until then compose/reply
 * show a banner and mail queues in the Outbox.
 */
export function AddAccountModal({ onClose }: { onClose: () => void }) {
  const addAccount = useEmailStore((s) => s.addAccount);
  // Needed to detect that an OAuth sign-in would overwrite an existing account.
  const accounts = useEmailStore((s) => s.accounts);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Guard so stepping Back to IMAP after a successful add doesn't re-add.
  const [didAddAccount, setDidAddAccount] = useState(false);

  // Step 1 — default to Sarv (first pill, pre-selected). `null` = Other/manual.
  const [email, setEmail] = useState('');
  const [providerId, setProviderId] = useState<string | null>(SARV_PRESET?.id ?? null);

  // Step 2 (IMAP)
  // Login username — defaults to the step-1 email but editable, since some
  // servers use a login that differs from the address. Server fields seed from
  // the pre-selected Sarv preset (kept in sync by applyPreset on pill change).
  const [username, setUsername] = useState('');
  const [host, setHost] = useState(SARV_PRESET?.imapHost ?? '');
  const [port, setPort] = useState(String(SARV_PRESET?.imapPort ?? 993));
  const [security, setSecurity] = useState<ConnectionSecurity>(SARV_PRESET?.imapSecurity ?? 'ssl');
  const [password, setPassword] = useState('');
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // OAuth providers available in this build (configured via OAUTH_SETUP.md).
  // `providersLoaded` distinguishes "not yet fetched" from "fetched, unconfigured"
  // so the default Sarv button never flashes as "Coming soon" during the fetch.
  const [oauthProviders, setOauthProviders] = useState<Record<string, { label: string; configured: boolean }>>({});
  const [providersLoaded, setProvidersLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const res = await window.electronAPI.oauth.listProviders();
        if (res.success && res.data) {
          const map: Record<string, { label: string; configured: boolean }> = {};
          for (const p of res.data) {
            if (p.purpose === 'email' || p.purpose === 'both') map[p.id] = { label: p.label, configured: p.configured };
          }
          setOauthProviders(map);
        }
      } catch {
        // no-op — manual flow still works
      } finally {
        setProvidersLoaded(true);
      }
    })();
  }, []);

  // Abandoning the modal mid-sign-in (X, overlay click, Cancel, or unmount)
  // must abort any in-flight OAuth flow so its loopback server releases the
  // registered redirect port. No-op when nothing is pending.
  useEffect(() => {
    return () => { void window.electronAPI.oauth.cancel?.(); };
  }, []);

  const selectedPreset: EmailProviderPreset | null = useMemo(
    () => EMAIL_PROVIDERS.find((p) => p.id === providerId) ?? null,
    [providerId],
  );

  // Each preset pill is OAuth-only (the "Other" pill covers manual IMAP/SMTP), so
  // a pill shows a "Sign in with <provider>" button. Whether that button is live
  // depends on the build-`configured` flag from listProviders() — a provider whose
  // client_id isn't wired (currently Outlook/Yahoo) renders a disabled button with
  // a "Coming soon" note instead. We only trust the flag once the (local, fast)
  // list has loaded; before that we stay optimistic so the default Sarv button —
  // always configured via its baked-in client_id — never flashes as coming soon.
  const oauthProviderId = selectedPreset?.oauthProviderId;
  const oauthSupported = !!oauthProviderId;
  const oauthConfigured = oauthSupported && !!oauthProviders[oauthProviderId!]?.configured;
  const showOAuth = oauthSupported;
  const oauthComingSoon = showOAuth && providersLoaded && !oauthConfigured;

  const applyPreset = (preset: EmailProviderPreset | null) => {
    setProviderId(preset?.id ?? null);
    setError('');
    if (preset) {
      setHost(preset.imapHost);
      setPort(String(preset.imapPort));
      setSecurity(preset.imapSecurity);
    } else {
      setHost('');
      setPort('993');
      setSecurity('ssl');
    }
  };

  const goToImap = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // Prefill the login with the entered email (only if untouched) so the common
    // "login === email" case is one field, while still allowing a different login.
    setUsername((u) => (u.trim() ? u : email.trim()));
    setStep(2);
  };

  const handleOAuthConnect = async () => {
    if (!oauthProviderId) return;
    setError('');
    setLoading(true);
    try {
      const res = await window.electronAPI.oauth.startFlow(oauthProviderId as any);
      if (!res.success || !res.data) throw new Error(res.error || 'Sign-in failed');
      const { email: oauthEmail, imap } = res.data;
      if (!imap) throw new Error(`${oauthProviderId} returned no IMAP config`);

      const candidate = {
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        username: oauthEmail,
        password: '',
        authMethod: 'oauth2',
        oauthProvider: oauthProviderId,
      };

      // 1. PROVE the token authenticates before we touch any stored account.
      //    A successful OAuth handshake only means the identity provider is
      //    happy — the MAIL server is a separate system and may not accept the
      //    token at all (e.g. it advertises no AUTH=XOAUTH2/OAUTHBEARER). This
      //    probe is isolated: it cannot disturb the live connection.
      //    Surfaced directly rather than thrown: a rejected probe is an expected
      //    outcome, and routing it through catch would run it past the
      //    "cancelled" heuristic below, which could swallow a real failure.
      const probe = await window.electronAPI.imap.probeCredentials(candidate as any);
      if (!probe.success) {
        setError(
          `Signed in as ${oauthEmail}, but ${imap.host} rejected the access token `
          + `(${probe.error ?? 'authentication failed'}). Nothing was changed — `
          + `connect via IMAP / app-password below instead.`,
        );
        return;
      }

      // 2. The credentials work. If this exact mailbox is already connected by
      //    another auth method, adding it would CONVERT that account in place
      //    (addAccount dedupes on email + host) — never do that silently.
      const clash = findAccountByEmailHost(accounts, oauthEmail, imap.host);
      if (clash && clash.imapConfig?.authMethod !== 'oauth2') {
        const ok = await requestConfirm({
          title: 'Mailbox already connected',
          message:
            `${oauthEmail} on ${imap.host} is already connected using an app password.\n\n`
            + `Replace it with this ${oauthProviderId} sign-in? Its mail stays on your device — `
            + `only the sign-in method changes.`,
          confirmLabel: 'Replace',
          cancelLabel: 'Keep app password',
          destructive: true,
        });
        // Declined — leave the working account exactly as it is.
        if (!ok) return;
      }

      // alreadyVerified: the probe above tested this exact config — the confirm
      // step had to come after it, so re-probing here would just be a second
      // connection to the same server. connect()'s email sync now runs in the
      // BACKGROUND, so this resolves as soon as the account is connected + folders
      // load — it no longer blocks on the (potentially long, contended) initial
      // folder sync that left the button spinning.
      await addAccount(candidate as any, { alreadyVerified: true });
      // OAuth sending is provider-derived (no manual SMTP to configure), so the
      // Sending step is redundant — finish here instead of showing step 3.
      onClose();
      return;
    } catch (err) {
      // User-initiated cancel (hit Back / closed the modal mid-flow) — not an
      // error, so don't flash a red banner. The finally still clears `loading`
      // so the button is immediately clickable again.
      const msg = (err as Error).message || '';
      if (/cancel/i.test(msg)) return;
      // Unconfigured providers can't reach here (their button is disabled), so any
      // failure is a genuine sign-in error — surface it verbatim.
      setError(msg || `${selectedPreset?.name ?? 'OAuth'} sign-in failed`);
    } finally {
      setLoading(false);
    }
  };

  const handleImapConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    // Already connected (user stepped back then forward) — just advance.
    if (didAddAccount) {
      setStep(3);
      return;
    }
    setError('');
    setLoading(true);
    try {
      await addAccount({
        host: host.trim(),
        port: parseInt(port, 10),
        username: (username.trim() || email.trim()),
        password: password.replace(/\s+/g, ''),
        secure: security === 'ssl',
        security, // persist the exact choice (ssl / starttls / none), not just the boolean
        allowInsecureTLS: allowInsecure || undefined,
      });
      setDidAddAccount(true);
      setStep(3);
    } catch (err) {
      setError((err as Error).message || 'Could not connect. Check the details and try again.');
    } finally {
      setLoading(false);
    }
  };

  const onSecurityChange = (v: ConnectionSecurity) => {
    setSecurity(v);
    setPort(String(defaultPort('imap', v)));
  };

  const inputCls = 'w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {/* Header + step indicator */}
        <div className="flex items-center gap-3 mb-1">
          <div className="p-2 bg-primary/10 rounded-lg">
            {step === 3 ? <Send className="h-5 w-5 text-primary" /> : <Mail className="h-5 w-5 text-primary" />}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold">Add account</h2>
            <p className="text-sm text-muted-foreground truncate">
              {step === 1 && 'Which mailbox do you want to add?'}
              {step === 2 && 'Connect for receiving (IMAP)'}
              {step === 3 && 'Set up sending (SMTP) — optional'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <Stepper step={step} className="my-4" />

        {/* Step 1 — Provider. OAuth providers (Sarv/Gmail/Outlook/Yahoo) sign in
            directly — the address comes from the token, so we never ask for an
            email or password. Only "Other" (or the app-password fallback) reveals
            the email input and continues to the IMAP + SMTP steps. */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">Provider</label>
              <div className="flex flex-wrap gap-2">
                {ORDERED_PROVIDERS.map((p) => (
                  <ProviderPill key={p.id} label={p.name} active={providerId === p.id} onClick={() => applyPreset(p)} />
                ))}
                <ProviderPill label="Other" active={providerId === null} onClick={() => applyPreset(null)} />
              </div>
            </div>

            {showOAuth ? (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handleOAuthConnect}
                  disabled={loading || oauthComingSoon}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  Sign in with {oauthProviders[oauthProviderId!]?.label ?? selectedPreset?.name}
                </button>
                <p className="text-center text-xs text-muted-foreground">
                  {oauthComingSoon
                    ? `Sign in with ${selectedPreset?.name} — coming soon.`
                    : `We'll use the email from your ${selectedPreset?.name} sign-in — no password needed.`}
                </p>
                {error && <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">{error}</div>}
                <div className="flex items-center justify-end pt-1">
                  <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50">Cancel</button>
                </div>
              </div>
            ) : (
              <form onSubmit={goToImap} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Email address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoFocus
                    className={inputCls}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Also used as your login username and sending address.</p>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted/50">Cancel</button>
                  <button type="submit" disabled={!email.trim()} className="px-4 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50">Next</button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Step 2 — Incoming (IMAP). Manual path only ("Other" or the
            app-password fallback); OAuth providers connect from step 1. */}
        {step === 2 && (
          <div className="space-y-4">
              <form onSubmit={handleImapConnect} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Email / Username</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="you@example.com"
                    required
                    className={inputCls}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Login for your mail server — defaults to your email; change it if your login differs.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className={`${inputCls} pr-10`}
                    />
                    <Tooltip content={showPassword ? 'Hide password' : 'Show password'} delayMs={40} className="absolute inset-y-0 right-0 flex items-center">
                      <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="flex items-center h-full px-3 text-muted-foreground hover:text-foreground">
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </Tooltip>
                  </div>
                  {selectedPreset?.id === 'gmail' && (
                    <p className="mt-1 text-xs text-muted-foreground">For Gmail, use an App Password (not your regular password).</p>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1">IMAP server</label>
                    <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="imap.sarv.com" required className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Port</label>
                    <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="993" required className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Connection security</label>
                  <select value={security} onChange={(e) => onSecurityChange(e.target.value as ConnectionSecurity)} className={inputCls}>
                    <option value="ssl">SSL/TLS (implicit, port 993)</option>
                    <option value="starttls">STARTTLS (port 143)</option>
                    <option value="none">None (not recommended)</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={allowInsecure} onChange={(e) => setAllowInsecure(e.target.checked)} className="w-4 h-4 rounded" />
                  Allow self-signed / invalid certificates
                </label>
                {error && <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">{error}</div>}
                <div className="flex items-center gap-3 pt-1">
                  <button type="button" onClick={() => setStep(1)} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md">Back</button>
                  <button
                    type="submit"
                    disabled={loading || (!didAddAccount && (!username || !host || !password))}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 font-medium"
                  >
                    {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</> : didAddAccount ? 'Continue' : 'Verify & Continue'}
                  </button>
                </div>
              </form>
          </div>
        )}

        {/* Step 3 — Sending (SMTP), optional */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-md text-sm">
              <Check className="h-4 w-4 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span className="text-emerald-800 dark:text-emerald-300">
                <span className="font-medium">{email || 'Your account'}</span> is connected for receiving. Add sending (SMTP) now, or skip and set it up later.
              </span>
            </div>
            <SmtpConfigForm onVerified={onClose} onBack={() => setStep(2)} submitLabel="Verify & Enable Sending" />
            <button type="button" onClick={onClose} className="w-full text-sm text-muted-foreground hover:text-foreground py-1">
              Skip for now — I'll set up sending later
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-primary/50 text-muted-foreground'
      }`}
    >
      {label}
    </button>
  );
}

function Stepper({ step, className }: { step: 1 | 2 | 3; className?: string }) {
  const labels = ['Provider', 'IMAP (Incoming)', 'SMTP (Sending)'];
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ''}`}>
      {labels.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = step > n;
        const current = step === n;
        return (
          <div key={label} className="flex items-center gap-1.5 flex-1">
            <span
              className={`h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold ${
                current ? 'bg-primary text-primary-foreground' : done ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
              }`}
            >
              {done ? <Check className="h-3 w-3" /> : n}
            </span>
            <span className={`text-xs whitespace-nowrap ${current ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{label}</span>
            {i < labels.length - 1 && <span className="flex-1 h-px bg-border" />}
          </div>
        );
      })}
    </div>
  );
}
