
import { assessSender, registrableDomain } from '@sarv-in/email-spam-scan/identity';
import { assessPhishing } from '@sarv-in/email-spam-scan/links';
import { describe, it, expect } from 'vitest';

// `src/utils/phishing.ts` was the renderer's copy of these rules; it is now
// `@sarv-in/email-spam-scan`, the open-source library the sync-time filter
// shares. The library pins each rule in its own suite — what this file keeps
// guarding is the SWAP: that the package the shield and the banner now import
// still answers the three questions this app asked of the module it replaced.
// If a version bump changes one of these answers, it fails here, in the app,
// rather than being noticed in a screenshot.
describe('the extracted rules, as this app consumes them', () => {
  it('still exposes registrableDomain and assessSender', () => {
    expect(registrableDomain('mail.paypal.com')).toBe('paypal.com');
    expect(assessSender('support@paypal.com', 'attacker@evil.ru')[0]?.severity).toBe('danger');
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
