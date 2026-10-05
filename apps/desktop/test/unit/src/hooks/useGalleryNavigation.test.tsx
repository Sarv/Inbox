// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UnscannedWarningRequest } from '../../../../electron/preload';
import { UnscannedAttachmentWarning } from '../../../../src/components/antivirus/UnscannedAttachmentWarning';
import { useGalleryNavigation } from '../../../../src/hooks/useGalleryNavigation';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

function Gallery({ count = 2, initialIndex = 0, onClose }: {
  count?: number;
  initialIndex?: number;
  onClose(): void;
}) {
  const { index, goTo } = useGalleryNavigation({ count, initialIndex, onClose });
  return <div role="dialog" aria-modal="true">
    <output aria-label="Attachment index">{index}</output>
    <button aria-label="Select third attachment" onClick={() => goTo(2)}>Select</button>
    <audio />
    <video />
  </div>;
}

let onWarning: ((request: UnscannedWarningRequest) => void) | undefined;
const respond = vi.fn(async () => ({ success: true }));
const onClose = vi.fn();
const request: UnscannedWarningRequest = {
  id: 'synthetic-preview-warning', accountId: 'synthetic-work', action: 'view',
  filename: 'arakiri_A_50186774_/_3.pdf',
};
const index = () => document.querySelector('output')?.textContent;

beforeEach(() => {
  onClose.mockReset();
  respond.mockReset().mockResolvedValue({ success: true });
  onWarning = undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    antivirus: {
      onUnscannedWarning: (callback: typeof onWarning) => { onWarning = callback; return () => {}; },
      onUnscannedWarningClosed: () => () => {},
      getPendingUnscannedWarning: async () => ({ success: true, data: null }),
      respondUnscannedWarning: respond,
    },
  };
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('gallery navigation under an attachment warning', () => {
  // Breaks: the viewer's earlier capture listener changes the selected file or closes it before the warning handles keys.
  it('lets the real warning own arrows and Escape, then restores gallery shortcuts after dismissal', async () => {
    render(<><Gallery onClose={onClose} /><UnscannedAttachmentWarning /></>);
    act(() => onWarning?.(request));
    const cancel = document.querySelector<HTMLButtonElement>('[role="alertdialog"] button:not([role])');
    expect(cancel?.textContent).toBe('Cancel');
    fire(cancel, 'keydown', { key: 'ArrowRight' });
    expect(index()).toBe('0');
    fire(cancel, 'keydown', { key: 'Escape' });
    await settle();
    expect(respond).toHaveBeenCalledWith({ id: request.id, choice: 'cancel', dontShowAgain: false });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    fire(document.body, 'keydown', { key: 'ArrowRight' });
    expect(index()).toBe('1');
    fire(document.body, 'keydown', { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  // Breaks: a warning cannot stop gallery navigation if keyboard focus remains in the underlying viewer.
  it('suppresses background keyboard events while a modal warning is present', () => {
    render(<><Gallery onClose={onClose} /><UnscannedAttachmentWarning /></>);
    act(() => onWarning?.(request));
    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    fire(document.body, 'keydown', { key: 'Escape' });
    expect(index()).toBe('0');
    expect(onClose).not.toHaveBeenCalled();
  });

  // Breaks: a mounted modal is bypassed during the interval before its own keyboard listener attaches.
  it('waits while a modal alert is present even before its keyboard handler attaches', () => {
    render(<><Gallery onClose={onClose} /><div role="alertdialog" aria-modal="true" /></>);
    fire(document.body, 'keydown', { key: 'ArrowRight' });
    fire(document.body, 'keydown', { key: 'Escape' });
    expect(index()).toBe('0');
    expect(onClose).not.toHaveBeenCalled();
  });

  // Breaks: an ordinary non-modal alert permanently disables the attachment viewer's shortcuts.
  it('keeps gallery shortcuts active beside a non-modal alert', () => {
    render(<><Gallery onClose={onClose} /><div role="alertdialog" aria-modal="false" /></>);
    fire(document.body, 'keydown', { key: 'ArrowRight' });
    expect(index()).toBe('1');
  });
});

describe('gallery keyboard and index behavior', () => {
  // Breaks: navigation at either end loses the file, or unrelated keys navigate unexpectedly.
  it('wraps both directions and ignores unrelated keys', () => {
    render(<Gallery count={3} initialIndex={2} onClose={onClose} />);
    fire(document.body, 'keydown', { key: 'ArrowRight' });
    expect(index()).toBe('0');
    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    expect(index()).toBe('2');
    fire(document.body, 'keydown', { key: 'a' });
    expect(index()).toBe('2');
  });

  // Breaks: arrow keys intended to seek audio or video unexpectedly select another attachment.
  it.each(['audio', 'video'])('leaves %s seeking keys alone', tag => {
    const mounted = render(<Gallery onClose={onClose} />);
    fire(mounted.find(tag), 'keydown', { key: 'ArrowRight' });
    expect(index()).toBe('0');
  });

  // Breaks: an out-of-range initial selection or an empty gallery produces an invalid index.
  it('bounds an initial selection and handles a zero-count selection', () => {
    const mounted = render(<Gallery count={3} initialIndex={99} onClose={onClose} />);
    expect(index()).toBe('2');
    mounted.unmount();
    const empty = render(<Gallery count={0} initialIndex={-99} onClose={onClose} />);
    expect(index()).toBe('0');
    fire(empty.byLabel('Select third attachment'), 'click');
    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    expect(index()).toBe('0');
  });

  // Breaks: a single attachment responds to arrows or an unmounted viewer keeps consuming Escape.
  it('ignores arrows for one item and removes its listener on unmount', () => {
    const mounted = render(<Gallery count={1} onClose={onClose} />);
    fire(document.body, 'keydown', { key: 'ArrowRight' });
    expect(index()).toBe('0');
    mounted.unmount();
    fire(document.body, 'keydown', { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
