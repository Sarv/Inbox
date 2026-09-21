import type { LinkMismatch } from '@sarv-in/mailguard/links';
import { ShieldAlert, ShieldX, Check, Ban } from 'lucide-react';
import { useMemo, useState } from 'react';

import { assessEmailSecurity, LEVEL_RANK } from '../../utils/email-security';
import { addLinkRule, useLinkRules } from '../../utils/security-rules';

interface PhishingWarningBannerProps {
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
 */
export function PhishingWarningBanner({
  fromName,
  fromAddress,
  html,
  className = 'mb-4',
  authStatus,
  spamScore,
  spamReasons,
}: PhishingWarningBannerProps) {
  const { sets } = useLinkRules();
  const assessment = useMemo(
    () => assessEmailSecurity({ fromName, fromAddress, html, authStatus, spamScore, spamReasons, rules: sets }),
    [fromName, fromAddress, html, authStatus, spamScore, spamReasons, sets],
  );
  const [busy, setBusy] = useState<string | null>(null);

  if (LEVEL_RANK[assessment.level] < LEVEL_RANK.caution) return null;

  const isDanger = assessment.level === 'danger';
  const Icon = isDanger ? ShieldX : ShieldAlert;
  // Only the checks that went wrong belong in a warning.
  const reasons = assessment.checks.filter((c) => c.status === 'fail' || c.status === 'warn');

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
    : assessment.spam.verdict === 'spam'
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
          <div className="mt-1.5 text-xs text-muted-foreground">
            Don&apos;t click links, open attachments, or share passwords or payment details unless you&apos;re sure the sender is genuine.
          </div>
        </div>
      </div>
    </div>
  );
}
