import { describe, it, expect } from 'vitest';

import {
  MAX_CREDITED_RECIPIENTS,
  creditableRecipients,
  isUnreachableSender,
  normalizeSenderKey,
  recipientCount,
} from '../../src/sender-key';

describe('normalizeSenderKey', () => {
  // Regression: a key that varies by case or whitespace splits one person's
  // history across several profiles, and their score never climbs. The failure
  // is silent — there is no error, just a VIP who is never recognised.
  it.each([
    ['plain', 'Ada@Example.COM', 'ada@example.com'],
    ['padded', '  ada@example.com  ', 'ada@example.com'],
    ['angle-bracketed', 'Ada Lovelace <Ada@Example.com>', 'ada@example.com'],
  ])('normalises a %s address', (_label, input, expected) => {
    expect(normalizeSenderKey(input)).toBe(expected);
  });

  // Regression: an unusable address must produce no key at all. A key of ''
  // or '@' becomes a bucket that every malformed message accumulates into.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['no at sign', 'not-an-address'],
    ['no local part', '@example.com'],
    ['no domain', 'ada@'],
    ['an unparsed list', 'ada@example.com, grace@example.com'],
  ])('returns null for %s', (_label, input) => {
    expect(normalizeSenderKey(input)).toBeNull();
  });
});

describe('isUnreachableSender', () => {
  // Regression: nobody is on the other end of these, so no volume of mail from
  // them should ever be read as a relationship.
  it.each([
    'no-reply@example.com',
    'noreply@example.com',
    'donotreply@example.com',
    'do-not-reply@example.com',
    'bounces-12345@example.com',
    'mailer-daemon@example.com',
    'postmaster@example.com',
  ])('treats %s as unreachable', (address) => {
    expect(isUnreachableSender(address)).toBe(true);
  });

  // Regression: being too aggressive here is the worse failure — people hold
  // real conversations with support and sales aliases, and silently excluding
  // them means their mail is never marked important.
  it.each(['support@example.com', 'sales@example.com', 'team@example.com', 'ada@example.com'])(
    'treats %s as reachable',
    (address) => {
      expect(isUnreachableSender(address)).toBe(false);
    }
  );
});

describe('recipientCount', () => {
  // Regression: "addressed to me alone" is one of the scoring signals. Counting
  // a comma inside a quoted display name as a recipient turns every direct
  // message from a person with a comma in their name into a broadcast.
  it.each([
    ['a single recipient', 'ada@example.com', 1],
    ['several recipients', 'ada@example.com, grace@example.com', 2],
    ['a quoted name containing a comma', '"Lovelace, Ada" <ada@example.com>', 1],
    ['nothing', null, 0],
  ])('counts %s', (_label, header, expected) => {
    expect(recipientCount(header)).toBe(expected);
  });
});

describe('creditableRecipients', () => {
  // Regression: writing to someone is the strongest ongoing signal there is,
  // so the recipients of your own mail must be extracted correctly.
  it('returns every normalised recipient', () => {
    expect(creditableRecipients('Ada <Ada@Example.com>, grace@example.com')).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
  });

  // Regression: one announcement to a large list would otherwise create a
  // profile per recipient and evict every real correspondent from the table.
  it('credits nobody when the list is too long', () => {
    const many = Array.from({ length: MAX_CREDITED_RECIPIENTS + 1 }, (_value, index) => `p${index}@example.com`);
    expect(creditableRecipients(many.join(', '))).toEqual([]);
  });

  // Regression: exactly at the cap must still be credited, so a five-person
  // thread is not silently ignored.
  it('credits a list exactly at the cap', () => {
    const many = Array.from({ length: MAX_CREDITED_RECIPIENTS }, (_value, index) => `p${index}@example.com`);
    expect(creditableRecipients(many.join(', '))).toHaveLength(MAX_CREDITED_RECIPIENTS);
  });

  // Regression: the same person listed twice is one relationship, not two.
  it('de-duplicates repeated recipients', () => {
    expect(creditableRecipients('Ada@example.com, ada@example.com')).toEqual(['ada@example.com']);
  });

  // Regression: an auto-generated address in a recipient list must not become
  // a tracked profile.
  it('drops unreachable recipients', () => {
    expect(creditableRecipients('ada@example.com, no-reply@example.com')).toEqual(['ada@example.com']);
  });
});
