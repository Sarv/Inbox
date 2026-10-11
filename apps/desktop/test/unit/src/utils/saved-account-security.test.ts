import { describe, expect, it } from 'vitest';

import { savedAccountSecurity } from '../../../../src/utils/saved-account-security';

// Settings → Accounts seeds its reconnect form from main's last-good saved
// config. Files saved before CASA M-5 have no `security`. Breaks: an account
// the user set to None reads back as STARTTLS (now required), so "Reconnect"
// is refused by a server that never had encryption.
describe('savedAccountSecurity', () => {
  const OLD_FILE = { username: 'me@x.com', host: 'mail.x.com', secure: false };

  it("takes the renderer's explicit choice for the same account when the file has none", () => {
    expect(savedAccountSecurity(OLD_FILE, { username: 'me@x.com', host: 'mail.x.com', security: 'none' })).toBe('none');
  });

  // Breaks: another account's None leaks onto this one and dials it unencrypted.
  it("never borrows another account's choice", () => {
    expect(savedAccountSecurity(OLD_FILE, { username: 'me@x.com', host: 'other.x.com', security: 'none' })).toBe('starttls');
    expect(savedAccountSecurity(OLD_FILE, { username: 'you@x.com', host: 'mail.x.com', security: 'none' })).toBe('starttls');
    expect(savedAccountSecurity(OLD_FILE, null)).toBe('starttls');
  });

  // Breaks: a newer file's own choice is overridden by a stale renderer copy.
  it('keeps a choice the file already has', () => {
    expect(savedAccountSecurity({ ...OLD_FILE, security: 'starttls' }, { username: 'me@x.com', host: 'mail.x.com', security: 'none' })).toBe('starttls');
  });

  it('resolves the legacy boolean when nobody knows better', () => {
    expect(savedAccountSecurity(OLD_FILE, { username: 'me@x.com', host: 'mail.x.com' })).toBe('starttls');
    expect(savedAccountSecurity({ ...OLD_FILE, secure: true }, null)).toBe('ssl');
  });
});
