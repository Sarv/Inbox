import { Activity, AlertCircle, ArrowUp, Bot, Check, ChevronDown, Circle, FileText, Inbox, ListFilter, Loader2, Mail, MailCheck, MailPlus, Menu, Pencil, Plus, RotateCcw, Search, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import '../../styles/assistant-theme.css';

import { requestConfirm } from '../../store/confirm-service';
import type {
  InboxAssistantAccount,
  InboxAssistantActionMode,
  InboxAssistantAccountCoverage,
  InboxAssistantActivity,
  InboxAssistantChat,
  InboxAssistantChatSummary,
  InboxAssistantDraft,
  InboxAssistantExchange,
  InboxAssistantSource,
} from '../../types/inbox-assistant';
import type { InboxAssistantReviewAction, InboxAssistantReviewKind } from '../../types/inbox-assistant-actions';
import { AccountSelectorTrigger } from '../AccountSelectorTrigger';

import { AssistantReviewCard } from './AssistantReviewCard';
import { ChatSidebar } from './ChatSidebar';

export interface InboxAssistantViewState {
  chatId: string | null;
  title: string;
  requestId: string | null;
  running: boolean;
  status: string;
}

export interface InboxAssistantProps {
  onNavigateToSource?: (source: InboxAssistantSource) => void;
  sourcePane?: ReactNode;
  onCloseSourcePane?: () => void;
  onOpenDraft?: (draft: InboxAssistantDraft) => void;
  defaultDraftAccountId?: string;
  onMailChanged?: () => void;
  compact?: boolean;
  visible?: boolean;
  onStateChange?: (state: InboxAssistantViewState) => void;
}

const starterQuestions = [
  'What quote did I send to TCS?',
  'Find the latest quotation I sent and any revisions.',
  'What did I agree with this customer?',
];
const starterActions = [
  { title: 'Review unread', description: 'Find low-value mail to mark as read.', question: 'Review my unread emails and mark low-value conversations as read.', Icon: MailCheck },
  { title: 'Check uncategorized', description: 'Include mail the categorization process missed.', question: 'Review my uncategorized unread emails.', Icon: ListFilter },
  { title: 'Find an answer', description: 'Search emails and attachments across accounts.', question: 'What quote did I send to TCS?', Icon: Search },
  { title: 'Find what needs a reply', description: 'Locate customer requests and open conversations.', question: 'Which recent customer emails need a response?', Icon: Inbox },
];

function formatDate(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Date unavailable';
}

function Coverage({ accounts }: { accounts: InboxAssistantAccountCoverage[] }) {
  if (accounts.length === 0) return null;
  return (
    <section aria-label="Search coverage" className="border-t border-border pt-4 text-xs">
      <h4 className="font-medium">Search coverage · {accounts.filter(account => account.status === 'searched').length} of {accounts.length} accounts searched</h4>
      <ul className="mt-3 space-y-3">
        {accounts.map(account => (
          <li key={account.accountId} className="space-y-1">
            <p className="font-medium text-foreground">{account.email}</p>
            <p className="text-muted-foreground">
              {account.status === 'unavailable'
                ? 'Account unavailable — its emails were not reviewed.'
                : `${account.reviewedMessages} of ${account.matchedMessages} matching messages reviewed · ${account.attachmentsRead} attachments read`}
            </p>
            {account.missingBodies > 0 && <p>{account.missingBodies} message bodies were unavailable.</p>}
            {account.attachmentsSkipped > 0 && <p>{account.attachmentsSkipped} attachments could not be read or were outside supported limits.</p>}
            {account.truncated && <p>Search limits were reached. Narrow your question to review more relevant results.</p>}
            {account.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function coverageWarnings(exchange: InboxAssistantExchange): string[] {
  const warnings = [...exchange.answer.warnings];
  for (const account of exchange.answer.coverage) {
    if (account.status === 'unavailable') warnings.push(`${account.email} could not be searched.`);
    if (account.missingBodies > 0) warnings.push(`${account.email}: ${account.missingBodies} message bodies were unavailable.`);
    if (account.attachmentsSkipped > 0) warnings.push(`${account.email}: ${account.attachmentsSkipped} attachments were not read.`);
    if (account.truncated) warnings.push(`${account.email}: search limits were reached. Narrow the question for more complete results.`);
  }
  return [...new Set(warnings)];
}

interface WorkInspection {
  kind?: 'question' | 'draft' | 'action';
  question: string;
  activities: InboxAssistantActivity[];
  status: 'running' | 'stopping' | 'done' | 'cancelled' | 'error';
  coverage: InboxAssistantAccountCoverage[];
  warnings: string[];
  error?: string;
}

function ActivitySidebar({ inspection, accounts, onClose, compact, visible, stopButton }: { inspection: WorkInspection; accounts: InboxAssistantAccount[]; onClose: () => void; compact: boolean; visible: boolean; stopButton?: ReactNode }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const timelineEnd = useRef<HTMLDivElement>(null);
  const initiallyVisible = useRef(visible);
  useEffect(() => { if (initiallyVisible.current) closeButton.current?.focus(); }, []);
  useEffect(() => {
    if (visible && inspection.status === 'running') timelineEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [inspection.status, inspection.activities.length, visible]);
  const status = inspection.status === 'running' ? 'In progress' : inspection.status === 'stopping' ? 'Stopping…' : inspection.status === 'cancelled' ? 'Stopped' : inspection.status === 'error' ? 'Failed' : 'Completed';
  return (
    <aside id="assistant-activity-panel" aria-labelledby="assistant-activity-heading" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }} className={`assistant-surface bottom-0 right-0 top-0 z-40 flex shrink-0 flex-col border-l border-border bg-background shadow-xl ${compact ? 'absolute w-full max-w-sm' : 'fixed w-[min(24rem,100vw)] lg:static lg:z-auto lg:h-full lg:min-h-0 lg:w-72 lg:shadow-none 2xl:w-80'}`}>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h3 id="assistant-activity-heading" className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4" />Activity</h3>
        <div className="flex items-center gap-2">{stopButton}<button ref={closeButton} type="button" onClick={onClose} aria-label="Close activity" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button></div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto p-4 [overflow-wrap:anywhere]">
        <div className="space-y-2">
          <p className="whitespace-pre-wrap break-words text-sm font-medium">{inspection.question}</p>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">{inspection.status === 'running' && <Loader2 className="h-3 w-3 animate-spin" />}{status}</p>
        </div>
        {inspection.activities.length > 0 ? (
          <ol aria-label="Work timeline" className="space-y-4">
            {inspection.activities.map((activity, index) => {
              const current = inspection.status === 'running' && index === inspection.activities.length - 1;
              const Icon = activity.status === 'warning' ? AlertCircle : current ? Loader2 : activity.status === 'done' ? Check : Circle;
              const accountEmail = accounts.find(account => account.id === activity.accountId)?.email;
              return (
                <li key={`${activity.requestId}:${activity.sequence}`} className="flex items-start gap-3">
                  <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${current && activity.status !== 'warning' ? 'animate-spin' : ''} ${activity.status === 'warning' ? 'text-amber-600' : 'text-muted-foreground'}`} />
                  <div className="min-w-0 space-y-1">
                    <p className="break-words text-xs font-medium">{activity.message}</p>
                    {activity.detail && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{activity.detail}</p>}
                    {accountEmail && <p className="break-words text-xs text-muted-foreground">{accountEmail}</p>}
                    {activity.filename && !activity.detail?.includes(activity.filename) && <p className="break-words text-xs text-muted-foreground">{activity.filename}</p>}
                    <time className="block text-[11px] text-muted-foreground">{new Date(activity.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : <p className="text-xs text-muted-foreground">{inspection.status === 'running' ? 'Preparing the search…' : 'No detailed activity was recorded for this answer.'}</p>}
        <div ref={timelineEnd} />
        {inspection.error && <p className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{inspection.error}</p>}
        {inspection.warnings.length > 0 && (
          <section aria-label="Search limitations" className="space-y-2 border-t border-border pt-4">
            <h4 className="flex items-center gap-2 text-xs font-medium"><AlertCircle className="h-3.5 w-3.5 text-amber-600" />Notes and limitations</h4>
            <ul className="list-disc space-y-2 pl-4 text-xs text-muted-foreground">{inspection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </section>
        )}
        <Coverage accounts={inspection.coverage} />
      </div>
    </aside>
  );
}

function SourceCard({ source, onNavigate }: {
  source: InboxAssistantSource;
  onNavigate?: (source: InboxAssistantSource) => void;
}) {
  const Icon = source.kind === 'attachment' ? FileText : Mail;
  return (
    <button
      type="button"
      onClick={() => onNavigate?.(source)}
      disabled={!onNavigate}
      aria-label={`Open source ${source.id}: ${source.filename ?? source.subject}`}
      className="assistant-surface min-w-0 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-background"
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 px-1 text-xs text-primary">{source.id}</span>
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{source.filename ?? source.subject ?? '(No subject)'}</span>
      </span>
      {source.filename && <span className="mt-2 block truncate text-xs font-medium">{source.subject || '(No subject)'}</span>}
      <span className="mt-2 block break-words text-xs text-muted-foreground">{source.accountEmail} · {source.folder || (source.sent ? 'Sent' : 'Mail')} · {formatDate(source.date * 1000)}</span>
      <span className="mt-1 block truncate text-xs text-muted-foreground">{source.sent ? `To: ${source.to.join(', ')}` : `From: ${source.from}`}</span>
      {source.location && <span className="mt-1 block text-xs text-muted-foreground">{source.location}</span>}
      {source.excerpt && <span className="mt-2 line-clamp-3 block whitespace-pre-wrap break-words text-xs text-muted-foreground">{source.excerpt}</span>}
    </button>
  );
}

function AnswerText({ text, sources, onNavigate }: {
  text: string;
  sources: InboxAssistantSource[];
  onNavigate?: (source: InboxAssistantSource) => void;
}) {
  return <>{text.split(/(\[S\d+\])/g).map((part, index) => {
    const source = /^\[S\d+\]$/.test(part) ? sources.find(item => `[${item.id}]` === part) : undefined;
    return source && onNavigate
      ? <button key={index} type="button" onClick={() => onNavigate(source)} aria-label={`Open citation ${source.id}`} className="mx-0.5 rounded bg-primary/10 px-1 text-xs font-medium text-primary hover:bg-primary/20">{part}</button>
      : <span key={index}>{part}</span>;
  })}</>;
}

interface UserMessageProps {
  question: string;
  date?: number;
  onEdit?: () => void;
  editValue?: string;
  onEditChange?: (value: string) => void;
  onCancelEdit?: () => void;
  onSaveEdit?: () => void;
  disabled?: boolean;
  visible?: boolean;
}

function UserMessage({ question, date, onEdit, editValue, onEditChange, onCancelEdit, onSaveEdit, disabled, visible = true }: UserMessageProps) {
  if (editValue !== undefined) return <form aria-label={`Edit question: ${question}`} onSubmit={event => { event.preventDefault(); onSaveEdit?.(); }} className="assistant-surface ml-auto w-full max-w-3xl space-y-3 rounded-2xl border border-border bg-muted/30 p-4">
    <label className="sr-only" htmlFor="assistant-edit-question">Edit question</label>
    <textarea autoFocus={visible} id="assistant-edit-question" aria-label="Edit question" value={editValue} onChange={event => onEditChange?.(event.target.value)} disabled={disabled} maxLength={4000} rows={3} className="max-h-60 min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50" />
    <p className="text-xs text-muted-foreground">This question and its later answers will be removed so you can send an edited question. You can restore the previous conversation. Mail changes already made will remain.</p>
    <div className="flex justify-end gap-2"><button type="button" disabled={disabled} onClick={onCancelEdit} className="rounded-lg px-3 py-2 text-xs hover:bg-accent disabled:opacity-50">Cancel edit</button><button type="submit" disabled={disabled || !editValue.trim()} className="assistant-primary-action rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">{disabled ? 'Rewinding…' : 'Save and rewind'}</button></div>
  </form>;
  return <div className="group flex items-start justify-end gap-1"><div className="assistant-user-message max-w-[90%] rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3">
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{question}</p>
    {date && <p className="mt-1 text-right text-[11px] text-muted-foreground">{formatDate(date)}</p>}
  </div>{onEdit && <button type="button" onClick={onEdit} disabled={disabled} aria-label={`Edit question: ${question}`} title="Edit question" className="shrink-0 rounded-lg p-2 text-muted-foreground opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 disabled:opacity-30 md:opacity-0 md:group-hover:opacity-100"><Pencil className="h-3.5 w-3.5" /></button>}</div>;
}

function Answer({ exchange, onNavigateToSource, onViewActivity, activityExpanded, actionBusy, onApply, onUndo, onRefresh, onContinue, userMessage, compact }: {
  exchange: InboxAssistantExchange;
  onNavigateToSource?: InboxAssistantProps['onNavigateToSource'];
  onViewActivity: (exchangeId: string, trigger: HTMLButtonElement) => void;
  activityExpanded: boolean;
  actionBusy: boolean;
  onApply: (ids: string[], manualSelection?: boolean, action?: InboxAssistantReviewAction) => void;
  onUndo: (ids: string[]) => void;
  onRefresh: () => void;
  onContinue: () => void;
  userMessage: Omit<UserMessageProps, 'question' | 'date'>;
  compact: boolean;
}) {
  return (
    <article className="space-y-5" aria-label={`Answer to ${exchange.question}`}>
      <UserMessage question={exchange.question} date={exchange.createdAt} {...userMessage} />
      <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-2 font-medium text-foreground"><Bot className="h-4 w-4 text-primary" />Inbox Agent</span>
            <button type="button" onClick={event => onViewActivity(exchange.id, event.currentTarget)} aria-label={`View activity for ${exchange.question}`} aria-expanded={activityExpanded} aria-controls="assistant-activity-panel" className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"><Activity className="h-3 w-3" />View activity</button>
          </div>
      {/* Mail and model output are untrusted text. Never interpret HTML here. */}
      <div className={`whitespace-pre-wrap break-words text-sm ${compact ? 'leading-6' : 'leading-7'}`}><AnswerText text={exchange.answer.text} sources={exchange.answer.sources} onNavigate={onNavigateToSource} /></div>
      {exchange.review && <AssistantReviewCard review={exchange.review} busy={actionBusy} onApply={onApply} onUndo={onUndo} onRefresh={onRefresh} onContinue={onContinue} onOpen={source => onNavigateToSource?.(source)} />}
      {exchange.answer.sources.length > 0 && (
        <details aria-label="Answer sources" className="assistant-surface rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Sources · {exchange.answer.sources.length}</summary>
          <div className={`mt-3 grid grid-cols-1 gap-3 ${compact ? '' : '2xl:grid-cols-2'}`}>
            {exchange.answer.sources.map(source => <SourceCard key={`${source.accountId}:${source.id}`} source={source} onNavigate={onNavigateToSource} />)}
          </div>
        </details>
      )}
      </div>
    </article>
  );
}

function chatSummary(chat: InboxAssistantChat): InboxAssistantChatSummary {
  const { exchanges: _exchanges, ...summary } = chat;
  return summary;
}

function updateSummary(chats: InboxAssistantChatSummary[], summary: InboxAssistantChatSummary): InboxAssistantChatSummary[] {
  return [...chats.filter(chat => chat.id !== summary.id), summary].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function InboxAssistant({ onNavigateToSource, sourcePane, onCloseSourcePane, onOpenDraft, defaultDraftAccountId, onMailChanged, compact = false, visible = true, onStateChange }: InboxAssistantProps) {
  const [accounts, setAccounts] = useState<InboxAssistantAccount[]>([]);
  const [chats, setChats] = useState<InboxAssistantChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<InboxAssistantChat | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [exchanges, setExchanges] = useState<InboxAssistantExchange[]>([]);
  const [question, setQuestion] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [chatListOpen, setChatListOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [pendingChatIds, setPendingChatIds] = useState<ReadonlySet<string>>(new Set());
  const [deletePending, setDeletePending] = useState(false);
  const [chatListError, setChatListError] = useState<string | null>(null);
  const [draftFormOpen, setDraftFormOpen] = useState(false);
  const [draftAccountId, setDraftAccountId] = useState('');
  const [draftInstructions, setDraftInstructions] = useState('');
  const [draftCreating, setDraftCreating] = useState(false);
  const [actionCreating, setActionCreating] = useState(false);
  const [stoppingRequestId, setStoppingRequestId] = useState<string | null>(null);
  const [stopFailed, setStopFailed] = useState(false);
  const [editingExchangeId, setEditingExchangeId] = useState<string | null>(null);
  const [editQuestion, setEditQuestion] = useState('');
  const [rewinding, setRewinding] = useState(false);
  const [modeSaving, setModeSaving] = useState(false);
  const [liveWork, setLiveWork] = useState<WorkInspection | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activitySelection, setActivitySelection] = useState('live');
  const generation = useRef(0);
  const metadataGeneration = useRef(0);
  const modeGeneration = useRef(0);
  const mounted = useRef(false);
  const visibleRef = useRef(visible);
  const stateListener = useRef(onStateChange);
  const activeChatRef = useRef<string | null>(null);
  const request = useRef<string | null>(null);
  const requestChatId = useRef<string | null>(null);
  const cancelledRequests = useRef(new Set<string>());
  const cancelPending = useRef(new Set<string>());
  const settledRequests = useRef(new Set<string>());
  const chatRevisions = useRef(new Map<string, number>());
  const activitySequence = useRef(0);
  const liveActivities = useRef<InboxAssistantActivity[]>([]);
  const drafts = useRef(new Map<string, { question: string; accountIds: string[] }>());
  const activityTrigger = useRef<HTMLButtonElement | null>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const accountPicker = useRef<HTMLDivElement>(null);
  const focusQuestionAfterRewind = useRef(false);
  const messages = useRef<HTMLDivElement>(null);
  const pendingChatMutations = useRef(new Set<string>());
  const pendingDeletion = useRef(false);
  useEffect(() => { visibleRef.current = visible; stateListener.current = onStateChange; }, [visible, onStateChange]);
  useEffect(() => {
    if (!accountPickerOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!accountPicker.current?.contains(event.target as Node)) setAccountPickerOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [accountPickerOpen]);

  const applyChat = useCallback((chat: InboxAssistantChat, knownAccounts: InboxAssistantAccount[]) => {
    activeChatRef.current = chat.id;
    setActiveChatId(chat.id);
    setActiveChat(chat);
    setExchanges(chat.exchanges);
    setChats(current => updateSummary(current, chatSummary(chat)));
    const draft = drafts.current.get(chat.id);
    const last = chat.exchanges[chat.exchanges.length - 1];
    const knownIds = new Set(knownAccounts.map(account => account.id));
    setQuestion(draft?.question ?? '');
    setSelectedAccountIds((draft?.accountIds ?? last?.accountIds ?? knownAccounts.map(account => account.id)).filter(id => knownIds.has(id)));
  }, []);

  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setLoadError(null);
    try {
      const api = window.electronAPI?.inboxAssistant;
      if (!api) throw new Error('Inbox Assistant is unavailable. Restart the app after updating.');
      const [accountResult, listResult] = await Promise.all([api.accounts(), api.chats()]);
      if (version !== generation.current) return;
      if (!accountResult.success) throw new Error(accountResult.error);
      if (!listResult.success) throw new Error(listResult.error);
      setAccounts(accountResult.data);
      setChats(listResult.data.chats);
      const targetId = listResult.data.chats.some(chat => chat.id === listResult.data.activeChatId)
        ? listResult.data.activeChatId : listResult.data.chats[0]?.id;
      activeChatRef.current = targetId ?? null;
      setActiveChatId(targetId ?? null);
      const chatResult = targetId ? await api.chat(targetId) : await api.createChat();
      if (version !== generation.current) return;
      if (!chatResult.success) throw new Error(chatResult.error);
      applyChat(chatResult.data, accountResult.data);
    } catch (cause) {
      if (version === generation.current) setLoadError(cause instanceof Error ? cause.message : 'Could not load Inbox Assistant.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [applyChat]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const unsubscribe = window.electronAPI?.inboxAssistant?.onActivity?.(activity => {
      if (!request.current || activity.requestId !== request.current
        || cancelledRequests.current.has(activity.requestId)
        || (activity.chatId !== undefined && activity.chatId !== activeChatRef.current)
        || !Number.isInteger(activity.sequence) || activity.sequence <= activitySequence.current) return;
      activitySequence.current = activity.sequence;
      liveActivities.current = [...liveActivities.current, activity].slice(-400);
      setLiveWork(current => current ? { ...current, activities: liveActivities.current } : current);
    });
    return () => {
      mounted.current = false;
      // The counter deliberately invalidates every outstanding request on unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      unsubscribe?.();
      if (request.current) void window.electronAPI?.inboxAssistant?.cancel(request.current).catch(() => {});
    };
  }, [load]);

  useEffect(() => { if (sourcePane) setActivityOpen(false); }, [sourcePane]);
  useEffect(() => {
    if (visible && !rewinding && focusQuestionAfterRewind.current) {
      focusQuestionAfterRewind.current = false;
      if (visibleRef.current) questionInput.current?.focus();
    }
  }, [rewinding, visible]);
  useEffect(() => {
    if (visible && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [activeChatId, chatLoading, exchanges.length, pendingQuestion, compact, visible]);
  useEffect(() => {
    if (!visible || !messages.current || typeof ResizeObserver === 'undefined') return;
    const pane = messages.current;
    const observer = new ResizeObserver(() => {
      if (request.current && visibleRef.current) pane.scrollTop = pane.scrollHeight;
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [visible]);

  const saveDraft = () => {
    if (activeChatId && !chatLoading) drafts.current.set(activeChatId, { question, accountIds: [...selectedAccountIds] });
  };
  const releaseRequest = (requestId: string) => {
    if (request.current !== requestId) return;
    request.current = null;
    requestChatId.current = null;
    if (!mounted.current) return;
    setStoppingRequestId(null);
    setStopFailed(false);
    setPendingQuestion(null);
    setDraftCreating(false);
    setActionCreating(false);
    setLiveWork(current => current?.status === 'stopping' ? { ...current, status: 'cancelled' } : current);
  };
  const finishRequest = (requestId: string) => {
    settledRequests.current.add(requestId);
    if (!cancelPending.current.has(requestId)) releaseRequest(requestId);
  };
  const stop = () => {
    generation.current++;
    const requestId = request.current;
    if (!requestId) return;
    cancelledRequests.current.add(requestId);
    setPendingQuestion(null);
    setDraftCreating(false);
    setActionCreating(false);
    setStoppingRequestId(requestId);
    setLiveWork(current => current ? { ...current, status: 'stopping' } : current);
    if (cancelPending.current.has(requestId)) return;
    const originChatId = requestChatId.current;
    cancelPending.current.add(requestId);
    setStopFailed(false);
    if (activeChatRef.current === originChatId) setError(null);
    void window.electronAPI.inboxAssistant.cancel(requestId).then(result => {
      if (!result.success) throw new Error(result.error);
      if (result.data.requestId !== requestId) throw new Error('The stop acknowledgement belongs to a different request.');
      releaseRequest(requestId);
    }).catch(cause => {
      if (!mounted.current || request.current !== requestId) return;
      if (settledRequests.current.has(requestId)) { releaseRequest(requestId); return; }
      setStopFailed(true);
      if (activeChatRef.current === originChatId) setError(cause instanceof Error ? cause.message : 'Could not confirm the request stopped. Try Stop again.');
    }).finally(() => cancelPending.current.delete(requestId));
  };
  const resetChatView = () => {
    modeGeneration.current++;
    setModeSaving(false);
    setExchanges([]);
    setActiveChat(null);
    setQuestion('');
    setSelectedAccountIds(accounts.map(account => account.id));
    setLiveWork(null);
    setActivityOpen(false);
    setActivitySelection('live');
    setError(null);
    setChatError(null);
    setLoadError(null);
    setRenaming(false);
    setRenameSaving(false);
    setDraftFormOpen(false);
    setDraftInstructions('');
    setEditingExchangeId(null);
    setEditQuestion('');
    setRewinding(false);
    setAccountPickerOpen(false);
    setChatListOpen(false);
    liveActivities.current = [];
    onCloseSourcePane?.();
  };

  const selectChat = async (chatId: string, retry = false) => {
    if (!retry && activeChatRef.current === chatId) { setChatListOpen(false); return; }
    saveDraft();
    stop();
    const version = ++generation.current;
    activeChatRef.current = chatId;
    setActiveChatId(chatId);
    resetChatView();
    setCreating(false);
    setLoading(false);
    setChatLoading(true);
    try {
      const result = await window.electronAPI.inboxAssistant.chat(chatId);
      if (version !== generation.current) return;
      if (!result.success) throw new Error(result.error);
      applyChat(result.data, accounts);
    } catch (cause) {
      if (version === generation.current) setChatError(cause instanceof Error ? cause.message : 'Could not load this conversation.');
    } finally {
      if (version === generation.current) setChatLoading(false);
    }
  };

  const newChat = async () => {
    if (loading || creating) return;
    saveDraft();
    stop();
    const version = ++generation.current;
    metadataGeneration.current++;
    activeChatRef.current = null;
    setActiveChatId(null);
    resetChatView();
    setCreating(true);
    setChatLoading(true);
    try {
      const result = await window.electronAPI.inboxAssistant.createChat();
      if (version !== generation.current) return;
      if (!result.success) throw new Error(result.error);
      applyChat(result.data, accounts);
      if (visibleRef.current) questionInput.current?.focus();
    } catch (cause) {
      if (version === generation.current) setChatError(cause instanceof Error ? cause.message : 'Could not create a conversation.');
    } finally {
      if (version === generation.current) { setCreating(false); setChatLoading(false); }
    }
  };

  const refreshSummaries = async () => {
    const version = ++metadataGeneration.current;
    try {
      const result = await window.electronAPI.inboxAssistant.chats();
      if (mounted.current && version === metadataGeneration.current && result.success) setChats(result.data.chats);
    } catch { /* The active answer remains usable if the summary refresh fails. */ }
  };

  const rewindChat = async (exchange: InboxAssistantExchange) => {
    const chatId = activeChatRef.current;
    const text = editQuestion.trim();
    if (!chatId || !text || request.current || rewinding) return;
    const version = ++generation.current;
    metadataGeneration.current++;
    setRewinding(true);
    setError(null);
    try {
      const result = await window.electronAPI.inboxAssistant.rewindChat({ chatId, exchangeId: exchange.id });
      if (!mounted.current || version !== generation.current || activeChatRef.current !== chatId) return;
      if (!result.success) throw new Error(result.error);
      if (result.data.chat.id !== chatId) throw new Error('The conversation rewind belongs to a different chat.');
      chatRevisions.current.set(chatId, (chatRevisions.current.get(chatId) ?? 0) + 1);
      drafts.current.set(chatId, { question: text, accountIds: result.data.accountIds });
      applyChat(result.data.chat, accounts);
      setLiveWork(null);
      setActivityOpen(false);
      setActivitySelection('live');
      setEditingExchangeId(null);
      setEditQuestion('');
      setDraftFormOpen(false);
      onCloseSourcePane?.();
      focusQuestionAfterRewind.current = true;
    } catch (cause) {
      if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : 'Could not rewind this conversation.');
    } finally {
      if (mounted.current && version === generation.current) setRewinding(false);
    }
  };

  const restoreRewind = async () => {
    const chatId = activeChatRef.current;
    if (!chatId || request.current || rewinding) return;
    const version = ++generation.current;
    metadataGeneration.current++;
    setRewinding(true);
    setError(null);
    try {
      const result = await window.electronAPI.inboxAssistant.restoreRewindChat({ chatId });
      if (!mounted.current || version !== generation.current || activeChatRef.current !== chatId) return;
      if (!result.success) throw new Error(result.error);
      if (result.data.id !== chatId) throw new Error('The restored conversation belongs to a different chat.');
      chatRevisions.current.set(chatId, (chatRevisions.current.get(chatId) ?? 0) + 1);
      drafts.current.delete(chatId);
      applyChat(result.data, accounts);
      setLiveWork(null);
      setActivityOpen(false);
      setActivitySelection('live');
      setEditingExchangeId(null);
      setEditQuestion('');
      setDraftFormOpen(false);
      onCloseSourcePane?.();
    } catch (cause) {
      if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : 'Could not restore the previous conversation.');
    } finally {
      if (mounted.current && version === generation.current) setRewinding(false);
    }
  };

  const ask = async (event?: FormEvent, override?: { question: string; reviewKind?: InboxAssistantReviewKind; continueReviewId?: string; accountIds?: string[]; reviewOnly?: boolean }) => {
    event?.preventDefault();
    const text = (override?.question ?? question).trim();
    const chatId = activeChatRef.current;
    const accountIds = override?.accountIds ?? selectedAccountIds;
    if (!text || !chatId || accountIds.length === 0 || loading || chatLoading || creating || rewinding || editingExchangeId || request.current) return;
    const version = ++generation.current;
    const requestId = globalThis.crypto.randomUUID();
    const chatRevision = chatRevisions.current.get(chatId) ?? 0;
    request.current = requestId;
    requestChatId.current = chatId;
    activitySequence.current = 0;
    liveActivities.current = [];
    setLiveWork({ question: text, activities: [], status: 'running', coverage: [], warnings: [] });
    setActivitySelection('live');
    setPendingQuestion(text);
    setAccountPickerOpen(false);
    setError(null);
    try {
      const previous = exchanges[exchanges.length - 1];
      const result = await window.electronAPI.inboxAssistant.ask({
        requestId, chatId, question: text, accountIds: [...accountIds],
        ...(previous ? { previousExchangeId: previous.id } : {}),
        ...(override?.reviewKind ? { reviewKind: override.reviewKind } : {}),
        ...(override?.continueReviewId ? { continueReviewId: override.continueReviewId } : {}),
        ...(override?.reviewOnly ? { reviewOnly: true } : {}),
      });
      if (result.success && (!result.data.chatId || result.data.chatId === chatId) && result.data.reviewResult) {
        onMailChanged?.();
        if (mounted.current && activeChatRef.current === chatId && (chatRevisions.current.get(chatId) ?? 0) === chatRevision
          && cancelledRequests.current.has(requestId)) {
          setExchanges(current => [...current.filter(exchange => exchange.id !== result.data.id), result.data]);
          setLiveWork(current => (current?.status === 'cancelled' || current?.status === 'stopping') && current.question === text ? { ...current, kind: 'action' } : current);
          void refreshSummaries();
        }
      }
      if (version !== generation.current || activeChatRef.current !== chatId) return;
      if (!result.success) throw new Error(result.error);
      if (result.data.chatId && result.data.chatId !== chatId) throw new Error('The answer belongs to a different conversation.');
      const completed = { ...result.data, activities: result.data.activities ?? liveActivities.current };
      setExchanges(current => [...current.filter(exchange => exchange.id !== completed.id), completed]);
      setLiveWork(null);
      setActivitySelection(current => current === 'live' ? completed.id : current);
      setQuestion('');
      drafts.current.set(chatId, { question: '', accountIds: [...selectedAccountIds] });
      void refreshSummaries();
    } catch (cause) {
      if (version === generation.current) {
        const message = cause instanceof Error ? cause.message : 'Could not answer this question. Please try again.';
        setError(message);
        setLiveWork(current => current ? { ...current, status: 'error', error: message } : current);
      }
    } finally {
      finishRequest(requestId);
    }
  };

  const setActionMode = async (mode: InboxAssistantActionMode) => {
    const chatId = activeChatRef.current;
    if (!chatId || request.current || modeSaving) return;
    const version = ++modeGeneration.current;
    setModeSaving(true);
    try {
      const result = await window.electronAPI.inboxAssistant.updateChat({ chatId, actionMode: mode });
      if (!mounted.current || version !== modeGeneration.current || activeChatRef.current !== chatId) return;
      if (!result.success) throw new Error(result.error);
      if (activeChatRef.current === chatId) setActiveChat(current => current ? { ...current, actionMode: mode } : current);
      setChats(current => updateSummary(current, result.data));
    } catch (cause) { if (mounted.current && version === modeGeneration.current && activeChatRef.current === chatId) setError(cause instanceof Error ? cause.message : 'Could not change the action mode.'); }
    finally { if (mounted.current && version === modeGeneration.current) setModeSaving(false); }
  };

  const applyReview = async (exchange: InboxAssistantExchange, itemIds: string[], undo = false, manualSelection = false, action?: InboxAssistantReviewAction) => {
    const chatId = activeChatRef.current;
    if (!chatId || !exchange.review || request.current || !itemIds.length) return;
    const moveAction = action === 'archive' || action === 'trash';
    const confirmationKey = `review-confirmation:${exchange.review.id}`;
    if (pendingChatMutations.current.has(confirmationKey)) return;
    if (!undo && (action === 'trash' || (manualSelection && !moveAction))) {
      pendingChatMutations.current.add(confirmationKey);
      let confirmed = false;
      try {
        const selected = exchange.review.items.filter(item => itemIds.includes(item.id));
        if (action === 'trash') {
          const emailCount = selected.reduce((sum, item) => sum + item.messageCount, 0);
          const accountCount = new Set(selected.map(item => item.accountId)).size;
          confirmed = await requestConfirm({ title: 'Move selected conversations to Trash?', message: `Move ${emailCount} ${emailCount === 1 ? 'email' : 'emails'} in ${selected.length} selected ${selected.length === 1 ? 'conversation' : 'conversations'} across ${accountCount} ${accountCount === 1 ? 'account' : 'accounts'} to Trash? You can restore them from Trash. This does not permanently delete them.`, confirmLabel: 'Move to Trash', destructive: true });
        } else {
          const emailCount = selected.reduce((sum, item) => sum + item.unreadEmailIds.length, 0);
          confirmed = await requestConfirm({ title: 'Override agent recommendation?', message: `The agent recommended keeping some of these conversations unread or reviewing them first. Mark ${emailCount} unread ${emailCount === 1 ? 'email' : 'emails'} in ${selected.length} selected ${selected.length === 1 ? 'conversation' : 'conversations'} as read?`, confirmLabel: 'Mark selected as read' });
        }
      } finally { pendingChatMutations.current.delete(confirmationKey); }
      if (!confirmed || !mounted.current || activeChatRef.current !== chatId || request.current) return;
    }
    if (exchange.review.status === 'expired' || !Number.isFinite(exchange.review.expiresAt) || exchange.review.expiresAt <= Date.now()) { setError('This review has expired. Refresh it before changing mail.'); return; }
    const version = ++generation.current;
    const requestId = globalThis.crypto.randomUUID();
    const chatRevision = chatRevisions.current.get(chatId) ?? 0;
    request.current = requestId;
    requestChatId.current = chatId;
    activitySequence.current = 0;
    liveActivities.current = [];
    const message = undo ? 'Restoring the previous read status of changed emails' : action === 'archive' ? 'Archiving selected conversations' : action === 'trash' ? 'Moving selected conversations to Trash' : exchange.review.kind === 'mark_unread' ? 'Marking selected emails as unread' : 'Marking selected conversations as read';
    setActionCreating(true);
    setError(null);
    setLiveWork({ kind: 'action', question: message, activities: [], status: 'running', coverage: [], warnings: [] });
    setActivitySelection('live');
    onCloseSourcePane?.();
    try {
      const result = await window.electronAPI.inboxAssistant.applyReview({ requestId, chatId, exchangeId: exchange.id, reviewId: exchange.review.id, itemIds, ...(undo ? { undo: true } : { ...(manualSelection || moveAction ? { manualSelection: true } : {}), ...(action ? { action } : {}) }) });
      if (result.success && result.data.chatId && result.data.chatId !== chatId) throw new Error('The receipt belongs to a different conversation.');
      if (result.success) onMailChanged?.();
      if (activeChatRef.current !== chatId) return;
      if (!result.success) throw new Error(result.error);
      // Cancellation stops later conversations; acknowledged writes still
      // update the receipt in the originating conversation.
      if (mounted.current && (chatRevisions.current.get(chatId) ?? 0) === chatRevision) setExchanges(current => current.map(item => item.id === result.data.id ? result.data : item));
      if (version !== generation.current) return;
      setLiveWork(null);
      void refreshSummaries();
    } catch (cause) {
      if (version === generation.current) {
        const message = cause instanceof Error ? cause.message : 'Could not apply the reviewed actions.';
        setError(message);
        setLiveWork(current => current ? { ...current, status: 'error', error: message } : current);
      }
    } finally {
      finishRequest(requestId);
    }
  };

  const renameChat = async (event: FormEvent) => {
    event.preventDefault();
    const chatId = activeChatRef.current;
    const title = renameDraft.trim();
    if (!chatId || !title || renameSaving) return;
    setRenameSaving(true);
    metadataGeneration.current++;
    try {
      const result = await window.electronAPI.inboxAssistant.renameChat({ chatId, title });
      if (!result.success) throw new Error(result.error);
      if (!mounted.current) return;
      setChats(current => updateSummary(current, result.data));
      if (activeChatRef.current === chatId) {
        setActiveChat(current => current?.id === chatId ? { ...current, ...result.data } : current);
        setRenaming(false);
      }
    } catch (cause) {
      if (mounted.current && activeChatRef.current === chatId) setError(cause instanceof Error ? cause.message : 'Could not rename this conversation.');
    } finally {
      if (mounted.current && activeChatRef.current === chatId) setRenameSaving(false);
    }
  };

  const markChatPending = (chatId: string, pending: boolean) => {
    if (pending) pendingChatMutations.current.add(chatId);
    else pendingChatMutations.current.delete(chatId);
    if (mounted.current) setPendingChatIds(new Set(pendingChatMutations.current));
  };
  const createEmailDraft = async (event: FormEvent) => {
    event.preventDefault();
    const chatId = activeChatRef.current;
    if (!chatId || !exchanges.length || !onOpenDraft || request.current || !accounts.some(account => account.id === draftAccountId)) return;
    const version = ++generation.current;
    const requestId = globalThis.crypto.randomUUID();
    request.current = requestId;
    requestChatId.current = chatId;
    activitySequence.current = 0;
    liveActivities.current = [];
    setLiveWork({ kind: 'draft', question: 'Draft email from conversation', activities: [], status: 'running', coverage: [], warnings: [] });
    setActivitySelection('live');
    setDraftCreating(true);
    setDraftFormOpen(false);
    setError(null);
    try {
      const instructions = draftInstructions.trim();
      const result = await window.electronAPI.inboxAssistant.draftEmail({ requestId, chatId, accountId: draftAccountId, ...(instructions ? { instructions } : {}) });
      if (version !== generation.current || activeChatRef.current !== chatId) return;
      if (!result.success) throw new Error(result.error);
      if (result.data.chatId !== chatId || result.data.accountId !== draftAccountId) throw new Error('The draft belongs to a different conversation or sending account.');
      setLiveWork(current => current ? { ...current, status: 'done' } : current);
      onOpenDraft(result.data);
    } catch (cause) {
      if (version === generation.current) {
        const message = cause instanceof Error ? cause.message : 'Could not prepare this draft.';
        setError(message);
        setLiveWork(current => current ? { ...current, status: 'error', error: message } : current);
      }
    } finally {
      finishRequest(requestId);
    }
  };
  const togglePinned = async (chat: InboxAssistantChatSummary) => {
    if (pendingChatMutations.current.has(chat.id) || pendingDeletion.current) return;
    markChatPending(chat.id, true);
    setChatListError(null);
    metadataGeneration.current++;
    try {
      const result = await window.electronAPI.inboxAssistant.updateChat({ chatId: chat.id, pinned: !chat.pinned });
      if (!result.success) throw new Error(result.error);
      if (!mounted.current) return;
      metadataGeneration.current++;
      setChats(current => updateSummary(current, result.data));
      setActiveChat(current => current?.id === chat.id ? { ...current, ...result.data } : current);
    } catch (cause) {
      if (mounted.current) setChatListError(cause instanceof Error ? cause.message : 'Could not update this conversation.');
    } finally { markChatPending(chat.id, false); }
  };
  const deleteChat = async (chat: InboxAssistantChatSummary) => {
    if (pendingDeletion.current || pendingChatMutations.current.has(chat.id)) return;
    pendingDeletion.current = true;
    setDeletePending(true);
    markChatPending(chat.id, true);
    setChatListError(null);
    try {
      const confirmed = await requestConfirm({ title: 'Delete conversation', message: `Delete “${chat.title}” and its saved questions and answers? This cannot be undone.`, confirmLabel: 'Delete conversation', destructive: true });
      if (!confirmed || !mounted.current) return;
      if (activeChatRef.current === chat.id) stop();
      metadataGeneration.current++;
      const result = await window.electronAPI.inboxAssistant.deleteChat(chat.id);
      if (!result.success) throw new Error(result.error);
      if (!mounted.current) return;
      metadataGeneration.current++;
      setChats(result.data.chats);
      drafts.current.delete(chat.id);
      if (activeChatRef.current === chat.id) {
        const next = result.data.chats.find(item => item.id === result.data.activeChatId) ?? result.data.chats[0];
        if (next) await selectChat(next.id);
        else await newChat();
      }
    } catch (cause) {
      if (mounted.current) setChatListError(cause instanceof Error ? cause.message : 'Could not delete this conversation.');
    } finally {
      pendingDeletion.current = false;
      if (mounted.current) setDeletePending(false);
      markChatPending(chat.id, false);
    }
  };

  const allAccountsSelected = accounts.length > 0 && selectedAccountIds.length === accounts.length;
  const scopeLabel = allAccountsSelected ? `All accounts (${accounts.length})` : `${selectedAccountIds.length} of ${accounts.length} accounts`;
  const singleAccount = selectedAccountIds.length === 1 ? accounts.find(account => account.id === selectedAccountIds[0]) : undefined;
  const selectedExchange = exchanges.find(exchange => exchange.id === activitySelection);
  const inspection: WorkInspection | null = activitySelection === 'live' ? liveWork : selectedExchange ? {
    question: selectedExchange.question, activities: selectedExchange.activities ?? [], status: 'done',
    coverage: selectedExchange.answer.coverage, warnings: coverageWarnings(selectedExchange),
  } : null;
  const viewActivity = (selection: string, trigger: HTMLButtonElement) => {
    onCloseSourcePane?.();
    activityTrigger.current = trigger;
    setActivitySelection(selection);
    setActivityOpen(true);
  };
  const closeActivity = () => {
    setActivityOpen(false);
    if (!visibleRef.current) return;
    if (activityTrigger.current?.isConnected) activityTrigger.current.focus();
    else if (visibleRef.current) questionInput.current?.focus();
  };
  const activeTitle = chats.find(chat => chat.id === activeChatId)?.title ?? activeChat?.title ?? 'New conversation';
  const actionMode = chats.find(chat => chat.id === activeChatId)?.actionMode ?? activeChat?.actionMode ?? 'review';
  const busy = loading || chatLoading || creating || draftCreating || actionCreating || modeSaving || rewinding || !!stoppingRequestId;
  const workRunning = !!pendingQuestion || draftCreating || actionCreating;
  const runningRequest = request.current;
  const workStatus = stoppingRequestId ? 'Stopping…' : workRunning ? liveWork?.activities.at(-1)?.message || (liveWork?.kind === 'draft' ? 'Preparing draft from conversation' : liveWork?.kind === 'action' ? liveWork.question : 'Preparing email search')
    : liveWork?.status === 'error' ? 'Request failed' : liveWork?.status === 'cancelled' ? 'Stopped' : 'Ready';
  useEffect(() => {
    stateListener.current?.({ chatId: activeChatId, title: activeTitle, requestId: runningRequest, running: !!runningRequest, status: workStatus });
  }, [activeChatId, activeTitle, runningRequest, workStatus]);

  const renderAccountPicker = () => <div ref={accountPicker} className={compact ? 'min-w-0 flex-1' : 'relative'} onKeyDown={event => {
    if (event.key === 'Escape' && accountPickerOpen) { event.stopPropagation(); setAccountPickerOpen(false); accountPicker.current?.querySelector('button')?.focus(); }
  }}>
    {compact ? <button type="button" aria-label="Accounts to search" aria-expanded={accountPickerOpen} aria-controls="assistant-account-picker" onClick={() => setAccountPickerOpen(open => !open)} disabled={!!pendingQuestion || busy} title={singleAccount?.email ?? scopeLabel} className="flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"><Mail aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{singleAccount?.email ?? scopeLabel}</span><ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0" /></button>
      : <AccountSelectorTrigger label={singleAccount?.email ?? scopeLabel} secondaryLabel={singleAccount ? scopeLabel : undefined} expanded={accountPickerOpen} controls="assistant-account-picker" onClick={() => setAccountPickerOpen(open => !open)} disabled={!!pendingQuestion || busy} avatar={<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">{singleAccount ? (singleAccount.name || singleAccount.email).charAt(0).toUpperCase() : <Mail className="h-4 w-4" />}</span>} />}
    {accountPickerOpen && <fieldset id="assistant-account-picker" disabled={!!pendingQuestion || busy} className={`assistant-raised absolute z-30 overflow-y-auto rounded-xl border border-border bg-background p-2 shadow-xl ${compact ? 'bottom-full left-3 right-3 mb-2 max-h-[min(50vh,calc(100cqh-10rem))]' : 'left-0 top-full mt-2 max-h-[50vh] w-full'}`}>
      <legend className="sr-only">Accounts to search</legend>
      <div className="mb-1 flex items-center justify-between gap-2 px-2 py-1"><span className="text-xs font-medium">Search accounts</span><button type="button" onClick={() => setAccountPickerOpen(false)} aria-label="Close account picker" className="rounded-md p-1 text-muted-foreground hover:bg-accent"><X className="h-3.5 w-3.5" /></button></div>
      <button type="button" onClick={() => setSelectedAccountIds(accounts.map(account => account.id))} className="mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-primary hover:bg-accent"><Check className="h-3.5 w-3.5" />Select all accounts</button>
      {accounts.map(account => <label key={account.id} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-accent"><input type="checkbox" checked={selectedAccountIds.includes(account.id)} onChange={event => setSelectedAccountIds(current => event.target.checked ? [...current, account.id] : current.filter(id => id !== account.id))} className="h-4 w-4 shrink-0 accent-primary" /><span className="min-w-0 text-sm"><span className="block truncate">{account.email}</span>{account.name && <span className="block truncate text-xs text-muted-foreground">{account.name}</span>}</span></label>)}
    </fieldset>}
  </div>;
  const modeControl = <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><span className="sr-only">Action mode</span><select aria-label="Action mode" value={actionMode} disabled={busy || !!pendingQuestion || !activeChatId} onChange={event => void setActionMode(event.target.value as InboxAssistantActionMode)} title={actionMode === 'review' ? 'Review and approve recommendations before mail changes are made.' : 'Apply eligible actions you request in this conversation without asking, until changed.'} className={`assistant-raised max-w-40 rounded-lg bg-background text-xs ${compact ? 'h-8 border border-border/70 px-2' : 'border border-border px-2 py-2'}`}><option value="review">Ask for approval</option><option value="approve_for_me">Approve for me</option></select></label>;
  const compactButton = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40';
  const workActive = workRunning || !!stoppingRequestId;
  const renderStopButton = (label: string) => <button type="button" onClick={stop} disabled={!!stoppingRequestId && !stopFailed} aria-label={label} title="Stop the current review or request" className="flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-wait disabled:opacity-70 dark:border-red-400/50 dark:bg-red-400/10 dark:text-red-200 dark:hover:bg-red-400/20">{stoppingRequestId && !stopFailed ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Square aria-hidden="true" className="h-3 w-3 fill-current" />}<span>{stoppingRequestId ? stopFailed ? 'Retry stop' : 'Stopping…' : 'Stop'}</span></button>;
  const renderWorkBar = (inSource = false) => <div role="group" aria-label={inSource ? 'Agent work while reading email' : 'Current agent work'} className={`assistant-chrome flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-3 py-2 ${compact ? '' : 'px-5'}`}>
    <button type="button" onClick={event => viewActivity('live', event.currentTarget)} aria-label={inSource ? 'View activity from email' : stoppingRequestId ? 'View stopping activity' : 'View current activity'} aria-expanded={activityOpen && activitySelection === 'live'} aria-controls="assistant-activity-panel" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left text-xs text-muted-foreground hover:text-foreground"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" /><span className="truncate" title={workStatus}>{stopFailed ? 'Stop could not be confirmed' : workStatus}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 -rotate-90" /></button>
    {renderStopButton(inSource ? 'Stop work from email' : 'Stop current work')}
  </div>;

  return (
    <section className="assistant-theme relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background [container-type:size]" aria-label="Inbox Agent">
      {compact && chatListOpen && <button type="button" aria-label="Dismiss conversations" onClick={() => setChatListOpen(false)} className="absolute inset-0 z-20 bg-foreground/10" />}
      <nav aria-label="Assistant chats" onKeyDown={event => { if (event.key === 'Escape') setChatListOpen(false); }} className={`assistant-surface min-h-0 w-64 min-w-64 shrink-0 flex-col border-r border-border bg-card ${compact ? chatListOpen ? 'absolute inset-y-0 left-0 z-30 flex shadow-xl' : 'hidden' : chatListOpen ? 'fixed inset-y-0 left-0 z-30 flex shadow-xl md:static md:z-auto md:shadow-none' : 'hidden md:flex'}`}>
        {!compact && <div className="flex h-14 shrink-0 items-center justify-center gap-2.5 border-b border-border px-2"><img src="./icon.svg" alt="" aria-hidden="true" className="h-10 w-10 shrink-0 object-contain" /><img src="./wordmark.svg" alt="SarvInbox" className="h-5 w-auto object-contain dark:hidden" /><img src="./wordmark-dark.svg" alt="" aria-hidden="true" className="hidden h-5 w-auto object-contain dark:block" /></div>}
        <div className="shrink-0 space-y-3 p-3">
          <div className={`flex items-center justify-between ${compact ? '' : 'md:hidden'}`}><span className="text-sm font-semibold">{compact ? 'Conversations' : 'Inbox Agent'}</span><button type="button" onClick={() => setChatListOpen(false)} aria-label="Close conversations" className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent"><X className="h-4 w-4" /></button></div>
          {!compact && renderAccountPicker()}
          <button type="button" onClick={() => void newChat()} disabled={loading || creating || deletePending} className="assistant-primary-action brand-fill flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 font-medium text-primary-foreground shadow-md transition-all hover:shadow-lg disabled:opacity-50">{creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}New conversation</button>
        </div>
        <ChatSidebar chats={chats} activeChatId={activeChatId} pendingChatIds={pendingChatIds} deletePending={deletePending} error={chatListError} onSelect={chatId => void selectChat(chatId)} onTogglePinned={chat => void togglePinned(chat)} onDelete={chat => void deleteChat(chat)} />
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className={`assistant-chrome flex shrink-0 items-center border-b border-border/70 ${compact ? 'gap-1 px-3 py-2' : 'relative gap-3 px-5 py-4'}`}>
          <button type="button" onClick={() => setChatListOpen(open => !open)} aria-label="Show conversations" title="Conversations" aria-expanded={chatListOpen} className={`${compactButton} ${compact ? '' : 'md:hidden'}`}><Menu className="h-4 w-4" /></button>
          <div className="min-w-0 flex-1">
            {!compact && <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Inbox Agent</p>}
            {renaming ? <form onSubmit={event => void renameChat(event)} className="flex flex-wrap items-center gap-2"><input autoFocus={visible} aria-label="Conversation name" value={renameDraft} onChange={event => setRenameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(false); }} maxLength={120} disabled={renameSaving} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" /><button type="submit" disabled={!renameDraft.trim() || renameSaving} className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-accent disabled:opacity-50">{renameSaving ? 'Saving…' : 'Save name'}</button><button type="button" onClick={() => setRenaming(false)} className="rounded px-2 py-1 text-xs hover:bg-accent">Cancel</button></form> : <div className="flex min-w-0 items-center gap-1"><h1 title={activeTitle} className={`truncate font-semibold ${compact ? 'text-sm' : 'text-base'}`}>{activeTitle}</h1><button type="button" onClick={() => { setRenameDraft(activeTitle); setRenaming(true); }} disabled={busy || !activeChatId} aria-label="Rename conversation" title="Rename conversation" className="shrink-0 rounded-lg p-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground disabled:opacity-40"><Pencil className="h-3 w-3" /></button></div>}
          </div>
          {(chats.find(chat => chat.id === activeChatId)?.rewindAvailable ?? activeChat?.rewindAvailable) && <button type="button" disabled={busy || !!pendingQuestion} onClick={() => void restoreRewind()} title="Restore the previous conversation. Mail changes are preserved." aria-label="Restore previous conversation" className={compact ? compactButton : 'rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-40'}>{compact ? <RotateCcw className="h-4 w-4" /> : 'Restore previous conversation'}</button>}
          {!compact && modeControl}
          <button type="button" disabled={busy || !!pendingQuestion || !exchanges.length || !accounts.length || !onOpenDraft} onClick={() => { const from = accounts.find(account => account.id === defaultDraftAccountId) ?? singleAccount ?? accounts[0]; setDraftAccountId(from?.id ?? ''); setDraftFormOpen(open => !open); }} aria-label="Draft email" title="Draft email from this conversation" aria-expanded={draftFormOpen} aria-controls="assistant-draft-form" className={compact ? compactButton : 'flex shrink-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-40'}><MailPlus className="h-4 w-4" />{!compact && <span>Draft email</span>}</button>
          {compact && <button type="button" onClick={() => void newChat()} disabled={loading || creating || deletePending} aria-label="New conversation" title="New conversation" className={compactButton}>{creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}</button>}
          {draftFormOpen && <form id="assistant-draft-form" aria-label="Draft from conversation" onSubmit={event => void createEmailDraft(event)} onKeyDown={event => { if (event.key === 'Escape') setDraftFormOpen(false); }} className={`assistant-raised absolute z-20 mt-2 space-y-4 overflow-y-auto rounded-xl border border-border bg-background p-4 shadow-xl ${compact ? 'left-3 right-3 top-12 max-h-[calc(100%-5rem)]' : 'right-4 top-full max-h-[calc(100vh-12rem)] w-96 max-w-[calc(100vw-3rem)]'}`}><h2 className="text-sm font-semibold">Draft from conversation</h2><label className="block space-y-1 text-xs font-medium"><span>From</span><select autoFocus={visible} aria-label="Draft sending account" value={draftAccountId} onChange={event => setDraftAccountId(event.target.value)} className="block w-full rounded-md border border-border bg-background px-2 py-2 text-sm">{accounts.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label><label className="block space-y-1 text-xs font-medium"><span>Instructions (optional)</span><textarea aria-label="Draft instructions" value={draftInstructions} onChange={event => setDraftInstructions(event.target.value)} maxLength={4000} rows={3} placeholder="For example, summarize the quotation and ask for feedback." className="max-h-40 w-full resize-none rounded-md border border-border bg-background px-2 py-2 text-sm font-normal" /></label><div className="flex justify-end gap-2"><button type="button" onClick={() => setDraftFormOpen(false)} className="rounded-md px-3 py-2 text-xs hover:bg-accent">Cancel</button><button type="submit" className="assistant-primary-action rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90">Create draft</button></div></form>}
        </header>

        {workActive && renderWorkBar()}

        <div ref={messages} aria-label="Conversation messages" className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${compact ? 'space-y-6 px-4 py-5' : 'space-y-8 px-5 py-6'}`} aria-live="polite" aria-busy={busy || !!pendingQuestion}>
          {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading conversations…</p> : loadError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{loadError}</p><button onClick={() => void load()} className="mt-3 font-medium underline">Try again</button></div> : chatLoading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{creating ? 'Creating conversation…' : 'Loading conversation…'}</p> : chatError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{chatError}</p><button type="button" onClick={() => activeChatId ? void selectChat(activeChatId, true) : void newChat()} className="mt-3 font-medium underline">Try again</button></div> : <>
            {accounts.length === 0 && <p role="status" className="text-sm text-muted-foreground">Connect an email account to ask Inbox Agent about your mail.</p>}
            {exchanges.length === 0 && !liveWork && <div className={`mx-auto flex w-full max-w-3xl flex-col justify-center ${compact ? 'space-y-5 py-3' : 'space-y-6 py-10'}`}><div className="space-y-3"><span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Bot className="h-6 w-6" /></span><h2 className={`${compact ? 'text-xl' : 'text-2xl'} font-semibold tracking-tight`}>What can I help you with?</h2><p className="text-sm text-muted-foreground">Search your mail, review unread conversations, and catch messages that missed categorization.</p></div><div className={`grid gap-2 ${compact ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>{starterActions.map(({ title, description, question: text, Icon }) => <button key={title} type="button" disabled={!accounts.length || !activeChatId} onClick={() => { setQuestion(text); if (visibleRef.current) questionInput.current?.focus(); }} className={`assistant-surface flex items-start gap-3 rounded-xl border border-border text-left transition-colors hover:bg-accent hover:border-primary/20 disabled:opacity-50 ${compact ? 'p-3' : 'p-4'}`}><Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><span className="space-y-1"><span className="block text-sm font-medium">{title}</span><span className="block text-xs leading-5 text-muted-foreground">{description}</span></span></button>)}</div><div className="flex flex-wrap gap-2">{starterQuestions.map(text => <button key={text} type="button" disabled={!accounts.length || !activeChatId} onClick={() => { setQuestion(text); if (visibleRef.current) questionInput.current?.focus(); }} className="rounded-full border border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">{text}</button>)}</div></div>}
            {exchanges.map(exchange => <Answer key={exchange.id} compact={compact} exchange={exchange} onNavigateToSource={onNavigateToSource} onViewActivity={viewActivity} activityExpanded={activityOpen && activitySelection === exchange.id} userMessage={{ visible, onEdit: () => { setEditingExchangeId(exchange.id); setEditQuestion(exchange.question); }, disabled: busy || !!pendingQuestion, ...(editingExchangeId === exchange.id ? { editValue: editQuestion, onEditChange: setEditQuestion, onCancelEdit: () => setEditingExchangeId(null), onSaveEdit: () => void rewindChat(exchange) } : {}) }} actionBusy={busy || !!pendingQuestion || !!editingExchangeId} onApply={(ids, manualSelection, action) => void applyReview(exchange, ids, false, manualSelection, action)} onUndo={ids => void applyReview(exchange, ids, true)} onRefresh={() => void ask(undefined, { question: exchange.question, reviewKind: exchange.review?.kind, accountIds: exchange.review?.accounts.map(account => account.id), reviewOnly: true })} onContinue={() => void ask(undefined, { question: exchange.question, reviewKind: exchange.review?.kind, continueReviewId: exchange.review?.id, accountIds: exchange.review?.accounts.map(account => account.id), reviewOnly: true })} />)}
            {liveWork && <div className="space-y-5" role={workRunning ? 'status' : undefined}>{liveWork.kind !== 'draft' && liveWork.kind !== 'action' && <UserMessage question={liveWork.question} visible={visible} onEdit={!workRunning && !stoppingRequestId ? () => { setQuestion(liveWork.question); if (visibleRef.current) questionInput.current?.focus(); } : undefined} />}{!workActive && <button type="button" onClick={event => viewActivity('live', event.currentTarget)} aria-label={workRunning ? 'View current activity' : liveWork.status === 'stopping' ? 'View stopping activity' : liveWork.status === 'done' ? 'View draft activity' : liveWork.status === 'error' ? 'View failed activity' : 'View stopped activity'} aria-expanded={activityOpen && activitySelection === 'live'} aria-controls="assistant-activity-panel" className="flex max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">{workRunning ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Activity className="h-3.5 w-3.5 shrink-0" />}<span className="truncate">{liveWork.status === 'running' ? liveWork.activities[liveWork.activities.length - 1]?.message || (liveWork.kind === 'draft' ? 'Preparing draft from conversation' : 'Preparing email search') : liveWork.status === 'done' ? 'Draft ready · View activity' : liveWork.status === 'stopping' ? 'Stopping… · View activity' : liveWork.status === 'cancelled' ? 'Stopped · View activity' : 'Failed · View activity'}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90" /></button>}</div>}
          </>}
        </div>
        {error && <p role="alert" className="mx-5 mb-3 shrink-0 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        <form onSubmit={event => void ask(event)} className={`relative shrink-0 space-y-2 bg-background ${compact ? 'border-t border-border/60 px-3 pb-3 pt-2.5' : 'border-t border-border px-5 py-4'}`}>
          <label htmlFor="inbox-assistant-question" className="sr-only">Message Inbox Agent</label>
          <div className={`assistant-raised flex items-end rounded-2xl border border-border bg-muted/10 transition-shadow focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10 ${compact ? 'gap-2 p-2.5' : 'gap-3 p-3'}`}>
            <textarea ref={questionInput} id="inbox-assistant-question" value={question} maxLength={4000} disabled={!!pendingQuestion || busy || !!editingExchangeId || !!loadError || !!chatError || !accounts.length || !activeChatId} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={compact ? 1 : 2} placeholder="Message Inbox Agent…" className={`max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none disabled:opacity-50 ${compact ? 'min-h-9 [field-sizing:content]' : 'min-h-12'}`} />
            {workActive ? renderStopButton(stoppingRequestId ? stopFailed ? 'Retry stop' : 'Stopping request' : draftCreating ? 'Stop drafting' : 'Stop answering') : <button type="submit" disabled={!question.trim() || selectedAccountIds.length === 0 || busy || !!editingExchangeId || !!loadError || !!chatError || !activeChatId} aria-label="Ask Inbox Agent" title="Send message" className={`assistant-primary-action shrink-0 rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground ${compact ? 'p-2.5' : 'p-3'}`}><ArrowUp className="h-4 w-4" /></button>}
          </div>
          {compact && <div className="flex min-w-0 items-center gap-2">{renderAccountPicker()}{modeControl}</div>}
          {selectedAccountIds.length === 0 && !loading && <p className="text-xs text-muted-foreground">Choose at least one account.</p>}
        </form>
      </div>
      {sourcePane ? <div aria-label="Assistant email source" className={`inset-y-0 right-0 z-40 flex min-h-0 flex-col border-l border-border bg-background shadow-xl ${compact ? 'absolute w-full' : 'fixed w-[min(56rem,100vw)] lg:static lg:z-auto lg:h-full lg:w-1/2 lg:shrink-0 lg:shadow-none'}`}>{workActive && renderWorkBar(true)}<div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">{sourcePane}</div></div> : activityOpen && inspection && <ActivitySidebar inspection={inspection} accounts={accounts} onClose={closeActivity} compact={compact} visible={visible} stopButton={workActive ? renderStopButton('Stop work from activity') : undefined} />}
    </section>
  );
}
