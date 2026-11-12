// Trailing-slash trimming for URLs and URL-like keys

import { trimCharsEnd } from './trim-chars';

/**
 * `value` without its trailing `/` characters (`https://a.example///` →
 * `https://a.example`). A backwards scan ({@link trimCharsEnd}) instead of
 * `replace(/\/+$/, '')`: that regex restarts at every slash of a long run and is
 * quadratic on a string made of many slashes (CodeQL js/polynomial-redos), and
 * the strings trimmed here come from config, settings and mail content.
 */
export function trimTrailingSlashes(value: string): string {
  return trimCharsEnd(value, '/');
}
