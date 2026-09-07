import { Loader2, Mail, X } from 'lucide-react';
import { useState } from 'react';

import { useEmailStore } from '../store/email-store';

import { VaultPasswordField } from './VaultPasswordField';

// `onClose` makes this a dismissible, on-demand re-auth dialog (opened from the
// non-blocking ReauthBanner) rather than a full-screen gate. When omitted it
// behaves as before (no close affordance).
export function ConnectionDialog({ onClose }: { onClose?: () => void } = {}) {
  const { connect, imapConfig, accounts, activeAccountId } = useEmailStore();
  const activeEmail = accounts.find((a) => a.id === activeAccountId)?.email;

  // Prefill from the failing account so the user only re-enters the password —
  // not the host/username (and never Gmail defaults for a Sarv account).
  const [host, setHost] = useState((imapConfig as any)?.host || 'imap.gmail.com');
  const [port, setPort] = useState(String((imapConfig as any)?.port || 993));
  const [username, setUsername] = useState((imapConfig as any)?.username || activeEmail || '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Remove all spaces from password (Google App Passwords have spaces for readability)
      const cleanPassword = password.replace(/\s+/g, '');

      await connect({
        host,
        port: parseInt(port),
        username,
        password: cleanPassword,
        secure: true,
      });
      onClose?.(); // reconnected — close the on-demand dialog
    } catch (err) {
      setError((err as Error).message || 'Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg shadow-lg w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Mail className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-semibold">Reconnect account</h2>
            <p className="text-sm text-muted-foreground truncate">
              {activeEmail ? `Re-enter the password for ${activeEmail}` : 'Enter your email account details'}
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email / Username */}
          <div>
            <label className="block text-sm font-medium mb-1">
              Email / Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="user@example.com"
              required
              className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Password — vault-backed: masked, Touch-ID reveal, blank = keep current */}
          <VaultPasswordField
            accountId={activeAccountId}
            kind="imap"
            value={password}
            onChange={setPassword}
            firstTimeHint="For Gmail, use an App Password (not your regular password)."
          />

          {/* IMAP Server */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1">
                IMAP Server
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="imap.gmail.com"
                required
                className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Port
              </label>
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

          {/* Error */}
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </button>

          {/* Help */}
          <div className="mt-4 p-3 bg-muted/50 rounded-md text-xs text-muted-foreground">
            <strong>Common IMAP Servers:</strong>
            <ul className="mt-2 space-y-1">
              <li>Gmail: imap.gmail.com:993</li>
              <li>Outlook: outlook.office365.com:993</li>
              <li>Yahoo: imap.mail.yahoo.com:993</li>
            </ul>
          </div>
        </form>
      </div>
    </div>
  );
}
