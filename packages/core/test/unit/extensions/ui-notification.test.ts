import { describe, it, expect } from 'vitest';

import {
  sanitizeExtensionNotification,
  namespaceNotificationId,
  LIMITS,
  MAX_NOTIFICATION_LIFETIME_MS,
  MIN_NOTIFICATION_TIMEOUT_MS,
  MAX_NOTIFICATION_TIMEOUT_MS,
} from '../../../src/extensions/ui-notification';

const NOW = 1_700_000_000_000;

describe('sanitizeExtensionNotification', () => {
  // Regression: two extensions both calling their card "code" must not replace
  // or dismiss each other's card. Without namespacing they share one slot.
  it('namespaces the card id with the extension id', () => {
    const card = sanitizeExtensionNotification('otp-code', { id: 'code', title: 'Code' }, NOW);
    expect(card?.id).toBe('otp-code:code');
    expect(card?.extensionId).toBe('otp-code');
  });

  // Regression: a card with no id can never be replaced or dismissed, and one
  // with no title renders an empty box. Both are unusable, so both are dropped.
  it.each([
    ['no id', { title: 'Code' }],
    ['no title', { id: 'code' }],
    ['empty id', { id: '   ', title: 'Code' }],
    ['empty title', { id: 'code', title: '  ' }],
    ['not an object', 'nope'],
    ['null', null],
  ])('rejects a card with %s', (_label, input) => {
    expect(sanitizeExtensionNotification('otp-code', input, NOW)).toBeNull();
  });

  // Regression: an extension with a blank id would produce a card nobody can
  // attribute, and a dismiss that matches every extension's cards.
  it('rejects a blank extension id', () => {
    expect(sanitizeExtensionNotification('', { id: 'code', title: 'Code' }, NOW)).toBeNull();
  });

  // Regression: an extension returning a 10MB title would be passed straight
  // through IPC to the renderer and break the card layout (or the window).
  it('caps every text field at its limit', () => {
    const card = sanitizeExtensionNotification(
      'otp-code',
      {
        id: 'x'.repeat(500),
        title: 't'.repeat(500),
        body: 'b'.repeat(500),
        emailId: 'e'.repeat(500),
        accountId: 'a'.repeat(500),
        fields: [{ label: 'l'.repeat(500), value: 'v'.repeat(500) }],
      },
      NOW
    );
    expect(card!.id.length).toBe('otp-code:'.length + LIMITS.id);
    expect(card!.title.length).toBe(LIMITS.title);
    expect(card!.body!.length).toBe(LIMITS.body);
    expect(card!.emailId!.length).toBe(LIMITS.emailId);
    expect(card!.accountId!.length).toBe(LIMITS.accountId);
    expect(card!.fields![0].label.length).toBe(LIMITS.fieldLabel);
    expect(card!.fields![0].value.length).toBe(LIMITS.fieldValue);
  });

  // Regression: an unbounded `fields` array would render an infinitely tall card.
  it('keeps at most LIMITS.fields rows', () => {
    const fields = Array.from({ length: 50 }, (_, i) => ({ label: `l${i}`, value: `v${i}` }));
    const card = sanitizeExtensionNotification('otp-code', { id: 'c', title: 'T', fields }, NOW);
    expect(card!.fields).toHaveLength(LIMITS.fields);
    expect(card!.fields![0].value).toBe('v0');
  });

  // Regression: one malformed field must not cost the user the whole card —
  // extensions are hand-written JS and a single undefined value is likely.
  it('drops malformed fields but keeps the rest of the card', () => {
    const card = sanitizeExtensionNotification(
      'otp-code',
      {
        id: 'c',
        title: 'T',
        fields: [null, { label: 'Code', value: '123456' }, { label: 'Empty' }, 'junk'],
      },
      NOW
    );
    expect(card!.fields).toEqual([
      { label: 'Code', value: '123456', copyable: false, emphasis: false },
    ]);
  });

  // Regression: `copyable: 'yes'` from untyped JS must not become a truthy flag
  // the renderer trusts — only a real boolean true enables the copy button.
  it('coerces field flags to strict booleans', () => {
    const card = sanitizeExtensionNotification(
      'otp-code',
      { id: 'c', title: 'T', fields: [{ label: 'L', value: 'V', copyable: 'yes', emphasis: 1 }] },
      NOW
    );
    expect(card!.fields![0].copyable).toBe(false);
    expect(card!.fields![0].emphasis).toBe(false);
  });

  // Regression: newlines in a value would break the single-line card row.
  it('collapses whitespace in text', () => {
    const card = sanitizeExtensionNotification(
      'otp-code',
      { id: 'c', title: '  Your\n\ncode  ' },
      NOW
    );
    expect(card!.title).toBe('Your code');
  });

  describe('expiry', () => {
    // Regression: a countdown that starts already expired renders "-0:03" and
    // dismisses instantly — worse than showing no countdown at all.
    it('drops an expiry in the past', () => {
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', expiresAt: NOW - 1 },
        NOW
      );
      expect(card!.expiresAt).toBeUndefined();
    });

    it('keeps an expiry in the future', () => {
      const expiresAt = NOW + 600_000;
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', expiresAt },
        NOW
      );
      expect(card!.expiresAt).toBe(expiresAt);
    });

    // Regression: an extension setting expiresAt to Number.MAX_SAFE_INTEGER
    // would pin a card on screen forever with a nonsense countdown.
    it('clamps an absurdly distant expiry', () => {
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', expiresAt: Number.MAX_SAFE_INTEGER },
        NOW
      );
      expect(card!.expiresAt).toBe(NOW + MAX_NOTIFICATION_LIFETIME_MS);
    });

    it.each([NaN, Infinity, '600000', null])('ignores a non-finite expiry (%s)', (value) => {
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', expiresAt: value },
        NOW
      );
      expect(card!.expiresAt).toBeUndefined();
    });
  });

  describe('timeout', () => {
    it('clamps a too-short timeout up to the minimum', () => {
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', timeoutMs: 5 },
        NOW
      );
      expect(card!.timeoutMs).toBe(MIN_NOTIFICATION_TIMEOUT_MS);
    });

    // Regression: without a ceiling an extension could pin a card open for a day.
    it('clamps a too-long timeout down to the maximum', () => {
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', timeoutMs: 999_999_999 },
        NOW
      );
      expect(card!.timeoutMs).toBe(MAX_NOTIFICATION_TIMEOUT_MS);
    });

    // Regression: honouring both would give the card two competing lifetimes —
    // the auto-dismiss timer could kill it while the countdown still ran.
    it('ignores timeoutMs when an expiry is set', () => {
      const card = sanitizeExtensionNotification(
        'otp-code',
        { id: 'c', title: 'T', expiresAt: NOW + 600_000, timeoutMs: 3_000 },
        NOW
      );
      expect(card!.timeoutMs).toBeUndefined();
    });
  });
});

describe('namespaceNotificationId', () => {
  // Regression: dismiss must resolve to exactly the id notify produced,
  // otherwise an extension can never take its own card down.
  it('matches the id notify assigns', () => {
    const card = sanitizeExtensionNotification('otp-code', { id: 'code', title: 'T' }, NOW);
    expect(namespaceNotificationId('otp-code', 'code')).toBe(card!.id);
  });

  it.each([
    ['blank extension id', '', 'code'],
    ['blank card id', 'otp-code', '  '],
    ['non-string card id', 'otp-code', 42],
  ])('returns null for %s', (_label, extensionId, cardId) => {
    expect(namespaceNotificationId(extensionId as string, cardId)).toBeNull();
  });
});
