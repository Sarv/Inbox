import { Eye, EyeOff, Loader2, Mail } from 'lucide-react';
import { useEffect, useState } from 'react';

import { EMAIL_PROVIDERS } from '../../config/email-providers';
import { useEmailStore } from '../../store/email-store';
import { Tooltip } from '../Tooltip';

interface IMAPStepProps {
  onNext: () => void;
  onBack: () => void;
  onSyncStarted: () => void;
}

type OAuthProviderId = 'gmail' | 'microsoft' | 'yahoo';
// Sarv (llm-purpose) does not participate in IMAP onboarding.

// Quick-fill pills derived from the shared provider presets (one source of
// truth — see config/email-providers.ts).
const PROVIDER_HINTS = EMAIL_PROVIDERS.map((p) => ({ name: p.name, host: p.imapHost, port: String(p.imapPort) }));

export function IMAPStep({ onNext, onBack, onSyncStarted }: IMAPStepProps) {
  const { connect } = useEmailStore();

  const [host, setHost] = useState('imap.sarv.com');
  const [port, setPort] = useState('9993');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [security, setSecurity] = useState<'ssl' | 'starttls' | 'none'>('ssl');
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<
    Array<{ id: OAuthProviderId; label: string; configured: boolean }>
  >([]);
  const [oauthLoading, setOauthLoading] = useState<OAuthProviderId | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.electronAPI.oauth.listProviders();
        if (res.success && res.data) {
          setOauthProviders(
            res.data
              .filter((p) => p.purpose === 'email' || p.purpose === 'both')
              .map((p) => ({ id: p.id as OAuthProviderId, label: p.label, configured: p.configured })),
          );
        }
      } catch {
        // no-op — manual flow still works
      }
    })();
  }, []);

  const handleOAuthSignIn = async (providerId: OAuthProviderId) => {
    setError('');
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
      await connect({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        username: email,
        password: '',
        authMethod: 'oauth2',
        oauthProvider: providerId,
      } as any);
      onSyncStarted();
      onNext();
    } catch (err) {
      setError((err as Error).message || 'OAuth sign-in failed');
    } finally {
      setOauthLoading(null);
    }
  };

  const handleProviderHint = (hint: typeof PROVIDER_HINTS[0]) => {
    setHost(hint.host);
    setPort(hint.port);
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const cleanPassword = password.replace(/\s+/g, '');
      await connect({
        host,
        port: parseInt(port),
        username,
        password: cleanPassword,
        secure: security === 'ssl',
        allowInsecureTLS: allowInsecure || undefined,
      });

      onSyncStarted();
      onNext();
    } catch (err) {
      setError((err as Error).message || 'Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  const anyOAuthConfigured = oauthProviders.some((p) => p.configured);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Mail className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">Connect Your Email</h2>
          <p className="text-sm text-muted-foreground">We'll start syncing while you learn shortcuts</p>
        </div>
      </div>

      {/* OAuth sign-in (when any provider is configured) */}
      {anyOAuthConfigured && (
        <div className="space-y-2 mb-4">
          {oauthProviders.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleOAuthSignIn(p.id)}
              disabled={!p.configured || oauthLoading !== null || loading}
              title={p.configured ? '' : 'Not configured — see OAUTH_SETUP.md'}
              className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md border text-sm font-medium transition-all ${
                p.configured
                  ? 'border-input bg-background text-foreground shadow-sm hover:bg-primary/5 hover:border-primary/50 hover:shadow active:scale-[0.99] disabled:opacity-60 disabled:cursor-wait'
                  : 'border-dashed border-border bg-muted/40 text-muted-foreground cursor-not-allowed'
              }`}
            >
              {oauthLoading === p.id ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <Mail className={`h-4 w-4 ${p.configured ? 'text-primary' : 'text-muted-foreground/50'}`} />
              )}
              <span>Sign in with {p.label}</span>
              {!p.configured && (
                <span className="ml-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                  not configured
                </span>
              )}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className="w-full text-xs text-muted-foreground hover:text-foreground py-2"
          >
            {showManual ? 'Hide' : 'Or connect via'} IMAP / app-password
          </button>
        </div>
      )}

      {/* OAuth-level errors (visible when form is collapsed) */}
      {!showManual && error && anyOAuthConfigured && (
        <div className="p-3 mb-4 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Manual IMAP form — always shown if no OAuth provider configured */}
      {(showManual || !anyOAuthConfigured) && (
        <>
          {/* Quick provider select */}
          <div className="flex gap-2 mb-5">
            {PROVIDER_HINTS.map((hint) => (
              <button
                key={hint.name}
                type="button"
                onClick={() => handleProviderHint(hint)}
                className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                  host === hint.host
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border hover:border-primary/50 text-muted-foreground'
                }`}
              >
                {hint.name}
              </button>
            ))}
          </div>

          <form onSubmit={handleConnect} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Email address</label>
              <input
                type="email"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">Also used as your sending address and login username.</p>
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
                  className="w-full px-3 py-2 pr-10 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Tooltip
                  content={showPassword ? 'Hide password' : 'Show password'}
                  delayMs={40}
                  className="absolute inset-y-0 right-0 flex items-center"
                >
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="flex items-center h-full px-3 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </Tooltip>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                For Gmail, use an App Password (not your regular password)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">IMAP Server</label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="imap.sarv.com"
                  required
                  className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Port</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="993"
                  required
                  className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Connection security</label>
              <select
                value={security}
                onChange={(e) => {
                  const v = e.target.value as 'ssl' | 'starttls' | 'none';
                  setSecurity(v);
                  setPort(v === 'ssl' ? '993' : '143');
                }}
                className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="ssl">SSL/TLS (implicit, port 993)</option>
                <option value="starttls">STARTTLS (port 143)</option>
                <option value="none">None (not recommended)</option>
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={allowInsecure} onChange={(e) => setAllowInsecure(e.target.checked)} className="w-4 h-4 rounded" />
              Allow self-signed / invalid certificates (only if you trust this server)
            </label>

            {error && (
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={onBack}
                className="px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading || !username || !password}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  'Connect & Continue'
                )}
              </button>
            </div>
          </form>
        </>
      )}

      {/* Back button when form is hidden (OAuth-only view) */}
      {anyOAuthConfigured && !showManual && (
        <div className="flex items-center gap-3 pt-4">
          <button
            type="button"
            onClick={onBack}
            className="px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}
