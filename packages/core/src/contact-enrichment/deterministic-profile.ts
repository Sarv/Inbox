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

import { contactLinkKind, normalizeContactUrl } from './contact-links';
import { PUBLIC_DOMAINS } from './phone-classifier';
import type { ExtractedSignals } from './signal-extractor';
import { looksLikeTitleLine } from './titles';

export interface DeterministicProfile {
  /** Person's name as written in the signature. */
  fullName: string | null;
  /** Job title line ("CBO", "Head of Sales"). */
  title: string | null;
  department: string | null;
  /** Employer explicitly named in the sender's signature. */
  organization: string | null;
  /** Website actually present in the sender's signature. */
  website: string | null;
  companyAddress: string | null;
  linkedinUrl: string | null;
  companyLinkedinUrl: string | null;
  twitterUrl: string | null;
  githubUrl: string | null;
  pronouns: string | null;
  personalEmail: string | null;
  otherSocials: Array<{ platform: string; url: string }>;
}

const EMPTY: DeterministicProfile = {
  fullName: null, title: null, department: null, organization: null, companyAddress: null,
  website: null, linkedinUrl: null, companyLinkedinUrl: null, twitterUrl: null, githubUrl: null,
  pronouns: null, personalEmail: null, otherSocials: [],
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
  if (looksLikeTitleLine(t) || /\b(?:team|department|support|sales|marketing|resources|procurement|road|street|avenue|building|address)\b/i.test(t)) return false;
  const words = t.split(' ');
  if (words.length < 2 || words.length > 4) return false;
  // Every word starts uppercase (allowing O'Neill, Jean-Luc, and initials).
  return words.every((w, i) => /^\p{Lu}[\p{L}'’.-]*$/u.test(w) || (i > 0 && /^(?:de|del|da|di|van|von|bin|al)$/i.test(w)));
}

/**
 * Company from a signature line, e.g. "Sarv", "Acme Ltd".
 * Only accepted when the token also appears in the sender's domain, so we never
 * invent an employer from an arbitrary line.
 */
const COMPANY_WORD = /\b(?:ltd|limited|llp|inc|llc|gmbh|pvt|corporation|corp|technologies|solutions|university|foundation|company)\b/i;

function organizationFrom(lines: string[], domain: string): string | null {
  const root = PUBLIC_DOMAINS.has(domain) ? '' : (domain.replace(/^(?:mail|smtp|mx)\./, '').split('.')[0] || '').toLowerCase();
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length > 100 || /@|https?:|www\.|\d{4,}|\b(?:address|road|street)\b/i.test(t)) continue;
    if (looksLikeTitleLine(t)) {
      const employer = t.split(',').slice(1).join(',').trim();
      if (COMPANY_WORD.test(employer)) return employer;
      continue;
    }
    const labelled = t.match(/^(?:company|organization|organisation|employer)\s*:\s*(.+)$/i);
    if (labelled) return labelled[1].trim();
    if (COMPANY_WORD.test(t)) return t;
    if (root.length >= 3 && t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(root)) return t;
  }
  return null;
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
    return { ...EMPTY, otherSocials: [] };
  }

  const lines = block.split(/\r?\n|\s+\|\s+/).map((l) => l.trim()).filter(Boolean);
  const organization = organizationFrom(lines, domain);

  // Name: the FIRST name-shaped line. Signatures lead with the person, then
  // title, then contact details — so first-match beats scanning the whole block
  // (which would happily match a city or a product name further down).
  const fullName = lines.slice(0, 5).find(line => line !== organization && looksLikeName(line)) ?? null;

  // Title: prefer a candidate the extractor already recognised; otherwise, the
  // line immediately after the name, when it is short and not contact details.
  let title = lines.find(line => looksLikeTitleLine(line) && !/@|https?:|www\.|\d{5,}/i.test(line)) ?? null;
  if (title) title = title.replace(/^(?:designation|position|title)\s*[:–—-]\s*/i, '');
  if (title?.includes(',') && COMPANY_WORD.test(title.split(',').slice(1).join(','))) title = title.split(',')[0].trim();
  const department = lines.map(line => line.match(/^(?:department|dept\.?|division|team)\s*[:–—-]\s*(.+)$/i)?.[1]?.trim()
    || (/^(?:sales|marketing|engineering|finance|human resources|talent acquisition|procurement|customer success|IT procurement)$/i.test(line) ? line : null)).find(Boolean) ?? null;
  const addressIndex = lines.findIndex(line => /^(?:office\s+|company\s+)?address\s*:/i.test(line) || /\d.*\b(?:road|street|avenue|lane|industrial area|building|floor|suite|sector)\b/i.test(line));
  const addressLines = addressIndex < 0 ? [] : [lines[addressIndex].replace(/^(?:office\s+|company\s+)?address\s*:\s*/i, '')];
  if (addressIndex >= 0) {
    for (const line of lines.slice(addressIndex + 1, addressIndex + 4)) {
      if (!/\b\d{4,6}\b|\b(?:road|street|avenue|floor|suite|sector)\b/i.test(line) || /@|https?:|\b(?:tel|mob|phone|fax)\b/i.test(line)) break;
      addressLines.push(line);
    }
  }
  const personalEmail = signals.emails.find(email => email !== fromAddress.toLowerCase() && PUBLIC_DOMAINS.has(email.split('@')[1])) ?? null;

  return {
    fullName,
    title,
    department,
    organization,
    companyAddress: addressLines.length ? addressLines.join('\n') : null,
    website: signals.websites.map(normalizeContactUrl).find(url => !!url && contactLinkKind(url) === 'website' && !PUBLIC_DOMAINS.has(new URL(url).hostname)) ?? null,
    linkedinUrl: signals.linkedinUrls.find(url => contactLinkKind(url) === 'linkedinPersonal') ?? null,
    companyLinkedinUrl: signals.linkedinUrls.find(url => contactLinkKind(url) === 'linkedinCompany') ?? null,
    twitterUrl: signals.twitterUrls[0] ?? null,
    githubUrl: signals.githubUrls[0] ?? null,
    pronouns: block.match(/\b(?:she\/her|he\/him|they\/them|she\/they|he\/they)\b/i)?.[0] ?? null,
    personalEmail,
    otherSocials: signals.otherSocials.map(normalizeContactUrl).filter((url): url is string => !!url).map(url => ({ platform: new URL(url).hostname.replace(/^www\./, ''), url })),
  };
}
