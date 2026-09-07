import type { SMTPConfig } from '@sarvinbox/core';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { useEmailStore } from '../store/email-store';
import { deriveSmtpFromImap, accountIdFor } from '../store/helpers';

import { VaultPasswordField } from './VaultPasswordField';

interface SmtpConfigFormProps {
  /** Called after SMTP is verified + marked configured. */
  onVerified: () => void;
  onBack?: () => void;
  submitLabel?: string;
}

/**
 * Collect + VERIFY SMTP (sending) settings. Prefilled from the saved SMTP config
 * or best-effort-derived from IMAP, but always editable — the derived guess is
 * often wrong (host/port/TLS vary per provider). connectSmtp runs the server's
 * verify() step; only on success is the account marked send-ready.
 */
export function SmtpConfigForm({ onVerified, onBack, submitLabel = 'Verify & Continue' }: SmtpConfigFormProps) {
  const imapConfig = useEmailStore((s) => s.imapConfig);
  const smtpConfig = useEmailStore((s) => s.smtpConfig);
  const connectSmtp = useEmailStore((s) => s.connectSmtp);
  const markSmtpConfigured = useEmailStore((s) => s.markSmtpConfigured);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  // The vault key connectSmtp writes under: the active account id, or — when it's
  // null (legacy / single-account) — the id DERIVED from the IMAP login. The
  // field must read the secret under the SAME id, otherwise it looks under `null`
  // and reports "no saved password" even though one is stored (that's why the eye
  // showed only "Show password", never the Touch-ID reveal).
  const vaultAccountId = activeAccountId
    ?? (imapConfig ? accountIdFor(imapConfig.username, imapConfig.host) : null);

  const initial = smtpConfig ?? (imapConfig ? deriveSmtpFromImap(imapConfig) : null);
  const isOAuth = imapConfig?.authMethod === 'oauth2' || smtpConfig?.authMethod === 'oauth2';

  // Default the SMTP login to the account email (from IMAP); editable so a
  // different SMTP username can be used. The "from" address IS this email —
  // no separate From field.
  const accountEmail = imapConfig?.username ?? initial?.from ?? initial?.username ?? '';

  const [host, setHost] = useState(initial?.host ?? '');
  const [security, setSecurity] = useState<'ssl' | 'starttls' | 'none'>(initial?.secure === false ? 'starttls' : 'ssl');
  const [port, setPort] = useState(String(initial?.port ?? 465));
  const [allowInsecure, setAllowInsecure] = useState<boolean>(!!initial?.allowInsecureTLS);
  const [username, setUsername] = useState(initial?.username ?? accountEmail);
  // The SMTP password lives in the vault; the field starts empty and is revealed
  // only on an explicit OS-authenticated request (VaultPasswordField handles the
  // masked display, keychain check, and Touch-ID reveal). Blank on submit =
  // "keep current" (connectSmtp rehydrates it from the vault).
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const onSecurityChange = (value: 'ssl' | 'starttls' | 'none') => {
    setSecurity(value);
    setPort(value === 'ssl' ? '465' : value === 'starttls' ? '587' : '25');
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const config: SMTPConfig = {
        host: host.trim(),
        port: parseInt(port, 10) || (security === 'ssl' ? 465 : security === 'starttls' ? 587 : 25),
        secure: security === 'ssl',
        username: username.trim(),
        password: isOAuth ? '' : password.replace(/\s+/g, ''),
        // From = the account email; the SMTP login username may differ.
        from: accountEmail || username.trim(),
        authMethod: imapConfig?.authMethod,
        oauthProvider: imapConfig?.oauthProvider,
        allowInsecureTLS: allowInsecure || undefined,
      };
      await connectSmtp(config); // verifies via nodemailer transporter.verify()
      markSmtpConfigured(true);
      onVerified();
    } catch (err) {
      setError((err as Error).message || 'Could not connect to the SMTP server. Check host, port, and credentials.');
    } finally {
      setLoading(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring';

  return (
    <form onSubmit={handleVerify} className="space-y-4">
      {!isOAuth && (
        <>
          <div>
            <label className="block text-sm font-medium mb-1">Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="user@example.com" required className={inputCls} />
          </div>
          <VaultPasswordField
            accountId={vaultAccountId}
            kind="smtp"
            value={password}
            onChange={setPassword}
            firstTimeHint="Your SMTP (sending) password can be different from your IMAP password."
          />
        </>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-sm font-medium mb-1">SMTP server</label>
          <input type="text" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.sarv.com" required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Port</label>
          <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="465" required className={inputCls} />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Connection security</label>
        <select
          value={security}
          onChange={(e) => onSecurityChange(e.target.value as 'ssl' | 'starttls' | 'none')}
          className={inputCls}
        >
          <option value="ssl">SSL/TLS (implicit, port 465)</option>
          <option value="starttls">STARTTLS (port 587)</option>
          <option value="none">None (not recommended)</option>
        </select>
      </div>

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={allowInsecure}
          onChange={(e) => setAllowInsecure(e.target.checked)}
          className="w-4 h-4 rounded"
        />
        Allow self-signed / invalid certificates (only if you trust this server)
      </label>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        {onBack && (
          <button type="button" onClick={onBack} className="px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors">
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={loading || !host || (!isOAuth && (!username || !password))}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> Verifying…</>) : submitLabel}
        </button>
      </div>
    </form>
  );
}
