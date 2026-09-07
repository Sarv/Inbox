// Validation utilities using zod

import { z } from 'zod';

import { parseAddresses } from './email-address';

/**
 * Email address validator
 */
export const emailAddressSchema = z.string().email();

/**
 * Message-ID validator (RFC 5322)
 */
export const messageIdSchema = z.string().regex(/^<.+@.+>$/);

/**
 * Validate email address
 */
export function isValidEmail(email: string): boolean {
  return emailAddressSchema.safeParse(email).success;
}

/**
 * Extract the bare address from a recipient that may be in `Name <email>` form
 * (what the To/Cc headers and the compose UI carry) or already bare. Delegates to
 * the shared RFC 5322 parser (`email-addresses`) so display names — including the
 * awkward `"Doe, John" <j@x.com>` with a comma — are handled correctly, not by a
 * fragile regex. Used before `isValidEmail` so a perfectly valid
 * `Accounts Sarv <accounts@sarv.com>` is never rejected as "invalid recipient"
 * just for carrying a display name. Falls back to the trimmed input if the parser
 * can't extract an address (so a genuinely malformed token still reaches
 * `isValidEmail`, which then rejects it).
 */
export function extractEmailAddress(recipient: string): string {
  const [first] = parseAddresses(recipient);
  return (first ?? recipient ?? '').trim();
}

/**
 * Validate Message-ID
 */
export function isValidMessageId(messageId: string): boolean {
  return messageIdSchema.safeParse(messageId).success;
}

/**
 * Parse comma-separated email addresses
 */
export function parseEmailAddresses(addresses: string): string[] {
  if (!addresses) return [];

  return addresses
    .split(',')
    .map(addr => addr.trim())
    .filter(addr => addr.length > 0);
}

/**
 * Validate IMAP folder path
 */
export function isValidFolderPath(path: string): boolean {
  return path.length > 0 && path.length < 255;
}

/**
 * Normalize subject for threading.
 *
 * Strips nested reply / forward prefixes ("Re: Re: Fwd: Foo" → "foo").
 * The previous version stopped after one prefix because the regex was
 * anchored to `^` — every `Re:` after that survived, and two emails
 * with subjects "Re: Foo" vs "Re: Re: Foo" produced different
 * normalized forms, breaking subject-based threading fallbacks.
 */
export function normalizeSubject(subject: string): string {
  if (!subject) return '';

  let s = subject.trim();
  // Reply/forward prefixes across common locales, each optionally carrying a
  // count like "Re[2]:" / "Re(2):". Multi-letter only (never a bare "R:"/"I:",
  // which are too easily part of a real subject), and always anchored to a colon,
  // so this can't over-strip. Kept in sync with the threading fallback — two mails
  // "Re: Foo" and "AW: Foo" must normalize to the same "foo" to thread together.
  //   en: re, fwd · de: aw, wg · nordic: sv · nl: antw, doorst · fr: rép, tr
  //   es: rv · it: rif · pt: enc
  // Deliberately NOT "ref"/"res"/"vs" — those are reference/ordinary subject
  // words as often as reply markers, and stripping them would MERGE unrelated mail.
  const prefixRe = /^\s*(re|fwd?|aw|wg|sv|rv|tr|rif|enc|antw|antwort|doorst|rép)\s*(\[\d+\]|\(\d+\))?\s*:\s*/i;
  // Cap at 8 iterations as a safety net against pathological input.
  for (let i = 0; i < 8 && prefixRe.test(s); i++) {
    s = s.replace(prefixRe, '');
  }
  return s.trim().toLowerCase();
}

/**
 * Did this subject arrive carrying a reply/forward prefix ("Re:", "AW:", "Fwd:")?
 *
 * DERIVED from normalizeSubject rather than testing a second copy of the prefix
 * regex: the two must never disagree about what counts as a marker, and a
 * duplicated pattern is exactly how they would drift. normalizeSubject only ever
 * trims, strips prefixes and lowercases, so a stripped prefix is the one thing
 * that can make its output differ from the plain trim+lowercase of the input.
 *
 * Used by the threading fallback as evidence that a mail belongs to a
 * CONVERSATION rather than to a recurring notification stream that merely
 * repeats one subject.
 */
export function hasReplyPrefix(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return normalizeSubject(subject) !== subject.trim().toLowerCase();
}
