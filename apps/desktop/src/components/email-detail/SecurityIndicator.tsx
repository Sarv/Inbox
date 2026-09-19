import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, Shield } from 'lucide-react';
import { useMemo } from 'react';

import { assessEmailSecurity, LEVEL_COPY, type SecurityLevel, type SecurityCheck } from '../../utils/email-security';
import { useLinkRules } from '../../utils/security-rules';
import { Tooltip } from '../Tooltip';

interface SecurityIndicatorProps {
  fromName?: string | null;
  fromAddress?: string | null;
  html?: string | null;
  authStatus?: string | null;
  /** Stored spam filter score / reasons (emails.spam_score, emails.spam_reasons). */
  spamScore?: number | null;
  spamReasons?: string | null;
  className?: string;
}

const ICON: Record<SecurityLevel, typeof Shield> = {
  verified: ShieldCheck,
  authenticated: Shield,
  unverified: ShieldQuestion,
  caution: ShieldAlert,
  danger: ShieldX,
};

const TONE: Record<SecurityLevel, string> = {
  verified: 'text-green-600 dark:text-green-400',
  authenticated: 'text-blue-600 dark:text-blue-400',
  unverified: 'text-muted-foreground',
  caution: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};

const STATUS_GLYPH: Record<SecurityCheck['status'], string> = {
  pass: '✓',
  fail: '✕',
  warn: '!',
  unknown: '–',
};

const STATUS_TONE: Record<SecurityCheck['status'], string> = {
  pass: 'text-green-600 dark:text-green-400',
  fail: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  unknown: 'text-muted-foreground',
};

/**
 * The shield beside the sender's name. Colour is the level; the tooltip is the
 * evidence — every check with its verdict, so "Caution" is never a bare
 * adjective but "SPF pass, DKIM pass, DMARC none, one link goes elsewhere".
 *
 * Renders for EVERY message, including clean ones: a badge that only appears
 * when something is wrong teaches the user nothing about the mail that is fine,
 * and the green shield on a bank statement is the thing that makes the red one
 * on a fake bank statement mean something.
 */
export function SecurityIndicator({ fromName, fromAddress, html, authStatus, spamScore, spamReasons, className = '' }: SecurityIndicatorProps) {
  const { sets } = useLinkRules();
  const assessment = useMemo(
    () => assessEmailSecurity({ fromName, fromAddress, html, authStatus, spamScore, spamReasons, rules: sets }),
    [fromName, fromAddress, html, authStatus, spamScore, spamReasons, sets],
  );
  const Icon = ICON[assessment.level];
  const copy = LEVEL_COPY[assessment.level];

  const content = (
    <div className="text-left">
      <div className={`font-semibold ${TONE[assessment.level]}`}>{copy.title}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground leading-snug">{copy.summary}</div>
      <ul className="mt-2 space-y-1">
        {assessment.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 text-[11px] leading-snug">
            <span className={`w-3 shrink-0 font-bold ${STATUS_TONE[c.status]}`} aria-hidden>{STATUS_GLYPH[c.status]}</span>
            <span>
              <span className="font-medium">{c.label}</span>
              <span className="text-muted-foreground"> — {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <Tooltip content={content} delayMs={40} maxWidth={340} position="bottom">
      <span
        className={`inline-flex items-center ${TONE[assessment.level]} ${className}`}
        role="img"
        aria-label={`Security: ${copy.title}`}
        data-security-level={assessment.level}
      >
        <Icon className="h-4 w-4" />
      </span>
    </Tooltip>
  );
}
