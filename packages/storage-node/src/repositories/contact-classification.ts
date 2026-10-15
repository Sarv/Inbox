import type { ContactType, ContactTypeSource } from '@sarvinbox/core';
import { parseAddresses, PUBLIC_DOMAINS } from '@sarvinbox/core';

export const CONTACT_TYPES: ReadonlySet<string> = new Set([
  'potential_customer', 'existing_customer', 'churned_customer', 'vendor',
  'colleague', 'personal', 'newsletter', 'automated', 'recruiter', 'unknown',
]);

export const CONTACT_TYPE_SOURCES: ReadonlySet<string> = new Set(['user', 'ai', 'rule', 'behavior', 'unset']);

const PUBLIC_MAIL_DOMAINS = new Set([
  ...PUBLIC_DOMAINS, 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com',
  'gmx.de', 'tuta.com', 'tutanota.com', 'hotmail.co.uk', 'yahoo.in',
]);

export interface ContactClassificationRow {
  email: string;
  kind?: string | null;
  contact_type?: string | null;
  contact_type_source?: string | null;
  contact_type_confidence?: number | null;
  received_count?: number | null;
  sent_count?: number | null;
}

export interface RelationshipEvidence {
  newsletter: boolean;
  vendor: boolean;
  customer: boolean;
  prospect: boolean;
  recruiter: boolean;
}

export const emptyRelationshipEvidence = (): RelationshipEvidence => ({
  newsletter: false, vendor: false, customer: false, prospect: false, recruiter: false,
});

/** Exact mailbox keys; display names and SQL wildcard characters are never domains. */
export function classificationAddress(value: string): string | null {
  const addresses = parseAddresses(value);
  if (addresses.length !== 1) return null;
  const address = addresses[0].trim().toLowerCase();
  return /^[^\s@<>]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(address) ? address : null;
}

export function classificationDomains(addresses: ReadonlySet<string>): Set<string> {
  return new Set([...addresses].map((email) => email.split('@')[1]).filter((domain) => !PUBLIC_MAIL_DOMAINS.has(domain)));
}

/** A role mailbox can be human-operated; only explicit system names imply a bot. */
export function isAutomatedContact(email: string): boolean {
  const local = email.split('@')[0].split('+')[0];
  return /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notifications?|alerts?|bounce(?:s)?)$/i.test(local);
}

/** Replies/forwards retain somebody else's subject and do not establish direction. */
export function addRelationshipEvidence(
  evidence: RelationshipEvidence,
  message: { subject?: string | null; list_unsubscribe?: string | null },
  outgoing: boolean,
): void {
  const subject = message.subject?.trim() || '';
  if (!outgoing && message.list_unsubscribe?.trim()) evidence.newsletter = true;
  if (/^(?:re|fw|fwd)\s*:/i.test(subject)) return;
  if (outgoing) {
    if (/\b(?:invoice(?:\s*(?:#|no\.?|number|:)|\s+\d|\s+for\b)|payment reminder\b|your invoice\b)/i.test(subject)) evidence.customer = true;
    return;
  }
  if (/\b(?:invoice(?:\s*(?:#|no\.?|number|:)|\s+\d|\s+for\b)|your invoice\b|billing statement\b|bill for\b|payment receipt\b|receipt for\b|your receipt\b)/i.test(subject)) evidence.vendor = true;
  if (/\b(?:purchase order|signed (?:contract|agreement)|renewal confirmation)\b/i.test(subject)) evidence.customer = true;
  if (/\b(?:request for (?:a )?(?:quote|quotation|proposal|demo)|(?:quote|quotation|demo) request|pricing (?:inquiry|enquiry)|request (?:a )?(?:quote|demo))\b/i.test(subject)) evidence.prospect = true;
  if (/\b(?:interview invitation|job opportunity|recruitment opportunity|hiring for|career opportunity)\b/i.test(subject)) evidence.recruiter = true;
}

export function canReclassifyContact(contact: ContactClassificationRow): boolean {
  if (contact.contact_type_source === 'user' || contact.kind === 'company') return false;
  if (!contact.contact_type || contact.contact_type === 'unknown') return true;
  // Deterministic labels are recalculated from the combined mailbox evidence,
  // so a previously confident guess can change as the relationship changes.
  if (['behavior', 'heuristic', 'rule'].includes(contact.contact_type_source ?? '')) return true;
  return contact.contact_type_source === 'ai' && (contact.contact_type_confidence ?? 0) < 0.85;
}

export function classifyContactRelationship(
  contact: ContactClassificationRow,
  ownAddresses: ReadonlySet<string>,
  ownDomains: ReadonlySet<string>,
  evidence: RelationshipEvidence,
): { type: ContactType; confidence: number; source: ContactTypeSource } {
  const email = classificationAddress(contact.email);
  const unknown = { type: 'unknown' as const, confidence: 0, source: 'unset' as const };
  if (!email || ownAddresses.has(email)) return unknown;
  if (isAutomatedContact(email)) return { type: 'automated', confidence: 0.95, source: 'rule' };
  const local = email.split('@')[0];
  const explicitListMailbox = /^(?:newsletter|digest)(?:[+._-]|$)/i.test(local);
  const internal = ownDomains.has(email.split('@')[1]);
  // Help desks and shared sales mailboxes can carry unsubscribe headers on
  // human replies. The owned company identity outweighs that generic signal.
  if (internal && !explicitListMailbox) return { type: 'colleague', confidence: 0.9, source: 'rule' };
  if (!evidence.vendor && !evidence.customer && !evidence.prospect
    && (contact.sent_count ?? 0) === 0 && (evidence.newsletter
    || (explicitListMailbox && (contact.received_count ?? 0) >= 3))) {
    return { type: 'newsletter', confidence: 0.9, source: 'behavior' };
  }
  if (internal) return { type: 'colleague', confidence: 0.9, source: 'rule' };
  // Contradictory transaction directions need a user decision, rather than the
  // order of SQL UPDATEs deciding whether this person buys or sells to us.
  if (evidence.vendor && (evidence.customer || evidence.prospect)) return unknown;
  if (evidence.vendor) return { type: 'vendor', confidence: 0.9, source: 'behavior' };
  if (evidence.customer) return { type: 'existing_customer', confidence: 0.9, source: 'behavior' };
  if (evidence.prospect) return { type: 'potential_customer', confidence: 0.9, source: 'behavior' };
  if (evidence.recruiter) return { type: 'recruiter', confidence: 0.9, source: 'behavior' };
  return unknown;
}
