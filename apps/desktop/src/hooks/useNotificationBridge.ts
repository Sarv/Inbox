import { useEffect } from 'react';

import { useEmailStore } from '../store/email-store';
import { openEmailFromNotification } from '../utils/open-email-from-notification';

/** Notification config the renderer owns and pushes to the main-process service.
 *  mode/sound come from settings (localStorage); accounts/view from the store. */
interface NotifSettings {
  mode: 'off' | 'important' | 'all';
  sound: boolean;
  workingHours: { enabled: boolean; days: number[]; start: string; end: string };
}

const DEFAULT_WH = { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };

function readNotifSettings(): NotifSettings {
  try {
    const s = JSON.parse(localStorage.getItem('sarvinbox-settings') || '{}');
    const mode = s.desktopNotifications === 'off' || s.desktopNotifications === 'all' ? s.desktopNotifications : 'important';
    const wh = s.notificationWorkingHours && typeof s.notificationWorkingHours === 'object'
      ? { ...DEFAULT_WH, ...s.notificationWorkingHours }
      : DEFAULT_WH;
    return { mode, sound: s.notificationSound !== false, workingHours: wh };
  } catch {
    return { mode: 'important', sound: true, workingHours: DEFAULT_WH };
  }
}

/**
 * Bridges the renderer's notification state into the main-process service:
 *  - pushes the config (mode/sound + per-account notify + current view) on mount
 *    and whenever accounts / active account / viewed folder change,
 *  - wires a notification CLICK back to opening that mail.
 * Mode/sound changes are pushed directly by Settings.saveSettings; this covers
 * the initial state + the store-driven pieces. Mount once (in App).
 */
export function useNotificationBridge(): void {
  useEffect(() => {
    const api = (window as unknown as { electronAPI?: any }).electronAPI?.notifications;
    if (!api) return;

    const push = (): void => {
      const st = useEmailStore.getState() as any;
      const accounts: Record<string, { notify: boolean; label: string }> = {};
      for (const a of st.accounts || []) {
        accounts[a.id] = { notify: a.notify !== false, label: a.email };
      }
      const { mode, sound, workingHours } = readNotifSettings();
      api.setConfig({
        mode, sound, accounts, workingHours,
        view: { accountId: st.activeAccountId ?? null, folderId: st.selectedFolderId ?? null },
      }).catch(() => { /* best effort */ });
    };

    push(); // initial

    // Re-push only when the pieces the service cares about change.
    const unsub = useEmailStore.subscribe((s: any, prev: any) => {
      if (
        s.accounts !== prev.accounts ||
        s.activeAccountId !== prev.activeAccountId ||
        s.selectedFolderId !== prev.selectedFolderId
      ) {
        push();
      }
    });

    // A notification click opens that mail (switching account first if needed).
    const offOpen = api.onOpenEmail(({ accountId, emailId }: { accountId: string; emailId: string }) => {
      // A notification can be clicked from ANY app section (Contacts, Settings…).
      // Navigate to the Mail view first — otherwise selecting the email in the
      // store has no visible effect and the user stays on the current page.
      openEmailFromNotification(emailId, accountId);
    });

    return () => {
      try { unsub(); } catch { /* ignore */ }
      try { offOpen?.(); } catch { /* ignore */ }
    };
  }, []);
}
