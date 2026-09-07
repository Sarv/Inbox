import { isValidEmail } from '../utils/validators';

// Pure helpers for send-as identities (the "From" addresses an account may send
// under: its own address plus any aliases). Kept framework-free so the "which
// addresses can this account send as, and what From header do we actually put on
// the wire" rules are unit-testable without a store, a component, or IPC — and
// shared by normalizeAccount (persistence), the compose From picker, and the
// AccountsTab alias editor so the three can never disagree.

/**
 * Normalise an account's send-as identities into the ordered list the UI offers:
 * the account's OWN address always first, then each alias — every entry trimmed,
 * invalid addresses dropped, and de-duplicated case-insensitively (first
 * occurrence's display casing wins). Always returns at least the account's own
 * address (when valid), so callers never have to special-case "no identities".
 */
export function normalizeIdentities(accountEmail: string | undefined, identities?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (raw: string | undefined): void => {
    const trimmed = (raw ?? '').trim();
    if (!trimmed || !isValidEmail(trimmed)) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };
  add(accountEmail);
  for (const identity of identities ?? []) add(identity);
  return result;
}

/**
 * The extra aliases only — the account's own address removed — for editing in the
 * AccountsTab (the primary address is fixed and shown separately, never edited as
 * an alias). Preserves order and the normalisation above.
 */
export function aliasesOf(accountEmail: string | undefined, identities?: string[]): string[] {
  const primary = (accountEmail ?? '').trim().toLowerCase();
  return normalizeIdentities(accountEmail, identities).filter((id) => id.toLowerCase() !== primary);
}

/**
 * Resolve the From header to actually send. The account's own address is the
 * default, so selecting it (or nothing) sends with NO explicit From override
 * (`undefined`) — only a real alias becomes an explicit From. Unknown selections
 * (not among the account's identities) are ignored and fall back to the default,
 * so a stale picker value can never spoof an address the account can't send as.
 */
export function sendAsFrom(
  accountEmail: string | undefined,
  selected: string | undefined,
  identities?: string[],
): string | undefined {
  if (!selected) return undefined;
  const trimmed = selected.trim();
  if (!trimmed || trimmed.toLowerCase() === (accountEmail ?? '').trim().toLowerCase()) return undefined;
  const allowed = normalizeIdentities(accountEmail, identities);
  const match = allowed.find((id) => id.toLowerCase() === trimmed.toLowerCase());
  return match ?? undefined;
}

export type AddAliasResult =
  | { ok: true; aliases: string[] }
  | { ok: false; error: string };

/**
 * Validate and append one alias to the AccountsTab editor's list. Rejects blanks,
 * invalid addresses, the account's own address (already implied), and duplicates
 * (case-insensitive) — each with a message the UI shows inline. Pure so the whole
 * add-flow is unit-testable without a form.
 */
export function addAlias(accountEmail: string | undefined, existing: string[], candidate: string): AddAliasResult {
  const trimmed = candidate.trim();
  if (!trimmed) return { ok: false, error: 'Enter an email address.' };
  if (!isValidEmail(trimmed)) return { ok: false, error: 'That is not a valid email address.' };
  const key = trimmed.toLowerCase();
  if (key === (accountEmail ?? '').trim().toLowerCase()) {
    return { ok: false, error: 'That is already this account’s own address.' };
  }
  if (existing.some((alias) => alias.toLowerCase() === key)) {
    return { ok: false, error: 'That alias is already added.' };
  }
  return { ok: true, aliases: [...existing, trimmed] };
}
