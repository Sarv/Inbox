// @vitest-environment happy-dom
import { buildAttachmentUrl } from '@sarvinbox/core/attachment-kind';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentDownloadProgress } from '../../../../../electron/preload';
import { AttachmentChips } from '../../../../../src/components/attachment-viewer/AttachmentChips';
import { act, fire, render, settle } from '../../../../helpers/render';

/**
 * The attachment strip — one component for every surface that shows
 * attachments. EmailCard and ThreadList each carried a copy of this markup that
 * differed only in Tailwind size tokens, and ThreadChatView a third variant; the
 * behaviour they disagreed on is what these tests pin.
 */

const downloadAttachment = vi.fn();
const previewAttachment = vi.fn();
const prepareAttachmentPreview = vi.fn();
const releaseAttachmentPreview = vi.fn();
const cancelAttachmentDownload = vi.fn();
let progress: (value: AttachmentDownloadProgress) => void;
const onAttachmentDownloadProgress = vi.fn();

const chips = (props: Partial<Parameters<typeof AttachmentChips>[0]> = {}) =>
  render(
    <AttachmentChips
      emailId="email-1"
      accountId="acct-2"
      attachments={[{ name: 'report.pdf' }, { name: 'photo.png' }]}
      {...props}
    />,
  );

let mounted: ReturnType<typeof render> | null = null;

beforeEach(() => {
  downloadAttachment.mockReset().mockResolvedValue({ success: true });
  previewAttachment.mockReset().mockResolvedValue({ success: true });
  prepareAttachmentPreview.mockReset().mockImplementation(async (emailId, filename, accountId) => ({ success: true, url: buildAttachmentUrl({ emailId, filename, accountId }) }));
  releaseAttachmentPreview.mockReset().mockResolvedValue({ success: true });
  cancelAttachmentDownload.mockReset().mockResolvedValue({ success: true });
  onAttachmentDownloadProgress.mockReset().mockImplementation((callback) => { progress = callback; return vi.fn(); });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: { downloadAttachment, previewAttachment, prepareAttachmentPreview, releaseAttachmentPreview, cancelAttachmentDownload, onAttachmentDownloadProgress },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const chipFor = (name: string) =>
  mounted!.all('[class*="cursor-pointer"]').find((el) => el.textContent?.includes(name)) ?? null;

describe('rendering', () => {
  it('lists the attachments with a count', () => {
    mounted = chips();

    expect(mounted.container.textContent).toContain('2 attachments');
    expect(mounted.container.textContent).toContain('report.pdf');
    expect(mounted.container.textContent).toContain('photo.png');
  });

  it('renders nothing when the message has no attachments', () => {
    mounted = chips({ attachments: [] });

    expect(mounted.container.textContent).toBe('');
  });

  // Breaks: the two size variants existed as two copies of the markup. One
  // component with a `size` prop is the point — this proves both branches
  // render the same content.
  it('renders the same content at either size', () => {
    mounted = chips({ size: 'sm' });
    const small = mounted.container.textContent;
    mounted.unmount();

    mounted = chips({ size: 'md' });
    expect(mounted.container.textContent).toBe(small);
  });
});

describe('interaction', () => {
  // Breaks: opening the viewer during a card download loses its scanning status
  // and enables a second save because the two surfaces own independent hooks.
  it('shares an ongoing scan with the viewer and leaves it running when the viewer closes', async () => {
    let release!: (value: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    mounted = chips();
    fire(mounted.byLabel('Save a copy of photo.png'), 'click');
    const requestId = downloadAttachment.mock.calls[0][3];
    act(() => { progress({ requestId, phase: 'scanning' }); });
    fire(chipFor('photo.png'), 'click');
    await settle();
    expect(mounted.find('[role="dialog"]')?.textContent).toContain('Scanning…');
    expect((mounted.byLabel('Save a copy') as HTMLButtonElement).disabled).toBe(true);
    fire(mounted.byLabel('Close attachment viewer'), 'click');
    expect(chipFor('photo.png')?.textContent).toContain('Scanning…');
    expect(cancelAttachmentDownload).not.toHaveBeenCalled();
    release({ success: true });
    await settle();
    expect(chipFor('photo.png')?.textContent).not.toContain('Scanning…');
    expect(downloadAttachment).toHaveBeenCalledOnce();
  });

  // Breaks: card tiles show only "Working" and hide malware failures after the
  // spinner clears; Cancel must remain a trusted host action without opening a viewer.
  it('shows scan progress, cancels the current request and keeps a blocked result visible', async () => {
    let release!: (value: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    mounted = chips();
    fire(mounted.byLabel('Save a copy of report.pdf'), 'click');
    const requestId = downloadAttachment.mock.calls[0][3];
    expect(chipFor('report.pdf')?.textContent).toContain('Downloading…');
    act(() => { progress({ requestId, phase: 'scanning' }); });
    expect(chipFor('report.pdf')?.textContent).toContain('Scanning…');
    expect((mounted.byLabel('Save all attachments') as HTMLButtonElement).disabled).toBe(true);
    fire(mounted.byLabel('Cancel download of report.pdf'), 'click');
    await settle();
    expect(cancelAttachmentDownload).toHaveBeenCalledWith(requestId);
    expect(chipFor('report.pdf')?.textContent).toContain('Cancelling…');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    release({ success: false, error: 'Download blocked: ClamAV detected a threat.' });
    await settle();
    expect(mounted.find('[role="alert"]')?.textContent).toContain('ClamAV detected a threat');
    expect((mounted.byLabel('Save all attachments') as HTMLButtonElement).disabled).toBe(false);
    expect(chipFor('photo.png')?.textContent).not.toContain('Scanning');
  });

  // Breaks: viewing an attachment bypasses the host scan gate or opens an OS
  // app/save dialog instead of asking for the protected in-app URL.
  it('opens the viewer through the host scan gate without saving or launching', async () => {
    mounted = chips();

    fire(chipFor('photo.png'), 'click');
    await settle();

    expect(mounted.find('[role="dialog"]')).not.toBeNull();
    expect(mounted.find('img')?.getAttribute('src')).toContain('photo.png');
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(previewAttachment).not.toHaveBeenCalled();
    expect(prepareAttachmentPreview).toHaveBeenCalledExactlyOnceWith('email-1', 'photo.png', 'acct-2', expect.any(String));
  });

  // Breaks: the per-chip save button opens the viewer as well as saving,
  // because the chip's own click handler still fires underneath it.
  it('saves a copy from the chip button without opening the viewer', async () => {
    mounted = chips();

    fire(mounted.byLabel('Save a copy of report.pdf'), 'click');
    await settle();

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2', expect.any(String));
    expect(mounted.find('[role="dialog"]')).toBeNull();
  });

  // Breaks: the strip sits inside a collapsible row in ThreadList — without
  // stopPropagation, touching an attachment collapses the message underneath it.
  it('stops a click reaching the row underneath when asked to', async () => {
    const rowClick = vi.fn();
    mounted = render(
      <div onClick={rowClick}>
        <AttachmentChips
          emailId="email-1"
          attachments={[{ name: 'report.pdf' }]}
          size="sm"
          stopPropagation
        />
      </div>,
    );

    fire(chipFor('report.pdf'), 'click');
    await settle();

    expect(rowClick).not.toHaveBeenCalled();
    expect(mounted.find('[role="dialog"]')).not.toBeNull();
  });

  // Breaks: "Save all" fires every dialog at once (see the hook's sequencing
  // test) or silently saves only the first attachment.
  it('saves every attachment from "Save all"', async () => {
    mounted = chips();

    fire(mounted.byLabel('Save all attachments'), 'click');
    await settle();
    await settle();

    expect(downloadAttachment.mock.calls.map((call) => call[1])).toEqual([
      'report.pdf',
      'photo.png',
    ]);
  });

  // Breaks: closing the viewer leaves the overlay mounted, so the message
  // underneath stays unreachable.
  it('closes the viewer again', async () => {
    mounted = chips();
    fire(chipFor('report.pdf'), 'click');
    await settle();

    fire(mounted.byLabel('Close attachment viewer'), 'click');
    await settle();

    expect(mounted.find('[role="dialog"]')).toBeNull();
  });
});
