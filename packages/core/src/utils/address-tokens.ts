// Address-shaped tokens in free text, found in linear time.
//
// For RFC 5322 address LISTS use `parseAddressList` / `parseAddresses`
// (email-address.ts). These two are for a looser job: finding what looks like
// an address in a stored To/Cc field or a "Name <addr>" entry whatever the
// separators are. They are the linear forms of the regexes that used to do it,
// `/[\w.+-]+@[\w.-]+/g` and `/<([^>]+)>/`, and return exactly what those
// returned for every input; only the running time changed. The parser is not a
// drop-in here: in its partial mode it stops at the first `;`- or
// space-separated address, which the regex (and so every caller) accepted.

/** `\w` without the `u` flag: ASCII letters, digits and `_`. */
function isWordCode(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

/** `[\w.+-]` — a character of the local part. */
function isLocalCode(c: number): boolean {
  return isWordCode(c) || c === 0x2e || c === 0x2b || c === 0x2d;
}

/** `[\w.-]` — a character of the domain. */
function isDomainCode(c: number): boolean {
  return isWordCode(c) || c === 0x2e || c === 0x2d;
}

/**
 * Every address-shaped token in `text`, left to right — exactly
 * `text.match(/[\w.+-]+@[\w.-]+/g) ?? []`.
 *
 * Why not that regex: it restarts at every character of a long run of
 * local-part characters with no `@` after it and rescans the run to its end, so
 * a To/Cc header of many `+` (or letters) took quadratic time — 150 K
 * characters ran for about 9 s, on the main thread, for one email (CodeQL
 * js/polynomial-redos). Here each `@` is visited once, its local part found by
 * scanning BACK (never past the previous token or `@`) and its domain forward.
 */
export function addressTokens(text: string): string[] {
  const out: string[] = [];
  // Where the regex would resume after the last token: a local part can't reach
  // back into a token already returned.
  let from = 0;
  let at = text.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > from && isLocalCode(text.charCodeAt(start - 1))) start--;
    let end = at + 1;
    while (end < text.length && isDomainCode(text.charCodeAt(end))) end++;
    if (start < at && end > at + 1) {
      out.push(text.slice(start, end));
      from = end;
    }
    at = text.indexOf('@', Math.max(at + 1, from));
  }
  return out;
}

/**
 * The text inside the first `<…>` with something in it (`'Ann <a@x.com>'` →
 * `'a@x.com'`), or null — exactly what `/<([^>]+)>/` captured.
 *
 * Why not that regex: from every `<` it scans to the next `>`, so an entry of
 * many `<` with no `>` took quadratic time (CodeQL js/polynomial-redos). Here,
 * once a `<` has no `>` after it, no later `<` can have one either, so the scan
 * stops.
 */
export function angleBracketed(text: string): string | null {
  let from = 0;
  for (;;) {
    const open = text.indexOf('<', from);
    if (open === -1) return null;
    const close = text.indexOf('>', open + 1);
    if (close === -1) return null;
    // `<>` holds nothing: the regex needs one character, so it moves on.
    if (close > open + 1) return text.slice(open + 1, close);
    from = close + 1;
  }
}
