import { X } from 'lucide-react';

import { Tooltip } from '../Tooltip';

import type { AttachmentDownloadState } from './useAttachmentActions';

/** An accepted missing-setup warning is never represented as a clean scan. */
export function UnscannedAttachmentNotice() {
  return <p role="status" className="text-xs text-amber-700 dark:text-amber-400">Not scanned for viruses.</p>;
}

/** The same trusted progress, cancellation and blocked-attachment message everywhere. */
export function AttachmentDownloadStatus({
  status,
  filename,
  onCancel,
}: {
  status?: AttachmentDownloadState;
  filename: string;
  onCancel: () => void;
}) {
  if (!status) return null;
  const action = status.operation === 'preview' ? 'preview' : status.operation === 'open' ? 'open' : 'download';
  const phase = status.cancelling ? 'Cancelling…' : {
    downloading: 'Downloading…',
    scanning: 'Scanning…',
    saving: 'Saving…',
  }[status.phase ?? 'downloading'];

  return (
    <div className="mt-1 space-y-1 text-xs" onClick={(event) => event.stopPropagation()}>
      {status.phase && <div role="status" aria-live="polite" className="flex items-center justify-center gap-1 text-muted-foreground">
        <span>{phase}</span>
        {status.canCancel && <Tooltip content={`Cancel ${action}`} delayMs={40}>
          <button type="button" aria-label={`Cancel ${action} of ${filename}`} disabled={status.cancelling} onClick={onCancel} className="rounded p-1 hover:bg-accent disabled:opacity-50">
            <X className="h-3 w-3" />
          </button>
        </Tooltip>}
      </div>}
      {status.error && <p role="alert" className="break-words text-destructive">{status.error}</p>}
      {status.cancelled && <p role="status" className="text-muted-foreground">{action === 'download' ? 'Download cancelled.' : action === 'preview' ? 'Preview cancelled.' : 'Opening cancelled.'}</p>}
      {status.notScanned && <UnscannedAttachmentNotice />}
    </div>
  );
}
