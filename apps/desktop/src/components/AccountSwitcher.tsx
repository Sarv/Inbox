import { BellDot, Check, ChevronDown, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useEmailStore } from '../store/email-store';
import { accountHost, isAccountEmailDuplicated } from '../store/helpers';

import { Tooltip } from './Tooltip';

/** Sidebar account switcher: shows the active account, lists the others, and
 *  offers "Add account". Hidden until at least one account exists. */
export function AccountSwitcher() {
  const { accounts, activeAccountId, selectAccount, accountUnread } = useEmailStore(
    useShallow((s) => ({
      accounts: s.accounts,
      activeAccountId: s.activeAccountId,
      selectAccount: s.selectAccount,
      accountUnread: s.accountUnread,
    })),
  );
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (accounts.length === 0) return null;
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0];

  // Same address can be connected via different providers (e.g. sarv vs gmail
  // IMAP). When an email is duplicated, show the IMAP host to disambiguate.
  // Shared helpers (store/helpers) so this logic lives in ONE place.
  const hostOf = (a: (typeof accounts)[number]) => accountHost(a);
  const isDupEmail = (a: (typeof accounts)[number]) => isAccountEmailDuplicated(accounts, a.email);
  const unreadOf = (a: (typeof accounts)[number]) => accountUnread[a.id] ?? 0;
  // Highlight the collapsed switcher when ANOTHER account has unread — so you
  // notice without opening the dropdown.
  const hasOtherUnread = accounts.some((a) => a.id !== activeAccountId && unreadOf(a) > 0);

  return (
    <div className="px-3 pt-3" ref={ref}>
      <div className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md border border-border hover:bg-accent/50 text-left transition-colors"
          title="Switch account"
        >
          <span
            className="h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 text-white"
            style={{ backgroundColor: active?.color ?? '#2563eb' }}
          >
            {(active?.email?.[0] || '?').toUpperCase()}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block truncate text-sm">{active?.email ?? 'Account'}</span>
            {active && isDupEmail(active) && (
              <span className="block truncate text-[11px] text-muted-foreground">{hostOf(active)}</span>
            )}
          </span>
          {/* Unread on another account — visible even while collapsed. */}
          {hasOtherUnread && (
            <Tooltip content="Unread mail in another account" delayMs={40}>
              <BellDot className="h-4 w-4 text-[#e56910] shrink-0" aria-label="Unread mail in another account" />
            </Tooltip>
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        </button>

        {open && (
          <div className="absolute left-0 right-0 z-30 mt-1 rounded-md border border-border bg-background shadow-lg p-1">
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => { setOpen(false); if (a.id !== activeAccountId) selectAccount(a.id); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted/50 text-left"
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: a.color ?? '#2563eb' }} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{a.email}</span>
                  {isDupEmail(a) && (
                    <span className="block truncate text-[11px] text-muted-foreground">{hostOf(a)}</span>
                  )}
                </span>
                {/* Unread marker (BellDot) — NOT on the active account, since its
                    folders are already visible. Distinct from the account-color dots. */}
                {unreadOf(a) > 0 && a.id !== activeAccountId && (
                  <Tooltip content="Unread mail" delayMs={40}>
                    <BellDot className="h-4 w-4 text-[#e56910] shrink-0" aria-label="Unread mail" />
                  </Tooltip>
                )}
                {a.id === activeAccountId && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
              </button>
            ))}
            <div className="my-1 border-t border-border" />
            <button
              onClick={() => { setOpen(false); document.dispatchEvent(new CustomEvent('sarvinbox:add-account')); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-primary hover:bg-muted/50 text-left"
            >
              <Plus className="h-4 w-4" /> Add account
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
