import { OutgoingMimeError, isTransientSendError } from '@sarvinbox/core';
import {
  detectPgpMime,
  generateKeyPair,
  openPgpMime,
  parseAutocryptHeader,
  readAnyKey,
  readUnlockedPrivateKey,
  splitHeaderBody,
  type GeneratedKey,
} from '@sarvinbox/core/pgp';
import MailComposer from 'nodemailer/lib/mail-composer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PgpKeyringError } from '../../../../electron/services/pgp-keyring';
import { pgpOutgoingTransform, type OutgoingKeyring } from '../../../../electron/services/pgp-outgoing';

vi.mock('electron', () => ({ safeStorage: {} }));

/**
 * The send-side OpenPGP step. What this protects, in order of how bad it is:
 * a message the user asked to encrypt leaving in plaintext (a recipient
 * without a key, a locked signing key, an openpgp failure); the Sent copy
 * encrypted without the sender's key; the Autocrypt header for someone else's
 * key; and a keyring hiccup blocking an ordinary, unencrypted send.
 */
let me: GeneratedKey;
let bob: GeneratedKey;
let raw: Buffer;

const compose = (options: Record<string, unknown>) =>
  new Promise<Buffer>((resolve, reject) =>
    new MailComposer(options).compile().build((error, message) => (error ? reject(error) : resolve(message))),
  );

beforeAll(async () => {
  [me, bob] = await Promise.all([
    generateKeyPair({ name: 'Me', email: 'me@example.org' }),
    generateKeyPair({ name: 'Bob', email: 'bob@example.org' }),
  ]);
  raw = await compose({ from: 'Me <me@example.org>', to: 'bob@example.org', subject: 'Hi', text: 'Secret plans' });
});

function fakeKeyring(over: Partial<OutgoingKeyring> = {}): OutgoingKeyring {
  return {
    ownPublicKeyFor: async (email) => (email === 'me@example.org' ? readAnyKey(me.armoredPublicKey) : null),
    signingKeyFor: async (email) => (email === 'me@example.org' ? readUnlockedPrivateKey(me.armoredPrivateKey) : null),
    encryptionKeysFor: async (_from, recipients) => {
      const known: Record<string, string> = { 'bob@example.org': bob.armoredPublicKey };
      const keys = await Promise.all(recipients.filter((r) => known[r]).map((r) => readAnyKey(known[r])));
      return { keys: [...keys, await readAnyKey(me.armoredPublicKey)], missing: recipients.filter((r) => !known[r]) };
    },
    ...over,
  } as OutgoingKeyring;
}

const context = (recipients = ['Bob <bob@example.org>']) => ({ fromHeader: 'Me <me@example.org>', recipients });
const headersOf = (bytes: Buffer) => splitHeaderBody(bytes).headerBytes.toString('utf8').replace(/\r\n[ \t]/g, ' ');
const keysFor = async (key: GeneratedKey) => ({
  decryptionKeys: [await readUnlockedPrivateKey(key.armoredPrivateKey)],
  verificationKeys: [await readAnyKey(me.armoredPublicKey)],
});

describe('pgpOutgoingTransform', () => {
  // Breaks: correspondents never learnt the user's key, so nobody could encrypt to them.
  it('adds an Autocrypt header for the sender\'s own key to a plain send, body untouched', async () => {
    const out = await pgpOutgoingTransform(fakeKeyring(), { preferEncrypt: true })(raw, context());
    expect(splitHeaderBody(out).body.equals(splitHeaderBody(raw).body)).toBe(true);
    const value = headersOf(out).match(/^Autocrypt: (.*)$/m)?.[1] ?? '';
    const parsed = parseAutocryptHeader(value)!;
    expect(parsed).toMatchObject({ addr: 'me@example.org', preferEncrypt: 'mutual' });
    expect((await readAnyKey(parsed.keydata)).getFingerprint().toUpperCase()).toBe(me.info.fingerprint);
  });

  // Breaks: an address without a key got an empty/garbage header, or a keyring error blocked a plain send.
  it('sends a plain message unchanged when there is no key or the keyring fails', async () => {
    const noKey = pgpOutgoingTransform(fakeKeyring({ ownPublicKeyFor: async () => null }), { preferEncrypt: false });
    expect((await noKey(raw, context())).equals(raw)).toBe(true);
    const broken = pgpOutgoingTransform(
      fakeKeyring({ ownPublicKeyFor: async () => { throw new Error('db gone'); } }),
      { preferEncrypt: false },
    );
    expect((await broken(raw, context())).equals(raw)).toBe(true);
    const noFrom = pgpOutgoingTransform(fakeKeyring(), { preferEncrypt: false });
    expect((await noFrom(raw, { fromHeader: '', recipients: [] })).equals(raw)).toBe(true);
  });

  // Breaks: prefer-encrypt=mutual was advertised by a user who turned auto-encrypt off.
  it('advertises no preference when auto-encrypt is off', async () => {
    const out = await pgpOutgoingTransform(fakeKeyring(), { preferEncrypt: false })(raw, context());
    expect(headersOf(out)).not.toContain('prefer-encrypt');
  });

  // Breaks: the recipient could not read it, or the sender could not read their own Sent copy.
  it('encrypts and signs so both the recipient and the sender can open it', async () => {
    const out = await pgpOutgoingTransform(fakeKeyring(), { request: { encrypt: true, sign: true }, preferEncrypt: true })(
      raw,
      context(),
    );
    expect(out.toString('utf8')).not.toContain('Secret plans');
    expect(detectPgpMime(out)).toBe('encrypted');
    expect(headersOf(out)).toMatch(/^Autocrypt: /m);
    expect(headersOf(out)).toMatch(/^Subject: Hi$/m);
    for (const reader of [bob, me]) {
      const opened = await openPgpMime(out, await keysFor(reader));
      expect(opened.wasEncrypted).toBe(true);
      expect(opened.signature.status).toBe('valid');
      expect(opened.content.type === 'mime' && opened.content.bytes.toString('utf8')).toContain('Secret plans');
    }
  });

  // Breaks: sign-only produced an encrypted (unreadable to keyless recipients) message.
  it('signs without encrypting', async () => {
    const out = await pgpOutgoingTransform(fakeKeyring(), { request: { encrypt: false, sign: true }, preferEncrypt: true })(
      raw,
      context(),
    );
    expect(detectPgpMime(out)).toBe('signed');
    expect((await openPgpMime(out, await keysFor(bob))).signature.status).toBe('valid');
  });

  // Breaks: an encrypted send to a keyless recipient went out in plaintext, or the outbox retried it forever.
  it('refuses to encrypt when a recipient has no key, permanently', async () => {
    const transform = pgpOutgoingTransform(fakeKeyring(), { request: { encrypt: true, sign: false }, preferEncrypt: true });
    const error = await transform(raw, context(['bob@example.org', 'Carol <carol@example.org>'])).catch((e) => e);
    expect(error).toBeInstanceOf(OutgoingMimeError);
    expect(error.message).toContain('carol@example.org');
    expect(error.message).not.toContain('bob@');
    expect(isTransientSendError(error)).toBe(false);
  });

  // Breaks: a send that asked to be signed went out unsigned.
  it('refuses to sign without a key or with a locked one', async () => {
    const noKey = pgpOutgoingTransform(fakeKeyring({ signingKeyFor: async () => null }), {
      request: { encrypt: false, sign: true },
      preferEncrypt: false,
    });
    await expect(noKey(raw, context())).rejects.toThrow(/No OpenPGP key for me@example.org/);
    const locked = pgpOutgoingTransform(
      fakeKeyring({ signingKeyFor: async () => { throw new PgpKeyringError('The key for me@example.org is locked', 'locked'); } }),
      { request: { encrypt: true, sign: true }, preferEncrypt: false },
    );
    const error = await locked(raw, context()).catch((e) => e);
    expect(error).toBeInstanceOf(OutgoingMimeError);
    expect(error.message).toMatch(/Could not encrypt the message: .*locked/);
    expect(error.transient).toBe(false);
    const noFrom = pgpOutgoingTransform(fakeKeyring({ signingKeyFor: async () => null }), {
      request: { encrypt: false, sign: true },
      preferEncrypt: false,
    });
    await expect(noFrom(raw, { fromHeader: '', recipients: [] })).rejects.toThrow(/this sender/);
  });

  // Breaks: an openpgp failure mid-wrap (bad key material) escaped as a transient error and was retried.
  it('wraps unexpected failures as permanent', async () => {
    const transform = pgpOutgoingTransform(
      fakeKeyring({ encryptionKeysFor: async () => { throw 'boom'; } }),
      { request: { encrypt: true, sign: false }, preferEncrypt: false },
    );
    await expect(transform(raw, context())).rejects.toMatchObject({ transient: false, message: expect.stringContaining('boom') });
  });
});
