/** Everything the inline reply box needs from the mail being answered. */
export interface ReplySource {
  id: string;
  /** Real RFC Message-ID — the In-Reply-To, so the reply (and its draft) threads natively. */
  messageId?: string;
  /** Groups the saved draft into this thread (avoids orphaned drafts). */
  threadId?: string;
  /** Owning account — the reply goes out from (and drafts into) it. */
  accountId?: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  ccAddress: string | null;
  date: number;
  cleanBody: string | null;
  /** Original HTML body, for preserving the quoted trail's structure. */
  rawBody: string | null;
  /** 'encrypted' keeps the reply encrypted by default. */
  pgpStatus?: 'encrypted' | 'signed' | null;
}

interface RepliableEmail extends Omit<ReplySource, 'subject' | 'toAddress' | 'messageId' | 'threadId'> {
  subject?: string | null;
  toAddress?: string | null;
  messageId?: string | null;
  threadId?: string | null;
}

/**
 * The one mapping from a mail row to the reply box's input. The message view
 * and the thread list each copied these fields by hand — the way the forward
 * box once lost its attachments — and neither carried the OpenPGP status, so a
 * reply to encrypted mail did not default to encrypted.
 */
export function toReplySource(email: RepliableEmail): ReplySource {
  return {
    id: email.id,
    messageId: email.messageId ?? undefined,
    threadId: email.threadId ?? undefined,
    accountId: email.accountId,
    subject: email.subject || '',
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    toAddress: email.toAddress || '',
    ccAddress: email.ccAddress,
    date: email.date,
    cleanBody: email.cleanBody,
    rawBody: email.rawBody,
    pgpStatus: email.pgpStatus,
  };
}
