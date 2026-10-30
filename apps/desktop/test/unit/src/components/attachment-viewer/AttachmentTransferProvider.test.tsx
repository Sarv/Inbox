// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentDownloadProgress } from '../../../../../electron/preload';
import { AttachmentPills } from '../../../../../src/components/attachment-viewer/AttachmentPills';
import { AttachmentTransferProvider } from '../../../../../src/components/attachment-viewer/AttachmentTransferProvider';
import { useAttachmentActions, type AttachmentActions } from '../../../../../src/components/attachment-viewer/useAttachmentActions';
import { act, cleanup, fire, render, settle } from '../../../../helpers/render';

interface HostResult {
  success: boolean;
  url?: string;
  error?: string;
  filePath?: string;
  savedFileId?: string;
  canOpenSavedFile?: boolean;
  notScanned?: boolean;
}
type HostOperation = (emailId: string, filename: string, accountId?: string, requestId?: string) => Promise<HostResult>;
const prepareAttachmentPreview = vi.fn<HostOperation>();
const downloadAttachment = vi.fn<HostOperation>();
const downloadAttachmentToDownloads = vi.fn<HostOperation>();
const previewAttachment = vi.fn<HostOperation>();
const cancelAttachmentDownload = vi.fn<(id: string) => Promise<{ success: boolean }>>();
const releaseAttachmentPreview = vi.fn<(url: string) => Promise<{ success: boolean }>>();
const openSavedAttachment = vi.fn<(id: string) => Promise<{ success: boolean }>>();
const revealSavedAttachment = vi.fn<(id: string) => Promise<{ success: boolean }>>();
let listeners: Set<(progress: AttachmentDownloadProgress) => void>;
let shared: AttachmentActions;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Probe() {
  shared = useAttachmentActions();
  return null;
}

function Mail({ id = 'email-1', account = 'account-1', filenames = ['report.pdf'] }: { id?: string; account?: string; filenames?: string[] }) {
  return <section aria-label={`${account} ${id}`}>
    <h1>{id}</h1>
    <input aria-label="Mail search" />
    <AttachmentPills emailId={id} accountId={account} attachments={filenames.map((name) => ({ name }))} />
  </section>;
}

const screen = (mail = <Mail />) => <AttachmentTransferProvider>{mail}<Probe /></AttachmentTransferProvider>;
const openButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((value) => value.textContent?.trim() === text) ?? null;
const previewUrl = (name: string) => `sarv-attachment://attachment/email-1/${name}?lease=${name}`;
const publish = (progress: AttachmentDownloadProgress) => act(() => listeners.forEach((listener) => listener(progress)));
const resolve = async (pending: ReturnType<typeof deferred<HostResult>>, reply: HostResult) => {
  await act(async () => { pending.resolve(reply); await pending.promise; });
  await settle();
};

beforeEach(() => {
  // Electron owns this protocol. Exercise the real viewer markup without
  // asking happy-dom to perform an unsupported attachment URL network fetch.
  const happyDOM = (window as unknown as { happyDOM?: { settings: { navigation: { disableChildFrameNavigation: boolean } } } }).happyDOM;
  if (happyDOM) happyDOM.settings.navigation.disableChildFrameNavigation = true;
  listeners = new Set();
  prepareAttachmentPreview.mockReset().mockImplementation(async (_email, filename) => ({ success: true, url: previewUrl(filename) }));
  downloadAttachment.mockReset().mockResolvedValue({ success: true });
  downloadAttachmentToDownloads.mockReset().mockResolvedValue({ success: true });
  previewAttachment.mockReset().mockResolvedValue({ success: true });
  cancelAttachmentDownload.mockReset().mockResolvedValue({ success: true });
  releaseAttachmentPreview.mockReset().mockResolvedValue({ success: true });
  openSavedAttachment.mockReset().mockResolvedValue({ success: true });
  revealSavedAttachment.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { emails: {
    prepareAttachmentPreview, downloadAttachment, downloadAttachmentToDownloads, previewAttachment,
    cancelAttachmentDownload, releaseAttachmentPreview, openSavedAttachment, revealSavedAttachment,
    onAttachmentDownloadProgress: (listener: (progress: AttachmentDownloadProgress) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('App-owned nonblocking attachment preparation', () => {
  it('keeps mail interactive with no modal or preview bytes while downloading, uploading and scanning', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen(<Mail filenames={['report.pdf', 'other.pdf']} />));
    fire(mounted.byLabel('Open report.pdf'), 'click');
    expect(mounted.byLabel('Attachment transfers')).not.toBeNull();
    expect(mounted.find('[aria-modal="true"]')).toBeNull();
    expect(mounted.find('iframe')).toBeNull();

    const requestId = prepareAttachmentPreview.mock.calls[0][3]!;
    publish({ requestId, phase: 'uploading', transferredBytes: 1024, totalBytes: 2048 });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('Uploading for scan');
    expect(mounted.find('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    publish({ requestId, phase: 'scanning' });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('Scanning on server');
    expect(mounted.find('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(mounted.find('iframe')).toBeNull();

    const received: string[] = [];
    const mailKey = (event: KeyboardEvent) => received.push(event.key);
    document.addEventListener('keydown', mailKey);
    try {
      const input = mounted.byLabel('Mail search')!;
      for (const key of ['Escape', 'ArrowLeft', 'ArrowRight']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(received).toEqual(['Escape', 'ArrowLeft', 'ArrowRight']);
    } finally { document.removeEventListener('keydown', mailKey); }
    await resolve(pending, { success: false, error: 'Download cancelled.' });
  });

  it('keeps the requested preview alive after its message unmounts, then opens the correct prepared file', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen(<Mail key="old-mail" id="email-1" />));
    fire(mounted.byLabel('Open report.pdf'), 'click');
    const requestId = prepareAttachmentPreview.mock.calls[0][3]!;
    mounted.rerender(screen(<Mail key="new-mail" id="email-2" filenames={['new-message.pdf']} />));
    expect(mounted.container.textContent).toContain('email-2');
    expect(cancelAttachmentDownload).not.toHaveBeenCalled();
    publish({ requestId, phase: 'scanning' });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('Scanning on server');
    await resolve(pending, { success: true, url: previewUrl('report.pdf') });
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(mounted.find('iframe')?.getAttribute('src')).toContain(previewUrl('report.pdf'));
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
    fire(mounted.byLabel('Close attachment viewer'), 'click');
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('report.pdf'));
  });

  it('defers automatic fullscreen expansion when minimized and reuses the lease for a later manual open', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    fire(mounted.byLabel('Minimize attachment transfers'), 'click');
    expect(mounted.find('[data-collapsed="true"]')).not.toBeNull();
    await resolve(pending, { success: true, url: previewUrl('report.pdf') });
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.find('[data-collapsed="false"]')).not.toBeNull();
    fire(openButton('Open preview'), 'click');
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
    expect(releaseAttachmentPreview).not.toHaveBeenCalled();
  });

  it('does not reopen a deliberately dismissed pending preview after completion', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    fire(mounted.byLabel('Dismiss report.pdf notification'), 'click');
    expect(cancelAttachmentDownload).not.toHaveBeenCalled();
    await resolve(pending, { success: true, url: previewUrl('report.pdf') });
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.byLabel('Attachment transfers')).toBeNull();
    fire(mounted.byLabel('Open report.pdf'), 'click');
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
  });

  it('never lets a late previous preview replace a newer file and releases its stale bytes', async () => {
    const first = deferred<HostResult>();
    const second = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const mounted = render(screen(<Mail filenames={['first.pdf', 'second.pdf']} />));
    fire(mounted.byLabel('Open first.pdf'), 'click');
    const firstRequest = prepareAttachmentPreview.mock.calls[0][3]!;
    fire(mounted.byLabel('Open second.pdf'), 'click');
    expect(cancelAttachmentDownload).toHaveBeenCalledExactlyOnceWith(firstRequest);
    await resolve(second, { success: true, url: previewUrl('second.pdf') });
    expect(mounted.byLabel('Attachment: second.pdf')).not.toBeNull();
    await resolve(first, { success: true, url: previewUrl('first.pdf') });
    expect(mounted.byLabel('Attachment: second.pdf')).not.toBeNull();
    expect(mounted.byLabel('Attachment: first.pdf')).toBeNull();
    expect(mounted.find('iframe')?.getAttribute('src')).toContain(previewUrl('second.pdf'));
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('first.pdf'));
  });

  it('releases a late successful result after explicit cancellation without rendering its bytes', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    fire(mounted.byLabel('Cancel transfer of report.pdf'), 'click');
    expect(cancelAttachmentDownload).toHaveBeenCalledOnce();
    await resolve(pending, { success: true, url: previewUrl('report.pdf') });
    expect(mounted.find('[aria-modal="true"]')).toBeNull();
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('Cancelled');
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('report.pdf'));
  });

  it('allows another cancellation attempt after the host rejects the first one', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    cancelAttachmentDownload.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    const requestId = prepareAttachmentPreview.mock.calls[0][3]!;
    fire(mounted.byLabel('Cancel transfer of report.pdf'), 'click');
    await settle();
    expect(mounted.find('[role="alert"]')?.textContent).toContain('Could not cancel the download. Try again.');
    expect((mounted.byLabel('Cancel transfer of report.pdf') as HTMLButtonElement).disabled).toBe(false);
    fire(mounted.byLabel('Cancel transfer of report.pdf'), 'click');
    expect(cancelAttachmentDownload.mock.calls).toEqual([[requestId], [requestId]]);
    await resolve(pending, { success: false, error: 'Download cancelled.' });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('Cancelled');
    expect(mounted.find('[role="dialog"]')).toBeNull();
  });

  it('deduplicates repeated clicks before preparation finishes', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    fire(mounted.byLabel('Open report.pdf'), 'click');
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
    await resolve(pending, { success: true, url: previewUrl('report.pdf') });
    expect(mounted.all('[role="dialog"]')).toHaveLength(1);
  });

  it('retries a failed prepared preview through the host scan gate', async () => {
    prepareAttachmentPreview.mockResolvedValueOnce({ success: false, error: 'Download blocked: scanning failed. Try again when the scanner is available.' });
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    expect(mounted.find('[role="alert"]')?.textContent).toContain('scanning failed');
    expect(mounted.find('iframe')).toBeNull();
    fire(openButton('Try again'), 'click');
    await settle();
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
  });

  it('prepares the next gallery item in the background instead of showing a fullscreen loading view', async () => {
    const next = deferred<HostResult>();
    prepareAttachmentPreview.mockResolvedValueOnce({ success: true, url: previewUrl('first.pdf') }).mockReturnValueOnce(next.promise);
    const mounted = render(screen(<Mail filenames={['first.pdf', 'second.pdf']} />));
    fire(mounted.byLabel('Open first.pdf'), 'click');
    await settle();
    expect(mounted.byLabel('Attachment: first.pdf')).not.toBeNull();
    fire(mounted.byLabel('Next attachment'), 'click');
    expect(prepareAttachmentPreview).toHaveBeenLastCalledWith('email-1', 'second.pdf', 'account-1', expect.any(String));
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.byLabel('Attachment preview pending')).toBeNull();
    expect(mounted.byLabel('Attachment transfers')).not.toBeNull();
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('first.pdf'));
    await resolve(next, { success: true, url: previewUrl('second.pdf') });
    expect(mounted.byLabel('Attachment: second.pdf')).not.toBeNull();
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
  });

  it('minimizes an already prepared viewer and reopens it without a new scan', async () => {
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    fire(mounted.byLabel('Minimize attachment viewer'), 'click');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(releaseAttachmentPreview).not.toHaveBeenCalled();
    fire(openButton('Open preview'), 'click');
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
  });

  it('retains the ready notification on minimize but dismisses it when the completed viewer is closed', async () => {
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    fire(mounted.byLabel('Minimize attachment viewer'), 'click');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.byLabel('Attachment transfers')).not.toBeNull();
    expect(openButton('Open preview')).not.toBeNull();
    expect(releaseAttachmentPreview).not.toHaveBeenCalled();
    fire(openButton('Open preview'), 'click');
    fire(mounted.byLabel('Close attachment viewer'), 'click');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.byLabel('Attachment transfers')).toBeNull();
    expect(openButton('Open preview')).toBeNull();
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('report.pdf'));
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
  });

  it('prepares a fresh lease before reopening a preview that has stayed minimized for four minutes', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const renewed = deferred<HostResult>();
    prepareAttachmentPreview.mockResolvedValueOnce({ success: true, url: previewUrl('report.pdf') }).mockReturnValueOnce(renewed.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    fire(mounted.byLabel('Minimize attachment viewer'), 'click');
    now += 4 * 60_000 + 1;
    fire(openButton('Open preview'), 'click');
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('report.pdf'));
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.find('iframe')).toBeNull();
    const newUrl = `${previewUrl('report.pdf')}-renewed`;
    await resolve(renewed, { success: true, url: newUrl });
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(mounted.find('iframe')?.getAttribute('src')).toContain(newUrl);
  });

  it('retries a viewer decoding failure with a new host lease instead of reusing broken bytes', async () => {
    const renewed = deferred<HostResult>();
    prepareAttachmentPreview.mockResolvedValueOnce({ success: true, url: previewUrl('picture.png') }).mockReturnValueOnce(renewed.promise);
    const mounted = render(screen(<Mail filenames={['picture.png']} />));
    fire(mounted.byLabel('Open picture.png'), 'click');
    await settle();
    fire(mounted.find('img'), 'error');
    expect(mounted.byLabel('Attachment: picture.png')?.textContent).toContain('This file could not be shown');
    fire(openButton('Retry preview'), 'click');
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(releaseAttachmentPreview).toHaveBeenCalledExactlyOnceWith(previewUrl('picture.png'));
    expect(mounted.find('[role="dialog"]')).toBeNull();
    const newUrl = `${previewUrl('picture.png')}-retry`;
    await resolve(renewed, { success: true, url: newUrl });
    expect(mounted.find('img')?.getAttribute('src')).toContain(newUrl);
  });

  it('binds an implicit account when requested and retains that owner on retry after switching accounts', async () => {
    let selectedAccount = 'account-a';
    const resolveAccountId = vi.fn(() => selectedAccount);
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const content = () => <AttachmentTransferProvider resolveAccountId={resolveAccountId}><Probe /></AttachmentTransferProvider>;
    const mounted = render(content());
    act(() => shared.requestPreview!({ emailId: 'email-1', attachments: [{ name: 'report.pdf' }], initialIndex: 0 }));
    expect(prepareAttachmentPreview).toHaveBeenLastCalledWith('email-1', 'report.pdf', 'account-a', expect.any(String));
    selectedAccount = 'account-b';
    mounted.rerender(content());
    await resolve(pending, { success: false, error: 'Download blocked: scanning failed. Try again when the scanner is available.' });
    fire(openButton('Try again'), 'click');
    await settle();
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(prepareAttachmentPreview).toHaveBeenLastCalledWith('email-1', 'report.pdf', 'account-a', expect.any(String));
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
  });
});

describe('App-owned saved downloads', () => {
  it('minimizes the expanded viewer while saving and keeps the saved path and receipt actions accessible', async () => {
    const pending = deferred<HostResult>();
    downloadAttachmentToDownloads.mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    fire(mounted.byLabel('Save a copy'), 'click');
    expect(downloadAttachmentToDownloads).toHaveBeenCalledExactlyOnceWith('email-1', 'report.pdf', 'account-1', expect.any(String));
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.byLabel('Attachment transfers')).not.toBeNull();
    expect(mounted.find('[role="progressbar"]')).not.toBeNull();
    expect(releaseAttachmentPreview).not.toHaveBeenCalled();
    const requestId = downloadAttachmentToDownloads.mock.calls[0][3]!;
    publish({ requestId, phase: 'scanning' });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('Scanning on server');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    await resolve(pending, { success: true, filePath: '/Users/me/Downloads/report.pdf', savedFileId: 'saved-from-preview', canOpenSavedFile: true });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('/Users/me/Downloads/report.pdf');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    fire(openButton('Open file'), 'click');
    fire(openButton('Show in folder'), 'click');
    await settle();
    expect(openSavedAttachment).toHaveBeenCalledExactlyOnceWith('saved-from-preview');
    expect(revealSavedAttachment).toHaveBeenCalledExactlyOnceWith('saved-from-preview');
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
    expect(downloadAttachmentToDownloads).toHaveBeenCalledOnce();
  });

  it('survives leaving the email and opens or reveals the saved receipt without rescanning', async () => {
    const pending = deferred<HostResult>();
    downloadAttachmentToDownloads.mockReturnValueOnce(pending.promise);
    const mounted = render(screen(<Mail key="first" />));
    fire(mounted.byLabel('Save a copy of report.pdf'), 'click');
    expect(downloadAttachment).not.toHaveBeenCalled();
    const requestId = downloadAttachmentToDownloads.mock.calls[0][3]!;
    mounted.rerender(screen(<Mail key="second" id="email-2" filenames={['other.pdf']} />));
    publish({ requestId, phase: 'uploading', transferredBytes: 5, totalBytes: 10 });
    expect(mounted.find('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    await resolve(pending, { success: true, filePath: '/Users/me/Downloads/report.pdf', savedFileId: 'saved-receipt-1', canOpenSavedFile: true });
    expect(mounted.byLabel('Attachment transfers')?.textContent).toContain('/Users/me/Downloads/report.pdf');
    fire(openButton('Open file'), 'click');
    fire(openButton('Show in folder'), 'click');
    await settle();
    expect(openSavedAttachment).toHaveBeenCalledExactlyOnceWith('saved-receipt-1');
    expect(revealSavedAttachment).toHaveBeenCalledExactlyOnceWith('saved-receipt-1');
    expect(downloadAttachmentToDownloads).toHaveBeenCalledOnce();
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
    expect(previewAttachment).not.toHaveBeenCalled();
    expect(mounted.find('[role="dialog"]')).toBeNull();
  });

  it('keeps same-name transfers independent across both email and account identity', async () => {
    const pending = [deferred<HostResult>(), deferred<HostResult>(), deferred<HostResult>()];
    pending.forEach((item) => downloadAttachmentToDownloads.mockReturnValueOnce(item.promise));
    const mounted = render(screen(<><Mail id="email-1" account="account-1" /><Mail id="email-1" account="account-2" /><Mail id="email-2" account="account-1" /></>));
    const start = (label: string) => {
      const section = mounted.byLabel(label)!;
      fire(section.querySelector('[aria-label="Save a copy of report.pdf"]'), 'click');
    };
    start('account-1 email-1');
    expect(shared.isBusy('email-1', 'report.pdf', 'account-1')).toBe(true);
    expect(shared.isBusy('email-1', 'report.pdf', 'account-2')).toBe(false);
    expect(shared.isBusy('email-2', 'report.pdf', 'account-1')).toBe(false);
    start('account-2 email-1');
    start('account-1 email-2');
    expect(downloadAttachmentToDownloads).toHaveBeenCalledTimes(3);
    const requestIds = downloadAttachmentToDownloads.mock.calls.map((call) => call[3]!);
    expect(new Set(requestIds).size).toBe(3);
    publish({ requestId: requestIds[1], phase: 'scanning' });
    expect(shared.getStatus('email-1', 'report.pdf', 'account-1')?.phase).toBe('downloading');
    expect(shared.getStatus('email-1', 'report.pdf', 'account-2')?.phase).toBe('scanning');
    expect(shared.getStatus('email-2', 'report.pdf', 'account-1')?.phase).toBe('downloading');
    for (const item of pending) await resolve(item, { success: true });
  });

  it('waits for an existing save before independently preparing its requested preview', async () => {
    const pending = deferred<HostResult>();
    downloadAttachmentToDownloads.mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Save a copy of report.pdf'), 'click');
    fire(mounted.byLabel('Open report.pdf'), 'click');
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
    expect(mounted.find('[role="dialog"]')).toBeNull();
    mounted.rerender(screen(<Mail id="email-2" filenames={['other.pdf']} />));
    expect(cancelAttachmentDownload).not.toHaveBeenCalled();
    await resolve(pending, { success: true, filePath: '/Users/me/Downloads/report.pdf', savedFileId: 'saved-receipt-1' });
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
  });
});

describe('Dismissed attachment transfers', () => {
  it('keeps dismissed failed and saved notifications hidden when another attachment opens', async () => {
    prepareAttachmentPreview.mockResolvedValueOnce({ success: false, error: 'Download blocked: scanning failed. Try again when the scanner is available.' });
    const mounted = render(screen(<Mail filenames={['blocked.pdf', 'saved.pdf', 'new.pdf']} />));
    fire(mounted.byLabel('Open blocked.pdf'), 'click');
    await settle();
    fire(mounted.byLabel('Save a copy of saved.pdf'), 'click');
    await settle();
    expect(mounted.all('.attachment-transfer')).toHaveLength(2);
    fire(mounted.byLabel('Dismiss blocked.pdf notification'), 'click');
    fire(mounted.byLabel('Dismiss saved.pdf notification'), 'click');
    expect(mounted.byLabel('Attachment transfers')).toBeNull();

    fire(mounted.byLabel('Open new.pdf'), 'click');
    await settle();
    expect(mounted.byLabel('Attachment: new.pdf')).not.toBeNull();
    expect(mounted.all('.attachment-transfer').map(row => row.getAttribute('aria-label'))).toEqual(['new.pdf']);
  });

  it.each(['active', 'ready'] as const)('restores only the selected %s preview notification when reopening it', async (status) => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockReturnValueOnce(pending.promise);
    const mounted = render(screen(<Mail filenames={['cached.pdf', 'saved.pdf']} />));
    fire(mounted.byLabel('Save a copy of saved.pdf'), 'click');
    await settle();
    fire(mounted.byLabel('Open cached.pdf'), 'click');
    fire(mounted.byLabel('Dismiss saved.pdf notification'), 'click');
    fire(mounted.byLabel('Dismiss cached.pdf notification'), 'click');
    if (status === 'ready') await resolve(pending, { success: true, url: previewUrl('cached.pdf') });
    expect(mounted.byLabel('Attachment transfers')).toBeNull();

    fire(mounted.byLabel('Open cached.pdf'), 'click');
    expect(mounted.all('.attachment-transfer').map(row => row.getAttribute('aria-label'))).toEqual(['cached.pdf']);
    if (status === 'active') await resolve(pending, { success: true, url: previewUrl('cached.pdf') });
    expect(mounted.byLabel('Attachment: cached.pdf')).not.toBeNull();
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
  });

  it('keeps the failed attempt hidden when retrying its preview', async () => {
    prepareAttachmentPreview.mockResolvedValueOnce({ success: false, error: 'Download blocked: scanning failed. Try again when the scanner is available.' });
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    expect(mounted.find('.attachment-transfer')?.getAttribute('data-status')).toBe('failed');

    fire(openButton('Try again'), 'click');
    await settle();
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(mounted.all('.attachment-transfer').map(row => row.getAttribute('data-status'))).toEqual(['ready']);
  });

  it('does not restore an older failed attempt when reopening a cached retry', async () => {
    const pending = deferred<HostResult>();
    prepareAttachmentPreview.mockResolvedValueOnce({ success: false, error: 'Download blocked: scanning failed. Try again when the scanner is available.' })
      .mockReturnValueOnce(pending.promise);
    const mounted = render(screen());
    fire(mounted.byLabel('Open report.pdf'), 'click');
    await settle();
    fire(openButton('Try again'), 'click');
    fire(mounted.byLabel('Dismiss report.pdf notification'), 'click');
    await resolve(pending, { success: true, url: previewUrl('report.pdf') });

    fire(mounted.byLabel('Open report.pdf'), 'click');
    expect(mounted.byLabel('Attachment: report.pdf')).not.toBeNull();
    expect(mounted.all('.attachment-transfer').map(row => row.getAttribute('data-status'))).toEqual(['ready']);
  });
});
