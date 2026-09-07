// Renderer-local RFC 5322 address-list parsing. Mirrors
// packages/core/src/utils/email-address.ts — kept as a separate copy because the
// renderer MUST NOT import a runtime value from `@sarvinbox/core` (that pulls the
// Node-only core barrel — imapflow/mailparser/nodemailer → `require('stream')` —
// into the browser bundle and blanks the renderer). Only `email-addresses` (a
// renderer dependency) is used here. Keep the two copies in sync.

import emailAddresses from 'email-addresses';

export interface ParsedAddress {
  /** Display name, or null when the address had none. */
  name: string | null;
  /** The bare email address (e.g. "john@x.com"). */
  address: string;
}

/**
 * Parse an address-list string into `{ name, address }` entries without the
 * classic `"Doe, John" <j@x.com>` comma-split bug. Falls back to a best-effort
 * comma split only if the parser can't make sense of the input at all.
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
