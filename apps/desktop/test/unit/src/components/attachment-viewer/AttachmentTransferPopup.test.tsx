// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentTransfer } from '../../../../../src/components/attachment-viewer/attachment-transfer-types';
import { AttachmentTransferPopup, type AttachmentTransferPopupProps } from '../../../../../src/components/attachment-viewer/AttachmentTransferPopup';
import { cleanup, fire, render } from '../../../../helpers/render';

const transfer = (overrides: Partial<AttachmentTransfer> = {}): AttachmentTransfer => ({
  id: 'request-1', key: 'account-1:email-1:report.pdf', emailId: 'email-1', accountId: 'account-1',
  filename: 'report.pdf', operation: 'preview', status: 'active', phase: 'downloading',
  canCancel: true, startedAt: 1, updatedAt: 1, ...overrides,
});

function props(transfers: AttachmentTransfer[] = [transfer()]): AttachmentTransferPopupProps {
  return {
    transfers, onCancel: vi.fn(), onDismiss: vi.fn(), onPreview: vi.fn(),
    onOpenFile: vi.fn(), onShowFolder: vi.fn(), onRetry: vi.fn(), onMinimize: vi.fn(),
  };
}

const button = (text: string) => Array.from(document.querySelectorAll('button')).find((value) => value.textContent?.trim() === text) ?? null;

afterEach(cleanup);

describe('background attachment progress', () => {
  it('renders nothing when there are no transfers', () => {
    const mounted = render(<AttachmentTransferPopup {...props([])} />);
    expect(mounted.container.textContent).toBe('');
  });

  it('shows the measured download bytes and percentage without becoming a modal', () => {
    const mounted = render(<AttachmentTransferPopup {...props([transfer({ transferredBytes: 1536, totalBytes: 4096 })])} />);
    const progress = mounted.find('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('37');
    expect(progress?.getAttribute('aria-valuetext')).toBe('37% · 1.5 KB of 4.0 KB');
    expect(mounted.container.textContent).toContain('1.5 KB of 4.0 KB');
    expect(mounted.find('[role="dialog"]')).toBeNull();
    expect(mounted.find('[aria-modal]')).toBeNull();
    expect(mounted.find('[aria-current="step"]')?.textContent).toContain('Download');
  });

  it('distinguishes real upload progress from server scanning and does not invent a scan percentage', () => {
    const callbacks = props([transfer({ phase: 'uploading', transferredBytes: 512, totalBytes: 1024 })]);
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    expect(mounted.find('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(mounted.container.textContent).toContain('Uploading for scan');
    expect(mounted.find('[aria-current="step"]')?.textContent).toContain('Upload');

    mounted.rerender(<AttachmentTransferPopup {...callbacks} transfers={[transfer({ phase: 'scanning', transferredBytes: 1024, totalBytes: 1024 })]} />);
    expect(mounted.find('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(mounted.find('[role="progressbar"]')?.dataset.indeterminate).toBe('true');
    expect(mounted.container.textContent).toContain('Scanning on server');
    expect(mounted.find('[aria-current="step"]')?.textContent).toContain('Scan');
    expect(mounted.container.textContent).not.toContain('100%');
  });

  it.each([
    { transferredBytes: 2 },
    { totalBytes: 100 },
    { transferredBytes: -1, totalBytes: 100 },
    { transferredBytes: 1, totalBytes: 0 },
    { transferredBytes: Number.NaN, totalBytes: 100 },
    { transferredBytes: 1, totalBytes: Number.POSITIVE_INFINITY },
  ])('uses an indeterminate bar for missing or invalid measured progress (%j)', (bytes) => {
    const mounted = render(<AttachmentTransferPopup {...props([transfer(bytes)])} />);
    expect(mounted.find('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(mounted.container.textContent).not.toContain('NaN');
    expect(mounted.container.textContent).not.toContain('Infinity');
  });

  it('clamps measured progress to the host total rather than showing more than 100 percent', () => {
    const mounted = render(<AttachmentTransferPopup {...props([transfer({ transferredBytes: 1100, totalBytes: 1000 })])} />);
    expect(mounted.find('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
    expect(mounted.container.textContent).toContain('1000 B of 1000 B');
  });

  it('separates hiding the notification from explicitly cancelling its exact request', () => {
    const callbacks = props();
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    fire(mounted.byLabel('Dismiss report.pdf notification'), 'click');
    expect(callbacks.onDismiss).toHaveBeenCalledExactlyOnceWith('request-1');
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fire(mounted.byLabel('Cancel transfer of report.pdf'), 'click');
    expect(callbacks.onCancel).toHaveBeenCalledExactlyOnceWith('request-1');
  });

  it('disables repeated cancellation until the host finishes cancelling', () => {
    const callbacks = props([transfer({ cancelling: true })]);
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    const cancel = mounted.byLabel('Cancel transfer of report.pdf') as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(cancel.textContent).toContain('Cancelling');
    expect(mounted.find('[role="status"]')?.textContent).toContain('Cancelling');
  });
});

describe('completion notifications', () => {
  it('shows the saved path and acts only through its host-issued receipt', () => {
    const callbacks = props([transfer({ status: 'saved', filePath: '/Users/me/Downloads/report.pdf', savedFileId: 'receipt-1', canOpenSavedFile: true })]);
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    expect(mounted.container.textContent).toContain('/Users/me/Downloads/report.pdf');
    fire(button('Open file'), 'click');
    fire(button('Show in folder'), 'click');
    expect(callbacks.onOpenFile).toHaveBeenCalledExactlyOnceWith('request-1');
    expect(callbacks.onShowFolder).toHaveBeenCalledExactlyOnceWith('request-1');
    expect(mounted.find('[role="progressbar"]')).toBeNull();
  });

  it('does not offer an unsafe OS open or reveal when a saved path has no receipt', () => {
    const mounted = render(<AttachmentTransferPopup {...props([transfer({ status: 'saved', filePath: '/some/path', canOpenSavedFile: true })])} />);
    expect(mounted.container.textContent).toContain('/some/path');
    expect(button('Open file')).toBeNull();
    expect(button('Show in folder')).toBeNull();
  });

  it('still allows showing a saved unsupported file in its folder without opening it', () => {
    const callbacks = props([transfer({ status: 'saved', filename: 'archive.exe', savedFileId: 'receipt-1', canOpenSavedFile: false })]);
    render(<AttachmentTransferPopup {...callbacks} />);
    expect(button('Open file')).toBeNull();
    fire(button('Show in folder'), 'click');
    expect(callbacks.onShowFolder).toHaveBeenCalledExactlyOnceWith('request-1');
  });

  it('opens only the requested prepared preview', () => {
    const callbacks = props([transfer({ status: 'ready' })]);
    render(<AttachmentTransferPopup {...callbacks} />);
    fire(button('Open preview'), 'click');
    expect(callbacks.onPreview).toHaveBeenCalledExactlyOnceWith('request-1');
    expect(callbacks.onOpenFile).not.toHaveBeenCalled();
  });

  it('retains the threat failure and provides a deliberate retry', () => {
    const callbacks = props([transfer({ status: 'failed', error: 'Download blocked: ClamAV detected a threat.' })]);
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    expect(mounted.find('[role="alert"]')?.textContent).toBe('Download blocked: ClamAV detected a threat.');
    expect(button('Open preview')).toBeNull();
    expect(button('Open file')).toBeNull();
    fire(button('Try again'), 'click');
    expect(callbacks.onRetry).toHaveBeenCalledExactlyOnceWith('request-1');
  });

  it('keeps the unscanned warning visible even when a file is ready', () => {
    const mounted = render(<AttachmentTransferPopup {...props([transfer({ status: 'ready', notScanned: true })])} />);
    expect(mounted.container.textContent).toContain('Not scanned for viruses');
    expect(mounted.find('[data-unscanned="true"]')).not.toBeNull();
  });
});

describe('unobtrusive popup behavior', () => {
  it('minimizes while working and expands a completion notification without moving focus', () => {
    const callbacks = props();
    const mounted = render(<><input aria-label="Mail search" /><AttachmentTransferPopup {...callbacks} /></>);
    fire(mounted.byLabel('Minimize attachment transfers'), 'click');
    expect(callbacks.onMinimize).toHaveBeenCalledOnce();
    expect(mounted.find('[data-collapsed="true"]')).not.toBeNull();
    expect(mounted.find('article')).toBeNull();
    const mailSearch = mounted.byLabel('Mail search')!;
    mailSearch.focus();

    mounted.rerender(<><input aria-label="Mail search" /><AttachmentTransferPopup {...callbacks} transfers={[transfer({ status: 'ready' })]} /></>);
    expect(mounted.find('[data-collapsed="false"]')).not.toBeNull();
    expect(button('Open preview')).not.toBeNull();
    expect(document.activeElement).toBe(mailSearch);
    expect(callbacks.onPreview).not.toHaveBeenCalled();
  });

  it('keeps a minimized completion hidden during unrelated progress updates', () => {
    const callbacks = props([transfer({ status: 'ready' }), transfer({ id: 'request-2', filename: 'other.pdf' })]);
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    fire(mounted.byLabel('Minimize attachment transfers'), 'click');
    mounted.rerender(<AttachmentTransferPopup {...callbacks} transfers={[transfer({ status: 'ready', updatedAt: 5 }), transfer({ id: 'request-2', filename: 'other.pdf', transferredBytes: 50, totalBytes: 100 })]} />);
    expect(mounted.find('[data-collapsed="true"]')).not.toBeNull();
    fire(mounted.byLabel('Expand attachment transfers'), 'click');
    expect(mounted.all('article')).toHaveLength(2);
    expect(callbacks.onMinimize).toHaveBeenCalledOnce();
  });

  it('hides all visible notifications from the collapsed header without cancelling them', () => {
    const callbacks = props([transfer(), transfer({ id: 'request-2', filename: 'other.pdf' })]);
    const mounted = render(<AttachmentTransferPopup {...callbacks} />);
    fire(mounted.byLabel('Minimize attachment transfers'), 'click');
    fire(mounted.byLabel('Hide attachment transfers'), 'click');
    expect(vi.mocked(callbacks.onDismiss).mock.calls).toEqual([['request-1'], ['request-2']]);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it('leaves Escape and arrow keys available to the mail view', () => {
    const callbacks = props();
    const mounted = render(<><input aria-label="Mail search" /><AttachmentTransferPopup {...callbacks} /></>);
    const received: string[] = [];
    const capture = (event: KeyboardEvent) => received.push(event.key);
    document.addEventListener('keydown', capture);
    try {
      const input = mounted.byLabel('Mail search')!;
      for (const key of ['Escape', 'ArrowLeft', 'ArrowRight']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(received).toEqual(['Escape', 'ArrowLeft', 'ArrowRight']);
      expect(callbacks.onDismiss).not.toHaveBeenCalled();
      expect(callbacks.onCancel).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', capture); }
  });
});
