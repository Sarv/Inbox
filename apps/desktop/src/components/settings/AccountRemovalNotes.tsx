/**
 * What removing an account does about its sign-in at the provider — said in
 * the remove dialog, per provider, so nobody believes access was revoked where
 * it cannot be (CASA audit I-6), and a notice for when a revocation did not go
 * through.
 *
 * Google and Sarv let an app revoke its own access. Microsoft does not, so the
 * user is pointed at the pages where they can do it themselves. A password
 * account keeps nothing but the password.
 */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { openExternalLink } from '../../utils/open-external';
import { Tooltip } from '../Tooltip';

export const MICROSOFT_PERSONAL_CONSENT_URL = 'https://account.live.com/consent/Manage';
export const MICROSOFT_WORK_APPS_URL = 'https://myapps.microsoft.com';
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

const linkClass = 'font-medium text-primary underline underline-offset-2 hover:text-primary/80';

function ExternalLink({ url, label }: { url: string; label: string }) {
  return <button type="button" onClick={() => openExternalLink(url)} className={linkClass}>{label}</button>;
}

/**
 * The remove dialog's line about the account's sign-in. `oauthProvider` is
 * the account's provider id, or undefined for a password account. `powersAI`:
 * an AI provider runs on this same sign-in, so it stops with the account.
 */
export function RemovalAccessNote({ oauthProvider, powersAI }: { oauthProvider?: string | null; powersAI?: boolean }) {
  let note: ReactNode;
  switch (oauthProvider) {
    case 'gmail':
      note = 'Sarv Inbox also revokes its access to this Google account.';
      break;
    case 'microsoft':
      note = (
        <>
          Microsoft doesn&apos;t let apps revoke their own access. After removing, also remove Sarv Inbox at{' '}
          <ExternalLink url={MICROSOFT_PERSONAL_CONSENT_URL} label="account.live.com/consent/Manage" /> (personal account) or{' '}
          <ExternalLink url={MICROSOFT_WORK_APPS_URL} label="myapps.microsoft.com" /> (work or school account).
        </>
      );
      break;
    case 'sarv':
      note = 'Sarv Inbox also ends this sign-in at Sarv and deletes its tokens from this device.';
      break;
    case undefined:
    case null:
    case '':
      note = 'Its saved password is deleted from this device.';
      break;
    default:
      // A provider with no revocation endpoint (Yahoo, or one added later).
      note = 'Its sign-in tokens are deleted from this device.';
  }
  return (
    <p data-testid="removal-access-note" className="text-sm text-muted-foreground mb-5">
      {note}
      {powersAI && ' Your AI provider uses this sign-in, so it stops too. If it is your only one, AI sorting and reply drafts stop until you connect another.'}
    </p>
  );
}

/** Whether a failed revocation at this provider leaves the user something to know. */
export function revokeFailureWorthNoticing(provider: string | null | undefined): provider is 'gmail' | 'sarv' {
  return provider === 'gmail' || provider === 'sarv';
}

/** Shown after an account was removed but its provider did not confirm the revocation. */
export function RevokeFailedNotice({ email, provider, onDismiss }: { email: string; provider: 'gmail' | 'sarv'; onDismiss: () => void }) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
      {provider === 'gmail' ? (
        <p className="flex-1">
          <span className="font-medium">{email}</span> was removed, but Sarv Inbox couldn&apos;t revoke its access at Google.
          Remove it yourself at <ExternalLink url={GOOGLE_PERMISSIONS_URL} label="myaccount.google.com/permissions" />.
        </p>
      ) : (
        <p className="flex-1">
          <span className="font-medium">{email}</span> was removed and its sign-in deleted from this device, but Sarv Inbox
          couldn&apos;t confirm that Sarv ended it. Nothing here can use it any more, and it expires on its own at Sarv.
          For help, write to support@sarv.com.
        </p>
      )}
      <Tooltip content="Dismiss" delayMs={40}>
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="p-1 rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
