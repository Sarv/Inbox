import { EventEmitter } from 'node:events';

import type { DownloadItem, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  installNativeAttachmentDownloadGuard,
  nativeDownloadBelongsToInbox,
} from '../../../../electron/services/native-attachment-download-guard';

const contents = (host: WebContents | null = null) => ({ hostWebContents: host }) as WebContents;
const download = (url: string, chain: string[] = [], savePath = '/Users/me/Downloads/report.pdf') =>
  Object.assign(new EventEmitter(), { getURL: () => url, getURLChain: () => chain, getSavePath: () => savePath }) as unknown as DownloadItem;

function fixture(options: { scanning?: boolean } = {}) {
  const session = new EventEmitter();
  const inbox = contents();
  const notifyBlocked = vi.fn();
  const markDownloaded = vi.fn(async (_file: string) => {});
  const scanningRequired = vi.fn(() => options.scanning ?? true);
  const remove = installNativeAttachmentDownloadGuard(session as unknown as Session, { inboxWebContents: () => inbox, scanningRequired, notifyBlocked, markDownloaded });
  const attempt = (item = download('blob:chrome-extension://pdf-viewer/pdf'), source = inbox) => {
    const event = { preventDefault: vi.fn() };
    session.emit('will-download', event, item, source);
    return event;
  };
  return { session, inbox, notifyBlocked, scanningRequired, markDownloaded, remove, attempt };
}

// Breaks: PDF toolbar, native media menu or blob downloads write attachments without the AV gate.
describe('native attachment download protection', () => {
  it('blocks a native download from the Inbox webContents and supplies trusted instructions', () => {
    const f = fixture(); const event = f.attempt();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(f.notifyBlocked).toHaveBeenCalledOnce();
  });

  it('blocks separate PDF guest contents attached to the Inbox window', () => {
    const f = fixture(); const guest = contents(contents(f.inbox));
    expect(f.attempt(download('blob:chrome-extension://pdf-viewer/pdf'), guest).preventDefault).toHaveBeenCalledOnce();
  });

  it('blocks an attachment URL or redirect chain even when a PDF guest omits its host', () => {
    const f = fixture(); const guest = contents();
    expect(f.attempt(download('sarv-attachment://email/report.pdf'), guest).preventDefault).toHaveBeenCalledOnce();
    expect(f.attempt(download('blob:chrome-extension://pdf-viewer/pdf', ['sarv-attachment://email/report.pdf']), guest).preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves native saves alone when no scanner is enabled', () => {
    const f = fixture({ scanning: false });
    expect(f.attempt().preventDefault).not.toHaveBeenCalled(); expect(f.notifyBlocked).not.toHaveBeenCalled();
  });

  it('does not block unrelated windows or malformed unrelated URLs', () => {
    const f = fixture();
    expect(f.attempt(download('https://unrelated.example/file.zip', ['not a url']), contents()).preventDefault).not.toHaveBeenCalled();
    expect(f.scanningRequired).not.toHaveBeenCalled(); expect(f.notifyBlocked).not.toHaveBeenCalled();
  });

  it('fails closed for Inbox downloads when the extension registry cannot be read', () => {
    const f = fixture(); f.scanningRequired.mockImplementation(() => { throw new Error('unreadable registry'); });
    expect(f.attempt().preventDefault).toHaveBeenCalledOnce();
  });

  it('coalesces instructions while the trusted dialog is open and permits a later reminder', async () => {
    const f = fixture(); let close!: () => void;
    f.notifyBlocked.mockImplementation(() => new Promise<void>(resolve => { close = resolve; }));
    const first = f.attempt(); const second = f.attempt();
    expect(first.preventDefault).toHaveBeenCalledOnce(); expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(f.notifyBlocked).toHaveBeenCalledOnce(); close(); await Promise.resolve(); await Promise.resolve();
    f.attempt(); expect(f.notifyBlocked).toHaveBeenCalledTimes(2); close();
  });

  it.each(['throw', 'reject'] as const)('keeps the security gate when showing instructions %ss', async failure => {
    const f = fixture(); f.notifyBlocked.mockImplementation(() => {
      if (failure === 'throw') throw new Error('window closed');
      return Promise.reject(new Error('window closed'));
    });
    expect(f.attempt().preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve(); await Promise.resolve();
    expect(f.attempt().preventDefault).toHaveBeenCalledOnce(); expect(f.notifyBlocked).toHaveBeenCalledTimes(2);
  });

  // Breaks (CASA 5.2.1): Electron's download manager applies no quarantine /
  // Mark of the Web, so a PDF saved from the viewer's own toolbar would open
  // with no "downloaded from the internet" warning.
  it('marks a native save it lets through once Chromium has finished writing it', () => {
    const f = fixture({ scanning: false });
    const item = download('blob:chrome-extension://pdf-viewer/pdf');
    f.attempt(item);
    expect(f.markDownloaded).not.toHaveBeenCalled(); // not before the bytes exist
    item.emit('done', {}, 'completed');
    expect(f.markDownloaded).toHaveBeenCalledExactlyOnceWith('/Users/me/Downloads/report.pdf');
  });

  it('marks an unrelated window\'s completed download too, and nothing that did not complete', () => {
    const f = fixture();
    const unrelated = download('https://unrelated.example/file.zip');
    f.attempt(unrelated, contents());
    unrelated.emit('done', {}, 'completed');
    expect(f.markDownloaded).toHaveBeenCalledOnce();
    for (const state of ['cancelled', 'interrupted']) {
      const item = download('https://unrelated.example/other.zip');
      f.attempt(item, contents());
      item.emit('done', {}, state);
    }
    const noPath = download('https://unrelated.example/x.zip', [], '');
    f.attempt(noPath, contents());
    noPath.emit('done', {}, 'completed');
    expect(f.markDownloaded).toHaveBeenCalledOnce();
  });

  // A blocked download never writes, so there is nothing to mark.
  it('does not wait to mark a download it blocked', () => {
    const f = fixture();
    const item = download('blob:chrome-extension://pdf-viewer/pdf');
    f.attempt(item);
    expect((item as unknown as EventEmitter).listenerCount('done')).toBe(0);
  });

  it('removes its session listener when the Inbox window closes', () => {
    const f = fixture(); expect(f.session.listenerCount('will-download')).toBe(1);
    f.remove(); expect(f.session.listenerCount('will-download')).toBe(0);
    expect(f.attempt().preventDefault).not.toHaveBeenCalled();
  });

  it('does not treat orphaned windows as the Inbox and tolerates host cycles', () => {
    const source = contents(); Object.assign(source, { hostWebContents: source });
    expect(nativeDownloadBelongsToInbox(download('https://unrelated.example/file'), source, contents())).toBe(false);
    expect(nativeDownloadBelongsToInbox(download('sarv-attachment://email/file.pdf'), source, undefined)).toBe(false);
  });
});
