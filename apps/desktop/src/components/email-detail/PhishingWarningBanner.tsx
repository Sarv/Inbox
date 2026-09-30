import type { LinkMismatch } from '@sarv-in/mailguard/links';
import { authenticationFailed } from '@sarv-in/mailguard/verdict';
import { ShieldAlert, ShieldX, Check, Ban, UserCheck, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { LEVEL_RANK, parseAuthStatus } from '../../utils/email-security';
import { addLinkRule } from '../../utils/security-rules';
import { trustSender } from '../../utils/trusted-senders';
import { useEmailSecurity } from '../../utils/use-email-security';

interface PhishingWarningBannerProps {
  /** The message, for "Trust this sender". Without it the button is not offered. */
  emailId?: string;
  /** The message's account (pane-account.ts `messageAccountOf`): whose trusted
   *  senders the warning checks, and where "Trust this sender" is saved. */
  accountId?: string;
  /**
   * Clear THIS message once its sender is trusted, the way the view it is in
   * does "Not spam" (out of the Spam folder, or just un-flagged in place).
   * Without it the button is not offered.
   */
  onTrusted?: () => Promise<unknown> | void;
  fromName?: string | null;
  fromAddress?: string | null;
  /** Rendered HTML body — scanned for deceptive links (anchor text ≠ href). */
  html?: string | null;
  /** Stored SPF/DKIM/DMARC verdict JSON (emails.auth_status), when known. */
  authStatus?: string | null;
  /** Stored spam filter score / reasons (emails.spam_score, emails.spam_reasons). */
  spamScore?: number | null;
  spamReasons?: string | null;
  /** Outer spacing. Defaults to `mb-4` (banner above a body); a caller that
   *  renders it BELOW a body — the chat bubble, whose library gives no slot
   *  above one — passes its own margin instead. */
  className?: string;
}

/**
 * Warning shown on a message whose security level is `caution` or `danger` —
 * the SAME level the shield beside the sender shows, from the same
 * assessment, so the two can never disagree. Two tones:
 *   - danger (red)   — authentication FAILED, the display name impersonates
 *     another domain, or a link the user has blocked is present.
 *   - caution (amber) — a link goes somewhere other than it says, or the
 *     sender's policy declined to vouch for the sending server.
 * Renders nothing otherwise, so its presence stays meaningful.
 *
 * Each deceptive link carries two actions. "I trust this link" records the
 * (sender, shown → actual) pair so it stops being flagged — for THIS sender
 * only. "Block this link" records the opposite, so any future message from
 * this sender carrying it is marked dangerous. Both land in Security →
 * Trusted & blocked links, where they can be revoked.
 *
 * "Trust this sender" is offered when the warning is about WHO sent it — the
 * sender name or the spam score — and the message authenticated. It stores the
 * address (Security → Spam → Trusted senders), clears this message, and from
 * then on their authenticated mail is never filed. Never offered on a message
 * that failed authentication: that is where a forged copy of a trusted address
 * would be, and one click must not wave it through.
 */
export function PhishingWarningBanner({
  emailId,
  accountId,
  onTrusted,
  fromName,
  fromAddress,
  html,
  className = 'mb-4',
  authStatus,
  spamScore,
  spamReasons,
}: PhishingWarningBannerProps) {
  const assessment = useEmailSecurity({ fromName, fromAddress, html, authStatus, spamScore, spamReasons, accountId });
  const [busy, setBusy] = useState<string | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);

  if (LEVEL_RANK[assessment.level] < LEVEL_RANK.caution) return null;

  const isDanger = assessment.level === 'danger';
  const Icon = isDanger ? ShieldX : ShieldAlert;
  // Only the checks that went wrong belong in a warning.
  const reasons = assessment.checks.filter((c) => c.status === 'fail' || c.status === 'warn');
  const canTrust =
    !!emailId && !!fromAddress && !!onTrusted && !assessment.trusted
    && !authenticationFailed(parseAuthStatus(authStatus ?? null))
    && reasons.some((r) => r.id === 'sender' || r.id === 'spam');

  const trust = async () => {
    setBusy('trust-sender');
    setTrustError(null);
    try {
      const res = await trustSender(fromAddress, accountId);
      if (!res.success) { setTrustError(res.error ?? 'Could not trust this sender'); return; }
      await onTrusted?.();
    } finally {
      setBusy(null);
    }
  };

  const decide = async (m: LinkMismatch, verdict: 'trust' | 'block') => {
    const id = `${m.shown}->${m.actual}:${verdict}`;
    setBusy(id);
    try {
      await addLinkRule({ senderDomain: assessment.senderDomain ?? '', shownDomain: m.shown, actualDomain: m.actual, verdict });
    } finally {
      setBusy(null);
    }
  };

  const shell = isDanger
    ? 'border-red-500/40 bg-red-500/[0.07] dark:bg-red-500/[0.10]'
    : 'border-amber-500/40 bg-amber-500/[0.07] dark:bg-amber-400/[0.10]';
  const iconWrap = isDanger
    ? 'bg-red-500/15 text-red-600 dark:text-red-400'
    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  const heading = isDanger ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300';

  const title = isDanger
    ? 'This message may not be from who it claims to be'
    : assessment.spam.verdict === 'spam' && !assessment.trusted
      ? 'The spam filter flagged this message'
      : 'Be careful with this message';

  return (
    <div className={`${className} rounded-lg border ${shell} overflow-hidden`} role="alert">
      <div className="flex items-start gap-3 p-3">
        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md ${iconWrap}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-semibold ${heading}`}>{title}</div>
          <ul className="mt-1 space-y-1">
            {reasons.map((r) => (
              <li key={r.id} className="text-xs text-muted-foreground break-words">
                <span className="font-medium text-foreground/80">{r.label}:</span> {r.detail}
              </li>
            ))}
          </ul>
          {assessment.untrustedLinks.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {assessment.untrustedLinks.map((m) => {
                const k = `${m.shown}->${m.actual}`;
                return (
                  <li key={k} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground/80">{m.shown}</span> → {m.actual}
                    </span>
                    <button
                      onClick={() => decide(m, 'trust')}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 hover:bg-muted/60 disabled:opacity-50 transition-colors"
                    >
                      <Check className="h-3 w-3" /> I trust this link
                    </button>
                    <button
                      onClick={() => decide(m, 'block')}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-background px-2 py-0.5 text-red-700 dark:text-red-300 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
                    >
                      <Ban className="h-3 w-3" /> Block this link
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {canTrust && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <button
                onClick={() => void trust()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 hover:bg-muted/60 disabled:opacity-50 transition-colors"
              >
                {busy === 'trust-sender' ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserCheck className="h-3 w-3" />}
                I trust this sender
              </button>
              <span className="text-muted-foreground">Their mail to you won&apos;t be marked as spam again.</span>
              {trustError && <span className="text-red-700 dark:text-red-300">{trustError}</span>}
            </div>
          )}
          <div className="mt-1.5 text-xs text-muted-foreground">
            Don&apos;t click links, open attachments, or share passwords or payment details unless you&apos;re sure the sender is genuine.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * What "I trust this sender" does to the message it was clicked on: the same
 * as the view's own Not spam. In the Spam folder that is the view's handler —
 * out of Spam, list updated. Anywhere else the message stays where it is and
 * only loses its spam verdict (it may carry the tag without having been filed).
 */
export function clearAfterTrust(
  ctx: { isInSpam: boolean; handleNotSpam: () => Promise<void> },
  emailId: string,
  accountId?: string,
): Promise<unknown> {
  if (ctx.isInSpam) return ctx.handleNotSpam();
  return window.electronAPI.spam.setUserVerdict(emailId, 'ham', accountId);
}
