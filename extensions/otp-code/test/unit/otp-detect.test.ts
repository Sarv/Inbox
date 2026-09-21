import { describe, it, expect } from 'vitest';

import {
  detectOtpCode,
  parseStatedExpiry,
  DEFAULT_EXPIRY_MS,
  MAX_SCAN_CHARS,
  MIN_CONFIDENCE,
} from '../../src/otp-detect';

describe('detectOtpCode', () => {
  // Regression: the commonest OTP mail of all puts the code in the subject.
  // If this stops matching, the code no longer surfaces before the body is
  // fetched — which is the entire point of running on arrival.
  it('finds a code in the subject', () => {
    const detection = detectOtpCode({ subject: '284917 is your Sarv verification code', body: '' });
    expect(detection?.code).toBe('284917');
    expect(detection?.source).toBe('subject');
    expect(detection?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  // Regression: codes that only appear in the body must still be found once it
  // has been downloaded, otherwise the body-stage re-run does nothing.
  it('finds a code in the body', () => {
    const detection = detectOtpCode({ subject: 'Security alert', body: 'Your verification code is 483920.' });
    expect(detection?.code).toBe('483920');
    expect(detection?.source).toBe('body');
  });

  // Regression: Google and others split the code with a space or hyphen. Read
  // as two 3-digit runs it scores nothing, and the user sees no card.
  it.each([
    ['space', 'Your verification code is 123 456'],
    ['hyphen', 'Your verification code is 123-456'],
  ])('joins a grouped code separated by a %s', (_label, body) => {
    expect(detectOtpCode({ body })?.code).toBe('123456');
  });

  // Regression: alphanumeric codes (GitHub, Steam) are a real format; dropping
  // them silently halves the extension's coverage.
  it('finds an uppercase alphanumeric code', () => {
    expect(detectOtpCode({ body: 'Your login code is G-4F7K2A' })?.code).toBe('4F7K2A');
  });

  // Regression: a number with no passcode wording near it is just a number.
  // Without the keyword requirement every order confirmation pops a card.
  it('returns null when no passcode keyword sits near the number', () => {
    expect(detectOtpCode({ subject: 'Invoice 483920 attached', body: 'Total due within 30 days.' })).toBeNull();
  });

  // Regression: "verification" plus a year is a footer, not a code. The year
  // penalty is what keeps copyright lines out of the notification surface.
  it('rejects a four-digit year even beside a keyword', () => {
    expect(detectOtpCode({ body: 'Verification service, copyright 2024' })).toBeNull();
  });

  // Regression: neighbour characters are the cheapest way to tell a passcode
  // from money, a percentage, a time or a URL fragment. Each of these produced
  // a false card before the neighbour check existed.
  it.each([
    ['a price', 'Your verification code order total $123456'],
    ['a percentage', 'Your verification code discount 123456%'],
    ['a URL path', 'Your verification code at https://example.com/123456'],
    ['a query value', 'Your verification code link ?ref=123456'],
  ])('rejects %s', (_label, body) => {
    expect(detectOtpCode({ body })).toBeNull();
  });

  // Regression: "code is 483920." — a code ending a sentence. Treating the
  // full stop as a decimal point rejected the commonest wording in the format.
  it('accepts a code that ends a sentence', () => {
    expect(detectOtpCode({ body: 'Your verification code is 483920.' })?.code).toBe('483920');
  });

  // Regression: a full stop or colon followed by a digit really is a decimal,
  // a version or a clock time, and must still be rejected.
  it.each([
    ['a decimal amount', 'Your verification code invoice 123456.75'],
    ['a version number', 'Your verification code build 123456.2'],
  ])('rejects %s', (_label, body) => {
    expect(detectOtpCode({ body })).toBeNull();
  });

  // Regression: the subject is the higher-signal location and arrives first;
  // if the body could outrank it the card would flip codes mid-countdown.
  it('prefers the subject when both carry a code', () => {
    const detection = detectOtpCode({
      subject: 'Your verification code is 111111',
      body: 'Your verification code is 222222',
    });
    expect(detection?.code).toBe('111111');
    expect(detection?.source).toBe('subject');
  });

  // Regression: scanning is bounded so a multi-megabyte newsletter cannot
  // stall the main thread. A code past the bound is deliberately not found.
  it('does not scan past MAX_SCAN_CHARS', () => {
    const padding = 'a'.repeat(MAX_SCAN_CHARS + 50);
    expect(detectOtpCode({ body: `${padding} your verification code is 483920` })).toBeNull();
  });

  // Regression: mail arrives with missing/empty fields constantly; a throw here
  // fails the whole workflow run for that message.
  it.each([
    ['both missing', {}],
    ['both null', { subject: null, body: null }],
    ['both empty', { subject: '', body: '' }],
  ])('returns null for %s', (_label, input) => {
    expect(detectOtpCode(input)).toBeNull();
  });

  // Regression: the countdown is the feature. When the mail states its own
  // validity we must use it, and say that we did.
  it('uses the validity the mail states', () => {
    const detection = detectOtpCode({ body: 'Your verification code is 483920. It expires in 5 minutes.' });
    expect(detection?.expiresInMs).toBe(5 * 60 * 1000);
    expect(detection?.expiryFromMail).toBe(true);
  });

  // Regression: without a stated validity we must still show a countdown, but
  // must not claim the mail said so.
  it('falls back to the default validity', () => {
    const detection = detectOtpCode({ body: 'Your verification code is 483920.' });
    expect(detection?.expiresInMs).toBe(DEFAULT_EXPIRY_MS);
    expect(detection?.expiryFromMail).toBe(false);
  });

  // Regression: the code is often in the subject while the validity is only in
  // the body. Reading one source only loses the real expiry.
  it('reads the validity from the body when the code is in the subject', () => {
    const detection = detectOtpCode({
      subject: '284917 is your verification code',
      body: 'This code is valid for 30 seconds.',
    });
    expect(detection?.code).toBe('284917');
    expect(detection?.expiresInMs).toBe(30_000);
  });
});

describe('parseStatedExpiry', () => {
  // Regression: every unit the phrase regex accepts must convert correctly —
  // a minutes/seconds mix-up shows a 10-second countdown for a 10-minute code.
  it.each([
    ['expires in 45 seconds', 45_000],
    ['valid for 90 sec', 90_000],
    ['expires in 10 minutes', 10 * 60 * 1000],
    ['good for 5 min', 5 * 60 * 1000],
    ['valid within 2 hours', 2 * 3_600_000],
    ['expires in 1 hr', 3_600_000],
  ])('parses %s', (text, expected) => {
    expect(parseStatedExpiry(text)).toBe(expected);
  });

  // Regression: text with no validity statement must return null so the caller
  // falls back to the default rather than to NaN.
  it('returns null when no validity is stated', () => {
    expect(parseStatedExpiry('Your verification code is 483920.')).toBeNull();
  });

  // Regression: a zero or malformed amount must not produce an already-expired
  // card that vanishes the instant it appears.
  it('returns null for a zero duration', () => {
    expect(parseStatedExpiry('expires in 0 minutes')).toBeNull();
  });
});
