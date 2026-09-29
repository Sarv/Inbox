import { describe, expect, it } from 'vitest';

import {
  encryptToggleText,
  pgpComposeState,
  signToggleText,
  type PgpComposeInput,
} from '../../../../src/utils/pgp-compose';

/**
 * When a message goes out encrypted or signed. What this protects: a reply to
 * encrypted mail quietly going out in the clear; auto-encrypt switching on for
 * a recipient with no key; and a send request carried by users who have never
 * set OpenPGP up.
 */
const input = (over: Partial<PgpComposeInput> = {}): PgpComposeInput => ({
  defaults: { hasOwnKey: true, signByDefault: false, autoEncrypt: true },
  keys: [{ email: 'a@x.org', status: 'key', source: 'wkd', fingerprint: 'F' }],
  replyToEncrypted: false,
  encryptOverride: null,
  signOverride: null,
  ...over,
});

const none = (email: string) => ({ email, status: 'none' as const });

describe('pgpComposeState', () => {
  // Breaks: users with no key see toggles that can only fail, or send a request main must refuse.
  it('offers nothing and requests nothing without a key of your own', () => {
    for (const defaults of [null, { hasOwnKey: false, signByDefault: true, autoEncrypt: true }]) {
      const state = pgpComposeState(input({ defaults, replyToEncrypted: true, encryptOverride: true }));
      expect(state).toMatchObject({ available: false, encrypt: false, sign: false, resolving: false, request: undefined });
    }
  });

  // Breaks: auto-encrypt — the feature's whole promise of encryption without thinking about it.
  it('encrypts by itself when every recipient has a key and auto-encrypt is on', () => {
    expect(pgpComposeState(input()).request).toEqual({ encrypt: true, sign: false });
  });

  // Breaks: auto-encrypt switches on for a message one recipient could never read.
  it('does not auto-encrypt when anyone lacks a key, when keys are unknown, or with no recipients', () => {
    expect(pgpComposeState(input({ keys: [input().keys![0], none('b@x.org')] }))).toMatchObject({ encrypt: false, missing: ['b@x.org'] });
    expect(pgpComposeState(input({ keys: null }))).toMatchObject({ encrypt: false, resolving: true });
    expect(pgpComposeState(input({ keys: [] })).encrypt).toBe(false);
  });

  // Breaks: auto-encrypt ignores the user's choice to turn it off.
  it('respects auto-encrypt being off', () => {
    expect(pgpComposeState(input({ defaults: { hasOwnKey: true, signByDefault: false, autoEncrypt: false } })).encrypt).toBe(false);
  });

  // Breaks: a reply to an encrypted message goes out in the clear because one recipient has no key.
  it('keeps a reply to encrypted mail encrypted, even when a key is missing', () => {
    const state = pgpComposeState(input({ replyToEncrypted: true, keys: [none('b@x.org')] }));
    expect(state).toMatchObject({ encrypt: true, missing: ['b@x.org'] });
  });

  // Breaks: the toggles do nothing, or a default wins over what the user clicked.
  it('lets the user override both defaults', () => {
    expect(pgpComposeState(input({ encryptOverride: false })).encrypt).toBe(false);
    expect(pgpComposeState(input({ replyToEncrypted: true, encryptOverride: false })).encrypt).toBe(false);
    expect(pgpComposeState(input({ keys: [none('b@x.org')], encryptOverride: true })).encrypt).toBe(true);
    expect(pgpComposeState(input({ signOverride: true })).sign).toBe(true);
    expect(pgpComposeState(input({ defaults: { hasOwnKey: true, signByDefault: true, autoEncrypt: false }, signOverride: false })).sign).toBe(false);
  });

  // Breaks: "sign by default" on the key is ignored.
  it('signs by default when the key says so', () => {
    expect(pgpComposeState(input({ defaults: { hasOwnKey: true, signByDefault: true, autoEncrypt: false } })).sign).toBe(true);
  });
});

describe('toggle wording', () => {
  // Breaks: the user is not told that an encrypted send will be refused, or for whom.
  it('names the recipients without a key', () => {
    const on = pgpComposeState(input({ encryptOverride: true, keys: [none('b@x.org')] }));
    expect(encryptToggleText(on)).toBe('No encryption key for b@x.org — this cannot be sent encrypted');
    const off = pgpComposeState(input({ keys: [none('b@x.org'), none('c@x.org'), none('d@x.org')] }));
    expect(encryptToggleText(off)).toBe('Encrypt (no key for b@x.org, c@x.org and 1 more)');
  });

  // Breaks: the lock's state and its label disagree.
  it('says whether the message is encrypted and signed', () => {
    expect(encryptToggleText(pgpComposeState(input()))).toBe('Encrypted — only the recipients can read it');
    expect(encryptToggleText(pgpComposeState(input({ encryptOverride: false })))).toBe('Encrypt');
    expect(signToggleText(pgpComposeState(input({ signOverride: true })))).toBe('Signed with your OpenPGP key');
    expect(signToggleText(pgpComposeState(input()))).toBe('Sign with your OpenPGP key');
  });
});
