// Lightweight, renderer-local phishing heuristics for the warning banner.
//
// Kept renderer-side (not in @sarvinbox/core) for the same reason as
// email-address.ts: importing a runtime value from the Node-only core barrel
// pulls imapflow/mailparser into the browser bundle and blanks the renderer.
//
// We deliberately do NOT use the stored `authStatus` (SPF/DKIM/DMARC): raw
// headers are not persisted, so that field is parsed from the body and is
// effectively always "none/unknown" — using it would be security theatre. The
// two signals below are computed from data we DO have and are the classic,
// high-signal phishing tells:
//   1. Sender-name domain impersonation — the friendly name references one
//      brand/domain while the mail was actually sent from another.
//   2. Deceptive links — an anchor whose visible text is a domain/URL that
//      points somewhere else entirely.
// Domain comparison is done on the registrable domain (eTLD+1) via `tldts`, so
// `mail.paypal.com` vs `paypal.com` is NOT flagged, while `paypal.com` vs
// `paypal.secure-login.ru` is.

import { getDomain } from 'tldts';

export type PhishingLevel = 'none' | 'caution' | 'danger';

export interface PhishingReason {
  /** 'danger' escalates the banner to red; 'caution' is amber. */
  severity: 'danger' | 'caution';
  text: string;
}

export interface PhishingAssessment {
  level: PhishingLevel;
  reasons: PhishingReason[];
}

/**
 * Registrable domain (eTLD+1), lowercased — e.g. `a.b.paypal.co.uk` → `paypal.co.uk`.
 * Returns null for inputs that aren't a resolvable public domain (bare words,
 * IPs handled by tldts, empty). `allowPrivateDomains:false` keeps things like
 * `github.io` collapsing to their true registrable owner where appropriate.
 */
export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const host = input.trim().toLowerCase();
  if (!host) return null;
  const d = getDomain(host, { allowPrivateDomains: false });
  return d || null;
}

/** Registrable domain of an email address (part after the last `@`). */
function domainOfAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  return registrableDomain(address.slice(at + 1));
}

/**
 * Registrable domains referenced inside a free-text display name. We tokenise on
 * separators (no heavy regex) and let tldts decide which tokens are real
 * domains — a token like `Advik` yields null and is ignored, while `paypal.com`
 * or `security@paypal.com` yields `paypal.com`.
 */
function domainsInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const rawToken of text.split(/[\s<>(),;:"'|]+/)) {
    const token = rawToken.trim();
    if (!token) continue;
    // If the token is (or contains) an email, keep the host side.
    const candidate = token.includes('@') ? token.slice(token.lastIndexOf('@') + 1) : token;
    // A token must actually look like a hostname (contain a dot) — this stops
    // tldts from resolving a bare word against its "no-dot" fallbacks.
    if (!candidate.includes('.')) continue;
    const d = registrableDomain(candidate);
    if (d) out.add(d);
  }
  return [...out];
}

/**
 * Common ESP / link-tracker / URL-shortener registrable domains. Legitimate
 * marketing mail routinely wraps links through these, so a "text says brand.com,
 * href is <esp>" mismatch there is expected, not deceptive — skip them to keep
 * the banner meaningful (fires rarely, so users trust it).
 */
const LINK_WRAPPER_DOMAINS = new Set<string>([
  'sendgrid.net', 'sparkpostmail.com', 'mandrillapp.com', 'mailchimp.com',
  'list-manage.com', 'mailgun.org', 'amazonses.com', 'rs6.net', 'createsend.com',
  'cmail19.com', 'cmail20.com', 'hubspotlinks.com', 'hs-sending.com', 'hubspot.com',
  'sendible.com', 'exct.net', 'salesforce.com', 'marketo.com', 'pardot.com',
  'bit.ly', 't.co', 'lnkd.in', 'goo.gl', 'ow.ly', 'tinyurl.com', 'hubs.ly',
  'doubleclick.net', 'safelinks.protection.outlook.com', 'google.com',
]);

/**
 * Assess the sender identity from the (always-available) From name + address.
 * DANGER when the display name references a different registrable domain than
 * the one the mail was sent from (classic display-name spoof); CAUTION when the
 * sender domain is punycode/IDN (possible homograph of a real brand).
 */
export function assessSender(fromName: string | null | undefined, fromAddress: string | null | undefined): PhishingReason[] {
  const reasons: PhishingReason[] = [];
  const senderDomain = domainOfAddress(fromAddress);
  if (!senderDomain) return reasons;

  const nameDomains = domainsInText(fromName).filter((d) => d !== senderDomain);
  if (nameDomains.length > 0) {
    reasons.push({
      severity: 'danger',
      text: `The sender name mentions ${nameDomains.join(', ')}, but this email was actually sent from ${senderDomain}.`,
    });
  }

  if (senderDomain.includes('xn--')) {
    reasons.push({
      severity: 'caution',
      text: `The sender domain "${senderDomain}" uses punycode, which can be used to imitate a well-known brand.`,
    });
  }

  return reasons;
}

/**
 * Scan HTML for links whose VISIBLE TEXT is a domain/URL pointing at a different
 * registrable domain than the actual href — the hallmark of a deceptive link.
 * Skips wrapper/tracker domains (see LINK_WRAPPER_DOMAINS) and non-web schemes.
 * Requires a DOM parser (renderer only). Returns at most a few, de-duplicated.
 */
/** One deceptive link: the domain the text shows vs the domain the href goes to. */
export interface LinkMismatch {
  shown: string;
  actual: string;
}

/**
 * Every anchor whose visible text names one registrable domain while its href
 * goes to another — the structured form, so callers can act on the PAIR (trust
 * it, block it, list it) rather than only render a sentence about it.
 * `assessLinks` is built on this. Skips wrapper/tracker domains and non-web
 * schemes; de-duplicated; capped at a few per message.
 */
export function linkMismatches(html: string | null | undefined): LinkMismatch[] {
  if (!html || typeof DOMParser === 'undefined') return [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: LinkMismatch[] = [];
  doc.querySelectorAll('a[href]').forEach((a) => {
    if (out.length >= 3) return;
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    let actual: string | null = null;
    try {
      actual = registrableDomain(new URL(href).hostname);
    } catch {
      return;
    }
    if (!actual || LINK_WRAPPER_DOMAINS.has(actual)) return;
    for (const shown of domainsInText(a.textContent)) {
      if (shown === actual || LINK_WRAPPER_DOMAINS.has(shown)) continue;
      const key = `${shown}->${actual}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ shown, actual });
      break;
    }
  });
  return out;
}

export function assessLinks(html: string | null | undefined): PhishingReason[] {
  return linkMismatches(html).map(({ shown, actual }) => ({
    severity: 'caution' as const,
    text: `A link that appears to go to ${shown} actually points to ${actual}.`,
  }));
}


/**
 * Combine every signal into one assessment. `level` is the max severity present
 * (danger > caution > none) so the banner can pick its colour, and `reasons`
 * lists each concrete tell for the user.
 */
export function assessPhishing(input: {
  fromName?: string | null;
  fromAddress?: string | null;
  html?: string | null;
}): PhishingAssessment {
  const reasons = [
    ...assessSender(input.fromName, input.fromAddress),
    ...assessLinks(input.html),
  ];
  const level: PhishingLevel = reasons.some((r) => r.severity === 'danger')
    ? 'danger'
    : reasons.length > 0
      ? 'caution'
      : 'none';
  return { level, reasons };
}
