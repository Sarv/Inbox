import type { AccountFollowUp } from '@sarvinbox/core';
import { create } from 'zustand';

interface FollowUpsState {
  items: AccountFollowUp[];
  loaded: boolean;
  /** Re-read every account's open reminders from the main process. */
  refresh: () => Promise<void>;
  /** Stop reminding about one; drops it from the list at once. */
  dismiss: (followUp: Pick<AccountFollowUp, 'id' | 'accountId'>) => Promise<void>;
}

/**
 * Open follow-up reminders across all accounts — the Follow-ups view, its
 * sidebar badge and the thread banner all read this one list, so a dismiss in
 * any of them shows everywhere. The main process pushes `follow-ups:changed`
 * when a pass marks one due or replied; {@link subscribeFollowUps} wires that.
 */
export const useFollowUpsStore = create<FollowUpsState>((set, get) => ({
  items: [],
  loaded: false,
  refresh: async () => {
    try {
      const res = await window.electronAPI.followUps.list();
      if (res.success && res.data) set({ items: res.data, loaded: true });
    } catch {
      /* main process restarting; the next change event or refresh retries */
    }
  },
  dismiss: async ({ id, accountId }) => {
    set({ items: get().items.filter((item) => item.id !== id) });
    try {
      await window.electronAPI.followUps.dismiss(id, accountId || undefined);
    } finally {
      await get().refresh();
    }
  },
}));

/** How many reminders are due — the sidebar badge. */
export const countDue = (items: AccountFollowUp[]): number => items.filter((item) => item.status === 'due').length;

/**
 * The open reminders on one thread of one account. `accountId` null means the
 * active account; a reminder recorded before any account existed has id ''.
 */
export function followUpsForThread(
  items: AccountFollowUp[],
  threadId: string | null | undefined,
  accountId: string | null,
  activeAccountId: string | null = null,
): AccountFollowUp[] {
  if (!threadId) return [];
  const account = accountId ?? activeAccountId;
  return items.filter(
    (item) => item.threadId === threadId && (!account || !item.accountId || item.accountId === account),
  );
}

/** Load once and follow main-process changes; returns the unsubscribe. */
export function subscribeFollowUps(): () => void {
  const { refresh } = useFollowUpsStore.getState();
  refresh();
  return window.electronAPI?.followUps?.onChanged?.(() => refresh()) ?? (() => {});
}
