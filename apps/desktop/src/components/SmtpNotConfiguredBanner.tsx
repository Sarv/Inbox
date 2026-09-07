import { AlertTriangle, Send } from 'lucide-react';

import { useEmailStore } from '../store/email-store';

/**
 * Sticky notice shown in compose / inline reply when the active account has no
 * verified SMTP (sending) config. Sending is NOT blocked — the message persists
 * to the Outbox and goes out once SMTP is set up. "Set up sending" opens the
 * dismissible SmtpSetup modal via a CustomEvent (see SmtpSetup.tsx), avoiding
 * prop-drilling through the compose trees. Returns null once SMTP is configured.
 */
export function SmtpNotConfiguredBanner() {
  const smtpConfigured = useEmailStore((s) => s.smtpConfigured);
  if (smtpConfigured) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="flex-1 min-w-0">
        <span className="font-semibold">Sending (SMTP) isn't set up.</span>{' '}
        <span className="opacity-90">This message will be saved to your Outbox and delivered once you add SMTP.</span>
      </span>
      <button
        type="button"
        onClick={() => document.dispatchEvent(new CustomEvent('sarvinbox:open-smtp-setup'))}
        className="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 font-medium text-amber-900 dark:text-amber-200 transition-colors flex-shrink-0"
      >
        <Send className="h-3 w-3" />
        Set up sending
      </button>
    </div>
  );
}
