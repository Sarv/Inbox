// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentDownloadProgress } from '../../../../../electron/preload';
import { AttachmentPills } from '../../../../../src/components/attachment-viewer/AttachmentPills';
import { act, cleanup, fire, render, settle } from '../../../../helpers/render';

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('chat attachment download progress', () => {
  // Breaks: the chat surface misses the scan gate UI even though card and viewer
  // saves show scanning; account routing and cancellation must also match there.
  it('shows scanning, cancels by request id and keeps a blocked scan visible', async () => {
    let progress!: (payload: AttachmentDownloadProgress) => void;
    let release!: (result: unknown) => void;
    const downloadAttachment = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const cancelAttachmentDownload = vi.fn(async () => ({ success: true }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { emails: {
      downloadAttachment,
      cancelAttachmentDownload,
      onAttachmentDownloadProgress: (callback: typeof progress) => { progress = callback; return vi.fn(); },
    } };
    const mounted = render(<AttachmentPills emailId="chat-email" accountId="outlook-account" attachments={[{ name: 'invoice.pdf', size: 2048 }]} />);
    fire(mounted.byLabel('Save a copy of invoice.pdf'), 'click');
    const requestId = (downloadAttachment.mock.calls[0] as unknown[])[3] as string;
    expect(downloadAttachment).toHaveBeenCalledWith('chat-email', 'invoice.pdf', 'outlook-account', requestId);
    act(() => { progress({ requestId, phase: 'scanning' }); });
    expect(mounted.container.textContent).toContain('Scanning…');
    fire(mounted.byLabel('Cancel download of invoice.pdf'), 'click');
    await settle();
    expect(cancelAttachmentDownload).toHaveBeenCalledWith(requestId);
    expect(mounted.find('[role="dialog"]')).toBeNull();
    release({ success: false, error: 'Download blocked: the attachment could not be fully scanned.' });
    await settle();
    expect(mounted.find('[role="alert"]')?.textContent).toContain('could not be fully scanned');
    expect(mounted.container.textContent).not.toContain('Scanning…');
  });
});
