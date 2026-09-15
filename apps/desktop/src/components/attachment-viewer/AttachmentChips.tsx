import { Download, Loader2, Paperclip } from 'lucide-react';
import { useState } from 'react';

import { getFileIcon, getFileType } from '../email-detail/utils';
import { Tooltip } from '../Tooltip';

import { AttachmentViewer, type ViewerAttachment } from './AttachmentViewer';
import { useAttachmentActions } from './useAttachmentActions';

/**
 * The attachment strip under a message, plus the viewer it opens.
 *
 * One component for every surface that shows attachments. EmailCard and
 * ThreadList previously carried two copies of this markup that differed only in
 * Tailwind size tokens — hence `size`, rather than a second copy.
 */

interface AttachmentChipsProps {
  emailId: string;
  accountId?: string;
  attachments: ViewerAttachment[];
  /** 'md' for the main message card, 'sm' for the denser thread replies. */
  size?: 'sm' | 'md';
  /** Stops a click reaching a collapsible row underneath the strip. */
  stopPropagation?: boolean;
}

const SIZES = {
  md: {
    wrap: 'flex flex-wrap gap-3',
    chip: 'min-w-[120px] max-w-[150px] p-3',
    iconBox: 'mb-2 p-2',
    spinner: 'h-6 w-6',
    name: 'text-xs',
    header: 'text-sm',
    clip: 'h-4 w-4',
  },
  sm: {
    wrap: 'flex flex-wrap gap-2',
    chip: 'min-w-[100px] max-w-[130px] p-2',
    iconBox: 'mb-1.5 p-1.5',
    spinner: 'h-5 w-5',
    name: 'text-[11px]',
    header: 'text-xs',
    clip: 'h-3.5 w-3.5',
  },
} as const;

export function AttachmentChips({
  emailId,
  accountId,
  attachments,
  size = 'md',
  stopPropagation = false,
}: AttachmentChipsProps) {
  const { isBusy, saveCopy, saveAll } = useAttachmentActions();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const style = SIZES[size];

  if (attachments.length === 0) return null;

  const halt = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) event.stopPropagation();
  };

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className={`flex items-center gap-2 ${style.header} text-muted-foreground`}>
          <Paperclip className={style.clip} />
          <span>
            {attachments.length} attachment{attachments.length > 1 ? 's' : ''}
          </span>
        </div>
        <Tooltip content="Save a copy of every attachment" delayMs={40}>
          <button
            onClick={(event) => {
              halt(event);
              void saveAll(emailId, attachments.map((a) => a.name), accountId);
            }}
            aria-label="Save all attachments"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Save all</span>
          </button>
        </Tooltip>
      </div>

      <div className={style.wrap}>
        {attachments.map((attachment, index) => {
          const busy = isBusy(emailId, attachment.name);
          return (
            <div
              key={`${attachment.name}:${index}`}
              onClick={(event) => {
                halt(event);
                setViewerIndex(index);
              }}
              className={`group relative flex cursor-pointer flex-col items-center rounded-lg border border-border bg-background transition-all hover:border-primary/30 hover:bg-accent/50 ${style.chip}`}
            >
              <Tooltip content="Save a copy" delayMs={40}>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void saveCopy({ emailId, filename: attachment.name, accountId });
                  }}
                  aria-label={`Save a copy of ${attachment.name}`}
                  className="absolute right-1 top-1 rounded bg-background/80 p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                >
                  <Download className="h-3 w-3 text-muted-foreground" />
                </button>
              </Tooltip>
              <div
                className={`rounded-lg bg-muted/50 transition-colors group-hover:bg-background ${style.iconBox}`}
              >
                {busy ? (
                  <Loader2 className={`${style.spinner} animate-spin text-primary`} />
                ) : (
                  getFileIcon(attachment.name)
                )}
              </div>
              <div className="w-full text-center">
                <div className={`truncate font-medium ${style.name}`} title={attachment.name}>
                  {attachment.name}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {busy ? 'Working…' : getFileType(attachment.name)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {viewerIndex !== null && (
        <AttachmentViewer
          emailId={emailId}
          accountId={accountId}
          attachments={attachments}
          initialIndex={viewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </>
  );
}
