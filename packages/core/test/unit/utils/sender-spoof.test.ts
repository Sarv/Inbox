import { assessSender, domainOfAddress, domainsInText, registrableDomain } from '@sarv-in/mailguard';
import { describe, expect, it } from 'vitest';


/**
 * Display-name impersonation — one rule for the shield and the spam filter.
 *
 * What this protects: `support@paypal.com <attacker@evil.ru>` is the classic
 * phish. These cases moved here from the renderer's phishing tests when the
 * logic moved into core; they pin BOTH sides — the spoof is caught, and an
 * ordinary human name, a brand word without a domain, or the sender's own
 * subdomain is not. A false positive here puts a red shield on a colleague.
 */
describe('registrableDomain', () => {
  it('collapses subdomains to eTLD+1, including multi-part TLDs', () => {
    expect(registrableDomain('mail.paypal.com')).toBe('paypal.com');
    expect(registrableDomain('a.b.company.co.uk')).toBe('company.co.uk');
    expect(registrableDomain(' MAIL.PayPal.com ')).toBe('paypal.com');
  });

  it('returns null for non-domains', () => {
    expect(registrableDomain('Advik')).toBeNull();
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('   ')).toBeNull();
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain(undefined)).toBeNull();
  });
});

describe('domainOfAddress', () => {
  it('takes the part after the LAST @ and collapses it', () => {
    expect(domainOfAddress('rc@mail.sarv.com')).toBe('sarv.com');
    expect(domainOfAddress('"odd@local"@sarv.com')).toBe('sarv.com');
  });
  it('is null without an @ or a resolvable host', () => {
    expect(domainOfAddress('not-an-email')).toBeNull();
    expect(domainOfAddress('x@localhost')).toBeNull();
    expect(domainOfAddress(null)).toBeNull();
  });
});

describe('domainsInText', () => {
  it('finds domains and the host side of embedded addresses, deduplicated', () => {
    expect(domainsInText('security@paypal.com via PayPal.com (paypal.com)')).toEqual(['paypal.com']);
  });
  it('ignores bare words — a name is not a domain', () => {
    expect(domainsInText('Advik Dutta')).toEqual([]);
    expect(domainsInText('')).toEqual([]);
    expect(domainsInText(null)).toEqual([]);
  });
});

describe('assessSender', () => {
  it('flags DANGER when the display name references a different registrable domain', () => {
    const r = assessSender('support@paypal.com', 'attacker@evil.ru');
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe('danger');
    expect(r[0].text).toContain('paypal.com');
    expect(r[0].text).toContain('evil.ru');
  });

  it('does NOT flag a subdomain of the sender domain in the name', () => {
    expect(assessSender('Amazon.com', 'ship@mail.amazon.com')).toEqual([]);
  });

  it('does NOT flag ordinary human display names', () => {
    expect(assessSender('Advik Dutta', 'advik.d@sarv.com')).toEqual([]);
    expect(assessSender('Meghna Kotak', 'meghna.k@sarv.com')).toEqual([]);
  });

  it('does NOT flag a brand word with no domain in the name', () => {
    // Conservative by design: a name like "PayPal Service" with no embedded
    // domain is NOT treated as impersonation (avoids false positives).
    expect(assessSender('PayPal Service', 'no-reply@paypal.com')).toEqual([]);
  });

  it('flags CAUTION for a punycode/IDN sender domain', () => {
    const r = assessSender('', 'billing@xn--paypa-9qa.com');
    expect(r).toHaveLength(1);
    expect(r[0].severity).toBe('caution');
  });

  it('returns nothing when the address has no parseable domain', () => {
    expect(assessSender('Somebody', 'not-an-email')).toEqual([]);
    expect(assessSender('security@paypal.com', null)).toEqual([]);
  });
});
