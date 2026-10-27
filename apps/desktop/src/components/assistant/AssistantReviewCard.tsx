import { Archive, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3, Loader2, Play, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import type { InboxAssistantSource } from '../../types/inbox-assistant';
import type { InboxAssistantReview, InboxAssistantReviewAction, InboxAssistantReviewAutomation, InboxAssistantReviewItem, InboxAssistantReviewRecommendation } from '../../types/inbox-assistant-actions';

import './assistant-review.css';

export interface AssistantReviewCardProps {
  review: InboxAssistantReview;
  busy: boolean;
  onApply: (itemIds: string[], manualSelection?: boolean, action?: InboxAssistantReviewAction) => void;
  onUndo: (itemIds: string[]) => void;
  onOpen: (source: InboxAssistantSource) => void;
  onRefresh: () => void;
  onContinue?: () => void;
  automation?: InboxAssistantReviewAutomation;
  onStartAutoReview?: () => void;
}

const filters: Array<{ value: InboxAssistantReviewRecommendation; label: string }> = [
  { value: 'mark_read', label: 'Mark read' },
  { value: 'keep_unread', label: 'Keep unread' },
  { value: 'needs_review', label: 'Needs review' },
];
const statusLabels = { applied: 'Applied', queued: 'Queued for sync', failed: 'Failed', skipped: 'Skipped', undone: 'Undone' };
const automationLabels = { running: 'Automatic review running', completed: 'Automatic review complete', stopped: 'Automatic review stopped', failed: 'Automatic review failed' };

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

function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value} ${value === 1 ? noun : plural}`;
}

function sourceDate(value: number): string {
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
}

function initialGroup(review: InboxAssistantReview): InboxAssistantReviewRecommendation {
  const primary = review.kind === 'mark_unread' ? 'mark_unread' : 'mark_read';
  const groups: InboxAssistantReviewRecommendation[] = [primary, 'keep_unread', 'needs_review'];
  return groups.find(group => review.items.some(item => item.recommendation === group)) ?? primary;
}

export function AssistantReviewCard({ review, busy, onApply, onUndo, onOpen, onRefresh, onContinue, automation, onStartAutoReview }: AssistantReviewCardProps) {
  const headingId = useId();
  const continuousHelpId = useId();
  const markUnread = review.kind === 'mark_unread';
  const scoped = review.kind === 'mark_read' || markUnread;
  const primaryFilter = markUnread ? 'mark_unread' : 'mark_read';
  const actionLabel = markUnread ? 'unread' : 'read';
  const visibleFilters = markUnread ? [{ value: 'mark_unread' as const, label: 'Mark unread' }, { value: 'keep_unread' as const, label: 'Keep current status' }, filters[2]!] : filters;
  const [filter, setFilter] = useState<InboxAssistantReviewRecommendation>(() => initialGroup(review));
  const groupReviewKey = useRef(JSON.stringify([review.id, primaryFilter]));
  const reviewedList = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [continueAutomatically, setContinueAutomatically] = useState(false);
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
  const currentAutomation = automation ?? review.automation;
  const automationRunning = currentAutomation?.status === 'running';
  const automationCompleted = currentAutomation?.status === 'completed';
  const resumingAutomation = currentAutomation?.status === 'stopped' || currentAutomation?.status === 'failed';
  const automationStartLabel = resumingAutomation ? 'Resume automatic review' : 'Mark recommended & continue';
  const automaticReviewSupported = review.kind === 'unread' || review.kind === 'uncategorized';
  const needsRetry = review.items.filter(item => item.needsRetry).length;
  const canStartAutoReview = automaticReviewSupported && !automationCompleted && (resumingAutomation || eligible.length > 0 || needsRetry > 0 || review.coverage.some(account => account.hasMore));
  const locked = busy || expired || automationRunning;
  const undoable = review.items.filter(item => item.undoAvailable === true
    && item.appliedAction !== 'archive' && item.appliedAction !== 'trash'
    && (item.status === 'applied' || item.status === 'queued' || item.status === 'failed') && (recommended(item, review) || item.manualSelectionAllowed === true));
  const shown = review.items.filter(item => item.recommendation === filter);
  const pageSize = 20;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(shown.length / pageSize) - 1));
  const visibleItems = shown.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const continuous = continueAutomatically && automaticReviewSupported && !!onStartAutoReview && !automationCompleted;
  const continuousHelp = expired ? 'Refresh this expired review before starting.'
    : !canStartAutoReview ? 'No recommendations or remaining batches. Refresh to check for new mail.'
      : 'Mark all recommended mail as read, then review the next batches. Important and uncertain mail stays unread.';
  const hasCoverageNotes = review.truncated || review.coverage.some(account => account.status === 'unavailable' || account.hasMore || account.warnings.length > 0 || account.cachedRecommendations !== undefined || account.aiReviewedThreads !== undefined);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    function refreshExpiry() {
      if (!active) return;
      if (timer !== undefined) clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (Number.isFinite(review.expiresAt) && review.expiresAt > current) {
        timer = setTimeout(refreshExpiry, Math.min(2_147_483_647, Math.max(1, Math.ceil(review.expiresAt - current))));
      }
    }
    function refreshWhenVisible() { if (document.visibilityState !== 'hidden') refreshExpiry(); }
    refreshExpiry();
    window.addEventListener('focus', refreshExpiry);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('focus', refreshExpiry);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [review.id, review.expiresAt]);

  useEffect(() => {
    const key = JSON.stringify([review.id, primaryFilter]);
    if (groupReviewKey.current === key) return;
    groupReviewKey.current = key;
    setFilter(initialGroup(review)); setPage(0); setContinueAutomatically(false);
  }, [review, primaryFilter]);
  useEffect(() => {
    if (currentAutomation?.status === 'stopped' || currentAutomation?.status === 'failed') setContinueAutomatically(true);
  }, [review.id, currentAutomation?.status]);

  useEffect(() => { if (reviewedList.current) reviewedList.current.scrollTop = 0; }, [review.id, filter, currentPage]);

  function canAct(): boolean {
    const current = Date.now();
    setNow(current);
    return !busy && !automationRunning && review.status !== 'expired' && Number.isFinite(review.expiresAt) && review.expiresAt > current;
  }

  function setSelected(ids: string[]) {
    if (!canAct()) return;
    setContinueAutomatically(false);
    setSelection({ reviewId: review.id, ids: new Set(ids), manualIds: new Set() });
  }

  function toggle(item: InboxAssistantReviewItem) {
    if (!canAct() || !canSelectItem(item, review)) return;
    setContinueAutomatically(false);
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
    setContinueAutomatically(false);
    const next = new Set(selected.map(item => item.id));
    const nextManual = new Set(manualIds);
    for (const item of shown.filter(item => canSelectItem(item, review))) {
      next.add(item.id);
      if (!selectable(item, review)) nextManual.add(item.id);
    }
    setSelection({ reviewId: review.id, ids: next, manualIds: nextManual });
  }

  return (
    <section aria-labelledby={headingId} className="assistant-surface assistant-review min-w-0 overflow-clip rounded-xl border border-border bg-background">
      <div className="assistant-review-header">
        <div className="assistant-review-heading">
          <div className="min-w-0">
            <h3 id={headingId} className="assistant-review-title">{scoped ? `Mark matching mail as ${actionLabel}` : review.kind === 'uncategorized' ? 'Uncategorized mail review' : 'Unread mail review'}</h3>
            <p className="assistant-review-subtitle">{count(review.items.length, 'conversation')} · {count(review.items.reduce((sum, item) => sum + (scoped ? item.targetEmailIds?.length ?? 0 : item.unreadCount), 0), scoped ? 'matching email' : 'unread email')}</p>
            {review.scope && <p className="mt-1 break-words text-xs text-muted-foreground">{review.scope.field === 'any' ? 'Matching' : `${review.scope.field.charAt(0).toUpperCase()}${review.scope.field.slice(1)} matches`}: {review.scope.query}</p>}
          </div>
          <button type="button" onClick={() => { if (!busy && !automationRunning) onRefresh(); }} disabled={busy || automationRunning} className="assistant-review-button assistant-review-quiet">
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Refresh review
          </button>
        </div>

        {automaticReviewSupported && currentAutomation && <div aria-label="Automatic unread review" className="assistant-review-workflow">
          <div role="status" aria-live="polite" className="assistant-review-progress">
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium">{automationRunning ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}<span>{automationLabels[currentAutomation.status]}</span></div>
            <p className="text-xs text-muted-foreground">{count(currentAutomation.batchesReviewed, 'batch', 'batches')} reviewed · {count(currentAutomation.reviewedConversations, 'conversation')} reviewed</p>
            <p className="text-xs text-muted-foreground">{count(currentAutomation.markedEmails, 'email')} marked as read{currentAutomation.queuedEmails > 0 && ` · ${count(currentAutomation.queuedEmails, 'email')} queued for sync`}</p>
            {currentAutomation.reason && <p className={`text-xs leading-5 ${currentAutomation.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{currentAutomation.reason}</p>}
            {automationCompleted && <p className="text-xs text-muted-foreground">Refresh review to check for newly arrived mail.</p>}
          </div>
        </div>}
        {needsRetry > 0 && <div role="status" className="assistant-review-notice"><div><p className="text-sm font-medium">{count(needsRetry, 'conversation')} still {needsRetry === 1 ? 'needs' : 'need'} classification</p><p className="mt-1 text-xs leading-5 text-muted-foreground">The AI response was incomplete. These conversations stay unread and will be retried when you continue.</p></div><button type="button" className="assistant-review-button" disabled={locked || !onContinue} onClick={() => { if (canAct()) onContinue?.(); }}><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Retry incomplete review</button></div>}
        {(hasCoverageNotes || (automaticReviewSupported && (onStartAutoReview || currentAutomation))) && <details className="assistant-review-coverage">
          <summary>Review details<ChevronDown aria-hidden="true" className="h-3 w-3" /></summary>
          <div className="assistant-review-coverage-content">
            {hasCoverageNotes && <div><h4>Review coverage and limits</h4><ul className="mt-2 space-y-2 [overflow-wrap:anywhere]">
              {review.coverage.map(account => <li key={account.accountId}>
                <span className="font-medium text-foreground">{account.email}</span>
                <p>{account.status === 'unavailable' ? 'Account unavailable; its mail was not reviewed.' : `${count(account.reviewedThreads, 'conversation')} reviewed`}{account.hasMore ? ' · More conversations remain.' : ''}</p>
                {(account.cachedRecommendations !== undefined || account.aiReviewedThreads !== undefined) && <p>{[account.cachedRecommendations !== undefined ? count(account.cachedRecommendations, 'cached recommendation') : undefined, account.aiReviewedThreads !== undefined ? `${count(account.aiReviewedThreads, 'conversation')} newly reviewed by AI` : undefined].filter(Boolean).join(' · ')}</p>}
                {account.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
              </li>)}
              {review.truncated && <li>This review covers a limited batch of conversations.</li>}
            </ul></div>}
            {automaticReviewSupported && (onStartAutoReview || currentAutomation) && <div><h4>How continuous review works</h4><p>Only recommended mail is marked as read. Important and uncertain mail stays unread. Nothing is archived or deleted.</p><p>Up to {currentAutomation?.maxBatches ?? 10} batches and {currentAutomation?.maxAICalls ?? 20} AI classification calls per run.</p><p>You can stop at any time. A paused run keeps its progress.</p></div>}
            {currentAutomation && <div><h4>Run results</h4><p>{count(currentAutomation.markedConversations, 'conversation')} marked as read · {count(currentAutomation.markedEmails, 'email')} marked as read</p>{currentAutomation.queuedEmails > 0 && <p>{count(currentAutomation.queuedEmails, 'email')} queued for sync; server changes are not confirmed yet.</p>}</div>}
          </div>
        </details>}
        <div aria-label="Filter recommendations" className="assistant-review-filters">
          {visibleFilters.map(value => <button key={value.value} type="button" aria-pressed={filter === value.value} onClick={() => { setFilter(value.value); setPage(0); }} className="assistant-review-filter">
            {value.label} <span className="ml-1 tabular-nums text-muted-foreground">{review.items.filter(item => item.recommendation === value.value).length}</span>
          </button>)}
        </div>
        {filter !== primaryFilter && !scoped && <p className="assistant-review-group-description">{expired ? 'Refresh this review to select conversations.' : `${filter === 'keep_unread' ? 'These conversations stay unread.' : 'These conversations need your attention and stay unread.'} You can select mail to mark as read, archive or delete. Read changes against the agent’s recommendation require confirmation.`}</p>}
        <div aria-label="Select reviewed conversations" className="assistant-review-selection-tools">
          <button type="button" onClick={() => setSelected(eligible.map(item => item.id))} disabled={locked || eligible.length === 0} className="assistant-review-text-button">Select recommended</button>
          <button type="button" onClick={selectGroup} disabled={locked || !shown.some(item => canSelectItem(item, review))} className="assistant-review-text-button">Select this group</button>
          <button type="button" onClick={() => setSelected([])} disabled={locked || selected.length === 0} className="assistant-review-text-button">Clear selection</button>
        </div>
      </div>

      <div ref={reviewedList} role="region" aria-label="Reviewed conversations" tabIndex={0} className="assistant-review-list border-t border-border"><ul className="divide-y divide-border">
        {visibleItems.map(item => {
          const canSelect = canSelectItem(item, review);
          const needsContentReview = !exactFlagTargets(item, review);
          const selectedItem = selected.some(value => value.id === item.id);
          const itemUndoable = undoable.some(value => value.id === item.id);
          const keptUnread = item.status === 'pending' && item.recommendation === 'keep_unread' && review.kind !== 'mark_unread';
          const hasProtection = item.protectedReasons.length > 0 || (needsContentReview && (item.bodyUnavailable || item.attachmentsUnknown)) || ((item.recommendation === 'mark_read' || item.recommendation === 'mark_unread') && item.confidence < 0.9);
          const compactProtection = item.protectedReasons.length > 1 && item.reason === item.protectedReasons.join(' ');
          return <li key={item.id} data-selected={selectedItem} className="assistant-review-item min-w-0">
            <label className="assistant-review-select-target"><input type="checkbox" checked={selectedItem} disabled={locked || !canSelect} onChange={() => toggle(item)} aria-label={`Select conversation: ${item.subject || '(No subject)'} (${item.accountEmail})`} className="assistant-review-checkbox h-4 w-4 accent-primary disabled:opacity-40" /></label>
            <div className="assistant-review-item-content">
              <div className="assistant-review-item-heading">
                <button type="button" onClick={() => onOpen(sourceFor(item))} aria-label={`Open conversation: ${item.subject || '(No subject)'} (${item.accountEmail})`} title={item.subject || '(No subject)'} className="assistant-review-subject">{item.subject || '(No subject)'}</button>
                {item.status !== 'pending' && <span className={`assistant-review-status ${item.status === 'failed' ? 'text-destructive' : item.status === 'applied' || item.status === 'undone' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                  {item.status === 'applied' && <CheckCircle2 aria-hidden="true" className="h-3 w-3" />}{item.status === 'queued' && <Clock3 aria-hidden="true" className="h-3 w-3" />}{reviewStatusLabel(item, review)}
                </span>}
              </div>
              <p title={item.from} className="assistant-review-sender">{item.from}</p>
              <p className="assistant-review-reason">{compactProtection ? <>{item.protectedReasons[0]} <span className="text-muted-foreground">{item.protectedReasons.length - 1} more {item.protectedReasons.length === 2 ? 'reason' : 'reasons'} in Details</span></> : item.reason}</p>
              <div className="assistant-review-item-tools">
                <details className="assistant-review-item-details">
                  <summary aria-label={`Review details: ${item.subject || '(No subject)'} (${item.accountEmail})`}>Details<ChevronDown aria-hidden="true" className="h-3 w-3" /></summary>
                  <div className="assistant-review-item-detail-content">
                    {item.status === 'pending' && <p className={keptUnread ? 'text-emerald-600 dark:text-emerald-400' : 'font-medium'}>{reviewStatusLabel(item, review)}</p>}
                    <p>{item.accountEmail} · {sourceDate(item.date)}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>{count(item.unreadCount, 'unread email')} of {count(item.messageCount, 'email')}</span>
                      {scoped && <span>{count(item.targetEmailIds?.length ?? 0, 'matching email')} to mark {actionLabel}</span>}
                      <span>{item.protectedReasons.length > 0 && item.confidence === 0 ? 'Protected by review rules' : Number.isFinite(item.confidence) ? `${Math.round(Math.max(0, Math.min(1, item.confidence)) * 100)}% confidence` : 'Confidence unavailable'}</span>
                    </div>
                    {(item.uncategorized || item.categories.length > 0) && <div className="flex flex-wrap gap-1.5">{item.uncategorized && <span className="assistant-review-category">Uncategorized</span>}{item.categories.map(category => <span key={category} className="assistant-review-category">{category.replace(/_/g, ' ')}</span>)}</div>}
                    {hasProtection && <ul aria-label="Reasons kept for review" className="space-y-1">
                      {item.protectedReasons.map((reason, index) => <li key={index}>{reason}</li>)}
                      {needsContentReview && item.bodyUnavailable && <li>Message content is unavailable.</li>}
                      {needsContentReview && item.attachmentsUnknown && <li>Attachments need review.</li>}
                      {(item.recommendation === 'mark_read' || item.recommendation === 'mark_unread') && item.confidence < 0.9 && <li>Confidence is below the threshold for changing read status.</li>}
                    </ul>}
                  </div>
                </details>
                {itemUndoable && <button type="button" disabled={locked} onClick={() => { if (canAct() && itemUndoable) onUndo([item.id]); }} aria-label={`Undo marked ${actionLabel}: ${item.subject || '(No subject)'} (${item.accountEmail})`} className="assistant-review-text-button"><Undo2 aria-hidden="true" className="h-3.5 w-3.5" />Undo</button>}
              </div>
            </div>
          </li>;
        })}
        {shown.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No conversations in this group.</li>}
      </ul></div>

      {shown.length > pageSize && <nav aria-label="Reviewed conversation pages" className="assistant-review-pagination"><p>{currentPage * pageSize + 1}–{Math.min(shown.length, (currentPage + 1) * pageSize)} of {shown.length} conversations</p><div className="flex gap-1"><button type="button" aria-label="Previous reviewed conversations" className="assistant-review-button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button><button type="button" aria-label="Next reviewed conversations" className="assistant-review-button" disabled={(currentPage + 1) * pageSize >= shown.length} onClick={() => setPage(currentPage + 1)}><ChevronRight aria-hidden="true" className="h-4 w-4" /></button></div></nav>}
      {!automationRunning && <div role="group" aria-label="Review actions" className="assistant-review-footer border-t border-border bg-card">
        <div className="assistant-review-selection"><p aria-live="polite" className="text-xs font-medium">{count(selected.length, 'conversation')} selected · {count(selectedTargetCount, selectedTargetLabel)}{scoped ? ` to mark ${actionLabel}` : ''}{selectedElsewhere > 0 && <span className="text-muted-foreground"> · {selectedElsewhere} in other groups</span>}</p>
            {!continuous && review.coverage.some(account => account.hasMore) && <button type="button" disabled={locked || !onContinue} onClick={() => { if (canAct()) onContinue?.(); }} className="assistant-review-text-button">Review next batch<ChevronRight aria-hidden="true" className="h-3.5 w-3.5" /></button>}
          {undoable.length > 1 && <button type="button" disabled={locked} onClick={() => { if (canAct()) onUndo(undoable.map(item => item.id)); }} className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"><Undo2 aria-hidden="true" className="h-3 w-3" />Undo {count(undoable.length, 'conversation')}</button>}
        </div>
        {expired && <div role="status" className="assistant-review-notice"><p className="text-xs leading-5">This review has expired. Refresh it before changing mail.</p><button type="button" disabled={busy || automationRunning} onClick={() => { if (!busy && !automationRunning) onRefresh(); }} className="assistant-review-button"><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Refresh review</button></div>}
        {canMove && <details className="text-xs leading-5 text-muted-foreground"><summary className="cursor-pointer">Archive and Delete affect whole conversations</summary><p className="pt-1">Archive and Delete apply to all {count(selectedMessageCount, 'email')} in these conversations. Delete moves them to Trash.</p></details>}
        {canMarkRead && overrides.length > 0 && <p className="text-xs leading-5 text-muted-foreground">{count(overrides.length, 'selection')} {overrides.length === 1 ? 'overrides' : 'override'} the agent’s recommendation. Confirmation required to mark as {actionLabel}.</p>}

        <div className="assistant-review-action-row">
          <div className="assistant-review-primary-group">
            {automaticReviewSupported && onStartAutoReview && !automationCompleted && <label className="assistant-review-continuous" title={continuousHelp}><input type="checkbox" aria-label="Continue automatically" aria-describedby={continuousHelpId} checked={continuous} disabled={busy} onChange={event => { if (busy) return; setNow(Date.now()); setContinueAutomatically(event.target.checked); if (event.target.checked) setSelection({ reviewId: review.id, ids: new Set(eligible.map(item => item.id)), manualIds: new Set() }); }} className="assistant-review-checkbox h-4 w-4 accent-primary" /><span className="text-xs font-medium">Continue automatically</span><span id={continuousHelpId} className="sr-only">{continuousHelp}</span></label>}

            {continuous ? <button type="button" disabled={locked || !canStartAutoReview} onClick={() => { if (canAct() && canStartAutoReview) onStartAutoReview?.(); }} className="assistant-review-button assistant-primary-action bg-primary text-primary-foreground"><Play aria-hidden="true" className="h-3.5 w-3.5" />{automationStartLabel}</button>
              : <button type="button" disabled={locked || !canMarkRead} onClick={() => { if (canAct() && canMarkRead) { const ids = selected.map(item => item.id); if (overrides.length) onApply(ids, true); else onApply(ids); } }} className="assistant-review-button assistant-primary-action bg-primary text-primary-foreground">Mark selected as {actionLabel}</button>}
          </div>
          <div className="assistant-review-secondary">
            <button type="button" aria-label="Archive selected conversations" disabled={locked || !canMove} onClick={() => { if (canAct() && canMove) onApply(selected.map(item => item.id), true, 'archive'); }} className="assistant-review-button"><Archive aria-hidden="true" className="h-3.5 w-3.5" />Archive</button>
            <button type="button" aria-label="Move selected conversations to Trash" disabled={locked || !canMove} onClick={() => { if (canAct() && canMove) onApply(selected.map(item => item.id), true, 'trash'); }} className="assistant-review-button text-destructive dark:text-red-300"><Trash2 aria-hidden="true" className="h-3.5 w-3.5" />Delete</button>
          </div>
        </div>
      </div>}
    </section>
  );
}
