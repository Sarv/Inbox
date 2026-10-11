import { describe, expect, it } from 'vitest';

import { isAuthError, isConnectionError, isQuotaError, isRateLimited } from '../../../src/imap/imap-errors';
import { isAuthTokenError, isTransientSendError } from '../../../src/smtp/smtp-errors';
import { resolveConnectionSecurity, starttlsUnavailableMessage } from '../../../src/utils/connection-security';

// The ONE rule for how a mail connection is secured (CASA M-5), shared by the
// IMAP client, the SMTP client and the account forms. What breaks if this file
// fails: a STARTTLS account can again be stripped to cleartext, a user's
// explicit "None" is overruled, or a config that says nothing sensible quietly
// drops encryption.

describe('resolveConnectionSecurity', () => {
  // The user's explicit choice wins over the legacy boolean, either way.
  it('uses `security` when it is one of the three modes', () => {
    expect(resolveConnectionSecurity({ security: 'ssl', secure: false })).toBe('ssl');
    expect(resolveConnectionSecurity({ security: 'starttls', secure: true })).toBe('starttls');
    expect(resolveConnectionSecurity({ security: 'none', secure: true })).toBe('none');
  });

  // Every account saved before `security` existed. Changed deliberately:
  // secure:false means STARTTLS REQUIRED now, not "upgrade if offered".
  it('derives it from the legacy `secure` boolean when absent', () => {
    expect(resolveConnectionSecurity({ secure: true })).toBe('ssl');
    expect(resolveConnectionSecurity({ secure: false })).toBe('starttls');
    expect(resolveConnectionSecurity({})).toBe('ssl');
  });

  // Breaks: a corrupt or future value silently means "no encryption".
  it('never resolves an unknown value to none', () => {
    for (const security of ['NONE', 'plain', '', null, 1, {}]) {
      expect(resolveConnectionSecurity({ security, secure: false })).toBe('starttls');
      expect(resolveConnectionSecurity({ security, secure: true })).toBe('ssl');
    }
  });

  // Breaks: an OAuth token rides an unencrypted session because a config —
  // stale, or sent by a compromised window — said 'none'.
  it('never resolves an OAuth account to none', () => {
    expect(resolveConnectionSecurity({ security: 'none', secure: false, authMethod: 'oauth2' })).toBe('starttls');
    expect(resolveConnectionSecurity({ security: 'none', secure: false, authMethod: 'password' })).toBe('none');
  });
});

describe('starttlsUnavailableMessage', () => {
  const messages = [starttlsUnavailableMessage('incoming', 'imap.x.com'), starttlsUnavailableMessage('outgoing', 'smtp.x.com')];

  it('names the server and says what the user can change', () => {
    expect(messages[0]).toContain('The incoming mail server imap.x.com did not agree to encrypt');
    expect(messages[1]).toContain('The outgoing mail server smtp.x.com');
    for (const message of messages) {
      expect(message).toContain('stopped before sending your password');
      expect(message).toContain('set Connection security to None');
    }
  });

  // The classifiers read message text. Breaks: the refusal is retried forever
  // as a network blip, or treated as a rejected password (which forgets the
  // saved account and asks the user to sign in again).
  it('does not read as a network blip, a rejected password, a quota or a rate limit', () => {
    for (const message of messages) {
      const error = new Error(message);
      expect(isConnectionError(error)).toBe(false);
      expect(isAuthError(error)).toBe(false);
      expect(isQuotaError(error)).toBe(false);
      expect(isRateLimited(error)).toBe(false);
      expect(isTransientSendError(error)).toBe(false);
      expect(isAuthTokenError(error)).toBe(false);
    }
  });
});
