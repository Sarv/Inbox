/** The parts of the original message a forward quotes. */
export interface ForwardedMessage {
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  /** Epoch SECONDS (UTC); rendered in the reader's zone. */
  date: number;
  cleanBody: string | null;
  rawBody: string | null;
}

const FORWARD_BANNER = '---------- Forwarded Message ----------';

const senderOf = (original: ForwardedMessage) => original.fromName || original.fromAddress;
const sentAtOf = (original: ForwardedMessage) => new Date(original.date * 1000).toLocaleString();

/**
 * The "Forwarded Message" block appended under the user's note — the same
 * markup for the sent mail and for its draft, so a draft reopened from Drafts
 * still carries what was being forwarded.
 */
export function buildForwardQuoteHtml(original: ForwardedMessage): string {
  const quotedBodyHtml = original.rawBody
    ? original.rawBody
    : (original.cleanBody || '').split('\n').map((line) => `<p>${line || '&nbsp;'}</p>`).join('');

  return `
<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">
<p style="margin: 0 0 10px 0;"><strong>${FORWARD_BANNER}</strong><br>
<strong>From:</strong> ${senderOf(original)}<br>
<strong>Date:</strong> ${sentAtOf(original)}<br>
<strong>Subject:</strong> ${original.subject}<br>
<strong>To:</strong> ${original.toAddress}</p>
<div>${quotedBodyHtml}</div>
</blockquote>`;
}

/** Plain-text twin of {@link buildForwardQuoteHtml}, for the draft's text part. */
export function buildForwardQuoteText(original: ForwardedMessage): string {
  return [
    FORWARD_BANNER,
    `From: ${senderOf(original)}`,
    `Date: ${sentAtOf(original)}`,
    `Subject: ${original.subject}`,
    `To: ${original.toAddress}`,
    '',
    original.cleanBody || '',
  ].join('\n');
}

/** The forward's own subject: "Fwd: " once, never stacked. */
export function forwardSubject(subject: string): string {
  return subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`;
}

/** A forward's draft: the user's note, then the message being forwarded. */
export function composeForwardDraft(
  original: ForwardedMessage,
  note: { body: string; htmlBody: string },
): { body: string; htmlBody: string } {
  return {
    body: `${note.body}\n\n${buildForwardQuoteText(original)}`,
    htmlBody: `${note.htmlBody}${buildForwardQuoteHtml(original)}`,
  };
}

/** Everything the inline forward box needs from the mail being forwarded. */
export interface ForwardSource extends ForwardedMessage {
  id: string;
  ccAddress: string | null;
  /** With attachmentNames, lets the forward fetch and re-attach the files. */
  hasAttachments?: boolean;
  attachmentNames?: string | null;
  /** Owning account — the forward goes out from (and drafts into) it. */
  accountId?: string;
}

interface ForwardableEmail {
  id: string;
  subject?: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddress?: string | null;
  ccAddress: string | null;
  date: number;
  cleanBody: string | null;
  rawBody: string | null;
  hasAttachments?: boolean;
  attachmentNames?: string | null;
  accountId?: string;
}

/**
 * The one mapping from a mail row to the forward box's input. Each view used to
 * copy the fields by hand, and two of them dropped the attachment fields — so a
 * forward from there silently went out without the original's files.
 */
export function toForwardSource(email: ForwardableEmail): ForwardSource {
  return {
    id: email.id,
    subject: email.subject || '',
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    toAddress: email.toAddress || '',
    ccAddress: email.ccAddress,
    date: email.date,
    cleanBody: email.cleanBody,
    rawBody: email.rawBody,
    hasAttachments: email.hasAttachments,
    attachmentNames: email.attachmentNames,
    accountId: email.accountId,
  };
}
