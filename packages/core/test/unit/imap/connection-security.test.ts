import { describe, expect, it } from 'vitest';

import { resolveImplicitTls } from '../../../src/imap/imapflow-client';

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
