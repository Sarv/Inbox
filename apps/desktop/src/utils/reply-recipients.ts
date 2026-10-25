import { parseAddresses } from './email-address';

export interface ReplySource {
  fromAddress: string;
  toAddress?: string | null;
  ccAddress?: string | null;
}

/**
 * Who a reply goes to. Replying to someone else's message answers its sender
 * (plus, for Reply All, everyone else on it but us). Replying to a message WE
 * sent — the "Follow up" on an unanswered reminder — must go back to the
 * people we wrote to; answering the sender would mail ourselves.
 */
export function replyRecipients(
  source: ReplySource,
  mode: 'reply' | 'replyAll',
  myEmail: string,
  identities: readonly string[] = [],
): { to: string; cc: string } {
  // Only this sending account's identities are self. Another configured
  // account can be an intentional recipient and must not disappear here.
  const own = new Set([myEmail, ...identities].flatMap(parseAddresses).map(address => address.toLowerCase()));
  const from = parseAddresses(source.fromAddress)[0] || source.fromAddress.trim();
  const seen = new Set<string>();
  const external = (addresses: string[]) => addresses.filter(address => {
    const key = address.toLowerCase();
    if (own.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (own.has(from.toLowerCase())) {
    const to = external(parseAddresses(source.toAddress));
    const cc = external(parseAddresses(source.ccAddress));
    // A sent message can have only self in To and an external Cc. Promote
    // those recipients when needed so the reply never addresses ourselves.
    return {
      to: (to.length ? to : cc).join(', '),
      cc: mode === 'replyAll' && to.length ? cc.join(', ') : '',
    };
  }
  if (mode === 'reply') return { to: from, cc: '' };
  seen.add(from.toLowerCase());
  const others = external([...parseAddresses(source.toAddress), ...parseAddresses(source.ccAddress)]);
  return { to: from, cc: others.join(', ') };
}
