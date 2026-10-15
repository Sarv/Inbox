import type { EmailStore } from '../../store/types';

/** The selected message's owning mailbox, including a thread opened from another account. */
export function panelMessageAccount(state: Pick<EmailStore, 'selectedEmailId' | 'emails' | 'threadEmails' | 'threadAccountId' | 'viewAccountId' | 'activeAccountId'>): string | undefined {
  if (!state.selectedEmailId) return undefined;
  if (state.viewAccountId) return state.viewAccountId;
  // A cited thread may belong to the active account while a still-loaded
  // unified-list row with the same ID belongs to another mailbox.
  if (state.threadEmails.some(email => email.id === state.selectedEmailId) && state.threadAccountId) return state.threadAccountId;
  const rowAccount = state.emails.find(email => email.id === state.selectedEmailId)?.accountId;
  if (rowAccount) return rowAccount;
  return state.activeAccountId || undefined;
}
