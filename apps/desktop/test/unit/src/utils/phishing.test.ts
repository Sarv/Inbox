import { describe, it, expect } from 'vitest';

import { assessSender, assessPhishing, registrableDomain } from '../../../../src/utils/phishing';

describe('registrableDomain', () => {
  it('collapses subdomains to eTLD+1, including multi-part TLDs', () => {
    expect(registrableDomain('mail.paypal.com')).toBe('paypal.com');
    expect(registrableDomain('a.b.company.co.uk')).toBe('company.co.uk');
  });
  it('returns null for non-domains', () => {
    expect(registrableDomain('Advik')).toBeNull();
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain(null)).toBeNull();
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
  });
});

describe('assessPhishing (level rollup)', () => {
  it('is "none" for a clean sender', () => {
    expect(assessPhishing({ fromName: 'Advik Dutta', fromAddress: 'advik.d@sarv.com' }).level).toBe('none');
  });
  it('is "danger" when sender impersonation is present', () => {
    const a = assessPhishing({ fromName: 'security@paypal.com', fromAddress: 'x@evil.ru' });
    expect(a.level).toBe('danger');
    expect(a.reasons.length).toBeGreaterThan(0);
  });
  it('is "caution" for punycode-only', () => {
    expect(assessPhishing({ fromName: '', fromAddress: 'x@xn--paypa-9qa.com' }).level).toBe('caution');
  });
});
