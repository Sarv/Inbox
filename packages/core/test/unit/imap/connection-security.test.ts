import { describe, expect, it } from 'vitest';

import { imapFlowSecurityOptions, resolveImplicitTls } from '../../../src/imap/imapflow-client';

// Connection-security mapping. Getting this wrong either blocks self-hosted
// STARTTLS-on-143 servers (the gap this closes) or silently opens plaintext when
// the user asked for SSL. The `security` field must win over the legacy boolean.

describe('resolveImplicitTls', () => {
  it("only 'ssl' opens implicit TLS (993)", () => {
    expect(resolveImplicitTls({ security: 'ssl', secure: false })).toBe(true);   // security wins over the boolean
    expect(resolveImplicitTls({ security: 'starttls', secure: true })).toBe(false); // starttls => plain connect + upgrade
    expect(resolveImplicitTls({ security: 'none', secure: true })).toBe(false);
  });

  it('falls back to the legacy `secure` boolean when `security` is absent', () => {
    expect(resolveImplicitTls({ secure: true })).toBe(true);
    expect(resolveImplicitTls({ secure: false })).toBe(false);
  });
});

// What ImapFlow is told (CASA M-5). Breaks: a STARTTLS account continues in
// cleartext when the upgrade is stripped (no doSTARTTLS), an SSL account fails
// with ImapFlow's "Misconfiguration" (doSTARTTLS with secure), or an explicit
// 'none' refuses even an offered upgrade (doSTARTTLS:false).
describe('imapFlowSecurityOptions', () => {
  it('requires the STARTTLS upgrade only for starttls, and never with implicit TLS', () => {
    expect(imapFlowSecurityOptions({ security: 'ssl', secure: false })).toEqual({ secure: true });
    expect(imapFlowSecurityOptions({ security: 'starttls', secure: true })).toEqual({ secure: false, doSTARTTLS: true });
    expect(imapFlowSecurityOptions({ security: 'none', secure: true })).toEqual({ secure: false });
  });

  // Changed deliberately: a legacy secure:false account now REQUIRES the upgrade.
  it('requires it for a legacy secure:false account, and for OAuth even when the config says none', () => {
    expect(imapFlowSecurityOptions({ secure: false })).toEqual({ secure: false, doSTARTTLS: true });
    expect(imapFlowSecurityOptions({ secure: true })).toEqual({ secure: true });
    expect(imapFlowSecurityOptions({ security: 'none', secure: false, authMethod: 'oauth2' })).toEqual({ secure: false, doSTARTTLS: true });
  });
});
