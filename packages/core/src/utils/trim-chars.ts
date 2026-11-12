// Trimming a set of characters off the ends of a string, in linear time.

/**
 * Which characters a trim removes: every character of a string (`'.'`, `'-_'`),
 * or a predicate for a set a string can't list (whitespace).
 */
export type TrimSet = string | ((ch: string) => boolean);

function stripperFor(set: TrimSet): (ch: string) => boolean {
  return typeof set === 'string' ? (ch) => set.includes(ch) : set;
}

/**
 * `value` without the characters of `set` at its END (`trimCharsEnd('a.b..',
 * '.')` → `'a.b'`).
 *
 * A backwards scan instead of `replace(/[…]+$/, '')`: an end-anchored run regex
 * is tried again at EVERY character of a long run that is not at the end, so a
 * string of many such characters followed by anything else takes quadratic
 * time (CodeQL js/polynomial-redos) — and the strings trimmed with this are
 * mail content: addresses, Message-IDs, sender domains, category names.
 */
export function trimCharsEnd(value: string, set: TrimSet): string {
  const strip = stripperFor(set);
  let end = value.length;
  while (end > 0 && strip(value[end - 1])) end--;
  return end === value.length ? value : value.slice(0, end);
}

/** `value` without the characters of `set` at its START. Linear, like {@link trimCharsEnd}. */
export function trimCharsStart(value: string, set: TrimSet): string {
  const strip = stripperFor(set);
  let start = 0;
  while (start < value.length && strip(value[start])) start++;
  return start === 0 ? value : value.slice(start);
}

/**
 * `value` without the characters of `set` at either end — the linear form of
 * `replace(/^x+|x+$/g, '')`.
 */
export function trimChars(value: string, set: TrimSet): string {
  return trimCharsStart(trimCharsEnd(value, set), set);
}

/**
 * Whether `ch` (one UTF-16 code unit) is a character a regex `\s` matches.
 * `String#trim` removes exactly the set `\s` matches (ECMAScript WhiteSpace and
 * LineTerminator), so a one-character string is whitespace iff it trims to ''.
 */
export function isWhitespaceChar(ch: string): boolean {
  return ch.length > 0 && ch.trim() === '';
}
