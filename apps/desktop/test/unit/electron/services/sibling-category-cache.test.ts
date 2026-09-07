import { describe, it, expect } from 'vitest';

import { SiblingCategoryCache } from '../../../../electron/services/sibling-category-cache';

// The dual-delivery de-dup: the same Message-ID delivered to two accounts must be
// categorized ONCE and shared. A regression here means a second LLM call (cost)
// and, worse, a divergent/empty re-categorization that flips the label.

describe('SiblingCategoryCache', () => {
  it('returns the recorded categories for a known message-id', () => {
    const c = new SiblingCategoryCache();
    c.record('<m1@x>', ['invoice', 'important']);
    expect(c.get('<m1@x>')).toEqual(['invoice', 'important']);
  });

  it('returns null for an unknown message-id or a missing id', () => {
    const c = new SiblingCategoryCache();
    expect(c.get('<nope@x>')).toBeNull();
    expect(c.get(undefined)).toBeNull();
    expect(c.get('')).toBeNull();
  });

  it('does not record an empty category list or a missing id', () => {
    const c = new SiblingCategoryCache();
    c.record('<m@x>', []);
    c.record(undefined, ['invoice']);
    expect(c.get('<m@x>')).toBeNull();
    expect(c.size).toBe(0);
  });

  it('expires an entry after the TTL', () => {
    let now = 1_000_000;
    const c = new SiblingCategoryCache(60_000, 2000, () => now);
    c.record('<m@x>', ['invoice']);
    now += 59_999;
    expect(c.get('<m@x>')).toEqual(['invoice']); // still fresh
    now += 2;
    expect(c.get('<m@x>')).toBeNull();           // past TTL
  });

  it('stores a COPY so later mutation of the caller array cannot corrupt the cache', () => {
    const c = new SiblingCategoryCache();
    const cats = ['invoice'];
    c.record('<m@x>', cats);
    cats.push('important'); // caller mutates its own array afterward
    expect(c.get('<m@x>')).toEqual(['invoice']);
  });

  it('evicts to stay within the size cap (TTL-expired first, then FIFO)', () => {
    let now = 0;
    const c = new SiblingCategoryCache(1000, 3, () => now);
    // Three entries at t=0 (will be TTL-expired by the time we overflow).
    c.record('a', ['x']); c.record('b', ['x']); c.record('c', ['x']);
    now = 5000; // all three now past the 1000ms TTL
    c.record('d', ['x']); // size would be 4 > cap 3 → sweep expired (a,b,c) → only d remains
    expect(c.size).toBe(1);
    expect(c.get('d')).toEqual(['x']);
    expect(c.get('a')).toBeNull();
  });

  it('FIFO-trims when over cap and nothing is TTL-expired', () => {
    let now = 0;
    const c = new SiblingCategoryCache(1_000_000, 3, () => now);
    c.record('a', ['x']); now += 1; c.record('b', ['x']); now += 1;
    c.record('c', ['x']); now += 1; c.record('d', ['x']); // 4 > cap 3, none expired → drop oldest (a)
    expect(c.size).toBe(3);
    expect(c.get('a')).toBeNull();  // oldest evicted
    expect(c.get('d')).toEqual(['x']);
  });
});
