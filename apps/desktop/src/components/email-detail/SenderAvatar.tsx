import { parseAuthStatus } from '../../utils/email-security';
import { pickSenderAvatar } from '../../utils/sender-avatar';
import { useSenderIdentity } from '../../utils/sender-identity';
import { Avatar } from '../Avatar';

interface SenderAvatarProps {
  email: string | null | undefined;
  name?: string | null;
  size: number;
  /** The message's stored SPF/DKIM/DMARC verdict — the BIMI logo is shown only on a DMARC pass. */
  authStatus?: string | null;
  className?: string;
}

/**
 * The avatar beside a message: BIMI logo (DMARC-passing mail only), then the
 * contact's confirmed photo, then the domain's favicon, then initials. Every
 * picture is a locally cached `data:` URI handed over by the main process;
 * nothing is fetched while a message renders.
 */
export function SenderAvatar({ email, name, size, authStatus, className }: SenderAvatarProps) {
  const identity = useSenderIdentity(email);
  const dmarcPass = parseAuthStatus(authStatus)?.dmarc === 'pass';
  const pick = pickSenderAvatar({
    bimiStatus: identity?.bimi?.status ?? null,
    bimiLogo: identity?.bimi?.logo ?? null,
    dmarcPass,
    contactPhoto: identity?.contactPhoto ?? null,
    favicon: identity?.favicon ?? null,
  });
  return (
    <Avatar
      email={email || ''}
      name={name}
      size={size}
      photoUrl={pick.src}
      fit={pick.fit}
      className={className}
      data-avatar-source={pick.source}
    />
  );
}
