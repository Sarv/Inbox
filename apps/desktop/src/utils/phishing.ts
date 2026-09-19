// Renderer-side phishing heuristics for the shield and the warning banner.
//
// Two signals, both computed from data the client always has:
//   1. Sender-name domain impersonation — the friendly name references one
//      brand/domain while the mail was actually sent from another. This rule
//      lives in core (`sender-spoof.ts`) because the sync-time spam filter
//      applies the SAME rule when a message arrives; it is deep-imported here
//      as a renderer-safe subpath and re-exported for the callers and tests
//      that already know it by this module's name.
//   2. Deceptive links — an anchor whose visible text is a domain/URL that
//      points somewhere else entirely. Needs a DOM parser, so it stays here.
// The stored SPF/DKIM/DMARC verdict is a third, authoritative input, consumed
// by email-security.ts, which combines all three into the level.
//
// Kept out of the core BARREL for the same reason as email-address.ts:
// importing a runtime value from '@sarvinbox/core' pulls imapflow/mailparser
// into the browser bundle and blanks the renderer. Subpath imports are fine.
// Domain comparison is done on the registrable domain (eTLD+1) via `tldts`, so
// `mail.paypal.com` vs `paypal.com` is NOT flagged, while `paypal.com` vs
// `paypal.secure-login.ru` is.

import { assessSender, domainsInText, registrableDomain, type PhishingReason } from '@sarvinbox/core/sender-spoof';

export { assessSender, registrableDomain };
export type { PhishingReason };

export type PhishingLevel = 'none' | 'caution' | 'danger';

export interface PhishingAssessment {
  level: PhishingLevel;
  reasons: PhishingReason[];
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
