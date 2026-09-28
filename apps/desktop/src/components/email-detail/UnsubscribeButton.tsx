import { canUnsubscribe, parseUnsubscribe, preferredRoute, type UnsubscribeRoute } from '@sarvinbox/core/unsubscribe';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';

import { requestConfirm } from '../../store/confirm-service';
import { Tooltip } from '../Tooltip';

interface UnsubscribeButtonProps {
  emailId: string;
  /** Owning account, so main reads the message from ITS database (All Inboxes). */
  accountId?: string;
  /** `emails.list_unsubscribe`, verbatim. */
  listUnsubscribe?: string | null;
  /** `emails.list_unsubscribe_post`, verbatim (RFC 8058). */
  listUnsubscribePost?: string | null;
  /** Suppress it entirely — set on mail assessed as dangerous, where a click
   *  would only confirm to a phisher that this address is read. */
  hidden?: boolean;
  /** Lead with a `·` — set when it follows the sender address on one line. */
  separated?: boolean;
}

/** The tooltip: what this sender's route will do, before the reader commits. */
const ROUTE_HINT: Record<UnsubscribeRoute, string> = {
  'one-click': 'One click and this sender stops emailing you.',
  page: 'Their unsubscribe page opens in your browser.',
  mailto: 'They take unsubscribes by email.',
};

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
 * The way off a mailing list, as a small labelled button on the sender line of
 * any message whose sender published one (`List-Unsubscribe`). A text label,
 * not an icon: there is no glyph people read as "unsubscribe", and a control
 * people go looking for must be findable without hovering. It sits in the
 * header rather than a banner above the body so newsletters — a large share of
 * mail — don't lose a slab of height to an option, and so banners stay
 * reserved for warnings.
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
export function UnsubscribeButton({ emailId, accountId, listUnsubscribe, listUnsubscribePost, hidden, separated }: UnsubscribeButtonProps) {
  const target = useMemo(
    () => parseUnsubscribe(listUnsubscribe, listUnsubscribePost),
    [listUnsubscribe, listUnsubscribePost],
  );
  const route = preferredRoute(target);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (hidden || !canUnsubscribe(target) || !route) return null;

  const run = async (event: MouseEvent) => {
    // The sender line toggles the message open/closed; this click is not that.
    event.stopPropagation();
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

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs">
      {separated && <span aria-hidden>·</span>}
      {done ? (
        // The button is gone once the request has landed, so an impatient
        // second click cannot fire a second POST.
        <span role="status" className="inline-flex items-center gap-1 text-muted-foreground">
          <Check className="h-3.5 w-3.5" /> {done}
        </span>
      ) : (
        <>
          <Tooltip content={ROUTE_HINT[route]} delayMs={40}>
            <button
              type="button"
              onClick={run}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-foreground hover:bg-muted/60 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Unsubscribe
              {route === 'page' && <ExternalLink className="h-3 w-3" aria-label="Opens in your browser" />}
            </button>
          </Tooltip>
          {error && <span role="alert" className="text-red-600 dark:text-red-400">{error}</span>}
        </>
      )}
    </span>
  );
}
