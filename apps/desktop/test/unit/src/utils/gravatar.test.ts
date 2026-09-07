import { describe, it, expect } from 'vitest';

import { gravatarUrl } from '../../../../src/utils/gravatar';

// The MD5 here is hand-rolled (the renderer has no Node `crypto`), so the hash
// itself needs pinning against known-good digests — a subtle bit-shift bug would
// silently give every contact the WRONG avatar rather than throwing.
const hashOf = (url: string) => url.slice(url.indexOf('/avatar/') + '/avatar/'.length, url.indexOf('?'));

describe('gravatarUrl', () => {
  it('matches the canonical Gravatar example digest', () => {
    // Gravatar's own documented example: md5("test@example.com").
    expect(hashOf(gravatarUrl('test@example.com', 80))).toBe('55502f40dc8b7c769880b10874abc9d0');
  });

  it('lowercases and trims before hashing, per the Gravatar spec', () => {
    // Same person typed three ways must resolve to the SAME avatar.
    const canonical = hashOf(gravatarUrl('myemailaddress@example.com', 64));
    expect(canonical).toBe('0bc83cb571cd1c50ba6f3e8a78ef1346');
    expect(hashOf(gravatarUrl('  MyEmailAddress@example.com  ', 64))).toBe(canonical);
    expect(hashOf(gravatarUrl('MYEMAILADDRESS@EXAMPLE.COM', 64))).toBe(canonical);
  });

  it('hashes the empty string to the well-known MD5 of ""', () => {
    expect(hashOf(gravatarUrl('', 32))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('hashes inputs that straddle the 64-byte block boundary correctly', () => {
    // The padding/length-append path is where a hand-written MD5 usually breaks:
    // 64 chars needs a whole extra block, 100 chars needs two.
    expect(hashOf(gravatarUrl('a'.repeat(64), 32))).toBe('014842d480b571495a4a0363793f7367');
    expect(hashOf(gravatarUrl('a'.repeat(100), 32))).toBe('36a92cc94a9e0fa21f625f8bfb007adf');
  });

  it('always emits a 32-hex-digit digest (no dropped leading zeros)', () => {
    for (const addr of ['a@b.com', 'zz@yy.io', 'someone.else@example.org', 'x'.repeat(200)]) {
      expect(hashOf(gravatarUrl(addr, 40))).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it('builds the https URL with the requested size and identicon default', () => {
    expect(gravatarUrl('test@example.com', 96)).toBe(
      'https://www.gravatar.com/avatar/55502f40dc8b7c769880b10874abc9d0?s=96&d=identicon',
    );
  });

  it('honours d=404 so the caller\'s onError can fall back to initials', () => {
    // The two modes are behaviourally different: 'identicon' ALWAYS paints an
    // image (no onError fires), '404' is what enables the initials fallback.
    expect(gravatarUrl('test@example.com', 40, '404')).toContain('&d=404');
    expect(gravatarUrl('test@example.com', 40, 'mp')).toContain('&d=mp');
    expect(gravatarUrl('test@example.com', 40, 'retro')).toContain('&d=retro');
    expect(gravatarUrl('test@example.com', 40, 'robohash')).toContain('&d=robohash');
  });

  it('is deterministic — the same address always yields the same URL', () => {
    expect(gravatarUrl('advik.d@sarv.com', 64)).toBe(gravatarUrl('advik.d@sarv.com', 64));
    expect(hashOf(gravatarUrl('advik.d@sarv.com', 64))).toBe('6c421ed0b234e78bf40fa23b28175a8e');
  });

  it('gives different addresses different hashes', () => {
    expect(hashOf(gravatarUrl('a@x.com', 32))).not.toBe(hashOf(gravatarUrl('b@x.com', 32)));
  });
});
