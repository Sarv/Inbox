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
): { to: string; cc: string } {
  const me = myEmail.toLowerCase();
  const from = source.fromAddress.toLowerCase();
  const notMe = (address: string) => address.toLowerCase() !== me;
  const toList = parseAddresses(source.toAddress);
  const ccList = parseAddresses(source.ccAddress);

  if (me && from === me) {
    return {
      to: toList.filter(notMe).join(', '),
      cc: mode === 'replyAll' ? ccList.filter(notMe).join(', ') : '',
    };
  }
  if (mode === 'reply') return { to: source.fromAddress, cc: '' };
  const others = [...toList, ...ccList].filter((address) => notMe(address) && address.toLowerCase() !== from);
  return { to: source.fromAddress, cc: others.join(', ') };
}
