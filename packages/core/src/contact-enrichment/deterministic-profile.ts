/**
 * Code-only contact profile.
 *
 * Everything here is derived from the signature block with no LLM involved, so
 * it works when there is no AI provider configured, no quota, or no network —
 * situations where enrichment currently yields nothing and a contact is left
 * showing a capitalised local part ("Pkh") forever.
 *
 * The LLM remains the better classifier for ambiguous cases; this is the floor,
 * not the ceiling. Every field is deliberately conservative: return null rather
 * than guess, because a wrong name or title is worse than an absent one and
 * downstream code treats these as authoritative.
 */

import type { ExtractedSignals } from './signal-extractor';

export interface DeterministicProfile {
  /** Person's name as written in the signature. */
  fullName: string | null;
  /** Job title line ("CBO", "Head of Sales"). */
  title: string | null;
  /** Employer, inferred from the signature or the sending domain. */
  organization: string | null;
  /** Company website (non-social URL, or the sender's own domain). */
  website: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  githubUrl: string | null;
}

const EMPTY: DeterministicProfile = {
  fullName: null, title: null, organization: null,
  website: null, linkedinUrl: null, twitterUrl: null, githubUrl: null,
};

/** Lines that are never a person's name. */
const NON_NAME = new RegExp(
  [
    '@',                                   // an address
    'https?:',                             // a URL
    '\\bwww\\.',
    '\\d{4,}',                             // phone / postcode runs
    '^\\+?\\d',                            // starts with a number
    '\\b(tel|mob|mobile|phone|fax|cell|email|e-mail|web|site)\\b\\s*[:.]',
    '\\b(ltd|llp|inc|gmbh|pvt|private limited|corporation|technologies|solutions)\\b',
    '^(regards|thanks|thank you|sincerely|cheers|best|br|rgds|yours)\\b',
    '^-{2,}$',
    '^\\p{Extended_Pictographic}',          // emoji-led decoration lines
  ].join('|'),
  'iu',
);

/**
 * A plausible human name: 2-4 words, each starting with a capital, no digits.
 * Deliberately strict — a false positive here overwrites a real display name.
 */
function looksLikeName(line: string): boolean {
  const t = line.trim().replace(/\s+/g, ' ');
  if (t.length < 3 || t.length > 60) return false;
  if (NON_NAME.test(t)) return false;
  const words = t.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  // Every word starts uppercase (allowing O'Neill, Jean-Luc, and initials).
  return words.every((w) => /^[A-Z][\p{L}'’.-]*$/u.test(w));
}

/**
 * Company from a signature line, e.g. "Sarv", "Acme Ltd".
 * Only accepted when the token also appears in the sender's domain, so we never
 * invent an employer from an arbitrary line.
 */
function organizationFrom(lines: string[], domain: string): string | null {
  const root = (domain.split('.')[0] || '').toLowerCase();
  if (!root || root.length < 3) return null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length > 60 || NON_NAME.test(t)) continue;
    if (t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(root)) return t;
  }
  // Nothing in the signature — fall back to the domain root, capitalised.
  return root.charAt(0).toUpperCase() + root.slice(1);
}

/**
 * Derive whatever can be known without an LLM.
 *
 * `fromAddress` supplies the domain used to sanity-check the organization and
 * to build a website fallback.
 */
export function extractDeterministicProfile(
  signals: ExtractedSignals,
  fromAddress: string,
): DeterministicProfile {
  const block = signals.signatureBlock;
  const domain = (fromAddress.split('@')[1] || '').toLowerCase().trim();
  if (!block) {
    // No signature: the only trustworthy signals are the social URLs, which
    // carry their own identity, plus the domain-derived employer.
    return {
      ...EMPTY,
      organization: domain ? organizationFrom([], domain) : null,
      linkedinUrl: signals.linkedinUrls[0] ?? null,
      twitterUrl: signals.twitterUrls[0] ?? null,
      githubUrl: signals.githubUrls[0] ?? null,
    };
  }

  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Name: the FIRST name-shaped line. Signatures lead with the person, then
  // title, then contact details — so first-match beats scanning the whole block
  // (which would happily match a city or a product name further down).
  const fullName = lines.find(looksLikeName) ?? null;

  // Title: prefer a candidate the extractor already recognised; otherwise, the
  // line immediately after the name, when it is short and not contact details.
  let title = signals.titleCandidates[0] ?? null;
  if (!title && fullName) {
    const next = lines[lines.indexOf(fullName) + 1];
    if (next && next.length <= 60 && !NON_NAME.test(next) && !looksLikeName(next)) {
      title = next;
    }
  }

  return {
    fullName,
    title,
    organization: organizationFrom(lines, domain),
    website: signals.websites[0] ?? (domain ? `https://${domain}` : null),
    linkedinUrl: signals.linkedinUrls[0] ?? null,
    twitterUrl: signals.twitterUrls[0] ?? null,
    githubUrl: signals.githubUrls[0] ?? null,
  };
}
