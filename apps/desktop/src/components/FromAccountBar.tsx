import { accountDisplayLabel } from '../store/helpers';
import type { StoredAccount } from '../store/types';

/**
 * "From: ● account" strip above an inline composer — shown when the mail goes
 * out from an account other than the active one, so nobody sends from the
 * wrong mailbox by accident (see resolveInlineSendingAccount).
 */
export function FromAccountBar({ account, accounts }: { account: StoredAccount; accounts: StoredAccount[] }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground">
      <span>From:</span>
      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: account.color ?? 'hsl(var(--primary))' }} />
      <span className="font-medium text-foreground truncate">{accountDisplayLabel(accounts, account.id)}</span>
    </div>
  );
}
