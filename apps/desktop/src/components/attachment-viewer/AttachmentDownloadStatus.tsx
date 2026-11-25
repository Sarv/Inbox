import { Loader2, Square, X } from 'lucide-react';
import { useContext } from 'react';

import { Tooltip } from '../Tooltip';

import { AttachmentActionsContext } from './attachment-actions-context';
import type { AttachmentDownloadState } from './useAttachmentActions';

/** An accepted missing-setup warning is never represented as a clean scan. */
export function UnscannedAttachmentNotice() {
  return <p role="status" className="text-xs text-amber-700 dark:text-amber-400">Not scanned for viruses.</p>;
}

/**
 * Whether the app-wide Attachments panel (AttachmentTransferProvider) is
 * showing this attachment's progress. It is mounted around the whole app; an
 * isolated embed without it has no other place to show progress.
 */
export function useAttachmentTransferPanel(): boolean {
  return useContext(AttachmentActionsContext) !== undefined;
}

type Action = 'preview' | 'open' | 'download';

function actionOf(status: AttachmentDownloadState): Action {
  return status.operation === 'preview' ? 'preview' : status.operation === 'open' ? 'open' : 'download';
}

/**
 * The busy spinner of an attachment chip, as the control that stops it.
 *
 * A stop square sits inside the spinning ring, so the way to stop is where the
 * eye already is, rather than in a status line under the chip that repeats what
 * the Attachments panel shows. A transfer that cannot be cancelled (a system
 * open) keeps a plain spinner: a stop button that does nothing is worse than
 * none.
 */
export function AttachmentStopButton({
  status,
  filename,
  onCancel,
  className = '',
  iconClassName = 'h-3.5 w-3.5',
}: {
  status?: AttachmentDownloadState;
  filename: string;
  onCancel: () => void;
  className?: string;
  iconClassName?: string;
}) {
  if (!status?.phase) return null;
  if (!status.canCancel) return <Loader2 aria-hidden="true" className={`${iconClassName} animate-spin`} />;
  const action = actionOf(status);
  return (
    <Tooltip content={status.cancelling ? 'Stopping…' : `Stop ${action}`} delayMs={40}>
      <button
        type="button"
        aria-label={`Stop ${action} of ${filename}`}
        disabled={status.cancelling}
        onClick={(event) => { event.stopPropagation(); onCancel(); }}
        className={`relative inline-flex shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-inherit hover:opacity-80 disabled:cursor-default disabled:opacity-50 ${className}`}
      >
        <Loader2 aria-hidden="true" className={`${iconClassName} animate-spin`} />
        <Square aria-hidden="true" className="absolute left-1/2 top-1/2 h-[40%] w-[40%] -translate-x-1/2 -translate-y-1/2 fill-current" />
      </button>
    </Tooltip>
  );
}

/**
 * The same trusted progress, cancellation and blocked-attachment message everywhere.
 *
 * `inlineProgress={false}` is for chips whose spinner is an AttachmentStopButton:
 * while the Attachments panel is showing, the phase and its cancel button are
 * left to the panel and the spinner. Without the panel they still show here.
 * A blocked attachment and "Not scanned for viruses" always show here.
 */
export function AttachmentDownloadStatus({
  status,
  filename,
  onCancel,
  inlineProgress = true,
}: {
  status?: AttachmentDownloadState;
  filename: string;
  onCancel: () => void;
  inlineProgress?: boolean;
}) {
  const panel = useAttachmentTransferPanel();
  if (!status) return null;
  const showProgress = inlineProgress || !panel;
  const action = actionOf(status);
  const phase = status.cancelling ? 'Cancelling…' : {
    downloading: 'Downloading…',
    uploading: 'Uploading for scan…',
    scanning: 'Scanning on server…',
    saving: 'Saving…',
  }[status.phase ?? 'downloading'];

  const progress = showProgress && status.phase;
  const cancelled = showProgress && status.cancelled;
  if (!progress && !status.error && !cancelled && !status.notScanned) return null;

  return (
    <div className="mt-1 space-y-1 text-xs" onClick={(event) => event.stopPropagation()}>
      {progress && <div role="status" aria-live="polite" className="flex items-center justify-center gap-1 text-muted-foreground">
        <span>{phase}</span>
        {status.canCancel && <Tooltip content={`Cancel ${action}`} delayMs={40}>
          <button type="button" aria-label={`Cancel ${action} of ${filename}`} disabled={status.cancelling} onClick={onCancel} className="rounded p-1 hover:bg-accent disabled:opacity-50">
            <X className="h-3 w-3" />
          </button>
        </Tooltip>}
      </div>}
      {status.error && <p role="alert" className="break-words text-destructive">{status.error}</p>}
      {cancelled && <p role="status" className="text-muted-foreground">{action === 'download' ? 'Download cancelled.' : action === 'preview' ? 'Preview cancelled.' : 'Opening cancelled.'}</p>}
      {status.notScanned && <UnscannedAttachmentNotice />}
    </div>
  );
}
