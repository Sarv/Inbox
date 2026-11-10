import { describe, it, expect } from 'vitest';

import { isWhitespaceChar, trimChars, trimCharsEnd, trimCharsStart } from '../../../src/utils/trim-chars';

// The trim helpers replace end-anchored run regexes (`/\.+$/`, `/^_+|_+$/g`,
// `/[>\s]+$/`) on mail content: sender domains, Message-IDs, category names.
// Those regexes were quadratic on a long run that isn't at the end; a trim that
// takes a character too many or too few changes a stored key or a label.

/** Every string up to `max` characters over `alphabet` — small enough to run, exhaustive enough to trust. */
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

describe('trimCharsEnd / trimCharsStart / trimChars', () => {
  // Breaks: a trailing dot or underscore survives, or one from the middle goes.
  it('removes the set only at the trimmed end(s)', () => {
    expect(trimCharsEnd('news.example.com..', '.')).toBe('news.example.com');
    expect(trimCharsStart('@@example.com', '@')).toBe('example.com');
    expect(trimChars('__follow_up__', '_')).toBe('follow_up');
    expect(trimChars('a.b', '.')).toBe('a.b');
  });

  // Breaks: a value made only of the set, or an empty one, throws or survives.
  it('returns an empty string for an empty or all-trimmed value', () => {
    expect(trimCharsEnd('', '.')).toBe('');
    expect(trimCharsStart('....', '.')).toBe('');
    expect(trimChars('----', '-')).toBe('');
  });

  // Breaks: a set of several characters, or a predicate, trims the wrong ones.
  it('takes several characters or a predicate as the set', () => {
    expect(trimChars('-_a-b_-', '-_')).toBe('a-b');
    expect(trimCharsEnd('x@sendgrid.net \t>', (ch) => ch === '>' || isWhitespaceChar(ch))).toBe('x@sendgrid.net');
  });

  // Breaks: the helpers stop being drop-in replacements for the regexes they
  // replaced, and a stored key or label changes. Exhaustive over short strings.
  it('returns exactly what the regexes they replace returned', () => {
    const alphabet = ['-', '_', '.', '@', '>', 'a', ' ', '\t', String.fromCharCode(0xa0), String.fromCharCode(0x2028)];
    const mismatches: string[] = [];
    for (const s of allStrings(alphabet, 4)) {
      if (
        trimChars(s, '-') !== s.replace(/^-+|-+$/g, '')
        || trimChars(s, '_') !== s.replace(/^_+|_+$/g, '')
        || trimCharsEnd(s, '.') !== s.replace(/\.+$/, '')
        || trimCharsStart(s, '@') !== s.replace(/^@+/, '')
        || trimCharsEnd(s, (ch) => ch === '>' || isWhitespaceChar(ch)) !== s.replace(/[>\s]+$/, '')
      ) mismatches.push(s);
    }
    expect(mismatches).toEqual([]);
  });

  // Breaks: the regexes this replaced restarted at every character of a long run
  // that wasn't at the end — quadratic (CodeQL js/polynomial-redos). Under them
  // 200 K characters take over 10 s and the test times out; the scan is instant.
  it('is linear on a long run that is not at the end', () => {
    const run = '.'.repeat(200_000);
    expect(trimCharsEnd(`a${run}x`, '.')).toBe(`a${run}x`);
    expect(trimCharsStart(`x${run}a`, '.')).toBe(`x${run}a`);
    expect(trimChars(`a${run}b`, '.')).toBe(`a${run}b`);
  });
});

describe('isWhitespaceChar', () => {
  // Breaks: a trim with this predicate stops matching what `\s` matched, so a
  // Message-ID domain keeps (or loses) a character it didn't before.
  it('is true for exactly the code units a regex \\s matches', () => {
    for (let code = 0; code < 0x10000; code++) {
      const ch = String.fromCharCode(code);
      if (isWhitespaceChar(ch) !== /\s/.test(ch)) throw new Error(`mismatch at U+${code.toString(16)}`);
    }
    expect(isWhitespaceChar('')).toBe(false);
  });
});
