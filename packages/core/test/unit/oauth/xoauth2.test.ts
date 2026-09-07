import { describe, it, expect } from 'vitest';

import { buildXOAuth2Token } from '../../../src/oauth/xoauth2';

// The SASL XOAUTH2 payload is byte-exact by spec:
//   base64("user=" <email> \x01 "auth=Bearer " <token> \x01 \x01)
// A single wrong byte (missing \x01, only one trailing separator, a stray
// space, latin1 instead of utf8) makes Gmail/Sarv IMAP+SMTP answer
// AUTHENTICATIONFAILED for every account — indistinguishable from an expired
// token, so it would be misdiagnosed as "needs re-login".

const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

describe('buildXOAuth2Token', () => {
  it('produces exactly base64("user=<email>\\x01auth=Bearer <token>\\x01\\x01")', () => {
    const token = buildXOAuth2Token('user@example.com', 'ya29.a0AfB_abc');

    expect(decode(token)).toBe('user=user@example.com\x01auth=Bearer ya29.a0AfB_abc\x01\x01');
    // Byte-for-byte, independently encoded — catches any reordering of the parts.
    expect(token).toBe(
      Buffer.from('user=user@example.com\x01auth=Bearer ya29.a0AfB_abc\x01\x01', 'utf8').toString('base64'),
    );
  });

  // The separator must be SOH (0x01) and there must be TWO at the end — the
  // second terminates the (empty) list of extra SASL params. Servers hang or
  // reject when it is missing.
  it('uses 0x01 separators with exactly two terminating ones', () => {
    const raw = decode(buildXOAuth2Token('a@b.com', 'tok'));

    expect(raw.split('\x01')).toEqual(['user=a@b.com', 'auth=Bearer tok', '', '']);
    expect(raw.endsWith('\x01\x01')).toBe(true);
    expect(raw).not.toContain('\n');
    expect(raw).not.toContain('\r');
  });

  // Real mailboxes contain +, dots, dashes, apostrophes and non-ASCII (SMTPUTF8
  // / Sarv internationalised addresses). Anything that escapes, strips or
  // latin1-truncates them locks those users out.
  it('preserves special and non-ASCII characters in the email verbatim', () => {
    const emails = [
      'user+imap.tag@example.co.uk',
      "o'brien@example.com",
      'first_last-99@sub.domain.example',
      'ünïcodé@exämple.com',
      '用户@例子.中国',
    ];

    for (const email of emails) {
      const raw = decode(buildXOAuth2Token(email, 'tok'));
      expect(raw).toBe(`user=${email}\x01auth=Bearer tok\x01\x01`);
      expect(raw).toContain(email); // no escaping / percent-encoding applied
    }
  });

  // Non-ASCII must be UTF-8 bytes (not latin1): '@' after a multi-byte name
  // shifts position, which is exactly how a latin1 regression shows up.
  it('encodes non-ASCII emails as UTF-8 bytes', () => {
    const email = 'ünïcodé@exämple.com';
    const token = buildXOAuth2Token(email, 'tok');

    expect(Buffer.from(token, 'base64')).toEqual(
      Buffer.from(`user=${email}\x01auth=Bearer tok\x01\x01`, 'utf8'),
    );
  });

  // JWT access tokens are long, contain dots/dashes/underscores and must not be
  // wrapped, trimmed or re-encoded.
  it('passes a long JWT-shaped access token through untouched', () => {
    const jwt = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${'x'.repeat(600)}-_.sIgNaTuRe`;
    const raw = decode(buildXOAuth2Token('a@b.com', jwt));

    expect(raw).toBe(`user=a@b.com\x01auth=Bearer ${jwt}\x01\x01`);
    expect(buildXOAuth2Token('a@b.com', jwt)).not.toMatch(/[\r\n]/); // no base64 line wrapping
  });

  // Degenerate inputs must still yield the canonical shape (the single space
  // after "Bearer" is part of the grammar) rather than a subtly different
  // string the server would reject in a confusing way.
  it('keeps the canonical shape for empty email/token', () => {
    expect(decode(buildXOAuth2Token('', ''))).toBe('user=\x01auth=Bearer \x01\x01');
    expect(decode(buildXOAuth2Token('a@b.com', ''))).toBe('user=a@b.com\x01auth=Bearer \x01\x01');
  });

  it('returns standard (padded, non-url) base64 as the SASL wire format requires', () => {
    const token = buildXOAuth2Token('user@example.com', 'abc');

    expect(token).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
