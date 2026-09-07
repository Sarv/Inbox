/**
 * Prompt builder for contact enrichment. Takes extracted signals (phones,
 * URLs, social handles, signature block) and asks the LLM to classify
 * each as personal vs company, identify designation/department, and
 * report the employer's name + domain. Returns strict JSON.
 *
 * Kept model-agnostic — output shape is validated separately in
 * response-parser. Prompt is terse on purpose: Sarv CAI bills per
 * token and this runs per-contact, so every extra sentence multiplies
 * across thousands of contacts.
 */

import type { ExtractedSignals } from './signal-extractor';

export interface EnrichmentPromptInput {
  contactEmail: string;
  contactName?: string | null;
  signals: ExtractedSignals;
  existingOrganization?: string | null;
  existingTitle?: string | null;
}

export const ENRICHMENT_SYSTEM_PROMPT = `You are a contact-enrichment classifier. Given signals mined from a
person's email signatures (phone numbers, URLs, social handles, text
blocks), produce a single JSON object describing that contact.

RULES
- Output JSON only. No prose, no markdown fences.
- The contact's email domain is the strongest clue to their employer.
  If the domain is a free provider (gmail.com, yahoo.com, outlook.com,
  hotmail.com, icloud.com, proton.me, ymail.com) IGNORE it as an
  employer clue and infer the employer from the signature instead.
- Bucket each phone as personal or company based on context:
    · "mobile"/"cell"/"whatsapp" near a number → personal (unless
      labeled "office mobile")
    · "office"/"direct"/"desk"/"work"/"tel" → company
    · unlabeled numbers default to company when a clear
      employer is identified, else personal.
- linkedinUrl MUST be a direct profile link (linkedin.com/in/...),
  not a company page (linkedin.com/company/...).
- companyWebsite is the employer's marketing site. companyDomain is
  that site's host. If they don't match the contact's email domain
  (because the contact uses a personal email), PREFER the signature
  domain.
- fullName = the person's full name exactly as written in their signature
  (e.g. "Pooja Khatri"). Null if the signature does not name them.
- designation = job title (e.g. "VP Engineering", "Head of Sales", "CBO").
- Leave any field null/omitted if the signals don't support it. Do
  NOT fabricate.

OUTPUT SHAPE
{
  "fullName": string|null,
  "designation": string|null,
  "department": string|null,
  "companyName": string|null,
  "companyDomain": string|null,
  "companyWebsite": string|null,
  "companyAddress": string|null,
  "linkedinUrl": string|null,
  "twitterUrl": string|null,
  "githubUrl": string|null,
  "personalPhone": string|null,       // raw as seen in signature
  "companyPhone": string|null,        // raw as seen in signature
  "whatsappNumber": string|null,
  "personalEmail": string|null,       // only if signature mentions alt
  "location": string|null,
  "pronouns": string|null,
  "otherSocials": [{"platform": string, "url": string}],
  "notes": string|null                // 1-line observation if salient
}`;

export function buildEnrichmentUserMessage(input: EnrichmentPromptInput): string {
  const { contactEmail, contactName, signals, existingOrganization, existingTitle } = input;
  const lines: string[] = [];

  lines.push('CONTACT');
  lines.push(`email: ${contactEmail}`);
  if (contactName) lines.push(`name: ${contactName}`);
  if (existingOrganization) lines.push(`current organization (may be stale): ${existingOrganization}`);
  if (existingTitle) lines.push(`current title (may be stale): ${existingTitle}`);
  lines.push('');

  lines.push('SIGNALS');
  if (signals.signatureBlock) {
    lines.push('signature block:');
    lines.push('"""');
    lines.push(signals.signatureBlock);
    lines.push('"""');
  }
  if (signals.titleCandidates.length > 0) {
    lines.push(`title-like lines: ${signals.titleCandidates.slice(0, 5).join(' | ')}`);
  }
  if (signals.phones.length > 0) {
    lines.push(`phones: ${signals.phones.slice(0, 8).join(', ')}`);
  }
  if (signals.linkedinUrls.length > 0) {
    lines.push(`linkedin urls: ${signals.linkedinUrls.slice(0, 3).join(', ')}`);
  }
  if (signals.twitterUrls.length > 0) {
    lines.push(`twitter urls: ${signals.twitterUrls.slice(0, 3).join(', ')}`);
  }
  if (signals.githubUrls.length > 0) {
    lines.push(`github urls: ${signals.githubUrls.slice(0, 3).join(', ')}`);
  }
  if (signals.otherSocials.length > 0) {
    lines.push(`other social urls: ${signals.otherSocials.slice(0, 5).join(', ')}`);
  }
  if (signals.websites.length > 0) {
    lines.push(`other urls: ${signals.websites.slice(0, 5).join(', ')}`);
  }
  if (signals.emails.length > 0) {
    lines.push(`emails seen: ${signals.emails.slice(0, 5).join(', ')}`);
  }

  lines.push('');
  lines.push('Return JSON only. No prose.');

  return lines.join('\n');
}
