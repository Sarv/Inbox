import { SlidersHorizontal, Undo2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { InboxAgentSettingChange } from '../../types/inbox-assistant-changes';

import './assistant-review.css';

/**
 * One setting the Inbox Agent asked to change (a filter, a sender block, VIP,
 * trust). It always waits for the user: nothing is saved until Approve, and
 * the offer to act on existing mail too starts unticked.
 */

export interface AssistantSettingChangeCardProps {
  change: InboxAgentSettingChange;
  busy: boolean;
  onDecision: (decision: 'approve' | 'cancel' | 'undo', includeExisting?: boolean) => void;
}

function count(value: number, noun: string): string {
  return `${value} ${value === 1 ? noun : `${noun}s`}`;
}

function statusLine(change: InboxAgentSettingChange, now: number): string {
  const existing = change.existingApplied && change.existing?.result ? ` · ${change.existing.result}` : '';
  switch (change.status) {
    case 'pending': return change.approveBy > now ? 'Waiting for your approval. Nothing has changed yet.' : 'This expired before it was approved. Nothing was changed.';
    case 'expired': return 'This expired before it was approved. Nothing was changed.';
    case 'cancelled': return 'Cancelled. Nothing was changed.';
    case 'undone': return `Undone${existing}`;
    default: return `Saved${existing}`;
  }
}

export function AssistantSettingChangeCard({ change, busy, onDecision }: AssistantSettingChangeCardProps) {
  const headingId = useId();
  const optionId = useId();
  const [now, setNow] = useState(() => Date.now());
  // The user's tick for this change only: a different card starts unticked.
  const [ticked, setTicked] = useState<{ id: string; on: boolean }>({ id: change.id, on: false });
  const includeExisting = ticked.id === change.id && ticked.on;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const canApprove = change.status === 'pending' && change.approveBy > now;
  const canUndo = change.status === 'applied' && change.undoBy > now;
  const canRetry = canUndo && change.existingApplied && /failed/.test(change.existing?.result ?? '') && change.approveBy > now;
  const existing = change.existing;

  return (
    <section aria-labelledby={headingId} className="assistant-surface assistant-review min-w-0 overflow-clip rounded-xl border border-border bg-background">
      <div className="assistant-review-header">
        <div className="assistant-review-heading">
          <div className="min-w-0">
            <h3 id={headingId} className="assistant-review-title flex items-center gap-1.5"><SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{change.summary}</h3>
            <p role="status" className="assistant-review-subtitle">{statusLine(change, now)}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Setting for {change.accountEmail}. It keeps acting on new mail after this chat.</p>
          </div>
        </div>
      </div>

      <ul aria-label="What this change does" className="border-t border-border px-4 py-2 text-xs leading-5">
        {change.details.map((line, index) => <li key={index}>{line}</li>)}
      </ul>

      {change.detail && <p className="border-t border-border px-4 py-2 text-xs text-destructive">{change.detail}</p>}

      {(canApprove || canUndo) && <div role="group" aria-label="Setting actions" className="assistant-review-footer border-t border-border bg-card">
        {canApprove && existing && <label htmlFor={optionId} className="flex items-start gap-2 text-xs leading-5">
          <input id={optionId} type="checkbox" checked={includeExisting} disabled={busy} onChange={event => setTicked({ id: change.id, on: event.target.checked })} className="mt-0.5 h-4 w-4 accent-primary" />
          <span>{existing.text}: {count(existing.count, 'email')}{existing.protectedCount ? `. ${count(existing.protectedCount, 'protected email')} ${existing.protectedCount === 1 ? 'stays' : 'stay'} as ${existing.protectedCount === 1 ? 'it is' : 'they are'}` : ''}.</span>
        </label>}
        <div className="assistant-review-action-row">
          <div className="assistant-review-primary-group">
            {canApprove && <button type="button" disabled={busy} onClick={() => onDecision('approve', includeExisting)} className="assistant-review-button assistant-primary-action bg-primary text-primary-foreground">Approve</button>}
            {canRetry && <button type="button" disabled={busy} onClick={() => onDecision('approve')} className="assistant-review-button assistant-primary-action bg-primary text-primary-foreground">Retry failed emails</button>}
          </div>
          <div className="assistant-review-secondary">
            {canApprove && <button type="button" disabled={busy} onClick={() => onDecision('cancel')} className="assistant-review-button">Cancel</button>}
            {canUndo && <button type="button" disabled={busy} onClick={() => onDecision('undo')} className="assistant-review-button"><Undo2 aria-hidden="true" className="h-3.5 w-3.5" />Undo</button>}
          </div>
        </div>
      </div>}
    </section>
  );
}
