// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentDownloadStatus } from '../../../../../src/components/attachment-viewer/AttachmentDownloadStatus';
import { cleanup, fire, render } from '../../../../helpers/render';

afterEach(cleanup);

describe('attachment download status', () => {
  // Breaks: any message surface omits the host's actual phase, leaving scanning
  // indistinguishable from downloading or displaying an unverified clean badge.
  it.each([
    ['downloading', 'Downloading…'], ['scanning', 'Scanning…'], ['saving', 'Saving…'],
  ] as const)('names the %s phase and provides a trusted cancel control', (phase, text) => {
    const onCancel = vi.fn();
    const mounted = render(<AttachmentDownloadStatus status={{ phase, canCancel: true }} filename="report.pdf" onCancel={onCancel} />);
    expect(mounted.find('[role="status"]')?.textContent).toContain(text);
    fire(mounted.byLabel('Cancel download of report.pdf'), 'click');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).not.toContain('clean');
  });

  // Breaks: repeated cancel clicks schedule duplicate IPC cancellation requests
  // while the scanner is still finishing its current work.
  it('labels cancellation in progress and disables repeated cancellation', () => {
    const mounted = render(<AttachmentDownloadStatus status={{ phase: 'scanning', canCancel: true, cancelling: true }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.container.textContent).toContain('Cancelling…');
    expect((mounted.byLabel('Cancel download of a.pdf') as HTMLButtonElement).disabled).toBe(true);
  });

  // Breaks: a blocked scan is silently hidden when the busy spinner finishes.
  it('keeps a failed scan visible as an alert without a success indicator', () => {
    const mounted = render(<AttachmentDownloadStatus status={{ error: 'Download blocked: ClamAV detected a threat.' }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.find('[role="alert"]')?.textContent).toContain('ClamAV detected a threat');
    expect(mounted.byLabel('Cancel download of a.pdf')).toBeNull();
    expect(mounted.find('[role="status"]')).toBeNull();
  });

  // Breaks: a cancelled native dialog is shown as a malware warning, or a system
  // open advertises cancellation that the download service cannot perform.
  it('renders normal cancellation and hides cancel for a system open', () => {
    const mounted = render(<AttachmentDownloadStatus status={{ cancelled: true }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.container.textContent).toBe('Download cancelled.');
    expect(mounted.find('[role="alert"]')).toBeNull();
    mounted.rerender(<AttachmentDownloadStatus status={{ phase: 'downloading', canCancel: false }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.byLabel('Cancel download of a.pdf')).toBeNull();
  });

  // Breaks: completed files retain a spinner or misleading persistent clean
  // badge even though the next download must scan its current bytes again.
  it('shows nothing without a current status', () => {
    const mounted = render(<AttachmentDownloadStatus filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.container.textContent).toBe('');
  });

  // Breaks: accepting the missing-setup warning presents the attachment as
  // scanned, or leaves a spinner/cancel control after it has already opened.
  it.each(['save', 'open', 'preview'] as const)('marks an explicitly unscanned %s outcome', (operation) => {
    const mounted = render(<AttachmentDownloadStatus status={{ operation, notScanned: true }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.find('[role="status"]')?.textContent).toBe('Not scanned for viruses.');
    expect(mounted.find('[role="alert"]')).toBeNull();
    expect(mounted.find('button')).toBeNull();
    expect(mounted.container.textContent).not.toContain('clean');
  });
});


// Breaks: a PDF viewer offers "Cancel download" instead of cancelling its own
// preview, or system opening is presented as an uncancellable scan bypass.
it.each([
  ['preview', 'preview', 'Preview cancelled.'],
  ['open', 'open', 'Opening cancelled.'],
] as const)('labels the %s request separately from saving', (operation, label, cancelled) => {
  const onCancel = vi.fn();
  const mounted = render(<AttachmentDownloadStatus status={{ operation, phase: 'scanning', canCancel: true }} filename="a.pdf" onCancel={onCancel} />);
  fire(mounted.byLabel(`Cancel ${label} of a.pdf`), 'click');
  expect(onCancel).toHaveBeenCalledOnce();
  mounted.rerender(<AttachmentDownloadStatus status={{ operation, cancelled: true }} filename="a.pdf" onCancel={onCancel} />);
  expect(mounted.container.textContent).toBe(cancelled);
});
