import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one at-rest envelope behind every main-process secret store (credential
 * vault, AI keys, DB key, OAuth tokens, last-good IMAP config, pipeline AI
 * config). What breaks if this file fails: an existing user's stored secrets
 * stop opening after the update (the bytes changed); a locked keychain reads
 * as an EMPTY store, which the next write then persists over every secret; or
 * plaintext is written while encryption was available.
 */

const h = vi.hoisted(() => ({ available: true }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const m = /^enc\((.*)\)$/s.exec(b.toString('utf8'));
      if (!m) throw new Error('cannot decrypt');
      return m[1];
    },
  },
}));

import {
  isEncryptedEnvelope,
  isPlaintextEnvelope,
  openJson,
  openString,
  sealJson,
  sealString,
} from '../../../../electron/services/safe-storage-envelope';

const errors = { locked: 'Store is encrypted but locked', unknownFormat: 'Unknown store format' };

beforeEach(() => { h.available = true; });

describe('the bytes are exactly what the stores always wrote', () => {
  // Breaks: every existing install's secrets fail to open after the update.
  it('seals as ENC1:<ciphertext> when encryption is available', () => {
    expect(sealString('{"a":1}').toString('utf8')).toBe('ENC1:enc({"a":1})');
    expect(sealJson({ a: 1 })).toEqual(sealString('{"a":1}'));
  });

  it('falls back to a MARKED PLAIN1:<payload> without encryption', () => {
    h.available = false;
    expect(sealString('hex').toString('utf8')).toBe('PLAIN1:hex');
  });

  it('opens envelopes written by the old per-store code', () => {
    expect(openJson(Buffer.from('ENC1:enc({"k":"v"})', 'utf8'), errors)).toEqual({ k: 'v' });
    expect(openJson(Buffer.from('PLAIN1:{"k":"v"}', 'utf8'), errors)).toEqual({ k: 'v' });
    expect(openString(Buffer.from('PLAIN1:abc123', 'utf8'), errors)).toBe('abc123');
  });
});

describe('round trips', () => {
  it.each([true, false])('round-trips JSON and strings (encryption available: %s)', (available) => {
    h.available = available;
    const value = { nested: { list: [1, 'two'], unicode: 'ünïcødé ✓' } };
    expect(openJson(sealJson(value), errors)).toEqual(value);
    expect(openString(sealString('a'.repeat(64)), errors)).toBe('a'.repeat(64));
  });
});

describe('failures throw — never read as empty', () => {
  // A transient keychain state must not look like "no secrets": callers that
  // read-modify-write would persist the empty read over every secret.
  it('throws the store\'s own message for ENC1 while encryption is unavailable', () => {
    const sealed = sealString('secret');
    h.available = false;
    expect(() => openString(sealed, errors)).toThrow('Store is encrypted but locked');
  });

  it('throws the store\'s own message for an unknown format, including empty input', () => {
    expect(() => openString(Buffer.from('WAT:{}', 'utf8'), errors)).toThrow('Unknown store format');
    expect(() => openString(Buffer.alloc(0), errors)).toThrow('Unknown store format');
    // A prefix that merely resembles a marker is not one.
    expect(() => openString(Buffer.from('ENC1', 'utf8'), errors)).toThrow('Unknown store format');
  });

  it('surfaces a decrypt failure rather than returning garbage', () => {
    expect(() => openString(Buffer.from('ENC1:not-ciphertext', 'utf8'), errors)).toThrow('cannot decrypt');
  });
});

describe('envelope kind', () => {
  // Callers warn when a secret had to be written as plaintext.
  it('tells the two forms apart', () => {
    const enc = sealString('x');
    h.available = false;
    const plain = sealString('x');
    expect([isEncryptedEnvelope(enc), isPlaintextEnvelope(enc)]).toEqual([true, false]);
    expect([isEncryptedEnvelope(plain), isPlaintextEnvelope(plain)]).toEqual([false, true]);
    expect([isEncryptedEnvelope(Buffer.from('?')), isPlaintextEnvelope(Buffer.from('?'))]).toEqual([false, false]);
  });
});
