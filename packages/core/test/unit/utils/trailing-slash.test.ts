import { describe, it, expect } from 'vitest';

import { trimTrailingSlashes } from '../../../src/utils/trailing-slash';

// trimTrailingSlashes builds the Sarv catalog and reputation URLs and the keys
// contact links are counted under. A slash left on doubles the one in front of
// the next path ('//oauth', which the API answers 404) or splits one link into
// two keys; a slash taken from the middle sends a request to the wrong path.

describe('trimTrailingSlashes', () => {
  // Breaks: an endpoint saved as "https://host/" builds "https://host//v1/…".
  it('removes one or many trailing slashes', () => {
    expect(trimTrailingSlashes('https://ai.sarv.com/')).toBe('https://ai.sarv.com');
    expect(trimTrailingSlashes('http://localhost:8880///')).toBe('http://localhost:8880');
  });

  // Breaks: a path or a scheme loses a slash it needs.
  it('keeps every slash that is not at the end', () => {
    expect(trimTrailingSlashes('https://a.example/x/y')).toBe('https://a.example/x/y');
    expect(trimTrailingSlashes('https://a.example/x//y//')).toBe('https://a.example/x//y');
  });

  // Breaks: a value made only of slashes, or an empty one, throws or comes
  // back unchanged instead of empty.
  it('returns an empty string for an empty or all-slash value', () => {
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('/')).toBe('');
    expect(trimTrailingSlashes('////')).toBe('');
  });

  // Breaks: the regex this replaced restarted at every slash of a long run, so a
  // value of many slashes followed by anything else took quadratic time (CodeQL
  // js/polynomial-redos). Under that regex this input takes about 14 s (0.6 s at
  // 40k slashes, measured 2026-11-08) and the test times out; the scan finishes
  // at once.
  it('is linear on a long run of slashes', () => {
    const many = '/'.repeat(200_000);
    expect(trimTrailingSlashes(`${many}x`)).toBe(`${many}x`);
    expect(trimTrailingSlashes(`x${many}`)).toBe('x');
  });
});
