import { describe, expect, it, vi } from 'vitest';

import {
  pgpBadge,
  pgpFailureView,
  shortFingerprint,
  unlockLockedKeys,
  type PgpSignatureView,
} from '../../../../../src/components/email-detail/pgp-view-model';

/**
 * The reader's OpenPGP wording. What this protects, above all: a green
 * "Signed" on mail whose signature was made by someone other than the sender
 * — the badge is the one thing a phisher would most like to borrow.
 */
const signature = (over: Partial<PgpSignatureView> = {}): PgpSignatureView => ({
  status: 'valid',
  signerEmails: ['gee@example.org'],
  signerFingerprint: '0123456789ABCDEF0123456789ABCDEF01234567',
  fromMatches: true,
  ...over,
});

describe('pgpBadge', () => {
  // Breaks: a correctly signed message from the sender loses its green badge.
  it('is good only for a valid signature that names From', () => {
    expect(pgpBadge(false, signature())).toMatchObject({ tone: 'good', label: 'Signed' });
    expect(pgpBadge(true, signature())).toMatchObject({ tone: 'good', label: 'Encrypted · Signed' });
  });

  // Breaks: an attacker's own valid signature on a spoofed From reads as "signed by the sender".
  it('is neutral for a valid signature by another key', () => {
    expect(pgpBadge(false, signature({ fromMatches: false }))).toMatchObject({
      tone: 'neutral',
      label: 'Signed by another key',
      detail: expect.stringContaining('gee@example.org'),
    });
  });

  // Breaks: a tampered message shows no warning.
  it('is bad for an invalid signature', () => {
    expect(pgpBadge(true, signature({ status: 'invalid' }))).toMatchObject({ tone: 'bad', label: 'Encrypted · Bad signature' });
  });

  // Breaks: a signature we cannot check reads as verified, or names nobody.
  it('says an unknown key cannot be checked, naming the key when there is no address', () => {
    expect(pgpBadge(false, signature({ status: 'unknown-key', signerEmails: undefined }))).toMatchObject({
      tone: 'neutral',
      detail: expect.stringContaining('key 89AB CDEF 0123 4567'),
    });
    expect(
      pgpBadge(false, signature({ status: 'unknown-key', signerEmails: undefined, signerFingerprint: undefined }))?.detail,
    ).toContain('an unknown key');
  });

  // Breaks: an unsigned plain message grows a badge, or an encrypted one loses its lock.
  it('shows the lock alone for unsigned encrypted mail and nothing for unsigned plain mail', () => {
    expect(pgpBadge(true, signature({ status: 'none' }))).toMatchObject({ tone: 'good', label: 'Encrypted' });
    expect(pgpBadge(false, signature({ status: 'none' }))).toBeNull();
  });
});

describe('shortFingerprint', () => {
  // Breaks: users compare the wrong part of the fingerprint.
  it('groups the last 16 hex digits in fours', () => {
    expect(shortFingerprint('0123456789ABCDEF0123456789ABCDEF01234567')).toBe('89AB CDEF 0123 4567');
    expect(shortFingerprint('ABCDEF')).toBe('ABCD EF');
    expect(shortFingerprint(undefined)).toBe('');
  });
});

describe('pgpFailureView', () => {
  // Breaks: a locked key shows no way to unlock, or a transient failure offers no retry.
  it('offers unlock for a locked key and retry only for an unavailable source', () => {
    expect(pgpFailureView('locked', '')).toMatchObject({ canUnlock: true, canRetry: false });
    expect(pgpFailureView('no-key', '')).toMatchObject({ canUnlock: false, canRetry: false, detail: expect.stringContaining('Settings') });
    expect(pgpFailureView('bad-data', 'broken packet')).toMatchObject({ detail: 'broken packet', canRetry: false });
    expect(pgpFailureView('unavailable', 'offline')).toMatchObject({ detail: 'offline', canRetry: true });
  });
});

describe('unlockLockedKeys', () => {
  // Breaks: the passphrase is tried on keys that are already open, or only on the first locked one.
  it('tries every locked key and counts the ones it opened', async () => {
    const unlock = vi.fn(async (fingerprint: string) => ({ success: fingerprint === 'B' }));
    const api = {
      listOwnKeys: async () => ({
        success: true,
        data: [
          { fingerprint: 'A', unlocked: false },
          { fingerprint: 'B', unlocked: false },
          { fingerprint: 'C', unlocked: true },
        ],
      }),
      unlock,
    };
    expect(await unlockLockedKeys(api, 'pass')).toBe(1);
    expect(unlock.mock.calls.map(([fingerprint]) => fingerprint)).toEqual(['A', 'B']);
  });

  // Breaks: an unreadable key list throws instead of reporting "nothing unlocked".
  it('unlocks nothing when the keys cannot be listed', async () => {
    expect(await unlockLockedKeys({ listOwnKeys: async () => ({ success: false }), unlock: vi.fn() }, 'pass')).toBe(0);
  });
});
