import { AlertTriangle, LogIn, Settings, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useOAuthSignIn } from '../hooks/useOAuthSignIn';
import { useReauthSessions } from '../hooks/useReauthSessions';
import { describeReauthSessions } from '../utils/reauth-sessions';

import { BannerBar } from './BannerBar';

/**
 * Non-blocking banner for an OAuth account whose token could not be refreshed.
 *
 * Until this existed the only signal was a native OS notification, which is a
 * moment rather than a state: suppressed by Focus mode, absent on a Linux box
 * with no notification daemon, or simply missed while the app was in the
 * background. Mail then quietly stopped arriving with nothing on screen saying
 * why — the failure mode this whole path exists to prevent.
 *
 * Distinct from `ReauthBanner`, which covers an IMAP PASSWORD being rejected;
 * that one asks for a password in a dialog, this one hands the user back to the
 * provider's sign-in. Same shell, different remedy.
 *
 * The local mailbox stays fully readable throughout — the account simply stops
 * receiving new mail until the user signs in, on their own time.
 */
export function OAuthSessionBanner({ onFix }: { onFix: () => void }) {
  const sessions = useReauthSessions();
  const { pending, start, cancel } = useOAuthSignIn();
  const [dismissed, setDismissed] = useState(false);

  // A NEWLY broken account is new information, so an earlier dismissal must not
  // hide it. Keyed on the count rather than a timestamp so re-showing happens
  // when the set actually grows, not on every re-render.
  const [dismissedAt, setDismissedAt] = useState(0);
  useEffect(() => {
    if (sessions.length > dismissedAt) setDismissed(false);
  }, [sessions.length, dismissedAt]);

  const handleSignIn = async () => {
    const target = sessions[0];
    if (!target) return;
    // A failed or cancelled flow deliberately leaves the banner up: the account
    // still cannot sync, so hiding the only prompt would be worse. Success is
    // not handled here either — the main process broadcasts "resolved", which
    // is what removes the row. The banner never guesses at the outcome.
    await start(target.provider);
  };

  if (sessions.length === 0 || dismissed) return null;

  return (
    <BannerBar
      tone="danger"
      icon={<AlertTriangle className="h-4 w-4" />}
      dismissTitle="Dismiss (the account stays unsynced until you sign in)"
      onDismiss={() => { setDismissed(true); setDismissedAt(sessions.length); }}
      actions={
        <>
          <button
            onClick={() => void handleSignIn()}
            aria-label="Sign in again"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-destructive/15 hover:bg-destructive/25 font-medium transition-colors flex-shrink-0"
          >
            <LogIn className="h-3.5 w-3.5" />
            {/* Never disabled: the sign-in tab may have been closed, which
                nothing reports, so clicking again must always start a fresh
                flow rather than leaving the user stuck on "Opening…". */}
            {pending ? 'Opening…' : 'Sign in'}
          </button>
          {pending && (
            <button
              onClick={cancel}
              aria-label="Cancel sign-in"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-destructive/15 font-medium transition-colors flex-shrink-0"
            >
              <XCircle className="h-3.5 w-3.5" />
              Cancel
            </button>
          )}
          <button
            onClick={onFix}
            aria-label="Account settings"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-destructive/15 font-medium transition-colors flex-shrink-0"
          >
            <Settings className="h-3.5 w-3.5" />
            Account settings
          </button>
        </>
      }
    >
      <span className="font-semibold">{describeReauthSessions(sessions)}</span>{' '}
      <span className="opacity-90">
        New mail won&apos;t sync until you sign in again. Your existing mail is still available.
      </span>
    </BannerBar>
  );
}
