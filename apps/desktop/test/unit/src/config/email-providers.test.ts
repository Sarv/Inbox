import { describe, it, expect } from 'vitest';

import type { ConnectionSecurity } from '../../../../src/config/email-providers';
import { EMAIL_PROVIDERS, defaultPort } from '../../../../src/config/email-providers';

const byId = (id: string) => EMAIL_PROVIDERS.find((p) => p.id === id);

describe('EMAIL_PROVIDERS presets', () => {
  // These presets prefill the add-account wizard and the onboarding IMAP step.
  // A wrong host/port here is a hard connect failure the user cannot diagnose,
  // and the whole point of the single list is that no two screens drift.
  it('exposes the four supported providers with unique ids', () => {
    expect(EMAIL_PROVIDERS.map((p) => p.id)).toEqual(['gmail', 'outlook', 'yahoo', 'sarv']);
    expect(new Set(EMAIL_PROVIDERS.map((p) => p.id)).size).toBe(EMAIL_PROVIDERS.length);
  });

  it('pins Gmail to imap/smtp.gmail.com over implicit TLS', () => {
    expect(byId('gmail')).toMatchObject({
      imapHost: 'imap.gmail.com',
      imapPort: 993,
      imapSecurity: 'ssl',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      oauthProviderId: 'gmail',
    });
  });

  it('pins Outlook to STARTTLS on 587 for SMTP (office365 rejects implicit TLS)', () => {
    // The one preset whose SMTP is NOT 465/ssl — the reason defaultPort alone
    // can't be used to fill this form.
    expect(byId('outlook')).toMatchObject({
      imapHost: 'outlook.office365.com',
      imapPort: 993,
      imapSecurity: 'ssl',
      smtpHost: 'smtp.office365.com',
      smtpPort: 587,
      smtpSecurity: 'starttls',
      oauthProviderId: 'microsoft',
    });
  });

  it('pins Yahoo and Sarv to implicit TLS on both legs', () => {
    expect(byId('yahoo')).toMatchObject({
      imapHost: 'imap.mail.yahoo.com',
      smtpHost: 'smtp.mail.yahoo.com',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      oauthProviderId: 'yahoo',
    });
    expect(byId('sarv')).toMatchObject({
      imapHost: 'imap.sarv.com',
      smtpHost: 'smtp.sarv.com',
      smtpPort: 465,
      smtpSecurity: 'ssl',
      oauthProviderId: 'sarv',
    });
  });

  it('gives every preset a complete IMAP + SMTP pair (the wizard prefills both)', () => {
    for (const p of EMAIL_PROVIDERS) {
      expect(p.name).toBeTruthy();
      expect(p.imapHost).toMatch(/\./);
      expect(p.smtpHost).toMatch(/\./);
      expect(p.imapPort).toBeGreaterThan(0);
      expect(p.smtpPort).toBeGreaterThan(0);
      expect(['ssl', 'starttls', 'none']).toContain(p.imapSecurity);
      expect(['ssl', 'starttls', 'none']).toContain(p.smtpSecurity);
    }
  });

  it('declares an OAuth provider id for every preset that supports sign-in', () => {
    // The wizard surfaces the "Sign in with …" button off this field; a typo
    // silently downgrades the provider to password-only.
    expect(EMAIL_PROVIDERS.map((p) => p.oauthProviderId)).toEqual(['gmail', 'microsoft', 'yahoo', 'sarv']);
  });

  it('keeps each preset port consistent with defaultPort for its security mode', () => {
    // Outlook's STARTTLS SMTP is the only preset that differs from the ssl
    // default — everything else must agree with the shared helper, or the form
    // shows one port and the preset connects on another.
    for (const p of EMAIL_PROVIDERS) {
      expect(p.imapPort).toBe(defaultPort('imap', p.imapSecurity));
      expect(p.smtpPort).toBe(defaultPort('smtp', p.smtpSecurity));
    }
  });
});

describe('defaultPort', () => {
  // Drives the port field whenever the user flips the security dropdown.
  it('returns the standard IMAP ports', () => {
    expect(defaultPort('imap', 'ssl')).toBe(993);
    expect(defaultPort('imap', 'starttls')).toBe(143);
    expect(defaultPort('imap', 'none')).toBe(143);
  });

  it('returns the standard SMTP ports (implicit TLS / submission / plain)', () => {
    expect(defaultPort('smtp', 'ssl')).toBe(465);
    expect(defaultPort('smtp', 'starttls')).toBe(587);
    expect(defaultPort('smtp', 'none')).toBe(25);
  });

  it('never returns 0/NaN for an unexpected security value (falls back to plain)', () => {
    // Defensive: a stored config from an older build could carry an unknown mode.
    const bogus = 'tls' as ConnectionSecurity;
    expect(defaultPort('imap', bogus)).toBe(143);
    expect(defaultPort('smtp', bogus)).toBe(25);
  });
});
