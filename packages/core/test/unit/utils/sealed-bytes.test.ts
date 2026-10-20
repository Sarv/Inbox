import { randomBytes } from 'crypto';

import { describe, expect, it } from 'vitest';

import { deriveSubkey, openSealedBytes, sealBytes, SEALED_BYTES_OVERHEAD } from '../../../src/utils/sealed-bytes';

// Bytes sealed at rest (the attachment cache, CASA M-7). What breaks if this
// file fails: cached attachments are readable on disk, a changed or swapped
// file is served as if it were genuine, or one key opens another store's data.
describe('sealBytes / openSealedBytes', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('%PDF-1.7 the quarterly report');

  it('round-trips, and the sealed form does not contain the plaintext', () => {
    const sealed = sealBytes(key, plaintext, 'email/file');
    expect(sealed.length).toBe(plaintext.length + SEALED_BYTES_OVERHEAD);
    expect(sealed.includes(Buffer.from('quarterly report'))).toBe(false);
    expect(openSealedBytes(key, sealed, 'email/file')).toEqual(plaintext);
  });

  it('round-trips empty content', () => {
    expect(openSealedBytes(key, sealBytes(key, Buffer.alloc(0)))).toEqual(Buffer.alloc(0));
  });

  // Breaks: two seals of the same file are identical, revealing equal content.
  it('uses a fresh IV every time', () => {
    expect(sealBytes(key, plaintext).equals(sealBytes(key, plaintext))).toBe(false);
  });

  // Breaks: a blob moved to another email/file slot opens as that file.
  it('refuses another aad', () => {
    const sealed = sealBytes(key, plaintext, 'email-a/report.pdf');
    expect(() => openSealedBytes(key, sealed, 'email-b/report.pdf')).toThrow();
  });

  it('refuses another key', () => {
    expect(() => openSealedBytes(randomBytes(32), sealBytes(key, plaintext))).toThrow();
  });

  // Breaks: a flipped byte is served as the attachment.
  it('refuses any altered byte, including the tag and IV', () => {
    const sealed = sealBytes(key, plaintext);
    for (const index of [5, 20, sealed.length - 1]) {
      const altered = Buffer.from(sealed);
      altered[index] ^= 0x01;
      expect(() => openSealedBytes(key, altered)).toThrow();
    }
  });

  // Breaks: a plaintext file left by an older build is "opened" and served raw.
  it('refuses data that was never sealed, and truncated data', () => {
    expect(() => openSealedBytes(key, Buffer.from('plain old file contents here, long enough'))).toThrow('Not sealed data');
    expect(() => openSealedBytes(key, sealBytes(key, plaintext).subarray(0, SEALED_BYTES_OVERHEAD - 1))).toThrow('Not sealed data');
  });
});

describe('deriveSubkey', () => {
  // Breaks: two stores share one key, or the derivation is not reproducible
  // (cached files become unreadable after a restart).
  it('is deterministic per purpose and distinct across purposes', () => {
    const secret = randomBytes(32);
    expect(deriveSubkey(secret, 'a')).toEqual(deriveSubkey(secret, 'a'));
    expect(deriveSubkey(secret, 'a').equals(deriveSubkey(secret, 'b'))).toBe(false);
    expect(deriveSubkey(secret, 'a')).toHaveLength(32);
  });
});
