// Trailing-slash trimming for URLs and URL-like keys

/**
 * `value` without its trailing `/` characters (`https://a.example///` →
 * `https://a.example`). A backwards scan instead of `replace(/\/+$/, '')`: that
 * regex restarts at every slash of a long run and is quadratic on a string made
 * of many slashes (CodeQL js/polynomial-redos), and the strings trimmed here
 * come from config, settings and mail content.
 */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return end === value.length ? value : value.slice(0, end);
}
