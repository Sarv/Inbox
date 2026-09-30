// Which account a message in the reading pane belongs to.
//
// Rows of the unified "All Inboxes" list carry their own `accountId`; rows of a
// thread do not — they were read from one account's database, and the store
// stamps that account (`threadAccountId`) together with them. Every
// per-message answer that depends on the account (its trust lists, the
// account a "Trust this sender" or "Load images" click is saved to) asks here,
// so the shield, the banner and the remote-image decision agree about a
// message instead of each picking its own account.

/** The store fields that say which account the open message came from. */
export interface PaneAccountState {
  threadEmails: readonly unknown[];
  /** The account `threadEmails` were read from, stamped with them by loadThread. */
  threadAccountId: string | null;
  /** The open message's account in the unified view (null elsewhere). */
  viewAccountId: string | null;
}

/**
 * The account a reading-pane message WITHOUT its own `accountId` belongs to:
 * while a thread is loaded, the account it was read from; otherwise the open
 * message's. Null means the active account.
 *
 * Not `viewAccountId` alone: selecting another account's copy of the open
 * conversation (same thread id) moves `viewAccountId` at once but keeps the
 * loaded thread until the new one lands, and those rows are still the first
 * account's. Pure, for `useEmailStore(paneAccountOf)`.
 */
export function paneAccountOf(state: Partial<PaneAccountState>): string | null {
  const view = state.viewAccountId ?? null;
  return (state.threadEmails?.length ?? 0) > 0 ? (state.threadAccountId ?? view) : view;
}

/** A message's own account, else the pane's ({@link paneAccountOf}); null = the active account. */
export function messageAccountOf(
  email: { accountId?: string | null } | null | undefined,
  paneAccountId?: string | null,
): string | null {
  return email?.accountId ?? paneAccountId ?? null;
}
