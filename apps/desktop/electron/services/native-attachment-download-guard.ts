import { ATTACHMENT_SCHEME } from '@sarvinbox/core';
import type { DownloadItem, Event, Session, WebContents } from 'electron';

import { markDownloadedFromInternet } from './mark-downloaded';

interface NativeDownloadGuardDependencies {
  inboxWebContents(): WebContents | undefined;
  scanningRequired(): boolean;
  notifyBlocked(): unknown | Promise<unknown>;
  /** Defaults to the shared helper; injectable for tests. */
  markDownloaded?(filePath: string): Promise<void>;
}

/**
 * A session download the guard lets through is still bytes from mail or the
 * web. Electron's download manager does not apply Chromium's quarantine / Mark
 * of the Web (it provides no quarantine connection), so mark it once Chromium
 * has finished writing it.
 */
function markWhenSaved(item: Pick<DownloadItem, 'once' | 'getSavePath'>, mark: (filePath: string) => Promise<void>): void {
  item.once('done', (_event, state) => {
    const savedPath = state === 'completed' ? item.getSavePath() : '';
    if (savedPath) void mark(savedPath);
  });
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
  const mark = deps.markDownloaded ?? markDownloadedFromInternet;
  const listener = (event: Event, item: DownloadItem, source: WebContents) => {
    if (!nativeDownloadBelongsToInbox(item, source, deps.inboxWebContents())) { markWhenSaved(item, mark); return; }
    let required = true;
    try { required = deps.scanningRequired(); }
    catch { /* An unreadable extension registry cannot prove the absence of protection. */ }
    if (!required) { markWhenSaved(item, mark); return; }
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
