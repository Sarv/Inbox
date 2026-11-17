import type { EmailRecord } from '@sarvinbox/core';

import { createAssistantHarness, type AssistantHarness } from '../../helpers/assistant-harness';

import { A1, A2, BASE_MAILS, ist, NOW_MS, TIME_ZONE, TRIAGE_MAILS, type Mail } from './mailbox';

/**
 * Put the evaluation mailbox into real account databases, the way mail looks
 * after ingestion: an HTML original with a hard-wrapped plain-text part, or
 * plain text only. Contacts are extracted as the app does on receipt, because
 * retrieval expands a name through them.
 */

function wrap76(text: string): string {
  return text.split('\n').map(line => {
    const out: string[] = [];
    let current = '';
    for (const word of line.split(' ')) {
      if (current && current.length + 1 + word.length > 76) { out.push(current); current = word; }
      else current = current ? `${current} ${word}` : word;
    }
    out.push(current);
    return out.join('\n');
  }).join('\n');
}
const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text: string) => `<div dir="ltr">${text.split('\n\n').map(part => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;

export function mailRecord(mail: Mail): Partial<EmailRecord> & { id: string } {
  const text = wrap76(mail.body);
  const folderTag = mail.folder === 'sent' ? 'Sent' : 'INBOX';
  return {
    id: mail.id, folderId: mail.folder === 'sent' ? 'f-sent' : 'f-inbox', tags: mail.unread ? `|${folderTag}|` : `|${folderTag}|read|`,
    subject: mail.subject, fromAddress: mail.from[0], fromName: mail.from[1], toAddress: mail.to, ccAddress: mail.cc ?? null,
    date: ist(mail.at), receivedDate: ist(mail.at), cleanBody: text, rawBody: mail.format === 'text' ? text : toHtml(mail.body),
    contentType: mail.format === 'text' ? 'text' : 'html', hasAttachments: Boolean(mail.attachments?.length),
    attachmentCount: mail.attachments?.length ?? 0, attachmentNames: mail.attachments?.length ? JSON.stringify(mail.attachments) : null,
    ...(mail.ics ? { calendarIcs: mail.ics } : {}),
  };
}

/** A harness over the seeded mailbox, with the clock fixed at the mailbox's "now". */
export async function createEvalHarness(mails: readonly Mail[] = [...BASE_MAILS, ...TRIAGE_MAILS]): Promise<AssistantHarness> {
  const harness = await createAssistantHarness({ accounts: [A1, A2], now: () => NOW_MS, timeZone: TIME_ZONE });
  for (const mail of mails) {
    const account = harness.mailbox(mail.acct === 'A1' ? A1.id : A2.id);
    await account.add(mail.thread ?? `t-${mail.id}`, mailRecord(mail));
    const stored = await account.storage.getEmail(mail.id);
    if (stored) await account.storage.extractContactsFromEmail(stored, mail.folder === 'sent' ? 'sent' : 'received');
  }
  return harness;
}

/** Whitespace as the model sees it: the plain-text part is hard-wrapped. */
export const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();
