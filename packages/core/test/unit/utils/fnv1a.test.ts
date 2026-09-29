import { describe, expect, it } from 'vitest';

import { fnv1a32, fnv1a32Hex, fnv1aFingerprint } from '../../../src/utils/fnv1a';

// What breaks if this file fails: every value already written with this hash.
// The read model stores `threads.state_version` from it (a different hash reads
// every thread as changed and rebuilds the mailbox), and the first-email split
// cache stores its source fingerprint (a different hash reads every split as
// stale and re-runs the AI on every open).
describe('fnv1a32', () => {
  // Breaks: the fold into core changed the function. These are the published
  // FNV-1a 32-bit test vectors; the old thread-rollup and duplicate-message
  // copies produced exactly these.
  it('matches the published FNV-1a vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  // Breaks: a signed result (no `>>> 0`) that never equals a stored unsigned value.
  it('is always an unsigned 32-bit integer', () => {
    for (const s of ['x', 'hello world', '\u{1F600}', 'a'.repeat(1000)]) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  // Breaks: the duplicate-message bucket key (base-36 of this value) moves.
  it('keeps the base-36 form the duplicate-message bucket key used', () => {
    expect(fnv1a32('foobar').toString(36)).toBe((0xbf9cf968).toString(36));
  });
});

describe('fnv1a32Hex / fnv1aFingerprint', () => {
  // Breaks: an unpadded hex makes two fingerprints of equal hashes compare
  // unequal after a round trip through a zero-stripping formatter.
  it('is fixed-width lower-case hex', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5');
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968');
    expect(fnv1a32Hex('x')).toMatch(/^[0-9a-f]{8}$/);
  });

  // Breaks: the change detector misses an edit, or reports one that did not happen.
  it('pairs the length with the hash and changes with any edit', () => {
    expect(fnv1aFingerprint('foobar')).toBe('6:bf9cf968');
    expect(fnv1aFingerprint('foobar')).toBe(fnv1aFingerprint('foobar'));
    expect(fnv1aFingerprint('foobar')).not.toBe(fnv1aFingerprint('foobaz'));
    expect(fnv1aFingerprint('foobar')).not.toBe(fnv1aFingerprint('foobar '));
  });
});
