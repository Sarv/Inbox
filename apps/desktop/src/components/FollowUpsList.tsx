import type { AccountFollowUp } from '@sarvinbox/core';
import { BellRing, Clock, X } from 'lucide-react';
import { useEffect } from 'react';

import { useEmailStore } from '../store/email-store';
import { useFollowUpsStore } from '../store/follow-ups-store';
import { followUpStatusText } from '../utils/follow-up-presets';

import { Tooltip } from './Tooltip';

/**
 * The Follow-ups view: every message the user asked to be reminded about,
 * across accounts, due ones first. Stands in for the email list pane, so the
 * reading pane beside it opens the sent message's thread as usual.
 */
export function FollowUpsList() {
  const items = useFollowUpsStore((s) => s.items);
  const loaded = useFollowUpsStore((s) => s.loaded);
  const refresh = useFollowUpsStore((s) => s.refresh);
  const dismiss = useFollowUpsStore((s) => s.dismiss);
  const viewMode = useEmailStore((s) => s.viewMode);
  const selectedEmailId = useEmailStore((s) => s.selectedEmailId);
  const openThread = useEmailStore((s) => s.openThread);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const width = viewMode === 'no-split' ? 'flex-1' : viewMode === 'horizontal' ? 'w-full h-full' : 'w-96 border-r border-border';

  const open = (followUp: AccountFollowUp) => {
    if (followUp.emailId && followUp.threadId) openThread(followUp.emailId, followUp.threadId, followUp.accountId || undefined);
  };

  return (
    <div className={`${width} flex flex-col bg-background h-full min-w-0 overflow-hidden`}>
      <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-2 bg-muted border-b border-border">
        <span className="text-sm font-medium text-foreground">Follow-ups</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loaded && items.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
            <BellRing className="h-8 w-8" />
            <p className="text-sm">No follow-ups</p>
            <p className="text-xs">Use the bell beside Send to be reminded when nobody replies.</p>
          </div>
        )}
        {items.map((followUp) => {
          const openable = !!(followUp.emailId && followUp.threadId);
          const due = followUp.status === 'due';
          return (
            <div
              key={`${followUp.accountId}:${followUp.id}`}
              className={`list-row group flex items-start gap-3 border-b border-border px-3 py-2 ${
                selectedEmailId && selectedEmailId === followUp.emailId ? 'bg-accent' : 'hover:bg-accent/50'
              }`}
            >
              <button
                type="button"
                onClick={() => open(followUp)}
                disabled={!openable}
                className="flex-1 min-w-0 text-left disabled:cursor-default"
              >
                <div className="text-sm font-medium text-foreground truncate">{followUp.subject || '(no subject)'}</div>
                <div className="text-xs text-muted-foreground truncate">To {followUp.recipients || 'unknown recipients'}</div>
                <div className={`mt-0.5 flex items-center gap-1 text-xs ${due ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                  {due ? <BellRing className="h-3 w-3 shrink-0" /> : <Clock className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{followUpStatusText(followUp)}</span>
                </div>
              </button>
              <Tooltip content="Dismiss reminder" delayMs={40}>
                <button
                  type="button"
                  aria-label="Dismiss reminder"
                  onClick={() => dismiss(followUp)}
                  className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
