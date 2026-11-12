/**
 * Whether a hostname IS a domain or lies UNDER it: `imap.gmail.com` is under
 * `gmail.com`; `gmail.com.evil.example`, `notgmail.com` and `imap.acme.com`
 * (which merely contains `me.com`) are not.
 *
 * The one rule for "does this host belong to that known domain", in place of
 * `host.includes(domain)`. A substring test matches the domain anywhere in the
 * host, so a lookalike, an unrelated domain that happens to contain it, or a
 * domain sitting in the middle of another one all pass — and the caller then
 * hands that host a provider's settings, or treats it as that provider.
 *
 * Takes a HOSTNAME, not a URL: parse a URL first (`new URL(u).hostname`) so a
 * domain in the path or query can never be mistaken for the host. Lower-cased
 * and trimmed, one trailing root dot dropped from each side; an empty host or
 * domain never matches.
 *
 * Hand-rolled rather than a public-suffix library: the domains callers pass are
 * exact, known registrable domains, so there is no eTLD+1 to infer, and this
 * module must stay import-free for the renderer's deep import
 * (`@sarvinbox/core/host-match`).
 */
export function hostIsOrUnder(host: string | null | undefined, domain: string): boolean {
  const h = normalize(host);
  const d = normalize(domain);
  if (!h || !d) return false;
  return h === d || h.endsWith(`.${d}`);
}

/** Lower-cased, trimmed, one trailing root dot removed. */
function normalize(value: string | null | undefined): string {
  const v = (typeof value === 'string' ? value : '').trim().toLowerCase();
  return v.endsWith('.') ? v.slice(0, -1) : v;
}
