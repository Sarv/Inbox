/**
 * Display-name impersonation — the ONE implementation.
 *
 * `support@paypal.com` as the friendly name on a message that actually came
 * from attacker@evil.ru is the oldest phishing tell there is, and it is decided
 * from the From header alone, so it is available before a body is downloaded.
 * Two callers need the same answer: the renderer's shield and warning banner
 * (on a message the user is reading) and the sync-time spam filter (on a
 * message that has just arrived). Until this file existed the logic lived in
 * the renderer only, so the spam filter would have had to copy it — and two
 * copies of a security rule drift, in exactly the direction nobody notices.
 *
 * Renderer-safe by construction: its only import is `tldts`, which is pure and
 * browser-safe. The renderer deep-imports it as `@sarvinbox/core/sender-spoof`
 * (see apps/desktop/vite/renderer-aliases.ts), never through the core barrel.
 *
 * Domain comparison is done on the registrable domain (eTLD+1), so
 * `mail.paypal.com` vs `paypal.com` is NOT flagged, while `paypal.com` vs
 * `paypal.secure-login.ru` is.
 */
import { getDomain } from 'tldts';

export interface PhishingReason {
  /** 'danger' escalates the banner to red; 'caution' is amber. */
  severity: 'danger' | 'caution';
  text: string;
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
export function domainOfAddress(address: string | null | undefined): string | null {
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
export function domainsInText(text: string | null | undefined): string[] {
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
