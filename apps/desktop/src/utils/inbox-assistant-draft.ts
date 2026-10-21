import type { EmailStore } from '../store/types';
import type { InboxAssistantDraft } from '../types/inbox-assistant';

/** Open a reviewable draft through the same composer used by Mail. */
export function openInboxAssistantDraft(
  draft: InboxAssistantDraft,
  store: Pick<EmailStore, 'accounts' | 'compose' | 'editDraftInComposer'>,
): void {
  if (store.compose.isOpen) throw new Error('Close the current email draft before opening another.');
  if (!store.accounts.some(account => account.id === draft.accountId)) throw new Error('The sending account is no longer connected.');
  const escaped = draft.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  store.editDraftInComposer({
    accountId: draft.accountId,
    to: draft.to.join(', '), cc: draft.cc.join(', '), subject: draft.subject,
    htmlContent: escaped.split(/\r?\n/).map(line => `<p>${line || '&nbsp;'}</p>`).join(''),
    attachments: [],
    ...(draft.calendarAvailability ? { calendarAvailability: draft.calendarAvailability } : {}),
  });
}
