// Shared RFC 5322 address-list parsing. Splitting a stored `To`/`Cc` field on
// "," is the classic bug: a display name can legally contain a comma
// (`"Doe, John" <j@x.com>`), and a naive split shreds it. This funnels every
// call through the `email-addresses` parser instead. Product-agnostic, pure,
// unit-testable — lives in core so renderer, core and storage-node share ONE
// implementation (per the reuse-over-duplication rule).

import emailAddresses from 'email-addresses';

export interface ParsedAddress {
  /** Display name, or null when the address had none. */
  name: string | null;
  /** The bare email address (e.g. "john@x.com"). */
  address: string;
}

/**
 * Parse an address-list string into `{ name, address }` entries. Falls back to a
 * best-effort comma split only if the parser can't make sense of the input at
 * all (so a malformed field still yields *something* rather than throwing).
 * Returns [] for empty input.
 */
export function parseAddressList(input: string | null | undefined): ParsedAddress[] {
  if (!input || !input.trim()) return [];

  const commaFallback = (): ParsedAddress[] =>
    input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((address) => ({ name: null, address }));

  try {
    const parsed = emailAddresses.parseAddressList({ input, partial: true });
    if (!parsed || parsed.length === 0) return commaFallback();

    const out: ParsedAddress[] = [];
    for (const node of parsed) {
      // A node is either a single mailbox or a group (with `.addresses`).
      const group = (node as emailAddresses.ParsedGroup).addresses;
      if (Array.isArray(group)) {
        for (const m of group) out.push({ name: m.name || null, address: m.address });
      } else {
        const m = node as emailAddresses.ParsedMailbox;
        if (m.address) out.push({ name: m.name || null, address: m.address });
      }
    }
    return out.length > 0 ? out : commaFallback();
  } catch {
    return commaFallback();
  }
}

/** Just the bare addresses from an address-list string (display names dropped). */
export function parseAddresses(input: string | null | undefined): string[] {
  return parseAddressList(input)
    .map((a) => a.address)
    .filter(Boolean);
}
