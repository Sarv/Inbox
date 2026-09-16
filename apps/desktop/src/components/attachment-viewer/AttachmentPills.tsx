import { Download, Loader2, Paperclip } from 'lucide-react';
import { useState } from 'react';

import { Tooltip } from '../Tooltip';

import { AttachmentViewer, formatSize, type ViewerAttachment } from './AttachmentViewer';
import { useAttachmentActions } from './useAttachmentActions';

/**
 * The attachment strip for a chat bubble, plus the viewer it opens.
 *
 * The chat library renders a strip of its own, but as plain `<span>`s with no
 * click handler, no message identity and no slot to replace them. Reaching them
 * meant delegating off `.sec-chip` and reading the filename back out of a
 * `title` attribute — which worked, but left the pill unreachable by keyboard
 * and left the only hint that it could be clicked at all to the mouse cursor.
 * So the app renders its own: the whole pill is a `<button>`, so it focuses,
 * answers Enter, and can carry a tooltip. chat-view-theme.css hides the
 * library's strip and styles this one.
 *
 * The library's `.sec-chip*` class names are deliberately reused rather than
 * restyled: its stylesheet already shapes the pill and makes it follow the
 * bubble's colour (white-on-blue for a sent message, ink-on-grey otherwise),
 * and a second pill design maintained beside it would drift on the first theme
 * change.
 *
 * Nothing else here is new either — `useAttachmentActions`, `AttachmentViewer`
 * and `formatSize` are the same ones EmailCard and ThreadList use, so a chat
 * pill and a card tile open the same viewer and report the same size.
 */

interface AttachmentPillsProps {
  emailId: string;
  accountId?: string;
  attachments: ViewerAttachment[];
}

export function AttachmentPills({ emailId, accountId, attachments }: AttachmentPillsProps) {
  const { isBusy, saveCopy } = useAttachmentActions();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  if (attachments.length === 0) return null;

  return (
    <>
      <div className="sarv-attachments">
        {attachments.map((attachment, index) => {
          // A save in flight, not a load: opening is instant here because the
          // viewer draws its own progress.
          const busy = isBusy(emailId, attachment.name);
          const size = formatSize(attachment.size);
          return (
            <span className="sec-chip" key={`${attachment.name}:${index}`}>
              {/* The filename, not just "Open": the library ellipsises the
                  name at 22ch and the native `title` that used to reveal it in
                  full is gone, so this tooltip is now the only way to read a
                  long one. */}
              <Tooltip content={`Open ${attachment.name}`} delayMs={40}>
                <button
                  type="button"
                  className="sarv-chip__open"
                  aria-label={`Open ${attachment.name}`}
                  onClick={() => setViewerIndex(index)}
                >
                  {busy ? (
                    <Loader2 className="sec-chip__clip h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Paperclip className="sec-chip__clip h-3.5 w-3.5" />
                  )}
                  <span className="sec-chip__name">{attachment.name}</span>
                  {size ? <span className="sec-chip__size">{size}</span> : null}
                </button>
              </Tooltip>
              <Tooltip content="Save a copy" delayMs={40}>
                <button
                  type="button"
                  className="sec-chip__btn"
                  aria-label={`Save a copy of ${attachment.name}`}
                  onClick={() => void saveCopy({ emailId, filename: attachment.name, accountId })}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </span>
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
