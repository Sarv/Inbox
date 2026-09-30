// Where to look up a correspondent's public key on the network. URL building
// only — the fetching lives in the main process, behind the user's privacy
// settings, so this stays pure and testable.

import { createHash } from 'crypto';

const Z_BASE32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/**
 * z-base-32 (the encoding WKD uses for its hashed local part). Hand-written on
 * purpose: the only npm package for it has a few hundred weekly downloads, and
 * the encoder is a dozen lines of bit shifting over a fixed alphabet, pinned by
 * the WKD draft's own test vector.
 */
export function zBase32Encode(bytes: Uint8Array): string {
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0')).join('');
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
  const groups = padded.match(/.{5}/g) ?? [];
  return groups.map((group) => Z_BASE32_ALPHABET[parseInt(group, 2)]).join('');
}

export interface WkdUrls {
  /** `openpgpkey.<domain>` subdomain — tried first, per the draft. */
  advanced: string;
  direct: string;
}

/**
 * Web Key Directory URLs for an address (draft-koch-openpgp-webkey-service §3.1).
 * The local part is lower-cased before hashing, as the draft specifies.
 */
export function wkdUrls(email: string): WkdUrls | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const localPart = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  const hash = zBase32Encode(createHash('sha1').update(localPart.toLowerCase(), 'utf8').digest());
  const query = `?l=${encodeURIComponent(localPart)}`;
  return {
    advanced: `https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hash}${query}`,
    direct: `https://${domain}/.well-known/openpgpkey/hu/${hash}${query}`,
  };
}

/** keys.openpgp.org's verifying keyserver: returns only keys whose address was confirmed. */
export function keyserverUrl(email: string): string {
  return `https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email.trim().toLowerCase())}`;
}
