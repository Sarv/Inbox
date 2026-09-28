import type { EmailRecord } from '@sarvinbox/core';
import { BellRing, Clock, X } from 'lucide-react';

import { useEmailStore } from '../../store/email-store';
import { followUpsForThread, useFollowUpsStore } from '../../store/follow-ups-store';
import { followUpStatusText } from '../../utils/follow-up-presets';
import { Tooltip } from '../Tooltip';

interface FollowUpBannerProps {
  threadId: string | null | undefined;
  /** Account the open thread belongs to (the active one when null). */
  accountId: string | null;
  threadEmails: EmailRecord[];
  /** Opens a Reply All to the given message — ours, so it goes back to its recipients. */
  onFollowUp: (email: EmailRecord) => void;
}

/**
 * "No reply since <date>" above a thread with a follow-up reminder on one of
 * our messages. Due: Follow up (reply to the people we wrote to) or Dismiss.
 * Still waiting: says when it will remind, and can be cancelled.
 */
export function FollowUpBanner({ threadId, accountId, threadEmails, onFollowUp }: FollowUpBannerProps) {
  const items = useFollowUpsStore((s) => s.items);
  const dismiss = useFollowUpsStore((s) => s.dismiss);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  const followUp = followUpsForThread(items, threadId, accountId, activeAccountId)[0];
  if (!followUp) return null;

  const due = followUp.status === 'due';
  const sent = threadEmails.find((email) => email.messageId === followUp.messageId || email.id === followUp.emailId);
  const label = due ? 'Dismiss reminder' : 'Cancel reminder';

  return (
    <div
      role="status"
      className={`mb-4 flex items-center gap-3 rounded-md border px-3 py-2 ${
        due ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted'
      }`}
    >
      {due ? <BellRing className="h-4 w-4 shrink-0 text-primary" /> : <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="flex-1 min-w-0 truncate text-sm text-foreground">{followUpStatusText(followUp)}</span>
      {due && sent && (
        <button
          type="button"
          onClick={() => onFollowUp(sent)}
          className="px-3 py-1 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors"
        >
          Follow up
        </button>
      )}
      <Tooltip content={label} delayMs={40}>
        <button
          type="button"
          onClick={() => dismiss(followUp)}
          aria-label={label}
          className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  );
}
