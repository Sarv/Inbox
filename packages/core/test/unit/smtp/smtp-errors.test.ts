import { describe, it, expect } from 'vitest';

import { isAuthTokenError, isTransientSendError } from '../../../src/smtp/smtp-errors';

describe('isAuthTokenError', () => {
  it('matches the Sarv expired-token phrasing (the reported failure)', () => {
    expect(isAuthTokenError('Invalid login: 500 invalid or expired token')).toBe(true);
  });

  it('matches common auth phrasings from a raw message string', () => {
    expect(isAuthTokenError('Invalid login')).toBe(true);
    expect(isAuthTokenError('535 Authentication failed')).toBe(true);
    expect(isAuthTokenError('AUTHENTICATIONFAILED')).toBe(true);
    expect(isAuthTokenError('invalid credentials')).toBe(true);
    expect(isAuthTokenError('token expired')).toBe(true);
  });

  it('matches on the SMTP 535 response code and EAUTH code', () => {
    expect(isAuthTokenError(Object.assign(new Error('x'), { responseCode: 535 }))).toBe(true);
    expect(isAuthTokenError(Object.assign(new Error('x'), { code: 'EAUTH' }))).toBe(true);
  });

  it('does NOT match unrelated failures', () => {
    expect(isAuthTokenError('Invalid recipient address(es): a@b.com')).toBe(false);
    expect(isAuthTokenError('Connection timed out')).toBe(false);
    expect(isAuthTokenError('550 Mailbox not found')).toBe(false);
    expect(isAuthTokenError(undefined)).toBe(false);
    expect(isAuthTokenError('')).toBe(false);
  });

  it('a 5xx token error is otherwise classified permanent by isTransientSendError (why the OAuth path must override it)', () => {
    const err = Object.assign(new Error('invalid or expired token'), { responseCode: 500 });
    expect(isTransientSendError(err)).toBe(false); // permanent → would dead-letter
    expect(isAuthTokenError(err)).toBe(true); // but recoverable via refresh+retry
  });
});

// This is the ONLY signal the outbox uses to choose "retry later" vs
// "dead-letter now", so a misclassification either loses mail (permanent when it
// was a hiccup) or hammers the server forever (transient when it was rejected).
describe('isTransientSendError', () => {
  it('treats a 4xx SMTP reply as transient (greylisting / mailbox busy)', () => {
    expect(isTransientSendError(Object.assign(new Error('450 try later'), { responseCode: 450 }))).toBe(true);
    expect(isTransientSendError(Object.assign(new Error('421 too busy'), { responseCode: 421 }))).toBe(true);
  });

  it('treats every 5xx SMTP reply as permanent', () => {
    for (const responseCode of [500, 535, 550, 553, 554]) {
      expect(isTransientSendError(Object.assign(new Error('rejected'), { responseCode })), String(responseCode)).toBe(false);
    }
  });

  it('treats nodemailer transport codes with no server reply as transient', () => {
    for (const code of ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS']) {
      expect(isTransientSendError(Object.assign(new Error('transport'), { code })), code).toBe(true);
    }
  });

  it('falls back to the shared network / rate-limit classifiers', () => {
    expect(isTransientSendError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientSendError(new Error('Not connected to SMTP server'))).toBe(true);
    expect(isTransientSendError(new Error('Too many messages, please try again later'))).toBe(true);
  });

  it('treats an unknown failure as permanent so a bad message is not retried forever', () => {
    expect(isTransientSendError(new Error('something entirely unexpected'))).toBe(false);
  });

  it('is false for anything that is not an Error', () => {
    expect(isTransientSendError('ETIMEDOUT')).toBe(false);
    expect(isTransientSendError(undefined)).toBe(false);
    expect(isTransientSendError({ code: 'ESOCKET' })).toBe(false);
  });
});
