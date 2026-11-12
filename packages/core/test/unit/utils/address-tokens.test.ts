import { describe, it, expect } from 'vitest';

import { addressTokens, angleBracketed } from '../../../src/utils/address-tokens';

// addressTokens decides whether the user is a direct (To) or Cc recipient for
// importance scoring and the AI prompt; angleBracketed pulls the address out of
// a "Name <addr>" entry for thread participants. Both replaced regexes that went
// quadratic on a crafted To/Cc header, on the main thread, for one email.

/** Every string up to `max` characters over `alphabet`. */
function* allStrings(alphabet: string[], max: number): Generator<string> {
  yield '';
  let level = [''];
  for (let len = 1; len <= max; len++) {
    const next: string[] = [];
    for (const prefix of level) for (const ch of alphabet) next.push(prefix + ch);
    yield* next;
    level = next;
  }
}

describe('addressTokens', () => {
  // Breaks: the user stops being recognised as a To/Cc recipient.
  it('finds every address in a stored To/Cc field, whatever the separator', () => {
    expect(addressTokens('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com']);
    expect(addressTokens('a@x.com;b@y.com c@z.org')).toEqual(['a@x.com', 'b@y.com', 'c@z.org']);
    expect(addressTokens('Ann <ann+tag@ex-ample.co.uk>, "Doe, J" <j.doe@x.com>')).toEqual(['ann+tag@ex-ample.co.uk', 'j.doe@x.com']);
    expect(addressTokens('')).toEqual([]);
    expect(addressTokens('undisclosed-recipients:;')).toEqual([]);
  });

  // Breaks: "joann@example.com" counts as user "ann@example.com" again (the
  // substring bug the exact comparison exists to prevent).
  it('returns whole tokens, never a suffix of one', () => {
    expect(addressTokens('joann@example.com')).toEqual(['joann@example.com']);
  });

  // Breaks: the scanner drifts from the regex every caller was written against,
  // so an address is newly missed or newly found. Exhaustive over short strings,
  // with the edge cases that matter: '@' runs, '+' (local part only), separators.
  it('returns exactly what /[\\w.+-]+@[\\w.-]+/g returned', () => {
    const mismatches: string[] = [];
    for (const s of allStrings(['a', '+', '.', '@', ' ', '-', 'é', '_'], 6)) {
      const expected = s.match(/[\w.+-]+@[\w.-]+/g) ?? [];
      if (JSON.stringify(addressTokens(s)) !== JSON.stringify(expected)) mismatches.push(s);
    }
    expect(mismatches).toEqual([]);
  });

  // Breaks: the regex this replaced rescanned a long local-part run from every
  // character of it; 150 K of "+" took over 10 s, so the test times out.
  it('is linear on a long run with no "@" after it', () => {
    expect(addressTokens('+'.repeat(150_000))).toEqual([]);
    expect(addressTokens(`${'a'.repeat(150_000)}@`)).toEqual([]);
  });
});

describe('angleBracketed', () => {
  // Breaks: a "Name <addr>" participant is compared by its display text, so two
  // mails between the same people stop threading together.
  it('returns the address inside the first non-empty <…>', () => {
    expect(angleBracketed('Ann <ann@x.com>')).toBe('ann@x.com');
    expect(angleBracketed('<a@x.com> <b@y.com>')).toBe('a@x.com');
    expect(angleBracketed('<> <b@y.com>')).toBe('b@y.com');
    expect(angleBracketed('plain@x.com')).toBeNull();
    expect(angleBracketed('Ann <ann@x.com')).toBeNull();
  });

  // Breaks: the scanner drifts from the regex the resolver was written against.
  it('returns exactly what /<([^>]+)>/ captured', () => {
    const mismatches: string[] = [];
    for (const s of allStrings(['<', '>', 'a', ' '], 8)) {
      if (angleBracketed(s) !== (s.match(/<([^>]+)>/)?.[1] ?? null)) mismatches.push(s);
    }
    expect(mismatches).toEqual([]);
  });

  // Breaks: the regex this replaced scanned to the end from every `<`, so an
  // entry of 200 K `<` took over 10 s and the test times out.
  it('is linear on a long run of "<" with no ">"', () => {
    expect(angleBracketed('<'.repeat(200_000))).toBeNull();
    expect(angleBracketed('<>'.repeat(100_000))).toBeNull();
  });
});
