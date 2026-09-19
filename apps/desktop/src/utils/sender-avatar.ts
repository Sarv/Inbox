/**
 * Which picture stands for a sender — the ONE rule, pure, so the card, the
 * chat bubble and the tests agree.
 *
 * Priority, and why:
 *   1. The domain's BIMI logo — but ONLY on mail that passed DMARC. The logo
 *      is a brand's own mark; showing it on a message the domain did not
 *      authenticate would put the brand on the phish. (Verified or not: the
 *      certificate decides the TICK, not the picture.)
 *   2. The contact's confirmed photo — a person the user knows, approved by
 *      the user in the Contacts pane.
 *   3. The domain's favicon — the organisation, when nothing more personal is
 *      known.
 *   4. Initials, offline and always available.
 *
 * `fit`: a photo fills the circle; a logo or favicon is a graphic on white
 * and must not be cropped.
 */
export type BimiStanding = 'verified' | 'logo' | 'declined' | 'none' | 'invalid' | 'error';
export type AvatarSource = 'bimi' | 'contact' | 'favicon' | 'initials';

export interface SenderAvatarInput {
  bimiStatus: BimiStanding | null;
  bimiLogo: string | null;
  /** The MESSAGE passed DMARC (stored auth_status), not the domain's policy. */
  dmarcPass: boolean;
  contactPhoto: string | null;
  favicon: string | null;
}

export interface SenderAvatarPick {
  /** `data:` URI to draw, or null for initials. */
  src: string | null;
  source: AvatarSource;
  fit: 'cover' | 'contain';
}

const showsLogo = (status: BimiStanding | null): boolean => status === 'verified' || status === 'logo';

export function pickSenderAvatar(input: SenderAvatarInput): SenderAvatarPick {
  if (input.dmarcPass && showsLogo(input.bimiStatus) && input.bimiLogo) {
    return { src: input.bimiLogo, source: 'bimi', fit: 'contain' };
  }
  if (input.contactPhoto) return { src: input.contactPhoto, source: 'contact', fit: 'cover' };
  if (input.favicon) return { src: input.favicon, source: 'favicon', fit: 'contain' };
  return { src: null, source: 'initials', fit: 'cover' };
}

/**
 * The blue tick: a Verified Mark Certificate that checked out, on a message
 * that passed DMARC. Either alone is not enough — the certificate says who
 * owns the brand, DMARC says this message came from them.
 */
export function isVerifiedSender(input: { bimiStatus: BimiStanding | null; dmarcPass: boolean }): boolean {
  return input.dmarcPass && input.bimiStatus === 'verified';
}
