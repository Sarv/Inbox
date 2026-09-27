import { useEmailStore } from '../store/email-store';
import type { StoredAccount } from '../store/types';

interface SendingAccountInput {
  /** The answered/forwarded mail's own account, when its row carries one
   *  (merged All Inboxes rows do; rows loaded through a thread don't). */
  emailAccountId?: string;
  /** The account of the mail opened from All Inboxes; null for a normal
   *  account-inbox open. */
  viewAccountId: string | null;
  activeAccountId: string | null;
  isUnifiedView: boolean;
  accounts: StoredAccount[];
}

/**
 * Which account an inline reply/forward goes out from, and whether to say so.
 *
 *  - `accountId` — the mail's owner, so the message is sent (and drafted) from
 *    the mailbox it was received in; undefined = the active account.
 *  - `fromAccount` — set only in All Inboxes when that owner is NOT the active
 *    account: the one case the user could send from the wrong mailbox without
 *    noticing, so the composer shows a From bar.
 */
export function resolveInlineSendingAccount(input: SendingAccountInput): {
  accountId: string | undefined;
  fromAccount: StoredAccount | null;
} {
  const accountId = input.emailAccountId ?? input.viewAccountId ?? undefined;
  const fromAccount = input.isUnifiedView && accountId && accountId !== input.activeAccountId
    ? input.accounts.find((a) => a.id === accountId) ?? null
    : null;
  return { accountId, fromAccount };
}

/** {@link resolveInlineSendingAccount} over the live store. */
export function useInlineSendingAccount(email: { accountId?: string } | null | undefined) {
  const accounts = useEmailStore((s) => s.accounts);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  const viewAccountId = useEmailStore((s) => s.viewAccountId);
  const isUnifiedView = useEmailStore((s) => s.selectedVirtualFolder === 'virtual-unified');
  return {
    accounts,
    activeAccountId,
    viewAccountId,
    isUnifiedView,
    ...resolveInlineSendingAccount({
      emailAccountId: email?.accountId,
      viewAccountId,
      activeAccountId,
      isUnifiedView,
      accounts,
    }),
  };
}
