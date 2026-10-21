import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one at-rest envelope behind every main-process secret store (credential
 * vault, AI keys, DB key, OAuth tokens, last-good IMAP config, pipeline AI
 * config). What breaks if this file fails: an existing user's stored secrets
 * stop opening after the update (the bytes changed); a locked keychain reads
 * as an EMPTY store, which the next write then persists over every secret; or
 * plaintext is written while encryption was available.
 */

const h = vi.hoisted(() => ({ available: true, backend: 'gnome_libsecret', encryptsWeakly: false }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => h.backend,
    encryptString: (s: string) => Buffer.from(`${process.platform === 'linux' ? h.encryptsWeakly ? 'v10' : 'v11' : ''}enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const m = /^(?:v10|v11)?enc\((.*)\)$/s.exec(b.toString('utf8'));
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
import { asPlatform } from '../../../helpers/as-platform';

const errors = { locked: 'Store is encrypted but locked', unknownFormat: 'Unknown store format' };

beforeEach(() => { h.available = true; h.backend = 'gnome_libsecret'; h.encryptsWeakly = false; });

describe('the bytes are exactly what the stores always wrote', () => {
  // Breaks: every existing install's secrets fail to open after the update.
  it('seals as ENC1:<ciphertext> when encryption is available', () => {
    expect(sealString('{"a":1}').toString('utf8')).toBe(`ENC1:${process.platform === 'linux' ? 'v11' : ''}enc({"a":1})`);
    expect(sealJson({ a: 1 })).toEqual(sealString('{"a":1}'));
  });

  it('refuses to create a new plaintext envelope on Linux without encryption', () => {
    h.available = false;
    expect(() => asPlatform('linux', () => sealString('hex'))).toThrow('A system keyring is required');
  });

  it('opens envelopes written by the old per-store code', () => {
    expect(openJson(Buffer.from('ENC1:enc({"k":"v"})', 'utf8'), errors)).toEqual({ k: 'v' });
    expect(openJson(Buffer.from('PLAIN1:{"k":"v"}', 'utf8'), errors)).toEqual({ k: 'v' });
    expect(openString(Buffer.from('PLAIN1:abc123', 'utf8'), errors)).toBe('abc123');
  });
});

describe('round trips', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('round-trips protected JSON and strings on %s', (platform) => {
    const value = { nested: { list: [1, 'two'], unicode: 'ünïcødé ✓' } };
    asPlatform(platform, () => {
      expect(openJson(sealJson(value), errors)).toEqual(value);
      expect(openString(sealString('a'.repeat(64)), errors)).toBe('a'.repeat(64));
    });
  });

  it.each(['darwin', 'win32', 'linux'] as const)('refuses new plaintext writes on %s but still opens legacy plaintext for recovery', (platform) => {
    h.available = false;
    asPlatform(platform, () => {
      expect(() => sealString('secret')).toThrow(/Keychain is unavailable|secure storage is unavailable|system keyring is required/);
      expect(openString(Buffer.from('PLAIN1:legacy-secret'), errors)).toBe('legacy-secret');
    });
  });

  it.each(['basic_text', 'unknown'])('refuses Linux %s even if Electron reports encryption available', (backend) => {
    h.backend = backend;
    expect(() => asPlatform('linux', () => sealString('secret'))).toThrow('A system keyring is required');
  });

  it('rejects a Linux encryption operation that unexpectedly returns legacy weak v10 bytes', () => {
    h.encryptsWeakly = true;
    expect(() => asPlatform('linux', () => sealString('secret'))).toThrow('Linux secure storage did not protect this secret');
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
    const plain = Buffer.from('PLAIN1:x');
    expect([isEncryptedEnvelope(enc), isPlaintextEnvelope(enc)]).toEqual([true, false]);
    expect([isEncryptedEnvelope(plain), isPlaintextEnvelope(plain)]).toEqual([false, true]);
    expect([isEncryptedEnvelope(Buffer.from('?')), isPlaintextEnvelope(Buffer.from('?'))]).toEqual([false, false]);
  });
});
