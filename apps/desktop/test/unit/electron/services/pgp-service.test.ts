import { OutgoingMimeError, type OutgoingMimeContext } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: {} }));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => {
    throw new Error('core DB not open');
  },
  readAppSetting: () => null,
}));

import type { PgpKeyring } from '../../../../electron/services/pgp-keyring';
import {
  attachAutocrypt,
  autocryptSink,
  getPgpKeyring,
  readPgpPrefsFromSettings,
  sendTransformFor,
} from '../../../../electron/services/pgp-service';

/**
 * The real wiring. What this protects: an unreadable settings store read as
 * "defaults" (which would turn lookups on), and a keyring that cannot open
 * letting an encrypted send go out in plaintext — or blocking a plain one.
 */
const ctx: OutgoingMimeContext = { fromHeader: 'me@example.org', recipients: ['bob@example.org'] };
const emptyKeyring = {
  ownPublicKeyFor: async () => null,
  signingKeyFor: async () => null,
  encryptionKeysFor: async () => ({ keys: [], missing: [] }),
} as unknown as PgpKeyring;

describe('readPgpPrefsFromSettings', () => {
  // Breaks: the user's toggles were ignored, or a fresh install had no defaults.
  it('reads the settings blob, and defaults when there is none', () => {
    expect(readPgpPrefsFromSettings(() => JSON.stringify({ pgpKeyserverLookup: true, pgpWkdLookup: false }))).toEqual({
      wkdLookup: false,
      keyserverLookup: true,
      autoEncrypt: true,
    });
    expect(readPgpPrefsFromSettings(() => null).wkdLookup).toBe(true);
    expect(readPgpPrefsFromSettings().keyserverLookup).toBe(false);
  });

  // Breaks: corrupt or unreadable settings silently became defaults instead of failing closed.
  it('throws on corrupt or unreadable settings', () => {
    expect(() => readPgpPrefsFromSettings(() => '{not json')).toThrow();
    expect(() =>
      readPgpPrefsFromSettings(() => {
        throw new Error('locked');
      }),
    ).toThrow('locked');
  });
});

describe('sendTransformFor', () => {
  // Breaks: a keyring that cannot open blocked every ordinary send.
  it('leaves a plain send alone when the keyring cannot open', () => {
    expect(sendTransformFor(undefined)).toBeUndefined();
    expect(sendTransformFor({ encrypt: false, sign: false }, { keyring: () => { throw new Error('no db'); } })).toBeUndefined();
    expect(() => getPgpKeyring()).toThrow('core DB not open');
  });

  // Breaks: an encrypted send went out as plaintext because the keyring was not ready.
  it('refuses an encrypted or signed send when the keyring cannot open', async () => {
    const transform = sendTransformFor({ encrypt: true, sign: false }, { keyring: () => { throw new Error('no db'); } })!;
    const error = await transform(Buffer.from('x'), ctx).catch((e) => e);
    expect(error).toBeInstanceOf(OutgoingMimeError);
    expect(error.transient).toBe(false);
  });

  // Breaks: unreadable settings made the transform throw instead of sending with no preference.
  it('builds a transform even when the settings cannot be read', async () => {
    const transform = sendTransformFor(undefined, { keyring: () => emptyKeyring, prefs: () => { throw new Error('x'); } })!;
    const raw = Buffer.from('From: me@example.org\r\n\r\nhi\r\n');
    expect((await transform(raw, ctx)).equals(raw)).toBe(true);
    expect(sendTransformFor(undefined, { keyring: () => emptyKeyring, prefs: () => ({ wkdLookup: true, keyserverLookup: false, autoEncrypt: true }) })).toBeTypeOf('function');
  });
});

describe('autocryptSink', () => {
  const sighting = { fromAddress: 'bob@example.org', header: 'addr=bob@example.org; keydata=AA', sentAt: '2026-01-01T00:00:00.000Z' };

  // Breaks: a sender's Autocrypt header never reached the keyring.
  it('hands each sighting to the keyring', async () => {
    const recordAutocrypt = vi.fn().mockResolvedValue(true);
    autocryptSink(() => ({ recordAutocrypt }))(sighting);
    expect(recordAutocrypt).toHaveBeenCalledWith(sighting);
  });

  // Breaks: a keyring that cannot open, or a key that fails to parse, would
  // throw into ingest (or leave an unhandled rejection) and cost the message.
  it('never throws or rejects into ingest', async () => {
    expect(() =>
      autocryptSink(() => {
        throw new Error('core DB not open');
      })(sighting),
    ).not.toThrow();
    const rejected = vi.fn().mockRejectedValue(new Error('bad key'));
    expect(() => autocryptSink(() => ({ recordAutocrypt: rejected }))(sighting)).not.toThrow();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalled();
  });

  // Breaks: engines were never wired, so no key was ever learned from mail.
  it('attaches a sink to an engine', () => {
    const setAutocryptSink = vi.fn();
    attachAutocrypt({ setAutocryptSink });
    expect(setAutocryptSink).toHaveBeenCalledWith(expect.any(Function));
    // The real keyring cannot open here (no core DB) — the sink still must not throw.
    expect(() => setAutocryptSink.mock.calls[0][0](sighting)).not.toThrow();
  });
});
