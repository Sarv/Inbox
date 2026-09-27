import { canUnsubscribe, parseUnsubscribe, preferredRoute, type UnsubscribeRoute } from '@sarvinbox/core/unsubscribe';
import { Check, ExternalLink, Loader2, MailX } from 'lucide-react';
import { useMemo, useState } from 'react';

import { requestConfirm } from '../../store/confirm-service';

interface UnsubscribeBannerProps {
  emailId: string;
  /** Owning account, so main reads the message from ITS database (All Inboxes). */
  accountId?: string;
  /** `emails.list_unsubscribe`, verbatim. */
  listUnsubscribe?: string | null;
  /** `emails.list_unsubscribe_post`, verbatim (RFC 8058). */
  listUnsubscribePost?: string | null;
}

/** What the reader is told BEFORE anything leaves the machine, per route. */
const CONFIRMATION: Record<UnsubscribeRoute, { message: string; confirmLabel: string }> = {
  'one-click': {
    message:
      'Tell this sender to stop emailing you? The request goes straight to them — no page opens, and it tells them this address is read.',
    confirmLabel: 'Unsubscribe',
  },
  page: {
    message:
      "This sender handles unsubscribes on their own web page, so it opens in your browser. You may have to confirm there before it takes effect.",
    confirmLabel: 'Open the page',
  },
  mailto: {
    message:
      'This sender takes unsubscribes by email, so a short message is sent from this account. It can take a few days to take effect.',
    confirmLabel: 'Send it',
  },
};

/**
 * The way off a mailing list, shown above the body of any message whose sender
 * published one (`List-Unsubscribe`).
 *
 * The button names a ROUTE, never a URL: the main process re-reads this
 * message's own headers and resolves the route there, so nothing a crafted
 * message contains can become the address this app posts to. See
 * `unsubscribe-handlers`.
 *
 * Every route is confirmed first, and the confirmation says what that
 * particular one costs — a one-click POST confirms the address is read, a page
 * leaves the app, a mailto sends mail from the reader's own account. Renders
 * nothing when the sender offered no route at all, which is most mail.
 */
export function UnsubscribeBanner({ emailId, accountId, listUnsubscribe, listUnsubscribePost }: UnsubscribeBannerProps) {
  const target = useMemo(
    () => parseUnsubscribe(listUnsubscribe, listUnsubscribePost),
    [listUnsubscribe, listUnsubscribePost],
  );
  const route = preferredRoute(target);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canUnsubscribe(target) || !route) return null;

  const run = async () => {
    const { message, confirmLabel } = CONFIRMATION[route];
    // Not destructive — nothing of the reader's is deleted, so the primary
    // button is the ordinary one rather than the red one.
    if (!(await requestConfirm({ title: 'Unsubscribe', message, confirmLabel, destructive: false }))) return;

    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.unsubscribe.run(emailId, route, accountId);
      if (!result?.success) {
        setError(result?.error || 'The unsubscribe request failed');
        return;
      }
      // A browser route is NOT "unsubscribed" — the reader still has a form to
      // submit. Saying otherwise is the one failure mode that leaves them
      // believing they have left a list they are still on.
      setDone(
        result.needsBrowser
          ? 'Finish unsubscribing in your browser.'
          : route === 'mailto'
            ? 'Unsubscribe message sent. It can take a few days.'
            : 'Unsubscribed. It can take a couple of days to stop.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const Icon = route === 'page' ? ExternalLink : MailX;

  return (
    <div className="mb-4 rounded-lg border border-border bg-muted/40 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {done ? 'Unsubscribe requested' : "You\u2019re on this sender\u2019s mailing list"}
          </div>
          <div className="text-xs text-muted-foreground break-words">
            {error ??
              done ??
              (route === 'page'
                ? "Their unsubscribe page opens in your browser."
                : route === 'mailto'
                  ? 'They take unsubscribes by email.'
                  : 'One click and this sender stops emailing you.')}
          </div>
        </div>
        {done ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5" /> Done
          </span>
        ) : (
          <button
            onClick={run}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/60 disabled:opacity-50 transition-colors"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
            {route === 'page' ? 'Unsubscribe in browser' : 'Unsubscribe'}
          </button>
        )}
      </div>
    </div>
  );
}
