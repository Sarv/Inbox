import { BadgeCheck } from 'lucide-react';

import { parseAuthStatus } from '../../utils/email-security';
import { isVerifiedSender } from '../../utils/sender-avatar';
import { useSenderIdentity } from '../../utils/sender-identity';
import { Tooltip } from '../Tooltip';

interface VerifiedBadgeProps {
  email: string | null | undefined;
  authStatus?: string | null;
  className?: string;
}

/**
 * The blue tick beside a sender's name — Gmail's verified-sender mark. Shown
 * only when the domain's Verified Mark Certificate chained to a pinned Mark
 * Verifying Authority for THIS logo and THIS domain, AND this message passed
 * DMARC. The tooltip says who vouched, so the tick is evidence, not decoration.
 * Sits beside the shield, which keeps judging the message itself.
 */
export function VerifiedBadge({ email, authStatus, className = '' }: VerifiedBadgeProps) {
  const identity = useSenderIdentity(email);
  const dmarcPass = parseAuthStatus(authStatus)?.dmarc === 'pass';
  if (!identity?.bimi || !isVerifiedSender({ bimiStatus: identity.bimi.status, dmarcPass })) return null;
  const org = identity.bimi.organization ?? 'The brand';
  const issuer = identity.bimi.issuer ?? 'a Mark Verifying Authority';
  const content = (
    <div className="text-left">
      <div className="font-semibold text-blue-600 dark:text-blue-400">Verified sender</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
        {org} proved ownership of {identity.domain} with a Verified Mark Certificate issued by {issuer}. This message passed DMARC, so it really came from them.
      </div>
    </div>
  );
  return (
    <Tooltip content={content} delayMs={40} maxWidth={320} position="bottom">
      <span
        className={`inline-flex items-center text-blue-600 dark:text-blue-400 ${className}`}
        role="img"
        aria-label="Verified sender"
        data-verified-sender="true"
      >
        <BadgeCheck className="h-4 w-4" />
      </span>
    </Tooltip>
  );
}
