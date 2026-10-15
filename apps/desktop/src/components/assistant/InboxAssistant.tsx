import { Activity, AlertCircle, ArrowUp, Bot, Check, ChevronDown, Circle, FileText, Loader2, Mail, MailPlus, Menu, Pencil, Plus, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { requestConfirm } from '../../store/confirm-service';
import type {
  InboxAssistantAccount,
  InboxAssistantAccountCoverage,
  InboxAssistantActivity,
  InboxAssistantChat,
  InboxAssistantChatSummary,
  InboxAssistantDraft,
  InboxAssistantExchange,
  InboxAssistantSource,
} from '../../types/inbox-assistant';
import { AccountSelectorTrigger } from '../AccountSelectorTrigger';

import { ChatSidebar } from './ChatSidebar';

interface InboxAssistantProps {
  onNavigateToSource?: (source: InboxAssistantSource) => void;
  sourcePane?: ReactNode;
  onCloseSourcePane?: () => void;
  onOpenDraft?: (draft: InboxAssistantDraft) => void;
  defaultDraftAccountId?: string;
}

const starterQuestions = [
  'What quote did I send to TCS?',
  'Find the latest quotation I sent and any revisions.',
  'What did I agree with this customer?',
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
  kind?: 'question' | 'draft';
  question: string;
  activities: InboxAssistantActivity[];
  status: 'running' | 'done' | 'cancelled' | 'error';
  coverage: InboxAssistantAccountCoverage[];
  warnings: string[];
  error?: string;
}

function ActivitySidebar({ inspection, accounts, onClose }: { inspection: WorkInspection; accounts: InboxAssistantAccount[]; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const timelineEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    if (inspection.status === 'running') timelineEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [inspection.status, inspection.activities.length]);
  const status = inspection.status === 'running' ? 'In progress' : inspection.status === 'cancelled' ? 'Stopped' : inspection.status === 'error' ? 'Failed' : 'Completed';
  return (
    <aside id="assistant-activity-panel" aria-labelledby="assistant-activity-heading" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }} className="fixed bottom-0 right-0 top-0 z-40 flex w-[min(24rem,100vw)] shrink-0 flex-col border-l border-border bg-background shadow-xl lg:static lg:z-auto lg:h-full lg:min-h-0 lg:w-72 lg:shadow-none 2xl:w-80">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h3 id="assistant-activity-heading" className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4" />Activity</h3>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close activity" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button>
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
      className="min-w-0 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-background"
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

function UserMessage({ question, date }: { question: string; date?: number }) {
  return <div className="flex justify-end"><div className="max-w-[90%] rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3">
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{question}</p>
    {date && <p className="mt-1 text-right text-[11px] text-muted-foreground">{formatDate(date)}</p>}
  </div></div>;
}

function Answer({ exchange, onNavigateToSource, onViewActivity, activityExpanded }: {
  exchange: InboxAssistantExchange;
  onNavigateToSource?: InboxAssistantProps['onNavigateToSource'];
  onViewActivity: (exchangeId: string, trigger: HTMLButtonElement) => void;
  activityExpanded: boolean;
}) {
  return (
    <article className="space-y-5" aria-label={`Answer to ${exchange.question}`}>
      <UserMessage question={exchange.question} date={exchange.createdAt} />
      <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-2 font-medium text-foreground"><Bot className="h-4 w-4 text-primary" />Inbox Agent</span>
            <button type="button" onClick={event => onViewActivity(exchange.id, event.currentTarget)} aria-label={`View activity for ${exchange.question}`} aria-expanded={activityExpanded} aria-controls="assistant-activity-panel" className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"><Activity className="h-3 w-3" />View activity</button>
          </div>
      {/* Mail and model output are untrusted text. Never interpret HTML here. */}
      <div className="whitespace-pre-wrap break-words text-sm leading-7"><AnswerText text={exchange.answer.text} sources={exchange.answer.sources} onNavigate={onNavigateToSource} /></div>
      {exchange.answer.sources.length > 0 && (
        <details aria-label="Answer sources" className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Sources · {exchange.answer.sources.length}</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 2xl:grid-cols-2">
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

export function InboxAssistant({ onNavigateToSource, sourcePane, onCloseSourcePane, onOpenDraft, defaultDraftAccountId }: InboxAssistantProps) {
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
  const [liveWork, setLiveWork] = useState<WorkInspection | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activitySelection, setActivitySelection] = useState('live');
  const generation = useRef(0);
  const metadataGeneration = useRef(0);
  const mounted = useRef(false);
  const activeChatRef = useRef<string | null>(null);
  const request = useRef<string | null>(null);
  const activitySequence = useRef(0);
  const liveActivities = useRef<InboxAssistantActivity[]>([]);
  const drafts = useRef(new Map<string, { question: string; accountIds: string[] }>());
  const activityTrigger = useRef<HTMLButtonElement | null>(null);
  const questionInput = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const pendingChatMutations = useRef(new Set<string>());
  const pendingDeletion = useRef(false);

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
    if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [activeChatId, chatLoading, exchanges.length, pendingQuestion]);

  const saveDraft = () => {
    if (activeChatId && !chatLoading) drafts.current.set(activeChatId, { question, accountIds: [...selectedAccountIds] });
  };
  const stop = () => {
    generation.current++;
    const requestId = request.current;
    request.current = null;
    setPendingQuestion(null);
    setDraftCreating(false);
    if (requestId) {
      setLiveWork(current => current ? { ...current, status: 'cancelled' } : current);
      void window.electronAPI.inboxAssistant.cancel(requestId).catch(() => {});
    }
  };
  const resetChatView = () => {
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
      questionInput.current?.focus();
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

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    const chatId = activeChatRef.current;
    if (!text || !chatId || selectedAccountIds.length === 0 || loading || chatLoading || creating || request.current) return;
    const version = ++generation.current;
    const requestId = globalThis.crypto.randomUUID();
    request.current = requestId;
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
        requestId, chatId, question: text, accountIds: [...selectedAccountIds],
        ...(previous ? { previousExchangeId: previous.id } : {}),
      });
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
      if (version === generation.current) { request.current = null; setPendingQuestion(null); }
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
      if (version === generation.current) { request.current = null; setDraftCreating(false); }
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
    if (activityTrigger.current?.isConnected) activityTrigger.current.focus();
    else questionInput.current?.focus();
  };
  const activeTitle = chats.find(chat => chat.id === activeChatId)?.title ?? activeChat?.title ?? 'New conversation';
  const busy = loading || chatLoading || creating || draftCreating;
  const workRunning = !!pendingQuestion || draftCreating;

  return (
    <section className="flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background" aria-label="Inbox Agent">
      <nav aria-label="Assistant chats" onKeyDown={event => { if (event.key === 'Escape') setChatListOpen(false); }} className={`min-h-0 w-64 min-w-64 shrink-0 flex-col border-r border-border bg-card ${chatListOpen ? 'fixed inset-y-0 left-0 z-30 flex shadow-xl md:static md:z-auto md:shadow-none' : 'hidden md:flex'}`}>
        <div className="flex h-14 shrink-0 items-center justify-center gap-2.5 border-b border-border px-2"><img src="./icon.svg" alt="" aria-hidden="true" className="h-10 w-10 shrink-0 object-contain" /><img src="./wordmark.svg" alt="SarvInbox" className="h-5 w-auto object-contain dark:hidden" /><img src="./wordmark-dark.svg" alt="" aria-hidden="true" className="hidden h-5 w-auto object-contain dark:block" /></div>
        <div className="shrink-0 space-y-3 p-3">
          <div className="flex items-center justify-between md:hidden"><span className="text-sm font-medium">Inbox Agent</span><button type="button" onClick={() => setChatListOpen(false)} aria-label="Close conversations" className="rounded p-1 hover:bg-accent"><X className="h-4 w-4" /></button></div>
          <div className="relative">
            <AccountSelectorTrigger label={singleAccount?.email ?? scopeLabel} secondaryLabel={singleAccount ? scopeLabel : undefined} expanded={accountPickerOpen} controls="assistant-account-picker" onClick={() => setAccountPickerOpen(open => !open)} disabled={!!pendingQuestion || busy} avatar={<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground">{singleAccount ? (singleAccount.name || singleAccount.email).charAt(0).toUpperCase() : <Mail className="h-4 w-4" />}</span>} />
            {accountPickerOpen && <fieldset id="assistant-account-picker" disabled={!!pendingQuestion || busy} className="absolute left-0 top-full z-20 mt-2 w-full rounded-lg border border-border bg-background p-2 shadow-lg">
              <legend className="sr-only">Accounts to search</legend>
              <button type="button" onClick={() => setSelectedAccountIds(accounts.map(account => account.id))} className="mb-2 flex items-center gap-2 rounded px-2 py-1 text-sm text-primary hover:bg-accent"><Check className="h-4 w-4" />Select all accounts</button>
              {accounts.map(account => <label key={account.id} className="flex cursor-pointer items-center gap-3 rounded p-2 hover:bg-accent"><input type="checkbox" checked={selectedAccountIds.includes(account.id)} onChange={event => setSelectedAccountIds(current => event.target.checked ? [...current, account.id] : current.filter(id => id !== account.id))} /><span className="min-w-0 text-sm"><span className="block truncate">{account.email}</span>{account.name && <span className="block truncate text-xs text-muted-foreground">{account.name}</span>}</span></label>)}
            </fieldset>}
          </div>
          <button type="button" onClick={() => void newChat()} disabled={loading || creating || deletePending} className="brand-fill flex w-full items-center justify-center gap-2 rounded-full px-4 py-2.5 font-medium text-primary-foreground shadow-md transition-all hover:shadow-lg disabled:opacity-50">{creating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}New conversation</button>
        </div>
        <ChatSidebar chats={chats} activeChatId={activeChatId} pendingChatIds={pendingChatIds} deletePending={deletePending} error={chatListError} onSelect={chatId => void selectChat(chatId)} onTogglePinned={chat => void togglePinned(chat)} onDelete={chat => void deleteChat(chat)} />
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="relative flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
          <button type="button" onClick={() => setChatListOpen(open => !open)} aria-label="Show conversations" aria-expanded={chatListOpen} className="rounded p-2 hover:bg-accent md:hidden"><Menu className="h-4 w-4" /></button>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Inbox Agent</p>
            {renaming ? <form onSubmit={event => void renameChat(event)} className="flex flex-wrap items-center gap-2"><input autoFocus aria-label="Conversation name" value={renameDraft} onChange={event => setRenameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(false); }} maxLength={120} disabled={renameSaving} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm" /><button type="submit" disabled={!renameDraft.trim() || renameSaving} className="rounded px-2 py-1 text-xs font-medium text-primary hover:bg-accent disabled:opacity-50">{renameSaving ? 'Saving…' : 'Save name'}</button><button type="button" onClick={() => setRenaming(false)} className="rounded px-2 py-1 text-xs hover:bg-accent">Cancel</button></form> : <div className="flex items-center gap-2"><h1 className="truncate text-base font-semibold">{activeTitle}</h1><button type="button" onClick={() => { setRenameDraft(activeTitle); setRenaming(true); }} disabled={busy || !activeChatId} aria-label="Rename conversation" className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"><Pencil className="h-3.5 w-3.5" /></button></div>}
          </div>
          <button type="button" disabled={busy || !!pendingQuestion || !exchanges.length || !accounts.length || !onOpenDraft} onClick={() => { const from = accounts.find(account => account.id === defaultDraftAccountId) ?? singleAccount ?? accounts[0]; setDraftAccountId(from?.id ?? ''); setDraftFormOpen(open => !open); }} aria-expanded={draftFormOpen} aria-controls="assistant-draft-form" className="flex shrink-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-40"><MailPlus className="h-4 w-4" />Draft email</button>
          {draftFormOpen && <form id="assistant-draft-form" aria-label="Draft from conversation" onSubmit={event => void createEmailDraft(event)} onKeyDown={event => { if (event.key === 'Escape') setDraftFormOpen(false); }} className="absolute right-4 top-full z-20 mt-2 w-96 max-w-[calc(100vw-3rem)] space-y-4 rounded-xl border border-border bg-background p-4 shadow-xl"><h2 className="text-sm font-semibold">Draft from conversation</h2><label className="block space-y-1 text-xs font-medium"><span>From</span><select autoFocus aria-label="Draft sending account" value={draftAccountId} onChange={event => setDraftAccountId(event.target.value)} className="block w-full rounded-md border border-border bg-background px-2 py-2 text-sm">{accounts.map(account => <option key={account.id} value={account.id}>{account.email}</option>)}</select></label><label className="block space-y-1 text-xs font-medium"><span>Instructions (optional)</span><textarea aria-label="Draft instructions" value={draftInstructions} onChange={event => setDraftInstructions(event.target.value)} maxLength={4000} rows={3} placeholder="For example, summarize the quotation and ask for feedback." className="max-h-40 w-full resize-none rounded-md border border-border bg-background px-2 py-2 text-sm font-normal" /></label><div className="flex justify-end gap-2"><button type="button" onClick={() => setDraftFormOpen(false)} className="rounded-md px-3 py-2 text-xs hover:bg-accent">Cancel</button><button type="submit" className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90">Create draft</button></div></form>}
        </header>

        <div ref={messages} aria-label="Conversation messages" className="min-h-0 flex-1 space-y-8 overflow-y-auto px-5 py-6" aria-live="polite" aria-busy={busy || !!pendingQuestion}>
          {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading conversations…</p> : loadError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{loadError}</p><button onClick={() => void load()} className="mt-3 font-medium underline">Try again</button></div> : chatLoading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{creating ? 'Creating conversation…' : 'Loading conversation…'}</p> : chatError ? <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{chatError}</p><button type="button" onClick={() => activeChatId ? void selectChat(activeChatId, true) : void newChat()} className="mt-3 font-medium underline">Try again</button></div> : <>
            {accounts.length === 0 && <p role="status" className="text-sm text-muted-foreground">Connect an email account to ask Inbox Agent about your mail.</p>}
            {exchanges.length === 0 && !liveWork && <div className="flex min-h-48 flex-col justify-center space-y-4"><h2 className="text-lg font-medium">What would you like to find?</h2><div className="flex flex-wrap gap-2">{starterQuestions.map(text => <button key={text} type="button" disabled={!accounts.length || !activeChatId} onClick={() => { setQuestion(text); questionInput.current?.focus(); }} className="rounded-xl border border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">{text}</button>)}</div></div>}
            {exchanges.map(exchange => <Answer key={exchange.id} exchange={exchange} onNavigateToSource={onNavigateToSource} onViewActivity={viewActivity} activityExpanded={activityOpen && activitySelection === exchange.id} />)}
            {liveWork && <div className="space-y-5" role={workRunning ? 'status' : undefined}>{liveWork.kind !== 'draft' && <UserMessage question={liveWork.question} />}<button type="button" onClick={event => viewActivity('live', event.currentTarget)} aria-label={workRunning ? 'View current activity' : liveWork.status === 'done' ? 'View draft activity' : liveWork.status === 'error' ? 'View failed activity' : 'View stopped activity'} aria-expanded={activityOpen && activitySelection === 'live'} aria-controls="assistant-activity-panel" className="flex max-w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">{workRunning ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Activity className="h-3.5 w-3.5 shrink-0" />}<span className="truncate">{liveWork.status === 'running' ? liveWork.activities[liveWork.activities.length - 1]?.message || (liveWork.kind === 'draft' ? 'Preparing draft from conversation' : 'Preparing email search') : liveWork.status === 'done' ? 'Draft ready · View activity' : liveWork.status === 'cancelled' ? 'Stopped · View activity' : 'Failed · View activity'}</span><ChevronDown className="h-3.5 w-3.5 shrink-0 -rotate-90" /></button></div>}
          </>}
        </div>
        {error && <p role="alert" className="mx-5 mb-3 shrink-0 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
        <form onSubmit={event => void ask(event)} className="shrink-0 space-y-2 border-t border-border bg-background px-5 py-4">
          <label htmlFor="inbox-assistant-question" className="sr-only">Message Inbox Agent</label>
          <div className="flex items-end gap-3 rounded-xl border border-border bg-background p-3 focus-within:ring-2 focus-within:ring-primary/30">
            <textarea ref={questionInput} id="inbox-assistant-question" value={question} maxLength={4000} disabled={!!pendingQuestion || busy || !!loadError || !!chatError || !accounts.length || !activeChatId} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={2} placeholder="Message Inbox Agent…" className="min-h-12 max-h-36 min-w-0 flex-1 resize-none bg-transparent text-sm outline-none disabled:opacity-50" />
            {workRunning ? <button type="button" onClick={stop} aria-label={draftCreating ? 'Stop drafting' : 'Stop answering'} className="rounded-lg bg-muted p-3 hover:bg-accent"><Square className="h-4 w-4" /></button> : <button type="submit" disabled={!question.trim() || selectedAccountIds.length === 0 || busy || !!loadError || !!chatError || !activeChatId} aria-label="Ask Inbox Agent" className="rounded-lg bg-primary p-3 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"><ArrowUp className="h-4 w-4" /></button>}
          </div>
          {selectedAccountIds.length === 0 && !loading && <p className="text-xs text-muted-foreground">Choose at least one account.</p>}
        </form>
      </div>
      {sourcePane ? <div aria-label="Assistant email source" className="fixed inset-y-0 right-0 z-40 w-[min(56rem,100vw)] border-l border-border bg-background shadow-xl lg:static lg:z-auto lg:h-full lg:w-1/2 lg:shrink-0 lg:shadow-none">{sourcePane}</div> : activityOpen && inspection && <ActivitySidebar inspection={inspection} accounts={accounts} onClose={closeActivity} />}
    </section>
  );
}
