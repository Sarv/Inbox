import { useMemo } from 'react';

import { useEmailStore } from '../store/email-store';
import { paneAccountOf } from '../utils/pane-account';
import { remoteImageFactsOf } from '../utils/remote-images';

import { SandboxedEmailBody } from './SandboxedEmailBody';

/** What the preview needs to know about the message being replied to or forwarded. */
type OriginalMessage = Parameters<typeof remoteImageFactsOf>[0];

/**
 * The read-only "Original Message" under a reply or forward being written.
 *
 * It is the original sender's HTML, tracking pixels and all, so its remote
 * images follow the same decision as reading that message
 * (`shouldAutoLoadRemoteImages`, with the message's own account). It used to
 * render with blocking off: opening the composer fetched the pixels in every
 * mode, "Block" included. One component for both composer layouts, so the
 * two cannot drift apart again.
 */
export function QuotedOriginalPreview({ html, original, compact = false }: {
  html: string;
  original: OriginalMessage;
  /** The inline (smaller) composer's spacing. */
  compact?: boolean;
}) {
  const paneAccountId = useEmailStore(paneAccountOf);
  const remoteImagesFrom = useMemo(() => remoteImageFactsOf(original, paneAccountId), [original, paneAccountId]);
  return (
    <div className={`flex-shrink-0 border-t border-border bg-muted/20 ${compact ? 'max-h-[150px]' : 'max-h-[200px]'} overflow-y-auto`}>
      <div className={`${compact ? 'px-3 py-1.5' : 'px-4 py-2'} text-xs text-muted-foreground font-medium border-b border-border bg-muted/30`}>
        Original Message
      </div>
      <SandboxedEmailBody html={html} className={compact ? 'px-3 py-2 text-xs' : 'px-4 py-2 text-sm'} remoteImagesFrom={remoteImagesFrom} />
    </div>
  );
}
