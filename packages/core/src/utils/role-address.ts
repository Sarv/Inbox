// Role / generic / automated mailbox detection.
//
// A "role address" is a functional mailbox that belongs to an
// organization rather than a human being — info@, no-reply@, sales@,
// hr@, accounts@, support@, billing@, careers@, … These must never be
// treated as a PERSON: they should not be enriched as an individual,
// never receive a person_id, and never be merged with other contacts by
// a shared (company) phone number. They are legitimately a company's
// mailbox, so company-level enrichment (domain/org) is still fine.
//
// IMPORTANT: the renderer keeps a byte-identical copy of this regex in
// apps/desktop/src/services/contact-enrichment-service.ts — keep the two
// in sync. (The contact-enrichment helpers are deliberately not exported
// from the core barrel for the renderer; this detector lives in utils,
// which IS exported, so the node storage layer can share it.)

// Two tiers, because "role address" conflates two very different things:
//
//  1) NO-REPLY / machine mailboxes — a program sends these and NO human ever
//     signs them (noreply@, notifications@, mailer-daemon@, invoices@, orders@…).
//     There is no personal signature to mine, and their bodies are full of
//     transaction IDs / helplines a scraper would mistake for personal phones —
//     so we must NOT attempt individual enrichment.
//
//  2) HUMAN-STAFFED role mailboxes — a real person often mans these and signs
//     off with a full signature (hr@, sales@, support@, careers@, info@…). We
//     SHOULD mine the signature to surface the current signer's name/title/
//     company/phone. They stay shared mailboxes though, so they never get a
//     bound person_id or personal mobile (see contact-repository.applyEnrichment).
//
// IMPORTANT: the renderer keeps a byte-identical copy of BOTH patterns in
// apps/desktop/src/services/contact-enrichment-service.ts — keep them in sync.
const NOREPLY_LOCAL_PART_RE =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|reminders?|alerts?|alert|mailer|mailer-daemon|postmaster|bounces?|delivery|deliveries|automated|auto|system|root|daemon|cron|transactional|receipts?|statements?|invoices?|payments?|orders?|shipping|tracking|tickets?|news|newsletters?|updates?|digest|verify|verification|confirm|confirmation|subscribe|unsubscribe|abuse|webmaster|hostmaster|sysadmin|mail|email)([.\-_+].*)?$/i;

const HUMAN_ROLE_LOCAL_PART_RE =
  /^(billing|accounts?|accounting|finance|info|enquiry|enquiries|inquiry|contact|contactus|hello|help|helpdesk|support|care|customercare|customer-care|service|services|servicing|feedback|sales|marketing|promo|promotions?|offers?|deals?|hr|jobs|careers?|recruit|recruiting|recruitment|talent|hiring|admin|administrator|security|privacy|legal|compliance|team|office|membership)([.\-_+].*)?$/i;

function localPartOf(email: string | null | undefined): string {
  if (!email) return '';
  return email.split('@')[0]?.toLowerCase().trim() || '';
}

/**
 * True when the address is a role/generic/automated mailbox (not an individual
 * person). Union of BOTH tiers — used wherever we must never treat the mailbox
 * as a person (no bound person_id, no merge-by-shared-phone). Anchored on the
 * local-part, so a human whose name merely starts with a role word ("careen@",
 * "newsome@") is NOT caught — the word must be the whole local-part or be
 * followed by a separator (`.`, `-`, `_`, `+`).
 */
export function isRoleAddress(email: string | null | undefined): boolean {
  const local = localPartOf(email);
  if (!local) return false;
  return NOREPLY_LOCAL_PART_RE.test(local) || HUMAN_ROLE_LOCAL_PART_RE.test(local);
}

/**
 * True ONLY for the no-reply / machine tier — mailboxes that never carry a
 * human signature. Enrichment uses THIS (not isRoleAddress) to decide whether
 * to skip: a human-staffed role mailbox (hr@, sales@…) is a role address but
 * still worth mining a signature from.
 */
export function isNoReplyAddress(email: string | null | undefined): boolean {
  const local = localPartOf(email);
  if (!local) return false;
  return NOREPLY_LOCAL_PART_RE.test(local);
}
