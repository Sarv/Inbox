import type { EmailStore } from '../../store/types';

/** The selected message's owning mailbox, including a thread opened from another account. */
export function panelMessageAccount(state: Pick<EmailStore, 'selectedEmailId' | 'emails' | 'threadEmails' | 'threadAccountId' | 'viewAccountId' | 'activeAccountId'>): string | undefined {
  if (!state.selectedEmailId) return undefined;
  if (state.viewAccountId) return state.viewAccountId;
  const rowAccount = state.emails.find(email => email.id === state.selectedEmailId)?.accountId;
  if (rowAccount) return rowAccount;
  if (state.threadEmails.some(email => email.id === state.selectedEmailId) && state.threadAccountId) return state.threadAccountId;
  return state.activeAccountId || undefined;
}
