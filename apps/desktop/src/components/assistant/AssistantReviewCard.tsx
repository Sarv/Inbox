import { Archive, CheckCircle2, Clock3, Mail, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { InboxAssistantSource } from '../../types/inbox-assistant';
import type { InboxAssistantReview, InboxAssistantReviewAction, InboxAssistantReviewItem, InboxAssistantReviewRecommendation } from '../../types/inbox-assistant-actions';

export interface AssistantReviewCardProps {
  review: InboxAssistantReview;
  busy: boolean;
  onApply: (itemIds: string[], manualSelection?: boolean, action?: InboxAssistantReviewAction) => void;
  onUndo: (itemIds: string[]) => void;
  onOpen: (source: InboxAssistantSource) => void;
  onRefresh: () => void;
  onContinue?: () => void;
}

const filters: Array<{ value: InboxAssistantReviewRecommendation; label: string }> = [
  { value: 'mark_read', label: 'Mark read' },
  { value: 'keep_unread', label: 'Keep unread' },
  { value: 'needs_review', label: 'Needs review' },
];
const statusLabels = { applied: 'Applied', queued: 'Queued for sync', failed: 'Failed', skipped: 'Skipped', undone: 'Undone' };

function exactFlagTargets(item: InboxAssistantReviewItem, review: InboxAssistantReview): boolean {
  return (review.kind === 'mark_read' || review.kind === 'mark_unread')
    && item.recommendation === review.kind && item.targetRead === (review.kind === 'mark_read')
    && !!item.targetEmailIds?.length;
}

function recommended(item: InboxAssistantReviewItem, review: InboxAssistantReview): boolean {
  return item.recommendation === (review.kind === 'mark_unread' ? 'mark_unread' : 'mark_read')
    && Number.isFinite(item.confidence) && item.confidence >= 0.9 && item.protectedReasons.length === 0
    && (exactFlagTargets(item, review) || (!item.bodyUnavailable && !item.attachmentsUnknown));
}

function selectable(item: InboxAssistantReviewItem, review: InboxAssistantReview): boolean {
  const targetCount = item.targetEmailIds?.length ?? (item.recommendation === 'mark_read' ? item.unreadEmailIds.length : 0);
  return item.status === 'pending' && targetCount > 0 && recommended(item, review);
}

function manuallySelectable(item: InboxAssistantReviewItem, review: InboxAssistantReview): boolean {
  return (review.kind === 'unread' || review.kind === 'uncategorized') && item.status === 'pending'
    && item.manualSelectionAllowed === true && item.unreadEmailIds.length > 0;
}

function movable(item: InboxAssistantReviewItem): boolean {
  return item.mailActionsAllowed === true && item.appliedAction !== 'archive' && item.appliedAction !== 'trash';
}

function canSelectItem(item: InboxAssistantReviewItem, review: InboxAssistantReview): boolean {
  return selectable(item, review) || manuallySelectable(item, review) || movable(item);
}

/** The stored "pending" flag tracks mutations, not whether review finished. */
function reviewStatusLabel(item: InboxAssistantReviewItem, review: InboxAssistantReview): string {
  if (item.status === 'applied' && item.appliedAction === 'archive') return 'Archived';
  if (item.status === 'applied' && item.appliedAction === 'trash') return 'Moved to Trash';
  if (item.status !== 'pending') return statusLabels[item.status];
  if (item.recommendation === 'keep_unread') return review.kind === 'mark_unread' ? 'Left unchanged' : 'Kept unread';
  if (!recommended(item, review)) return 'Needs your review';
  return review.kind === 'mark_unread' ? 'Ready to mark unread' : 'Ready to mark read';
}

function sourceFor(item: InboxAssistantReviewItem): InboxAssistantSource {
  return {
    id: item.id, kind: 'message', accountId: item.accountId, accountEmail: item.accountEmail,
    emailId: item.emailId, threadId: item.threadId, date: item.date,
    subject: item.subject, from: item.from, to: [], folder: '', sent: false, excerpt: item.reason,
  };
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function sourceDate(value: number): string {
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
}

export function AssistantReviewCard({ review, busy, onApply, onUndo, onOpen, onRefresh, onContinue }: AssistantReviewCardProps) {
  const headingId = useId();
  const markUnread = review.kind === 'mark_unread';
  const scoped = review.kind === 'mark_read' || markUnread;
  const primaryFilter = markUnread ? 'mark_unread' : 'mark_read';
  const actionLabel = markUnread ? 'unread' : 'read';
  const visibleFilters = markUnread ? [{ value: 'mark_unread' as const, label: 'Mark unread' }, { value: 'keep_unread' as const, label: 'Keep current status' }, filters[2]!] : filters;
  const [filter, setFilter] = useState<InboxAssistantReviewRecommendation>(primaryFilter);
  const [now, setNow] = useState(() => Date.now());
  const [selection, setSelection] = useState(() => ({ reviewId: review.id, ids: new Set(review.items.filter(item => selectable(item, review)).map(item => item.id)), manualIds: new Set<string>() }));
  const eligible = review.items.filter(item => selectable(item, review));
  const selectedIds = selection.reviewId === review.id ? selection.ids : new Set(eligible.map(item => item.id));
  const manualIds = selection.reviewId === review.id ? selection.manualIds ?? new Set<string>() : new Set<string>();
  const selected = review.items.filter(item => selectedIds.has(item.id) && (selectable(item, review) || (manualIds.has(item.id) && canSelectItem(item, review))));
  const overrides = selected.filter(item => !recommended(item, review));
  const selectedElsewhere = selected.filter(item => item.recommendation !== filter).length;
  const selectedTargetCount = selected.reduce((sum, item) => sum + (item.targetEmailIds?.length ?? item.unreadEmailIds.length), 0);
  const selectedTargetLabel = scoped || selected.some(item => item.status !== 'pending') ? 'email' : 'unread email';
  const selectedMessageCount = selected.reduce((sum, item) => sum + item.messageCount, 0);
  const canMarkRead = selected.length > 0 && selected.every(item => selectable(item, review) || manuallySelectable(item, review));
  const canMove = selected.length > 0 && selected.every(movable);
  const expired = review.status === 'expired' || !Number.isFinite(review.expiresAt) || review.expiresAt <= now;
  const locked = busy || expired;
  const undoable = review.items.filter(item => item.undoAvailable === true
    && item.appliedAction !== 'archive' && item.appliedAction !== 'trash'
    && (item.status === 'applied' || item.status === 'queued' || item.status === 'failed') && (recommended(item, review) || item.manualSelectionAllowed === true));
  const shown = review.items.filter(item => item.recommendation === filter);
  const hasCoverageNotes = review.truncated || review.coverage.some(account => account.status === 'unavailable' || account.hasMore || account.warnings.length > 0);

  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(review.expiresAt)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, review.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [review.id, review.expiresAt]);

  useEffect(() => { setFilter(primaryFilter); }, [review.id, primaryFilter]);

  function canAct(): boolean {
    return !busy && review.status !== 'expired' && Number.isFinite(review.expiresAt) && review.expiresAt > Date.now();
  }

  function setSelected(ids: string[]) {
    if (!canAct()) return;
    setSelection({ reviewId: review.id, ids: new Set(ids), manualIds: new Set() });
  }

  function toggle(item: InboxAssistantReviewItem) {
    if (!canAct() || !canSelectItem(item, review)) return;
    const next = new Set(selected.map(value => value.id));
    const nextManual = new Set(manualIds);
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    if (next.has(item.id) && !selectable(item, review)) nextManual.add(item.id);
    else nextManual.delete(item.id);
    setSelection({ reviewId: review.id, ids: next, manualIds: nextManual });
  }

  function selectGroup() {
    if (!canAct()) return;
    const next = new Set(selected.map(item => item.id));
    const nextManual = new Set(manualIds);
    for (const item of shown.filter(item => canSelectItem(item, review))) {
      next.add(item.id);
      if (!selectable(item, review)) nextManual.add(item.id);
    }
    setSelection({ reviewId: review.id, ids: next, manualIds: nextManual });
  }

  return (
    <section aria-labelledby={headingId} className="assistant-surface min-w-0 overflow-clip rounded-2xl border border-border bg-background">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id={headingId} className="text-sm font-semibold">{scoped ? `Mark matching mail as ${actionLabel}` : review.kind === 'uncategorized' ? 'Uncategorized mail review' : 'Unread mail review'}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{count(review.items.length, 'conversation')} · {count(review.items.reduce((sum, item) => sum + (scoped ? item.targetEmailIds?.length ?? 0 : item.unreadCount), 0), scoped ? 'matching email' : 'unread email')}</p>
            {review.scope && <p className="mt-1 break-words text-xs text-muted-foreground">{review.scope.field === 'any' ? 'Matching' : `${review.scope.field.charAt(0).toUpperCase()}${review.scope.field.slice(1)} matches`}: {review.scope.query}</p>}
          </div>
          <button type="button" onClick={() => { if (!busy) onRefresh(); }} disabled={busy} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Refresh review
          </button>
        </div>
        {expired && <div role="status" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-foreground"><p>This review has expired. Refresh it before changing mail.</p><button type="button" onClick={() => { if (!busy) onRefresh(); }} disabled={busy} className="flex min-h-8 items-center gap-1.5 font-medium underline underline-offset-2"><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Refresh now</button></div>}
        {hasCoverageNotes && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Review coverage and limits</summary>
            <ul className="mt-2 space-y-2 [overflow-wrap:anywhere]">
              {review.coverage.map(account => <li key={account.accountId}>
                <span className="font-medium text-foreground">{account.email}</span>
                <p>{account.status === 'unavailable' ? 'Account unavailable; its mail was not reviewed.' : `${count(account.reviewedThreads, 'conversation')} reviewed`}{account.hasMore ? ' · More conversations remain.' : ''}</p>
                {account.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
              </li>)}
              {review.truncated && <li>This review covers a limited batch of conversations.</li>}
            </ul>
          </details>
        )}
        <div aria-label="Filter recommendations" className="assistant-raised assistant-review-filters flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1">
          {visibleFilters.map(value => <button key={value.value} type="button" aria-pressed={filter === value.value} onClick={() => setFilter(value.value)} className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors ${filter === value.value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}>
            {value.label} <span className="ml-1 tabular-nums text-muted-foreground">{review.items.filter(item => item.recommendation === value.value).length}</span>
          </button>)}
        </div>
        {filter !== primaryFilter && !scoped && <p className="text-xs leading-5 text-muted-foreground">{expired ? 'Refresh this review to select conversations.' : 'Select conversations to mark as read, archive or delete. Marking mail as read against the agent’s recommendation requires confirmation.'}</p>}
        <div className="flex flex-wrap gap-3 text-xs">
          <button type="button" onClick={() => setSelected(eligible.map(item => item.id))} disabled={locked || eligible.length === 0} className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">Select recommended</button>
          <button type="button" onClick={selectGroup} disabled={locked || !shown.some(item => canSelectItem(item, review))} className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">Select this group</button>
          <button type="button" onClick={() => setSelected([])} disabled={locked || selected.length === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-50">Clear selection</button>
        </div>
      </div>

      <ul aria-label="Reviewed conversations" className="assistant-review-list divide-y divide-border border-t border-border">
        {shown.map(item => {
          const canSelect = canSelectItem(item, review);
          const needsContentReview = !exactFlagTargets(item, review);
          const selectedItem = selected.some(value => value.id === item.id);
          const itemUndoable = undoable.some(value => value.id === item.id);
          const keptUnread = item.status === 'pending' && item.recommendation === 'keep_unread' && review.kind !== 'mark_unread';
          return <li key={item.id} data-selected={selectedItem} className={`assistant-review-item min-w-0 p-4 ${selectedItem ? 'bg-primary/5' : ''}`}>
            <div className="flex min-w-0 items-start gap-3">
              <label className="-m-2 mt-0 flex h-8 w-8 shrink-0 items-center justify-center"><input type="checkbox" checked={selectedItem} disabled={locked || !canSelect} onChange={() => toggle(item)} aria-label={`Select conversation: ${item.subject || '(No subject)'} (${item.accountEmail})`} className="assistant-review-checkbox h-4 w-4 accent-primary disabled:opacity-40" /></label>
              <div className="min-w-0 flex-1 space-y-2 [overflow-wrap:anywhere]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <button type="button" onClick={() => onOpen(sourceFor(item))} aria-label={`Open conversation: ${item.subject || '(No subject)'} (${item.accountEmail})`} className="min-w-0 text-left text-sm font-medium text-foreground hover:text-primary hover:underline">
                    <Mail aria-hidden="true" className="mr-1.5 inline h-3.5 w-3.5 text-muted-foreground" />{item.subject || '(No subject)'}
                  </button>
                  <span className={`shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] ${item.status === 'failed' ? 'text-destructive' : keptUnread || item.status === 'applied' || item.status === 'undone' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                    {(keptUnread || item.status === 'applied') && <CheckCircle2 aria-hidden="true" className="mr-1 inline h-3 w-3" />}{item.status === 'queued' && <Clock3 aria-hidden="true" className="mr-1 inline h-3 w-3" />}{reviewStatusLabel(item, review)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{item.accountEmail} · {item.from} · {sourceDate(item.date)}</p>
                <p className="text-sm leading-5">{item.reason}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{count(item.unreadCount, 'unread email')} of {count(item.messageCount, 'email')}</span>
                  {scoped && <span>{count(item.targetEmailIds?.length ?? 0, 'matching email')} to mark {actionLabel}</span>}
                  <span>{Number.isFinite(item.confidence) ? `${Math.round(Math.max(0, Math.min(1, item.confidence)) * 100)}% confidence` : 'Confidence unavailable'}</span>
                  {item.uncategorized && <span className="rounded-full bg-muted px-2 py-0.5">Uncategorized</span>}
                  {item.categories.map(category => <span key={category} className="rounded-full bg-muted px-2 py-0.5">{category.replace(/_/g, ' ')}</span>)}
                </div>
                {(item.protectedReasons.length > 0 || (needsContentReview && (item.bodyUnavailable || item.attachmentsUnknown)) || ((item.recommendation === 'mark_read' || item.recommendation === 'mark_unread') && item.confidence < 0.9)) && <ul aria-label="Reasons kept for review" className="space-y-1 text-xs text-muted-foreground">
                  {item.protectedReasons.map((reason, index) => <li key={index}>{reason}</li>)}
                  {needsContentReview && item.bodyUnavailable && <li>Message content is unavailable.</li>}
                  {needsContentReview && item.attachmentsUnknown && <li>Attachments need review.</li>}
                  {(item.recommendation === 'mark_read' || item.recommendation === 'mark_unread') && item.confidence < 0.9 && <li>Confidence is below the threshold for changing read status.</li>}
                </ul>}
                {itemUndoable && <button type="button" disabled={locked} onClick={() => { if (canAct() && itemUndoable) onUndo([item.id]); }} aria-label={`Undo marked ${actionLabel}: ${item.subject || '(No subject)'} (${item.accountEmail})`} className="flex items-center gap-1.5 text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"><Undo2 aria-hidden="true" className="h-3.5 w-3.5" />Undo</button>}
              </div>
            </div>
          </li>;
        })}
        {shown.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No conversations in this group.</li>}
      </ul>

      <div role="group" aria-label="Review actions" className="assistant-raised sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card p-4">
        <div className="space-y-1"><p aria-live="polite" className="text-xs text-muted-foreground">{count(selected.length, 'conversation')} selected · {count(selectedTargetCount, selectedTargetLabel)}{scoped ? ` to mark ${actionLabel}` : ''}{selectedElsewhere > 0 && <span> · {selectedElsewhere} in other groups</span>}</p>{canMove && <p className="text-xs text-muted-foreground">Archive and Delete apply to all {count(selectedMessageCount, 'email')} in these conversations. Delete moves them to Trash.</p>}{canMarkRead && overrides.length > 0 && <p className="text-xs text-muted-foreground">{count(overrides.length, 'selection')} {overrides.length === 1 ? 'overrides' : 'override'} the agent’s recommendation. Confirmation required to mark as {actionLabel}.</p>}</div>
        <div className="flex flex-wrap items-center gap-3">
          {expired && <button type="button" disabled={busy} onClick={() => { if (!busy) onRefresh(); }} className="flex min-h-9 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Refresh review</button>}
          {review.coverage.some(account => account.hasMore) && <button type="button" disabled={locked || !onContinue} onClick={() => { if (canAct()) onContinue?.(); }} className="rounded-xl border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50">Review next batch</button>}
          {undoable.length > 1 && <button type="button" disabled={locked} onClick={() => { if (canAct()) onUndo(undoable.map(item => item.id)); }} className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline">Undo {count(undoable.length, 'conversation')}</button>}
          <button type="button" aria-label="Archive selected conversations" disabled={locked || !canMove} onClick={() => { if (canAct() && canMove) onApply(selected.map(item => item.id), true, 'archive'); }} className="flex min-h-9 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"><Archive aria-hidden="true" className="h-3.5 w-3.5" />Archive</button>
          <button type="button" aria-label="Move selected conversations to Trash" disabled={locked || !canMove} onClick={() => { if (canAct() && canMove) onApply(selected.map(item => item.id), true, 'trash'); }} className="flex min-h-9 items-center gap-1.5 rounded-xl border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 aria-hidden="true" className="h-3.5 w-3.5" />Delete</button>
          <button type="button" disabled={locked || !canMarkRead} onClick={() => { if (canAct() && canMarkRead) { const ids = selected.map(item => item.id); if (overrides.length) onApply(ids, true); else onApply(ids); } }} className="assistant-primary-action min-h-9 rounded-xl bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">Mark selected as {actionLabel}</button>
        </div>
      </div>
    </section>
  );
}
