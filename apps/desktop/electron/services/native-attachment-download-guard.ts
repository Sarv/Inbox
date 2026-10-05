import { ATTACHMENT_SCHEME } from '@sarvinbox/core';
import type { DownloadItem, Event, Session, WebContents } from 'electron';

interface NativeDownloadGuardDependencies {
  inboxWebContents(): WebContents | undefined;
  scanningRequired(): boolean;
  notifyBlocked(): unknown | Promise<unknown>;
}

/** PDF guests may be separate webContents; their attachment URL is still host-owned. */
export function nativeDownloadBelongsToInbox(
  item: Pick<DownloadItem, 'getURL' | 'getURLChain'>,
  source: WebContents | undefined,
  inbox: WebContents | undefined,
): boolean {
  if (!inbox) return false;
  const seen = new Set<WebContents>();
  for (let current = source; current && !seen.has(current); current = current.hostWebContents ?? undefined) {
    if (current === inbox) return true;
    seen.add(current);
  }
  return [...item.getURLChain(), item.getURL()].some(url => {
    try { return new URL(url).protocol === `${ATTACHMENT_SCHEME}:`; }
    catch { return false; }
  });
}

/** Native PDF/media save controls cannot bypass the app's verified save workflow. */
export function installNativeAttachmentDownloadGuard(
  session: Pick<Session, 'on' | 'removeListener'>,
  deps: NativeDownloadGuardDependencies,
): () => void {
  let notificationPending = false;
  const listener = (event: Event, item: DownloadItem, source: WebContents) => {
    if (!nativeDownloadBelongsToInbox(item, source, deps.inboxWebContents())) return;
    let required = true;
    try { required = deps.scanningRequired(); }
    catch { /* An unreadable extension registry cannot prove the absence of protection. */ }
    if (!required) return;
    event.preventDefault();
    if (notificationPending) return;
    notificationPending = true;
    try {
      void Promise.resolve(deps.notifyBlocked()).catch(() => {}).finally(() => { notificationPending = false; });
    } catch { notificationPending = false; }
  };
  session.on('will-download', listener);
  return () => session.removeListener('will-download', listener);
}
