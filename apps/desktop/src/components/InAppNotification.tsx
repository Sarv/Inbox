import { Mail, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useEmailStore } from '../store/email-store';

/**
 * In-app notification toasts — a fallback for when the OS can't show native
 * ones. The main process mirrors each toast here whenever native notifications
 * aren't available: in DEV (Electron is spawned by node, so macOS won't authorize
 * native toasts) and on any platform with no notification daemon (e.g. a headless
 * Linux box). Never fires in a normal packaged build, so it can't double up with
 * the real OS toast. Clicking a mail toast opens that email (same path as a
 * native notification click).
 */
interface Toast {
  id: string;
  title: string;
  body: string;
  subtitle?: string;
  accountId?: string;
  emailId?: string;
}

const AUTO_DISMISS_MS = 6000;
const MAX_VISIBLE = 4;

export function InAppNotification() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const off = window.electronAPI?.notifications?.onInApp?.((data: Toast) => {
      setToasts((cur) => [data, ...cur].slice(0, MAX_VISIBLE));
      setTimeout(() => remove(data.id), AUTO_DISMISS_MS);
    });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, [remove]);

  // Same open path as a native notification click (useNotificationBridge).
  const open = (t: Toast) => {
    remove(t.id);
    if (!t.emailId) return;
    document.dispatchEvent(new CustomEvent('sarvinbox:open-mail'));
    const st = useEmailStore.getState() as any;
    const sel = () => { try { st.selectEmail?.(t.emailId); } catch { /* ignore */ } };
    if (t.accountId && t.accountId !== st.activeAccountId && typeof st.selectAccount === 'function') {
      st.selectAccount(t.accountId).then(sel).catch(sel);
    } else {
      sel();
    }
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[250] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div key={t.id} className="group bg-card border border-border rounded-lg shadow-2xl overflow-hidden animate-in slide-in-from-right-4 fade-in duration-200">
          <div className="flex items-start gap-3 p-3">
            <div className="p-1.5 bg-primary/10 rounded-md shrink-0"><Mail className="h-4 w-4 text-primary" /></div>
            <button
              onClick={() => open(t)}
              className={`flex-1 min-w-0 text-left ${t.emailId ? 'cursor-pointer' : 'cursor-default'}`}
              title={t.emailId ? 'Open this email' : undefined}
            >
              <div className="text-sm font-medium truncate">{t.title}</div>
              {t.subtitle && <div className="text-xs text-muted-foreground truncate">{t.subtitle}</div>}
              <div className="text-sm text-muted-foreground truncate">{t.body}</div>
            </button>
            <button
              onClick={() => remove(t.id)}
              aria-label="Dismiss"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
