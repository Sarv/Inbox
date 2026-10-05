import { EventEmitter } from 'node:events';

import type { DownloadItem, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
  installNativeAttachmentDownloadGuard,
  nativeDownloadBelongsToInbox,
} from '../../../../electron/services/native-attachment-download-guard';

const contents = (host: WebContents | null = null) => ({ hostWebContents: host }) as WebContents;
const download = (url: string, chain: string[] = []) => ({ getURL: () => url, getURLChain: () => chain }) as DownloadItem;

function fixture(options: { scanning?: boolean } = {}) {
  const session = new EventEmitter();
  const inbox = contents();
  const notifyBlocked = vi.fn();
  const scanningRequired = vi.fn(() => options.scanning ?? true);
  const remove = installNativeAttachmentDownloadGuard(session as unknown as Session, { inboxWebContents: () => inbox, scanningRequired, notifyBlocked });
  const attempt = (item = download('blob:chrome-extension://pdf-viewer/pdf'), source = inbox) => {
    const event = { preventDefault: vi.fn() };
    session.emit('will-download', event, item, source);
    return event;
  };
  return { session, inbox, notifyBlocked, scanningRequired, remove, attempt };
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
