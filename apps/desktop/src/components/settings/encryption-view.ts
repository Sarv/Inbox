/**
 * The Encryption tab's wording — pure, so what a key row claims is tested
 * without the bridge. The claims that matter: an expired or revoked key is
 * never shown as usable, and a key's protection says truthfully where its
 * secret lives.
 */
import type { ContactKeySummary, OwnKeySummary } from '../../../electron/services/pgp-keyring';
import { normalizeIdentities } from '../../store/identities';
import { shortFingerprint } from '../email-detail/pgp-view-model';

export type { ContactKeySummary, OwnKeySummary };

export { shortFingerprint };

type KeyState = Pick<OwnKeySummary, 'isExpired' | 'isRevoked'> & { unlocked?: boolean };

/** Short warnings for a key row, most serious first. Empty for a key that is fine to use. */
export function keyWarnings(key: KeyState): string[] {
  return [
    key.isRevoked ? 'Revoked' : null,
    key.isExpired ? 'Expired' : null,
    key.unlocked === false ? 'Locked' : null,
  ].filter((warning): warning is string => warning !== null);
}

export const protectionText = (protection: OwnKeySummary['protection']): string =>
  protection === 'keychain'
    ? 'Protected by your system keychain — no passphrase to type.'
    : 'Protected by its passphrase — asked for once per session.';

const SOURCE_LABELS: Record<ContactKeySummary['source'], string> = {
  manual: 'Imported by you',
  autocrypt: 'From their mail (Autocrypt)',
  wkd: 'From their mail domain (WKD)',
  keyserver: 'From keys.openpgp.org',
};

export const keySourceLabel = (source: ContactKeySummary['source']): string => SOURCE_LABELS[source];

/** A UTC timestamp as a date in the reader's own locale and zone. */
export const localDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

/**
 * The addresses a key can be made for: every account and its aliases, each
 * once, in account order — through the same rule the From picker uses.
 */
export const keyAddressChoices = (accounts: { email: string; identities?: string[] }[]): string[] =>
  normalizeIdentities(undefined, accounts.flatMap((account) => [account.email, ...(account.identities ?? [])]));
