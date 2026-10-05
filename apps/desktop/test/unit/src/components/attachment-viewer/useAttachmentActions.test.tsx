// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentDownloadProgress } from '../../../../../electron/preload';
import {
  attachmentKey,
  useAttachmentActions,
  type AttachmentActions,
} from '../../../../../src/components/attachment-viewer/useAttachmentActions';
import { act, render } from '../../../../helpers/render';

/**
 * The one implementation of "what happens when you touch an attachment".
 *
 * It replaced three near-copies (EmailCard, ThreadList, ThreadChatView), one of
 * which silently dropped the failure handling — a failed save looked exactly
 * like a successful one. These tests pin the behaviour the copies disagreed on.
 */

const downloadAttachment = vi.fn();
const previewAttachment = vi.fn();
const prepareAttachmentPreview = vi.fn();
const cancelAttachmentDownload = vi.fn();
const unsubscribe = vi.fn();
const onAttachmentDownloadProgress = vi.fn();
let progress: (value: AttachmentDownloadProgress) => void;

/** Exposes the hook's API to the test without a component wrapper per case. */
let actions: AttachmentActions;
function Probe() {
  actions = useAttachmentActions();
  return (
    <div
      data-busy={String(actions.isBusy('email-1', 'report.pdf'))}
      data-busy-other={String(actions.isBusy('email-2', 'report.pdf'))}
    />
  );
}

const spyOnConsoleError = () => vi.spyOn(console, 'error').mockImplementation(() => {});

let mounted: ReturnType<typeof render>;
let errorSpy: ReturnType<typeof spyOnConsoleError>;

beforeEach(() => {
  downloadAttachment.mockReset().mockResolvedValue({ success: true });
  previewAttachment.mockReset().mockResolvedValue({ success: true });
  prepareAttachmentPreview.mockReset().mockResolvedValue({ success: true, url: 'sarv-attachment://attachment/email-1/report.pdf?lease=clean' });
  cancelAttachmentDownload.mockReset().mockResolvedValue({ success: true });
  unsubscribe.mockReset();
  onAttachmentDownloadProgress.mockReset().mockImplementation((callback) => {
    progress = callback;
    return unsubscribe;
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: { downloadAttachment, previewAttachment, prepareAttachmentPreview, cancelAttachmentDownload, onAttachmentDownloadProgress },
  };
  errorSpy = spyOnConsoleError();
  mounted = render(<Probe />);
});

afterEach(() => {
  mounted.unmount();
  vi.restoreAllMocks();
});

const probe = () => mounted.find('[data-busy]')!;

/** Start a hook action inside act(), so React flushes the busy-state update.
 *  Returns the still-pending promise so a test can assert mid-flight. */
function start<T>(action: () => Promise<T>): Promise<T> {
  let pending!: Promise<T>;
  act(() => {
    pending = action();
  });
  return pending;
}

/** Start an action and wait for it to finish. */
const run = async <T,>(action: () => Promise<T>): Promise<T> => {
  const pending = start(action);
  let result!: T;
  await act(async () => {
    result = await pending;
  });
  return result;
};

describe('in-flight keying', () => {
  // Breaks: two messages in one thread carrying the same attachment name share a
  // spinner — saving one makes the other look like it is working too. The key is
  // emailId AND filename for exactly this reason.
  it('keys the busy state per email and filename', async () => {
    let release: (value: unknown) => void = () => {};
    downloadAttachment.mockReturnValue(new Promise((resolve) => (release = resolve)));

    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(probe().dataset.busy).toBe('true');
    expect(probe().dataset.busyOther).toBe('false');

    release({ success: true });
    await act(async () => {
      await pending;
    });
    expect(probe().dataset.busy).toBe('false');
  });

  // Breaks: a failing save leaves the chip spinning forever, so the user cannot
  // retry it.
  it('clears the busy state when the call throws', async () => {
    downloadAttachment.mockRejectedValue(new Error('IPC gone'));

    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(probe().dataset.busy).toBe('false');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('composes the key from both parts', () => {
    expect(attachmentKey('email-1', 'report.pdf')).toBe('email-1:report.pdf');
    expect(attachmentKey('email-1', 'a')).not.toBe(attachmentKey('email-2', 'a'));
  });
});

describe('error reporting', () => {
  // Breaks: a changed setup or bounded unscanned-file limit is hidden by a
  // generic connection error instead of telling the user why it was blocked.
  it.each([
    'Antivirus setup changed. Try again.',
    'Attachment is too large to open or save without scanning.',
  ])('preserves the host optional-scanning failure (%s)', async (error) => {
    downloadAttachment.mockResolvedValueOnce({ success: false, error });
    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBe(error);
    expect(actions.getStatus('email-1', 'report.pdf')?.notScanned).toBeUndefined();
  });

  // Breaks: a punctuation mismatch hides the host's bounded-download timeout
  // behind an unrelated generic error and leaves the user unable to explain a failed scan.
  it('preserves the host-owned timeout message exactly', async () => {
    downloadAttachment.mockResolvedValueOnce({ success: false, error: 'Attachment download timed out.' });
    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBe('Attachment download timed out.');
    expect(actions.isBusy('email-1', 'report.pdf')).toBe(false);
  });

  // Breaks: a cancelled save dialog is logged as an error. It isn't one — the
  // user changed their mind — and logging it is what trained everyone to ignore
  // the real failures next to it.
  it('does not report a cancelled save as an error', async () => {
    downloadAttachment.mockResolvedValue({ success: false, error: 'Save cancelled' });

    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Breaks: the ThreadChatView regression — a genuine failure (not connected,
  // file too large, wrong account) shows nothing at all.
  it('reports a genuine failure', async () => {
    downloadAttachment.mockResolvedValue({ success: false, error: 'Not connected to IMAP' });

    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(errorSpy.mock.calls[0].join(' ')).toContain('The attachment could not be saved');
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toContain('Check your connection');
    expect(errorSpy.mock.calls[0].join(' ')).not.toContain('Not connected to IMAP');
  });
});

describe('trusted download progress', () => {
  // Breaks: an explicitly accepted missing-setup warning disappears on success,
  // making an unscanned save, preview or system opening look like a clean scan.
  it.each(['save', 'open', 'preview'] as const)('keeps the host unscanned outcome visible for %s', async (operation) => {
    const host = operation === 'save' ? downloadAttachment : operation === 'open' ? previewAttachment : prepareAttachmentPreview;
    host.mockResolvedValueOnce({ success: true, notScanned: true, url: 'sarv-attachment://attachment/email-1/report.pdf?lease=unscanned' });
    const target = { emailId: 'email-1', filename: 'report.pdf', accountId: 'acct-1' };
    await run(async () => {
      if (operation === 'save') await actions.saveCopy(target);
      else if (operation === 'open') await actions.openInSystemApp(target);
      else await actions.preparePreview(target);
    });
    expect(actions.getStatus('email-1', 'report.pdf')).toEqual({ notScanned: true, operation });
    expect(actions.getStatus('email-2', 'report.pdf')).toBeUndefined();
    expect(actions.isBusy('email-1', 'report.pdf')).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  // Breaks: a stale warning remains during a later scan, or an unchecked
  // truthy flag makes an ordinary clean/no-scanner outcome appear unscanned.
  it('clears the warning on a new operation and accepts only a boolean host flag', async () => {
    downloadAttachment.mockResolvedValueOnce({ success: true, notScanned: true });
    const target = { emailId: 'email-1', filename: 'report.pdf' };
    await run(() => actions.saveCopy(target));
    expect(actions.getStatus('email-1', 'report.pdf')?.notScanned).toBe(true);
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const retry = start(() => actions.saveCopy(target));
    expect(actions.getStatus('email-1', 'report.pdf')).toMatchObject({ phase: 'downloading', operation: 'save' });
    expect(actions.getStatus('email-1', 'report.pdf')?.notScanned).toBeUndefined();
    release({ success: true, notScanned: 'true' });
    await act(async () => { await retry; });
    expect(actions.getStatus('email-1', 'report.pdf')).toBeUndefined();
  });

  // Breaks: a failed scan or malformed preview succeeds visually merely
  // because its reply also carries an unscanned flag.
  it.each([
    { success: false, error: 'Download blocked: ClamAV detected a threat.' },
    { success: false, error: 'Download blocked: the attachment could not be fully scanned.' },
    { success: false, error: 'Download blocked: scanning failed. Try again when the scanner is available.' },
    { success: true, url: '' },
  ])('never substitutes an unscanned outcome for a failure (%j)', async (reply) => {
    prepareAttachmentPreview.mockResolvedValueOnce({ ...reply, notScanned: true });
    expect(await run(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }))).toBeUndefined();
    expect(actions.getStatus('email-1', 'report.pdf')?.notScanned).toBeUndefined();
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBeTruthy();
  });

  // Breaks: a cached attachment begins scanning before the renderer subscribes,
  // leaving the user looking at a download spinner for the entire scan.
  it('subscribes before starting and shows downloading, scanning and saving', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockImplementation((_email, _file, _account, requestId) => {
      expect(onAttachmentDownloadProgress).toHaveBeenCalledOnce();
      progress({ requestId, phase: 'scanning' });
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    const requestId = downloadAttachment.mock.calls[0][3];
    expect(actions.getStatus('email-1', 'report.pdf')?.phase).toBe('scanning');
    act(() => { progress({ requestId, phase: 'saving' }); });
    expect(actions.getStatus('email-1', 'report.pdf')?.phase).toBe('saving');
    release({ success: true });
    await act(async () => { await pending; });
    expect(actions.getStatus('email-1', 'report.pdf')).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  // Breaks: global IPC progress from another account/request alters this file,
  // or malformed phases are treated as a successful scan.
  it('matches only its request and ignores malformed phases and late events', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    const requestId = downloadAttachment.mock.calls[0][3];
    act(() => {
      progress({ requestId: 'another-request', phase: 'scanning' });
      progress({ requestId, phase: 'clean' as AttachmentDownloadProgress['phase'] });
      progress(undefined as unknown as AttachmentDownloadProgress);
    });
    expect(actions.getStatus('email-1', 'report.pdf')?.phase).toBe('downloading');
    release({ success: true });
    await act(async () => { await pending; });
    act(() => { progress({ requestId, phase: 'scanning' }); });
    expect(actions.getStatus('email-1', 'report.pdf')).toBeUndefined();
  });

  // Breaks: concurrent saves from unified inboxes share a request id or show
  // another account's scan status merely because both files are named report.pdf.
  it('keeps simultaneous account saves and progress isolated', async () => {
    const releases = new Map<string, (result: unknown) => void>();
    downloadAttachment.mockImplementation((emailId) => new Promise((resolve) => { releases.set(emailId, resolve); }));
    const first = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf', accountId: 'acct-1' }));
    const second = start(() => actions.saveCopy({ emailId: 'email-2', filename: 'report.pdf', accountId: 'acct-2' }));
    const firstId = downloadAttachment.mock.calls[0][3];
    expect(downloadAttachment.mock.calls[1][3]).not.toBe(firstId);
    act(() => {
      for (const [callback] of onAttachmentDownloadProgress.mock.calls) callback({ requestId: firstId, phase: 'scanning' });
    });
    expect(actions.getStatus('email-1', 'report.pdf')?.phase).toBe('scanning');
    expect(actions.getStatus('email-2', 'report.pdf')?.phase).toBe('downloading');
    releases.get('email-1')!({ success: false, error: 'Download blocked: ClamAV detected a threat.' });
    await act(async () => { await first; });
    expect(actions.isBusy('email-2', 'report.pdf')).toBe(true);
    releases.get('email-2')!({ success: true });
    await act(async () => { await second; });
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toContain('ClamAV detected a threat');
    expect(actions.getStatus('email-2', 'report.pdf')).toBeUndefined();
  });

  // Breaks: a failed OS-open IPC call leaks its raw exception or keeps this
  // attachment spinning even though downloads and opens use separate routes.
  it('handles a thrown system-open error with a generic visible message', async () => {
    previewAttachment.mockRejectedValueOnce(new Error('private-path-secret'));
    await run(() => actions.openInSystemApp({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBe('The attachment could not be opened. Try again.');
    expect(actions.isBusy('email-1', 'report.pdf')).toBe(false);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('private-path-secret');
  });

  // Breaks: a double click schedules two scanner jobs and native dialogs before
  // React can disable the original control.
  it('deduplicates the same file before rendering and generates new ids on retry', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(downloadAttachment).toHaveBeenCalledOnce();
    release({ success: false, error: 'Download blocked: ClamAV detected a threat.' });
    await act(async () => { await pending; });
    expect(actions.isBusy('email-1', 'report.pdf')).toBe(false);
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toContain('ClamAV detected a threat');
    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(downloadAttachment.mock.calls[1][3]).not.toBe(downloadAttachment.mock.calls[0][3]);
    expect(actions.getStatus('email-1', 'report.pdf')).toBeUndefined();
  });

  // Breaks: a remote exception containing an API token is shown or logged by the
  // trusted host UI, leaking credentials outside the main-process vault.
  it.each(['server response: Bearer secret-token', undefined])('keeps untrusted failures generic (%s)', async (error) => {
    downloadAttachment.mockResolvedValue({ success: false, error });
    await run(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBe('The attachment could not be saved. Check your connection and try again.');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-token');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  // Breaks: closing a message leaks the IPC listener, or cancels a save the user
  // already requested instead of letting its host-owned workflow finish.
  it('unsubscribes on unmount without cancelling the requested save', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cancelAttachmentDownload).not.toHaveBeenCalled();
    release({ success: true });
    await pending;
  });
});

describe('cancellation and batch failures', () => {
  // Breaks: Cancel sends a filename or message id that can stop another account's
  // scan. Only the random request id owning this save may cross the IPC bridge.
  it('cancels only the current download and waits for its terminal outcome', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    const requestId = downloadAttachment.mock.calls[0][3];
    await run(() => actions.cancelDownload('email-1', 'report.pdf'));
    await run(() => actions.cancelDownload('email-1', 'report.pdf'));
    expect(cancelAttachmentDownload).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(actions.getStatus('email-1', 'report.pdf')?.cancelling).toBe(true);
    expect(actions.isBusy('email-1', 'report.pdf')).toBe(true);
    release({ success: false, error: 'Download cancelled.' });
    await act(async () => { await pending; });
    expect(actions.getStatus('email-1', 'report.pdf')).toEqual({ cancelled: true, operation: 'save' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // Breaks: a failed cancellation clears the spinner while the host still owns
  // an active scan, or leaves the cancel control disabled forever.
  it.each(['reply', 'throw'])('shows safe cancellation failure and allows a retry (%s)', async (kind) => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    if (kind === 'reply') cancelAttachmentDownload.mockResolvedValueOnce({ success: false, error: 'secret' });
    else cancelAttachmentDownload.mockRejectedValueOnce(new Error('secret'));
    const pending = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    await run(() => actions.cancelDownload('email-1', 'report.pdf'));
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBe('Could not cancel the download. Try again.');
    expect(actions.getStatus('email-1', 'report.pdf')?.cancelling).toBe(false);
    await run(() => actions.cancelDownload('email-1', 'report.pdf'));
    expect(cancelAttachmentDownload).toHaveBeenCalledTimes(2);
    release({ success: false, error: 'Download cancelled.' });
    await act(async () => { await pending; });
  });

  // Breaks: a slow cancellation refusal arriving after a completed save restores
  // a stale error/spinner and makes a successful download look failed.
  it('ignores a cancellation failure after the download has finished', async () => {
    let releaseDownload!: (result: unknown) => void;
    let releaseCancel!: (result: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { releaseDownload = resolve; }));
    cancelAttachmentDownload.mockReturnValue(new Promise((resolve) => { releaseCancel = resolve; }));
    const download = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    const cancellation = start(() => actions.cancelDownload('email-1', 'report.pdf'));
    releaseDownload({ success: true });
    await act(async () => { await download; });
    releaseCancel({ success: false, error: 'secret' });
    await act(async () => { await cancellation; });
    expect(actions.getStatus('email-1', 'report.pdf')).toBeUndefined();
  });

  // Breaks: a cancel control without an active operation cancels another file,
  // or the system-open scan cannot be cancelled before the OS launches it.
  it('ignores absent requests and cancels system opening by its own request id', async () => {
    await run(() => actions.cancelDownload('email-1', 'report.pdf'));
    let release!: (result: unknown) => void;
    previewAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = start(() => actions.openInSystemApp({ emailId: 'email-1', filename: 'report.pdf' }));
    await run(() => actions.cancelDownload('email-1', 'report.pdf'));
    expect(cancelAttachmentDownload).toHaveBeenCalledExactlyOnceWith(previewAttachment.mock.calls[0][3]);
    expect(onAttachmentDownloadProgress).toHaveBeenCalledOnce();
    release({ success: false, error: 'secret' });
    await act(async () => { await pending; });
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toBe('The attachment could not be opened. Try again.');
  });

  // Breaks: Save all continues opening dialogs after a threat, lost connection
  // or a deliberate cancel, making an interrupted batch look successful.
  it.each(['Download blocked: the attachment could not be fully scanned.', 'Download cancelled.', 'Save cancelled'])('stops Save all after %s', async (error) => {
    downloadAttachment.mockResolvedValueOnce({ success: false, error });
    await run(() => actions.saveAll('email-1', ['a.pdf', 'b.pdf'], 'acct-2'));
    expect(downloadAttachment).toHaveBeenCalledOnce();
    expect(downloadAttachment.mock.calls[0][1]).toBe('a.pdf');
  });
});

describe('routing', () => {
  // Breaks: save and open-in-system-app are two different IPC calls; crossing
  // them means "Save a copy" launches the file instead, which is the one thing
  // the allow-list exists to keep deliberate.
  it('sends save to downloadAttachment and open to previewAttachment', async () => {
    await run(() =>
      actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf', accountId: 'acct-2' }),
    );
    await run(() => actions.openInSystemApp({ emailId: 'email-1', filename: 'report.pdf' }));

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2', expect.any(String));
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', undefined, expect.any(String));
  });

  // Breaks: each save opens a NATIVE modal dialog. Firing them in parallel
  // stacks dialogs on top of each other (or drops all but one).
  it('saves all attachments one at a time', async () => {
    const order: string[] = [];
    let resolveFirst: (value: unknown) => void = () => {};
    downloadAttachment.mockImplementation((_id: string, name: string) => {
      order.push(name);
      return name === 'a.pdf'
        ? new Promise((resolve) => (resolveFirst = resolve))
        : Promise.resolve({ success: true });
    });

    const all = start(() => actions.saveAll('email-1', ['a.pdf', 'b.pdf'], 'acct-2'));
    expect(order).toEqual(['a.pdf']); // b.pdf has NOT started

    resolveFirst({ success: true });
    await act(async () => {
      await all;
    });
    expect(order).toEqual(['a.pdf', 'b.pdf']);
    expect(downloadAttachment).toHaveBeenLastCalledWith('email-1', 'b.pdf', 'acct-2', expect.any(String));
  });
});


describe('protected in-app preview', () => {
  // Breaks: PDF/image/text rendering starts through the old raw protocol URL
  // before the trusted host has finished its scan of this exact account/file.
  it('passes account and request id, relays scan progress and returns only the host URL', async () => {
    let release!: (result: unknown) => void;
    prepareAttachmentPreview.mockImplementation((_email, _file, _account, requestId) => {
      expect(onAttachmentDownloadProgress).toHaveBeenCalledOnce();
      progress({ requestId, phase: 'scanning' });
      return new Promise((resolve) => { release = resolve; });
    });
    const pending = start(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf', accountId: 'outlook-account' }));
    expect(actions.getStatus('email-1', 'report.pdf')).toMatchObject({ phase: 'scanning', operation: 'preview', canCancel: true });
    expect(prepareAttachmentPreview).toHaveBeenCalledWith('email-1', 'report.pdf', 'outlook-account', expect.any(String));
    release({ success: true, url: 'sarv-attachment://attachment/email-1/report.pdf?lease=host-only' });
    let url: string | undefined;
    await act(async () => { url = await pending; });
    expect(url).toBe('sarv-attachment://attachment/email-1/report.pdf?lease=host-only');
    expect(actions.isBusy('email-1', 'report.pdf')).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(previewAttachment).not.toHaveBeenCalled();
  });

  // Breaks: a malformed successful host reply renders a raw fallback URL, or an
  // untrusted server exception leaks a token through preview errors/logs.
  it.each([
    { success: true },
    { success: true, url: '' },
    { success: false, error: 'secret-token-private-path' },
  ])('rejects malformed or untrusted preview replies (%j)', async (reply) => {
    prepareAttachmentPreview.mockResolvedValueOnce(reply);
    expect(await run(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }))).toBeUndefined();
    expect(actions.getStatus('email-1', 'report.pdf')).toEqual({ error: 'The attachment could not be opened. Try again.', operation: 'preview' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('secret-token-private-path');
  });

  // Breaks: ClamAV finds a threat, but the UI hides the reason because only
  // downloaded files use the trusted host error allow-list.
  it('preserves threat and incomplete scan failures for preview and OS-open', async () => {
    prepareAttachmentPreview.mockResolvedValueOnce({ success: false, error: 'Download blocked: ClamAV detected a threat.' });
    expect(await run(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }))).toBeUndefined();
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toContain('ClamAV detected a threat');
    previewAttachment.mockResolvedValueOnce({ success: false, error: 'Download blocked: the attachment could not be fully scanned.' });
    await run(() => actions.openInSystemApp({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(actions.getStatus('email-1', 'report.pdf')?.error).toContain('could not be fully scanned');
  });

  // Breaks: closing a viewer cancels the save it was sharing, or starts a new
  // scanner request after that viewer has already gone away.
  it('waits for an existing save and stops before preparing if its viewer closes', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const save = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    const controller = new AbortController();
    const preview = start(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }, controller.signal));
    controller.abort();
    expect(cancelAttachmentDownload).not.toHaveBeenCalled();
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
    release({ success: true });
    await act(async () => { await save; expect(await preview).toBeUndefined(); });
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
  });

  // Breaks: a preview waiting for Save never starts after its dialog finishes,
  // leaving the viewer blank instead of independently authorizing its bytes.
  it('prepares after the active save finishes without overlapping scans', async () => {
    let release!: (result: unknown) => void;
    downloadAttachment.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const save = start(() => actions.saveCopy({ emailId: 'email-1', filename: 'report.pdf' }));
    const preview = start(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }));
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
    release({ success: true });
    await act(async () => { await save; expect(await preview).toContain('lease=clean'); });
    expect(prepareAttachmentPreview).toHaveBeenCalledOnce();
  });

  // Breaks: an already-closed viewer sends attachment bytes to a remote scanner.
  it('does not prepare an already-aborted viewer', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await run(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }, controller.signal))).toBeUndefined();
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
    expect(actions.getStatus('email-1', 'report.pdf')).toBeUndefined();
  });

  // Breaks: navigation cancels another account's request, or an aborted viewer
  // leaks an event listener that cancels a later save of the same filename.
  it('aborts only its preview request and removes its abort listener after completion', async () => {
    let release!: (result: unknown) => void;
    prepareAttachmentPreview.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = start(() => actions.preparePreview({ emailId: 'email-1', filename: 'report.pdf' }, controller.signal));
    act(() => controller.abort());
    expect(cancelAttachmentDownload).toHaveBeenCalledExactlyOnceWith(prepareAttachmentPreview.mock.calls[0][3]);
    expect(actions.getStatus('email-1', 'report.pdf')?.cancelling).toBe(true);
    release({ success: false, error: 'Download cancelled.' });
    await act(async () => { await pending; });
    expect(actions.getStatus('email-1', 'report.pdf')).toEqual({ cancelled: true, operation: 'preview' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
