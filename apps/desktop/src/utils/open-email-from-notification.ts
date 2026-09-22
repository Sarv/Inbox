import { useEmailStore } from '../store/email-store';

/**
 * Open a message the way a notification click opens it.
 *
 * Three surfaces need this — the native-notification bridge, the in-app toast
 * fallback, and an extension's notification card — and all three must do the
 * same two things in the same order, or the click half-works:
 *
 *  1. Navigate to the Mail view first. A notification can be clicked from
 *     Contacts or Settings, where selecting an email in the store changes
 *     nothing on screen and the user stays where they were.
 *  2. Switch account before selecting, when the mail belongs to another one.
 *     Selecting first would target the wrong account's list.
 *
 * The selection is attempted even if the account switch rejects: a failed
 * switch should not swallow the click entirely.
 */
export function openEmailFromNotification(emailId: string, accountId?: string): void {
  if (!emailId) return;

  document.dispatchEvent(new CustomEvent('sarvinbox:open-mail'));

  const store = useEmailStore.getState() as any;
  const select = () => {
    try {
      store.selectEmail?.(emailId);
    } catch {
      /* the list is not mounted yet; nothing to select into */
    }
  };

  if (accountId && accountId !== store.activeAccountId && typeof store.selectAccount === 'function') {
    store.selectAccount(accountId).then(select).catch(select);
  } else {
    select();
  }
}
