import { Copy } from 'lucide-react';

import { Tooltip } from '../Tooltip';

import { formatRelativeDate } from './utils';

interface DuplicateCopiesBadgeProps {
  /** The identical copies hidden behind the message this badge sits on. */
  duplicates: { date: number }[];
}

/**
 * "N copies" marker on a message that reached this conversation more than once
 * as the SAME message — same Message-ID, delivered to two of the reader's
 * accounts (see `collapseDuplicateMessages`). Two mails that merely look alike
 * never get here: they are different messages and each renders on its own.
 *
 * Deliberately a marker and not a silent hide: the copies are real mail sitting
 * on the server, and a conversation that quietly drops messages is a worse bug
 * than one that shows too many. The tooltip lists when each copy arrived so the
 * user can confirm against Gmail or webmail without opening the DB.
 */
export function DuplicateCopiesBadge({ duplicates }: DuplicateCopiesBadgeProps) {
  if (!duplicates || duplicates.length === 0) return null;

  const total = duplicates.length + 1;

  return (
    <Tooltip
      delayMs={40}
      maxWidth={280}
      content={
        <div className="text-left">
          <div className="font-medium mb-1">
            The same message (one Message-ID) reached this conversation {total} times.
          </div>
          <div className="opacity-80">
            Also received {duplicates.map((d) => formatRelativeDate(d.date)).join(', ')}
          </div>
        </div>
      }
    >
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border text-[11px] text-muted-foreground"
        aria-label={`${total} copies of this same message`}
      >
        <Copy className="h-3 w-3" />
        {total} copies
      </span>
    </Tooltip>
  );
}
