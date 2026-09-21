import { describe, it, expect } from 'vitest';

import type { OtpDetection } from '../../src/otp-detect';
import {
  MAX_NOTIFY_AGE_MS,
  buildOtpNotification,
  isFreshEnoughToNotify,
  notificationId,
  receivedAtMs,
  senderLabel,
} from '../../src/otp-notification';

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;

const detection: OtpDetection = {
  code: '483920',
  confidence: 0.9,
  source: 'body',
  expiresInMs: 5 * 60 * 1000,
  expiryFromMail: true,
};

describe('receivedAtMs', () => {
  // Regression: EmailRecord stores seconds, the notification takes UTC epoch
  // milliseconds. A missing x1000 puts every card 54 years in the past and the
  // freshness gate then silences the extension completely.
  it('converts stored seconds to epoch milliseconds', () => {
    expect(receivedAtMs({ date: NOW_SECONDS, receivedDate: null })).toBe(NOW);
  });

  // Regression: a sender with a wrong clock must not be able to make an old
  // code look fresh — our own receive time wins whenever we have it.
  it('prefers our receive time over the sender Date header', () => {
    expect(receivedAtMs({ date: 1, receivedDate: NOW_SECONDS })).toBe(NOW);
  });

  // Regression: absent or nonsensical timestamps must not become epoch 0 or
  // NaN, both of which slip past a naive comparison.
  it.each([
    ['zero', { date: 0, receivedDate: null }],
    ['negative', { date: -5, receivedDate: null }],
    ['not a number', { date: Number.NaN, receivedDate: null }],
  ])('returns null for %s timestamps', (_label, email) => {
    expect(receivedAtMs(email)).toBeNull();
  });
});

describe('isFreshEnoughToNotify', () => {
  // Regression: this gate is what stops a first sync of a large mailbox firing
  // a burst of cards for codes that expired months ago.
  it('rejects mail older than the window', () => {
    const old = { date: (NOW - MAX_NOTIFY_AGE_MS - 1000) / 1000, receivedDate: null };
    expect(isFreshEnoughToNotify(old, NOW)).toBe(false);
  });

  // Regression: mail that just landed is the whole reason the extension exists.
  it('accepts mail that just arrived', () => {
    expect(isFreshEnoughToNotify({ date: NOW_SECONDS, receivedDate: null }, NOW)).toBe(true);
  });

  // Regression: exactly at the boundary must stay inclusive, so a code that
  // arrives at the edge of the window is not silently dropped.
  it('accepts mail exactly at the window boundary', () => {
    const edge = { date: (NOW - MAX_NOTIFY_AGE_MS) / 1000, receivedDate: null };
    expect(isFreshEnoughToNotify(edge, NOW)).toBe(true);
  });

  // Regression: a sender clock running fast is common. Treating a future date
  // as stale would hide real codes from whole providers.
  it('accepts mail dated in the future', () => {
    const future = { date: (NOW + 60_000) / 1000, receivedDate: null };
    expect(isFreshEnoughToNotify(future, NOW)).toBe(true);
  });

  // Regression: with no usable timestamp we cannot tell fresh from archived,
  // so we stay quiet rather than interrupt on a guess.
  it('rejects mail with no usable timestamp', () => {
    expect(isFreshEnoughToNotify({ date: 0, receivedDate: null }, NOW)).toBe(false);
  });
});

describe('senderLabel', () => {
  // Regression: the card's only context is who sent the code; an empty line
  // makes a phishing code indistinguishable from a real one.
  it.each([
    ['display name', { fromName: 'Sarv Security', fromAddress: 'no-reply@sarv.com' }, 'Sarv Security'],
    ['address when unnamed', { fromName: null, fromAddress: 'no-reply@sarv.com' }, 'no-reply@sarv.com'],
    ['address when the name is blank', { fromName: '   ', fromAddress: 'no-reply@sarv.com' }, 'no-reply@sarv.com'],
    ['a placeholder when neither is set', { fromName: null, fromAddress: '' }, 'Unknown sender'],
  ])('uses the %s', (_label, email, expected) => {
    expect(senderLabel(email)).toBe(expected);
  });
});

describe('buildOtpNotification', () => {
  const email = {
    id: 'email-1',
    accountId: 'account-1',
    fromName: 'Sarv Security',
    fromAddress: 'no-reply@sarv.com',
  };

  // Regression: the id must be derived from the email, because re-notifying
  // with the same id REPLACES the card. A random id stacks a second card on
  // the body-stage re-run.
  it('derives a stable id from the email', () => {
    expect(buildOtpNotification(email, detection, NOW).id).toBe(notificationId('email-1'));
    expect(buildOtpNotification(email, detection, NOW + 5_000).id).toBe(notificationId('email-1'));
  });

  // Regression: expiry is sent as an absolute UTC instant so the renderer can
  // run the countdown without knowing when detection happened. A relative
  // duration here would restart the countdown on every re-render.
  it('sends an absolute expiry instant', () => {
    expect(buildOtpNotification(email, detection, NOW).expiresAt).toBe(NOW + detection.expiresInMs);
  });

  // Regression: the copy button is the point of the card. Losing `copyable`
  // sends the user back into the email to select six digits by hand.
  it('marks the code copyable and emphasised', () => {
    const [field] = buildOtpNotification(email, detection, NOW).fields ?? [];
    expect(field).toEqual({ label: 'Code', value: '483920', copyable: true, emphasis: true });
  });

  // Regression: clicking the card opens the mail, which needs both ids on a
  // multi-account setup — otherwise it opens the wrong account's message.
  it('carries the email and account ids', () => {
    const card = buildOtpNotification(email, detection, NOW);
    expect(card.emailId).toBe('email-1');
    expect(card.accountId).toBe('account-1');
  });

  // Regression: a single-account record has no accountId; emitting the key as
  // undefined fails the host's sanitizer shape check.
  it('omits the account id when the email has none', () => {
    const card = buildOtpNotification({ ...email, accountId: undefined }, detection, NOW);
    expect('accountId' in card).toBe(false);
  });
});
