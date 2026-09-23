// The remote-image allowlist: what the reader has chosen to let load without
// being asked. One entry is either a single SENDER (`boss@x.com`) or a whole
// DOMAIN (`@x.com`, which also covers `news.x.com`).
//
// Both live in the same per-account store (`image_allowed_senders`), keyed by a
// string, and the leading `@` is what tells them apart — a domain key can never
// collide with an address key because an address always has a local part.
//
// Pure and dependency-light on purpose: the renderer deep-imports this module
// (see the `@sarvinbox/core/image-allowlist` alias) so the block-vs-load
// decision, the Security page's list, and anything that writes an entry all
// agree on ONE normalisation. A second copy here would mean an entry the user
// can add but that never matches.

import { parse as parseHost } from 'tldts';

import { parseAddressList } from './email-address';

/** Marks a stored key as a whole-domain allowance rather than one address. */
export const DOMAIN_KEY_PREFIX = '@';

export type ImageAllowKind = 'sender' | 'domain';

export interface ImageAllowEntry {
  kind: ImageAllowKind;
  /** What is stored / passed to the IPC: `boss@x.com` or `@x.com`. */
  key: string;
  /** What the UI shows: the bare address, or the bare domain without the `@`. */
  label: string;
}

/** Bare, lowercased address from `Name <addr>` or an already-bare address. */
export function bareSenderAddress(input?: string | null): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const [first] = parseAddressList(raw);
  return (first?.address ?? raw).trim().toLowerCase();
}

/** Everything after the LAST `@`, lowercased and without a trailing dot. */
const domainOf = (address: string): string => {
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  return address.slice(at + 1).replace(/\.+$/, '').toLowerCase();
};

/**
 * A domain the user may allow, or '' when the input isn't one.
 *
 * Rejects a bare public suffix (`com`, `co.uk`): allowing one would hand every
 * sender on the internet a pass, and it is the kind of thing a reader types by
 * accident far more often than on purpose.
 */
export function normalizeAllowDomain(input?: string | null): string {
  const candidate = (input ?? '').trim().replace(/^@+/, '').replace(/\.+$/, '').toLowerCase();
  if (!candidate || candidate.includes('@') || candidate.includes('/') || candidate.includes(' ')) return '';
  const parsed = parseHost(candidate);
  // A hostname tldts had to repair (or could not read at all) is not what the
  // reader typed, so it is not what we store.
  if (parsed.hostname !== candidate) return '';
  // No registrable domain (or the input IS the suffix) → not something to allow.
  if (!parsed.domain || parsed.publicSuffix === candidate) return '';
  return candidate;
}

/** A stored key rendered for display (and for grouping the list by kind). */
export function describeImageAllowEntry(key?: string | null): ImageAllowEntry {
  const trimmed = (key ?? '').trim().toLowerCase();
  return trimmed.startsWith(DOMAIN_KEY_PREFIX)
    ? { kind: 'domain', key: trimmed, label: trimmed.slice(1) }
    : { kind: 'sender', key: trimmed, label: trimmed };
}

/**
 * What the reader typed, turned into a storable entry — or null when it is
 * neither an address nor a domain.
 *
 * `@x.com` and `x.com` both mean the domain; `boss@x.com` and
 * `The Boss <boss@x.com>` both mean the sender.
 */
export function parseImageAllowInput(input?: string | null): ImageAllowEntry | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  // A leading `@`, or no `@` at all, can only be meant as a domain.
  if (raw.startsWith(DOMAIN_KEY_PREFIX) || !raw.includes('@')) {
    const domain = normalizeAllowDomain(raw);
    return domain ? { kind: 'domain', key: `${DOMAIN_KEY_PREFIX}${domain}`, label: domain } : null;
  }

  // A sender is taken as given once it parses: the public-suffix check above
  // guards against a typo that would allow half the internet, and a single
  // address can't. Requiring a registrable domain here would silently refuse to
  // remember intranet mail (`someone@mail.corp`, `root@localhost`).
  const address = bareSenderAddress(raw);
  const domain = domainOf(address);
  const local = address.slice(0, address.lastIndexOf('@'));
  if (!local || !domain) return null;
  return { kind: 'sender', key: `${local}@${domain}`, label: `${local}@${domain}` };
}

/**
 * Every stored key that would let this sender's images load: the address
 * itself, its domain, and each parent domain — so `@x.com` covers
 * `news.x.com` without the reader having to guess which subdomain a newsletter
 * happens to be sent from.
 */
export function imageAllowKeysFor(address?: string | null): string[] {
  const bare = bareSenderAddress(address);
  const domain = domainOf(bare);
  if (!bare) return [];
  if (!domain) return [bare];

  const labels = domain.split('.');
  const parents = labels
    .map((_, index) => labels.slice(index).join('.'))
    // A single label ("com") is never a key we'd have stored — see
    // normalizeAllowDomain — so don't bother probing for it.
    .filter((candidate) => candidate.includes('.'))
    .map((candidate) => `${DOMAIN_KEY_PREFIX}${candidate}`);

  return [bare, ...parents];
}

/** Does any stored entry allow this sender's remote images? */
export function isImageAllowedFor(
  address: string | null | undefined,
  entries: ReadonlySet<string>,
): boolean {
  return imageAllowKeysFor(address).some((key) => entries.has(key));
}
