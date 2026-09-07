/**
 * Phone-number normalizer — turns a raw signature string into an E.164
 * representation suitable for identity matching (so "+91 98765 43210",
 * "9876543210" and "(+91)-9876543210" all collapse to "+919876543210").
 *
 * Uses `libphonenumber-js` (already a dependency, and used by the sibling
 * signal-extractor) rather than a hand-rolled dial-code table + "assume 10
 * digits" heuristic — the heuristic mis-handled national-number lengths that
 * vary by country (DE/FR/CN/GB national numbers aren't all 10 digits).
 *
 * NOTE: this file is intentionally duplicated at
 * apps/desktop/src/services/contact-enrichment/phone-normalizer.ts — the
 * renderer can't import `@sarvinbox/core` at runtime (it drags in
 * imapflow/nodemailer and breaks Vite). Keep the two copies in sync.
 */

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export function normalizePhoneToE164(raw: string, defaultCountry = 'IN'): string | null {
  if (!raw) return null;
  try {
    // parsePhoneNumberFromString honors a leading '+' country code when present
    // and applies `defaultCountry` only for bare national numbers.
    const parsed = parsePhoneNumberFromString(raw.trim(), defaultCountry as CountryCode);
    if (!parsed) return null;
    // M3 fix: an explicit '+'/'00' prefix carries its own country code, so trust
    // libphonenumber's lenient length-based isPossible() (the right bar for
    // format-collapsing dedupe). But a BARE national number is *assumed* to be in
    // `defaultCountry` — a bare FOREIGN number (e.g. a US "4155552671") would be
    // mis-prefixed to +91… and corrupt identity dedup. For bare input require the
    // stricter isValid() for the default region, so a number that isn't a
    // plausible `defaultCountry` number is dropped (null) rather than mis-prefixed.
    const hasIntlPrefix = raw.includes('+') || raw.replace(/\D/g, '').startsWith('00');
    const acceptable = hasIntlPrefix ? parsed.isPossible() : parsed.isValid();
    return acceptable ? parsed.number : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a batch of raw phone strings, dedupe, and return in
 * rank-preserved order. Nulls (unparseable entries) are dropped.
 */
export function normalizePhones(raws: string[], defaultCountry = 'IN'): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const e164 = normalizePhoneToE164(raw, defaultCountry);
    if (!e164 || seen.has(e164)) continue;
    seen.add(e164);
    out.push(e164);
  }
  return out;
}
