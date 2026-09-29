import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => {
    throw new Error('the core DB is not opened in tests');
  },
}));

import { PgpKeyStore, normalizeEmail, type OwnKeyRow } from '../../../../electron/services/pgp-key-store';

/**
 * The keyring's rows. What this protects: a re-import that reset the user's
 * sign-by-default choice, a WKD sighting that demoted a key the user imported
 * by hand, or a lookup by "Alice@Example.org" that missed the row stored as
 * lower case — each would silently change which key mail is encrypted to.
 */
const store = () => new PgpKeyStore(new Database(':memory:'));
const own = (over: Partial<OwnKeyRow> = {}): OwnKeyRow => ({
  fingerprint: 'AAAA',
  email: 'Me@Example.org',
  publicKey: 'PUB',
  secret: Buffer.from('ENC1:xyz'),
  protection: 'keychain',
  signByDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  addedAt: '2026-02-01T00:00:00.000Z',
  ...over,
});
const contact = {
  email: 'Bob@Example.org',
  fingerprint: 'BBBB',
  publicKey: 'PUB1',
  source: 'autocrypt' as const,
  preferEncrypt: 'mutual' as const,
  lastSeen: '2026-03-01T00:00:00.000Z',
};

describe('PgpKeyStore own keys', () => {
  // Breaks: an own key that did not round-trip (secret as a Buffer, flags as booleans) could not be opened.
  it('round-trips a key and normalises its address', () => {
    const s = store();
    s.putOwnKey(own());
    expect(s.getOwnKey('AAAA')).toEqual({ ...own(), email: 'me@example.org' });
    expect(s.listOwnKeys()).toHaveLength(1);
    expect(s.getOwnKey('NOPE')).toBeNull();
  });

  // Breaks: re-importing a key reset the user's signing choice and its added date.
  it('re-import refreshes the key material but keeps sign-by-default and added_at', () => {
    const s = store();
    s.putOwnKey(own());
    expect(s.setSignByDefault('AAAA', true)).toBe(true);
    s.putOwnKey(own({ publicKey: 'PUB2', protection: 'passphrase', addedAt: '2030-01-01T00:00:00.000Z' }));
    expect(s.getOwnKey('AAAA')).toMatchObject({ publicKey: 'PUB2', protection: 'passphrase', signByDefault: true, addedAt: own().addedAt });
  });

  // Breaks: toggling or deleting a missing key reported success to the UI.
  it('reports whether a toggle or delete touched a row', () => {
    const s = store();
    expect(s.setSignByDefault('AAAA', true)).toBe(false);
    s.putOwnKey(own());
    expect(s.deleteOwnKey('AAAA')).toBe(true);
    expect(s.deleteOwnKey('AAAA')).toBe(false);
  });
});

describe('PgpKeyStore contact keys', () => {
  // Breaks: a lookup in a different case missed the stored key and sent in the clear or refused to send.
  it('finds keys case-insensitively, newest sighting first', () => {
    const s = store();
    s.upsertContactKey(contact);
    s.upsertContactKey({ ...contact, fingerprint: 'CCCC', lastSeen: '2026-04-01T00:00:00.000Z' });
    expect(s.contactKeysFor('  BOB@example.ORG ').map((row) => row.fingerprint)).toEqual(['CCCC', 'BBBB']);
    expect(s.listContactKeys()).toHaveLength(2);
    expect(s.contactKeysFor('bob@example.org')[1]).toMatchObject({ email: 'bob@example.org', firstSeen: contact.lastSeen });
  });

  // Breaks: an older message re-processed later moved last_seen backwards, or a
  // new sighting forgot when the key was first seen.
  it('keeps the first sighting and the latest last-seen', () => {
    const s = store();
    s.upsertContactKey(contact);
    s.upsertContactKey({ ...contact, publicKey: 'PUB2', lastSeen: '2026-05-01T00:00:00.000Z' });
    s.upsertContactKey({ ...contact, lastSeen: '2026-01-01T00:00:00.000Z', preferEncrypt: null });
    expect(s.contactKeysFor(contact.email)[0]).toMatchObject({
      firstSeen: contact.lastSeen,
      lastSeen: '2026-05-01T00:00:00.000Z',
      preferEncrypt: 'mutual',
    });
  });

  // Breaks: a header or directory answer downgraded a key the user vouched for by importing it.
  it('never demotes a manual key, but lets an automatic one be promoted', () => {
    const s = store();
    s.upsertContactKey({ ...contact, source: 'manual' });
    s.upsertContactKey({ ...contact, source: 'autocrypt' });
    expect(s.contactKeysFor(contact.email)[0].source).toBe('manual');
    s.upsertContactKey({ ...contact, fingerprint: 'DDDD', source: 'autocrypt' });
    s.upsertContactKey({ ...contact, fingerprint: 'DDDD', source: 'wkd' });
    expect(s.contactKeysFor(contact.email).find((row) => row.fingerprint === 'DDDD')?.source).toBe('wkd');
  });

  // Breaks: deleting a contact key in the settings UI left it in place.
  it('deletes one (address, fingerprint)', () => {
    const s = store();
    s.upsertContactKey(contact);
    expect(s.deleteContactKey('BOB@example.org', 'BBBB')).toBe(true);
    expect(s.deleteContactKey('bob@example.org', 'BBBB')).toBe(false);
  });

  // Breaks: addresses with stray whitespace or capitals landed in separate rows.
  it('normalizeEmail trims and lower-cases', () => {
    expect(normalizeEmail('  A@B.C ')).toBe('a@b.c');
  });
});
