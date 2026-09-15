// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentChips } from '../../../../../src/components/attachment-viewer/AttachmentChips';
import { fire, render, settle } from '../../../../helpers/render';

/**
 * The attachment strip — one component for every surface that shows
 * attachments. EmailCard and ThreadList each carried a copy of this markup that
 * differed only in Tailwind size tokens, and ThreadChatView a third variant; the
 * behaviour they disagreed on is what these tests pin.
 */

const downloadAttachment = vi.fn();
const previewAttachment = vi.fn();

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
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: { downloadAttachment, previewAttachment },
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
  // The whole feature: a click reads the attachment IN the app. It must not
  // download, and must not hand the file to the OS.
  it('opens the viewer on the clicked attachment, downloading nothing', async () => {
    mounted = chips();

    fire(chipFor('photo.png'), 'click');
    await settle();

    expect(mounted.find('[role="dialog"]')).not.toBeNull();
    expect(mounted.find('img')?.getAttribute('src')).toContain('photo.png');
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(previewAttachment).not.toHaveBeenCalled();
  });

  // Breaks: the per-chip save button opens the viewer as well as saving,
  // because the chip's own click handler still fires underneath it.
  it('saves a copy from the chip button without opening the viewer', async () => {
    mounted = chips();

    fire(mounted.byLabel('Save a copy of report.pdf'), 'click');
    await settle();

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2');
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
