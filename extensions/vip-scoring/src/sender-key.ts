/**
 * Turning a From address into the key a relationship is remembered under.
 *
 * Pure and separate from the scoring so the two can be reasoned about — and
 * broken — independently. Getting this wrong does not produce a visible error:
 * it silently splits one person's history across several keys, and their score
 * never climbs.
 */

/**
 * Local parts that can never be a relationship, because nobody is on the other
 * end of them. Mail from these is scored at zero regardless of volume — a
 * newsletter you open every morning is a habit, not a correspondent.
 *
 * Deliberately narrow: `support@`, `sales@` and `team@` are NOT here, because
 * people do hold real conversations with them.
 */
const UNREACHABLE_LOCAL_PARTS = [
  'no-reply',
  'noreply',
  'no_reply',
  'no.reply',
  'do-not-reply',
  'donotreply',
  'do_not_reply',
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'bounce',
  'bounces',
] as const;

/**
 * Normalise an address into a stable key: lowercased and trimmed, with a
 * display name stripped if one came along.
 *
 * Returns null for anything that is not usable as an identity — no history can
 * be attributed to it, so it must not create a key.
 */
export function normalizeSenderKey(address: string | null | undefined): string | null {
  if (!address) return null;

  // Accept both "Name <a@b.com>" and a bare address; the record normally holds
  // the bare form, but a malformed header can leave the whole thing in place.
  const angled = address.match(/<([^<>]+)>/);
  const candidate = (angled ? angled[1] : address).trim().toLowerCase();

  const at = candidate.indexOf('@');
  if (at <= 0 || at === candidate.length - 1) return null;
  if (candidate.includes(' ')) return null;

  return candidate;
}

/** True when no human can be reached at this address. */
export function isUnreachableSender(key: string): boolean {
  const localPart = key.slice(0, key.indexOf('@'));
  // A suffix match catches the "no-reply+1234@" and "bounces-abc@" variants
  // that every bulk sender generates per message.
  return UNREACHABLE_LOCAL_PARTS.some(
    (blocked) => localPart === blocked || localPart.startsWith(`${blocked}+`) || localPart.startsWith(`${blocked}-`)
  );
}

/**
 * How many people the message was addressed to.
 *
 * A message to you alone is a conversation; a message to forty people is an
 * announcement. Counting is done on the raw header string because that is what
 * the record stores — commas inside a quoted display name would over-count, so
 * quoted sections are dropped first.
 */
export function recipientCount(toAddress: string | null | undefined): number {
  if (!toAddress) return 0;
  const withoutQuotes = toAddress.replace(/"[^"]*"/g, '');
  return withoutQuotes.split(',').filter((part) => part.includes('@')).length;
}

/**
 * Sending to more people than this is an announcement, not a relationship.
 * Without the cap, one mail to a 200-person list would create 200 profiles and
 * push every real correspondent out of the table.
 */
export const MAX_CREDITED_RECIPIENTS = 5;

/**
 * Every usable address in a recipient header, normalised and de-duplicated.
 *
 * Returns an empty list when the header names more people than
 * {@link MAX_CREDITED_RECIPIENTS} — see above.
 */
export function creditableRecipients(toAddress: string | null | undefined): string[] {
  if (!toAddress) return [];

  const withoutQuotes = toAddress.replace(/"[^"]*"/g, '');
  const keys = new Set<string>();
  for (const part of withoutQuotes.split(',')) {
    const key = normalizeSenderKey(part);
    if (key && !isUnreachableSender(key)) keys.add(key);
  }

  return keys.size > MAX_CREDITED_RECIPIENTS ? [] : [...keys];
}
