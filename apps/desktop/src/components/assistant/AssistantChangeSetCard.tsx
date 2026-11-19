import { CheckCircle2, Clock3, ShieldAlert, Undo2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { InboxAssistantSource } from '../../types/inbox-assistant';
import type { InboxAgentChangeItem, InboxAgentChangeSet } from '../../types/inbox-assistant-changes';

import './assistant-review.css';

/**
 * One change set the Inbox Agent prepared (or applied under "Approve for
 * me"): what it changes, on which emails, and the user's decision. Protected
 * emails start unticked with the reason shown; nothing changes until Approve.
 */

export interface AssistantChangeSetCardProps {
  changeSet: InboxAgentChangeSet;
  busy: boolean;
  onDecision: (decision: 'approve' | 'cancel' | 'undo', itemIds?: string[]) => void;
  onOpen: (source: InboxAssistantSource) => void;
}

const PAGE = 25;

const itemStatus: Record<Exclude<InboxAgentChangeItem['status'], 'pending'>, string> = {
  applied: 'Done', queued: 'Will sync', unchanged: 'Already as asked', failed: 'Failed', skipped: 'Left out', undone: 'Undone',
};

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

function sourceDate(value: number): string {
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
}

function sourceFor(item: InboxAgentChangeItem): InboxAssistantSource {
  return {
    id: item.id, kind: 'message', accountId: item.accountId, accountEmail: item.accountEmail,
    emailId: item.emailId, threadId: item.threadId, date: item.date,
    subject: item.subject, from: item.from, to: [], folder: '', sent: false, excerpt: item.reason ?? '',
  };
}

const changed = (item: InboxAgentChangeItem) => item.status === 'applied' || item.status === 'queued';

function statusLine(set: InboxAgentChangeSet, now: number): string {
  const tally = (status: InboxAgentChangeItem['status']) => set.items.filter(item => item.status === status).length;
  const done = set.items.filter(changed).length;
  const parts = [
    done ? `${count(done, 'email')} changed` : '',
    tally('queued') ? `${tally('queued')} will sync when the account is online` : '',
    tally('unchanged') ? `${tally('unchanged')} already as asked` : '',
    tally('undone') ? `${tally('undone')} undone` : '',
    tally('failed') ? `${tally('failed')} failed` : '',
  ].filter(Boolean);
  switch (set.status) {
    case 'pending': return set.approveBy > now ? 'Waiting for your approval. Nothing has changed yet.' : 'This expired before it was approved. Nothing was changed.';
    case 'expired': return 'This expired before it was approved. Nothing was changed.';
    case 'cancelled': return parts.length ? `Cancelled · ${parts.join(' · ')}` : 'Cancelled. Nothing was changed.';
    case 'undone': return `Undone · ${parts.join(' · ') || 'nothing left changed'}`;
    default: return `${set.autoApplied ? 'Applied for you' : 'Applied'} · ${parts.join(' · ') || 'nothing needed changing'}`;
  }
}

export function AssistantChangeSetCard({ changeSet, busy, onDecision, onOpen }: AssistantChangeSetCardProps) {
  const headingId = useId();
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState(PAGE);
  const initial = () => new Set(changeSet.items.filter(item => item.status === 'pending' && !item.protectedReason).map(item => item.id));
  const [selection, setSelection] = useState(() => ({ id: changeSet.id, ids: initial() }));
  // A refreshed card (after a decision) starts from its own pending rows.
  const selected = selection.id === changeSet.id ? selection.ids : initial();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const pending = changeSet.items.filter(item => item.status === 'pending');
  const failed = changeSet.items.filter(item => item.status === 'failed');
  const undoable = changeSet.items.filter(changed);
  const canApprove = ['pending', 'partial'].includes(changeSet.status) && changeSet.approveBy > now && (pending.length > 0 || failed.length > 0);
  const canUndo = ['applied', 'partial'].includes(changeSet.status) && changeSet.undoBy > now && undoable.length > 0;
  const chosen = pending.filter(item => selected.has(item.id));
  const protectedChosen = chosen.filter(item => item.protectedReason).length;
  const protectedCount = changeSet.items.filter(item => item.protectedReason && item.status === 'pending').length;

  function toggle(item: InboxAgentChangeItem) {
    if (busy || !canApprove) return;
    const next = new Set(selected);
    if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
    setSelection({ id: changeSet.id, ids: next });
  }

  return (
    <section aria-labelledby={headingId} className="assistant-surface assistant-review min-w-0 overflow-clip rounded-xl border border-border bg-background">
      <div className="assistant-review-header">
        <div className="assistant-review-heading">
          <div className="min-w-0">
            <h3 id={headingId} className="assistant-review-title">{changeSet.summary}</h3>
            <p role="status" className="assistant-review-subtitle">{statusLine(changeSet, now)}</p>
            {changeSet.note && <p className="mt-1 text-xs leading-5 text-muted-foreground">{changeSet.note}</p>}
            {protectedCount > 0 && canApprove && <p className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground"><ShieldAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />{count(protectedCount, 'email')} {protectedCount === 1 ? 'is' : 'are'} protected and left unticked. Tick {protectedCount === 1 ? 'it' : 'them'} only if you are sure.</p>}
          </div>
        </div>
      </div>

      <div role="region" aria-label="Emails in this change" tabIndex={0} className="assistant-review-list border-t border-border"><ul className="divide-y divide-border">
        {changeSet.items.slice(0, shown).map(item => {
          const isSelected = item.status === 'pending' && selected.has(item.id);
          return <li key={item.id} data-selected={isSelected} className="assistant-review-item min-w-0">
            <label className="assistant-review-select-target"><input type="checkbox" checked={isSelected} disabled={busy || !canApprove || item.status !== 'pending'} onChange={() => toggle(item)} aria-label={`Include: ${item.subject} (${item.accountEmail})`} className="assistant-review-checkbox h-4 w-4 accent-primary disabled:opacity-40" /></label>
            <div className="assistant-review-item-content">
              <div className="assistant-review-item-heading">
                <button type="button" onClick={() => onOpen(sourceFor(item))} aria-label={`Open email: ${item.subject} (${item.accountEmail})`} className="assistant-review-subject">{item.subject}</button>
                {item.status !== 'pending' && <span className={`assistant-review-status ${item.status === 'failed' ? 'text-destructive' : changed(item) || item.status === 'undone' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                  {item.status === 'applied' && <CheckCircle2 aria-hidden="true" className="h-3 w-3" />}{item.status === 'queued' && <Clock3 aria-hidden="true" className="h-3 w-3" />}{itemStatus[item.status]}
                </span>}
              </div>
              <p title={item.from} className="assistant-review-sender">{item.from} · {sourceDate(item.date)}</p>
              {item.reason && <p className="assistant-review-reason">{item.reason}</p>}
              {item.protectedReason && <p className="assistant-review-reason flex items-start gap-1.5"><ShieldAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>Protected: {item.protectedReason}</span></p>}
              {item.detail && <p className="text-xs text-muted-foreground">{item.detail}</p>}
            </div>
          </li>;
        })}
      </ul>
        {changeSet.items.length > shown && <div className="px-4 py-2"><button type="button" onClick={() => setShown(value => value + PAGE * 2)} className="assistant-review-text-button">Show {Math.min(PAGE * 2, changeSet.items.length - shown)} more of {changeSet.items.length}</button></div>}
      </div>

      {(canApprove || canUndo) && <div role="group" aria-label="Change actions" className="assistant-review-footer border-t border-border bg-card">
        {canApprove && pending.length > 0 && <p aria-live="polite" className="text-xs font-medium">{count(chosen.length, 'email')} selected{protectedChosen ? ` · ${protectedChosen} protected` : ''}</p>}
        <div className="assistant-review-action-row">
          <div className="assistant-review-primary-group">
            {canApprove && pending.length > 0 && <button type="button" disabled={busy || chosen.length === 0} onClick={() => onDecision('approve', chosen.map(item => item.id))} className="assistant-review-button assistant-primary-action bg-primary text-primary-foreground">{chosen.length === pending.length ? 'Approve' : 'Approve selected'}</button>}
            {canApprove && pending.length === 0 && failed.length > 0 && <button type="button" disabled={busy} onClick={() => onDecision('approve', failed.map(item => item.id))} className="assistant-review-button assistant-primary-action bg-primary text-primary-foreground">Retry {count(failed.length, 'failed email')}</button>}
          </div>
          <div className="assistant-review-secondary">
            {canApprove && pending.length > 0 && <button type="button" disabled={busy} onClick={() => onDecision('cancel')} className="assistant-review-button">{changeSet.status === 'pending' ? 'Cancel' : 'Leave the rest'}</button>}
            {canUndo && <button type="button" disabled={busy} onClick={() => onDecision('undo')} className="assistant-review-button"><Undo2 aria-hidden="true" className="h-3.5 w-3.5" />Undo {count(undoable.length, 'email')}</button>}
          </div>
        </div>
      </div>}
    </section>
  );
}
