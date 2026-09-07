import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Tooltip } from './Tooltip';

interface VaultPasswordFieldProps {
  /** Owning account id — the vault key. When absent, treated as first-time. */
  accountId?: string | null;
  /** Which stored secret this field edits. */
  kind: 'imap' | 'smtp';
  value: string;
  onChange: (value: string) => void;
  label?: string;
  /** Hint shown ONLY for a first-time setup (no stored password). */
  firstTimeHint?: string;
  /** Override the required flag; defaults to "required only when nothing stored". */
  required?: boolean;
  inputClassName?: string;
  autoFocus?: boolean;
}

/**
 * Shared password field for IMAP/SMTP credentials, backed by the OS keychain.
 *
 * Intelligent per state:
 *  - Vault HAS a password  → shows masked dots, field is OPTIONAL ("leave blank
 *    to keep current"), and the eye reveals the plaintext ONLY after an OS-auth
 *    prompt (Touch ID) — so a casual snooper at an unlocked machine can't read it.
 *  - Vault has NOTHING     → a plain required field (first-time setup), no reveal.
 *
 * Existence is checked as a boolean (secureCreds.hasPassword) so the plaintext
 * never enters the renderer just to render the form; it's fetched only on an
 * explicit, authenticated reveal (secureCreds.reveal).
 */
export function VaultPasswordField({
  accountId,
  kind,
  value,
  onChange,
  label = 'Password',
  firstTimeHint,
  required,
  inputClassName,
  autoFocus,
}: VaultPasswordFieldProps) {
  const [hasStored, setHasStored] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!accountId) { setHasStored(false); return; }
      try {
        const res = await window.electronAPI.secureCreds.hasPassword?.(accountId, kind);
        if (!cancelled) setHasStored(!!res?.success && !!res.data);
      } catch { if (!cancelled) setHasStored(false); }
    })();
    return () => { cancelled = true; };
  }, [accountId, kind]);

  const isEditing = hasStored;
  const needsReveal = isEditing && !revealed && !value;

  // Eye: toggles visibility normally, but in edit mode BEFORE the password is
  // revealed it triggers an OS-auth prompt to fetch + show the stored password.
  const handleEye = async () => {
    if (needsReveal) {
      setMsg(null);
      try {
        const res = await window.electronAPI.secureCreds.reveal?.(accountId as string, kind);
        if (res?.success && res.data?.password) {
          onChange(res.data.password);
          setRevealed(true);
          setShow(true);
        } else if (res?.error === 'auth-cancelled') {
          setMsg('Authentication cancelled — password stays hidden.');
        } else if (res?.error === 'biometric-unavailable') {
          setMsg("Can't reveal here (no Touch ID on this device). Type a new password to change it.");
        } else if (res?.error === 'no-stored-password') {
          setHasStored(false);
        } else {
          setMsg('Could not reveal the saved password.');
        }
      } catch {
        setMsg('Could not reveal the saved password.');
      }
      return;
    }
    setShow((v) => !v);
  };

  const inputCls = inputClassName ?? 'w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring';
  const eyeHint = needsReveal ? 'Show saved password (Touch ID)' : (show ? 'Hide password' : 'Show password');

  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => { onChange(e.target.value); if (msg) setMsg(null); }}
          placeholder="••••••••"
          required={required ?? !hasStored}
          autoFocus={autoFocus}
          className={`${inputCls} pr-10`}
        />
        <Tooltip content={eyeHint} delayMs={40} className="absolute inset-y-0 right-0 flex items-center">
          <button
            type="button"
            onClick={handleEye}
            aria-label={needsReveal ? 'Show saved password (requires Touch ID)' : eyeHint}
            className="flex items-center h-full px-3 text-muted-foreground hover:text-foreground"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </Tooltip>
      </div>
      {(isEditing || firstTimeHint) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {isEditing
            ? 'Saved securely — click the eye to view it (asks for Touch ID), or leave blank to keep it. Change only what actually changed.'
            : firstTimeHint}
        </p>
      )}
      {msg && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{msg}</p>}
    </div>
  );
}
