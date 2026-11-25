// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentActionsContext } from '../../../../../src/components/attachment-viewer/attachment-actions-context';
import { AttachmentDownloadStatus, AttachmentStopButton } from '../../../../../src/components/attachment-viewer/AttachmentDownloadStatus';
import type { AttachmentActions } from '../../../../../src/components/attachment-viewer/useAttachmentActions';
import { cleanup, fire, render } from '../../../../helpers/render';

afterEach(cleanup);

describe('attachment download status', () => {
  // Breaks: any message surface omits the host's actual phase, leaving scanning
  // indistinguishable from downloading or displaying an unverified clean badge.
  it.each([
    ['downloading', 'Downloading…'], ['scanning', 'Scanning on server…'], ['saving', 'Saving…'],
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

/** Rendered inside the app-wide Attachments panel's provider, as in the app. */
const withPanel = (child: ReactElement) => <AttachmentActionsContext.Provider value={{} as AttachmentActions}>{child}</AttachmentActionsContext.Provider>;

describe('a chip whose spinner is its stop button', () => {
  // Breaks: "Uploading for scan…" and a cancel button appear under the chip
  // as well as in the Attachments panel, the same progress twice (2026-11-24).
  it('leaves progress and cancellation to the Attachments panel and the spinner', () => {
    const mounted = render(withPanel(<AttachmentDownloadStatus status={{ phase: 'uploading', canCancel: true }} filename="a.pdf" onCancel={vi.fn()} inlineProgress={false} />));
    expect(mounted.container.textContent).toBe('');
    expect(mounted.byLabel('Cancel download of a.pdf')).toBeNull();
    mounted.rerender(withPanel(<AttachmentDownloadStatus status={{ cancelled: true }} filename="a.pdf" onCancel={vi.fn()} inlineProgress={false} />));
    expect(mounted.container.textContent).toBe('');
  });

  // Breaks: a blocked attachment or an unscanned file is only reported in a
  // panel the user may have hidden, not where they clicked.
  it('still shows a blocked attachment and an unscanned file under the chip', () => {
    const mounted = render(withPanel(<AttachmentDownloadStatus status={{ error: 'Download blocked: ClamAV detected a threat.' }} filename="a.pdf" onCancel={vi.fn()} inlineProgress={false} />));
    expect(mounted.find('[role="alert"]')?.textContent).toContain('ClamAV detected a threat');
    mounted.rerender(withPanel(<AttachmentDownloadStatus status={{ operation: 'save', notScanned: true }} filename="a.pdf" onCancel={vi.fn()} inlineProgress={false} />));
    expect(mounted.find('[role="status"]')?.textContent).toBe('Not scanned for viruses.');
  });

  // Breaks: an embed with no Attachments panel loses its only progress line
  // and its only way to cancel.
  it('keeps progress under the chip when there is no Attachments panel', () => {
    const mounted = render(<AttachmentDownloadStatus status={{ phase: 'uploading', canCancel: true }} filename="a.pdf" onCancel={vi.fn()} inlineProgress={false} />);
    expect(mounted.find('[role="status"]')?.textContent).toContain('Uploading for scan…');
    expect(mounted.byLabel('Cancel download of a.pdf')).not.toBeNull();
  });
});

describe('attachment stop button', () => {
  // Breaks: the spinner cannot stop the transfer it shows, or stopping it also
  // opens the attachment (the click reaches the chip under it).
  it('stops the transfer it shows, and only that', () => {
    const onCancel = vi.fn();
    const chip = vi.fn();
    const mounted = render(<div onClick={chip}><AttachmentStopButton status={{ phase: 'scanning', canCancel: true, operation: 'preview' }} filename="a.pdf" onCancel={onCancel} /></div>);
    fire(mounted.byLabel('Stop preview of a.pdf'), 'click');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(chip).not.toHaveBeenCalled();
  });

  // Breaks: repeated clicks while stopping send duplicate cancellations.
  it('is disabled while the transfer is stopping', () => {
    const mounted = render(<AttachmentStopButton status={{ phase: 'scanning', canCancel: true, cancelling: true }} filename="a.pdf" onCancel={vi.fn()} />);
    expect((mounted.byLabel('Stop download of a.pdf') as HTMLButtonElement).disabled).toBe(true);
  });

  // Breaks: a system open, which cannot be cancelled, offers a stop button
  // that does nothing; or a finished transfer keeps a spinner.
  it('is a plain spinner when the transfer cannot be stopped, and nothing when idle', () => {
    const mounted = render(<AttachmentStopButton status={{ phase: 'downloading', canCancel: false, operation: 'open' }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.find('button')).toBeNull();
    expect(mounted.find('svg.animate-spin')).not.toBeNull();
    mounted.rerender(<AttachmentStopButton status={{ notScanned: true }} filename="a.pdf" onCancel={vi.fn()} />);
    expect(mounted.container.innerHTML).toBe('');
  });
});
