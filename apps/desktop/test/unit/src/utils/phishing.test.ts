import { describe, it, expect } from 'vitest';

import { assessSender, assessPhishing, registrableDomain } from '../../../../src/utils/phishing';

// registrableDomain / assessSender are re-exported from core's sender-spoof
// module and pinned in packages/core/test/unit/utils/sender-spoof.test.ts. What
// stays here is the renderer's own roll-up and the fact that the re-export
// still answers to this module's name — callers and the shield import it here.
describe('re-exports from core', () => {
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
