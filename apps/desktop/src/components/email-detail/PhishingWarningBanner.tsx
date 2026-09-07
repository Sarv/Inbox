import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useMemo } from 'react';

import { assessPhishing } from '../../utils/phishing';

interface PhishingWarningBannerProps {
  fromName?: string | null;
  fromAddress?: string | null;
  /** Rendered HTML body — scanned for deceptive links (anchor text ≠ href). */
  html?: string | null;
}

/**
 * Gmail-style warning shown above the message body when the sender identity or a
 * link looks deceptive. Two levels:
 *   - danger (red)   — sender-name domain impersonation: the friendly name
 *     references one domain but the mail came from another.
 *   - caution (amber) — softer tells (deceptive-looking links, punycode domain).
 * Renders nothing when no signal fires (the common case), so its presence stays
 * meaningful. See utils/phishing.ts for the heuristics.
 */
export function PhishingWarningBanner({ fromName, fromAddress, html }: PhishingWarningBannerProps) {
  const { level, reasons } = useMemo(
    () => assessPhishing({ fromName, fromAddress, html }),
    [fromName, fromAddress, html],
  );

  if (level === 'none') return null;

  const isDanger = level === 'danger';
  const Icon = isDanger ? ShieldAlert : ShieldQuestion;

  const shell = isDanger
    ? 'border-red-500/40 bg-red-500/[0.07] dark:bg-red-500/[0.10]'
    : 'border-amber-500/40 bg-amber-500/[0.07] dark:bg-amber-400/[0.10]';
  const iconWrap = isDanger
    ? 'bg-red-500/15 text-red-600 dark:text-red-400'
    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
  const heading = isDanger ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300';

  const title = isDanger
    ? 'This message may not be from who it claims to be'
    : 'Be careful with this message';

  return (
    <div className={`mb-4 rounded-lg border ${shell} overflow-hidden`} role="alert">
      <div className="flex items-start gap-3 p-3">
        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md ${iconWrap}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-semibold ${heading}`}>{title}</div>
          <ul className="mt-1 space-y-1">
            {reasons.map((r, i) => (
              <li key={i} className="text-xs text-muted-foreground break-words">
                {r.text}
              </li>
            ))}
          </ul>
          <div className="mt-1.5 text-xs text-muted-foreground">
            Don&apos;t click links, open attachments, or share passwords or payment details unless you&apos;re sure the sender is genuine.
          </div>
        </div>
      </div>
    </div>
  );
}
