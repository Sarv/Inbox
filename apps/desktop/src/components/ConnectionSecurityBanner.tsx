import { Settings, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useEmailStore } from '../store/email-store';

import { BannerBar } from './BannerBar';

/**
 * Non-blocking banner shown when the ACTIVE account's mail server would not
 * encrypt a STARTTLS session (CASA M-5) — the incoming (IMAP) server, the
 * sending (SMTP) server, or both. Sarv Inbox stopped before sending the
 * password, so this is not a sign-in problem: the remedy is the account's
 * Connection security — or a different network, if someone on this one is
 * stripping encryption. The local mailbox stays readable meanwhile, and
 * outgoing mail waits in the Outbox.
 *
 * "Account settings" deep-links to Settings → Accounts, where the security can
 * be changed.
 */
export function ConnectionSecurityBanner({ onFix }: { onFix: () => void }) {
  const issue = useEmailStore((s) => s.connectionSecurityIssue);
  const smtpIssue = useEmailStore((s) => s.smtpSecurityIssue);
  const connected = useEmailStore((s) => s.connected);
  const [dismissed, setDismissed] = useState(false);

  // The incoming refusal only describes the account while it is not connected.
  const incoming = issue && !connected ? issue : null;

  // A new refusal (or a cleared one) shows the banner again next time.
  useEffect(() => { setDismissed(false); }, [incoming, smtpIssue]);

  if ((!incoming && !smtpIssue) || dismissed) return null;

  return (
    <BannerBar
      tone="danger"
      icon={<ShieldAlert className="h-4 w-4" />}
      dismissTitle={incoming
        ? 'Dismiss (account stays unsynced until it can connect securely)'
        : 'Dismiss (mail stays in the Outbox until it can be sent securely)'}
      onDismiss={() => setDismissed(true)}
      actions={
        <button
          onClick={onFix}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-destructive/15 font-medium transition-colors flex-shrink-0"
        >
          <Settings className="h-3.5 w-3.5" />
          Account settings
        </button>
      }
    >
      {incoming ? (
        <>
          <span className="font-semibold">Not connected: the mail server would not use encryption.</span>{' '}
          <span className="opacity-90">{incoming} Your existing mail is still available.</span>
          {smtpIssue && <span className="opacity-90"> Sending is refused the same way.</span>}
        </>
      ) : (
        <>
          <span className="font-semibold">Can&apos;t send: the outgoing mail server would not use encryption.</span>{' '}
          <span className="opacity-90">{smtpIssue} Your messages wait in the Outbox until it can.</span>
        </>
      )}
    </BannerBar>
  );
}
