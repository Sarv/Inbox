import { ArrowRight, CalendarDays, ChevronDown, Clock3, ExternalLink, ListFilter, Loader2, MailCheck, Plus, RefreshCw, ReplyAll, Search } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { InboxAssistantChatSummary, InboxAssistantDashboard, InboxAssistantSource, InboxAssistantUsage } from '../../types/inbox-assistant';
import type { LocalCalendarOpenEvent } from '../../types/local-calendar';

import { AssistantUsage } from './AssistantUsage';
import './assistant-dashboard.css';

export interface AssistantDashboardProps {
  accountIds: string[];
  chats: InboxAssistantChatSummary[];
  visible?: boolean;
  compact?: boolean;
  currentConversationUsage?: InboxAssistantUsage;
  currentConversationTitle?: string;
  onChoosePrompt: (question: string) => void;
  onOpenConversation: (chatId: string) => void;
  onNewConversation: () => void;
  onNavigateToSource?: (source: InboxAssistantSource) => void;
  onReplyToSource?: (source: InboxAssistantSource) => void;
  onOpenCalendarEvent?: (event: LocalCalendarOpenEvent) => void;
}

export const dashboardPrompts = {
  unread: 'Review my unread emails and mark low-value conversations as read.',
  uncategorized: 'Review my uncategorized unread emails.',
  needsReply: 'Which recent customer emails need a response?',
  quotations: 'Find the latest quotation I sent and any revisions.',
  invitations: 'Find meeting invitations received today.',
} as const;

function amount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : 'Unavailable';
}

function dateLabel(value: number, options: Intl.DateTimeFormatOptions, timeZone?: string): string {
  if (!Number.isFinite(value)) return 'Date unavailable';
  try { return new Intl.DateTimeFormat(undefined, { ...options, ...(timeZone ? { timeZone } : {}) }).format(value); }
  catch { return 'Date unavailable'; }
}

function shortDate(value: number): string {
  return dateLabel(value, { month: 'short', day: 'numeric' });
}

function Panel({ title, caption, children, action }: { title: string; caption?: string; children: ReactNode; action?: ReactNode }) {
  return <section aria-label={title} className="min-w-0">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 pb-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold">{title}</h3>{caption && <p className="mt-1 text-xs leading-5 text-muted-foreground">{caption}</p>}</div>{action}
    </div>
    {children}
  </section>;
}

const emptyClass = 'py-5 text-sm leading-6 text-muted-foreground';
const actionClass = 'inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';

function senderLabel(from: string): string {
  return from.replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '').trim() || from;
}

function senderInitials(from: string): string {
  const name = senderLabel(from).split('@')[0];
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase() || '?';
}

/** A local overview. Suggested tasks only prepare a new conversation. */
export function AssistantDashboard({ accountIds, chats, visible = true, compact = false, currentConversationUsage, currentConversationTitle,
  onChoosePrompt, onOpenConversation, onNewConversation, onNavigateToSource, onReplyToSource, onOpenCalendarEvent }: AssistantDashboardProps) {
  const scopeKey = JSON.stringify([...new Set(accountIds)].sort());
  const [refresh, setRefresh] = useState(0);
  const requestGeneration = useRef(0);
  const taskLauncher = useRef<HTMLDetailsElement>(null);
  const replyHeading = useRef<HTMLHeadingElement>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; data?: InboxAssistantDashboard; error?: string; loading: boolean }>({ key: '', loading: false });

  useEffect(() => {
    if (!visible) return;
    const version = ++requestGeneration.current;
    let active = true;
    const selectedIds = JSON.parse(scopeKey) as string[];
    if (selectedIds.length === 0) { setSnapshot({ key: scopeKey, loading: false }); return; }
    setSnapshot(current => ({ key: scopeKey, data: current.key === scopeKey ? current.data : undefined, loading: true }));
    void (async () => {
      try {
        const api = window.electronAPI?.inboxAssistant;
        if (!api?.dashboard) throw new Error('Inbox overview is unavailable. Restart Inbox after updating.');
        const result = await api.dashboard({ accountIds: selectedIds });
        if (!active || version !== requestGeneration.current) return;
        if (!result.success) throw new Error(result.error);
        setSnapshot({ key: scopeKey, data: result.data, loading: false });
      } catch (cause) {
        if (!active || version !== requestGeneration.current) return;
        const error = cause instanceof Error ? cause.message : 'Could not load the local inbox overview.';
        setSnapshot(current => ({ key: scopeKey, data: current.key === scopeKey ? current.data : undefined, loading: false, error }));
      }
    })();
    return () => { active = false; };
  }, [scopeKey, refresh, visible]);

  const data = snapshot.key === scopeKey ? snapshot.data : undefined;
  const error = snapshot.key === scopeKey ? snapshot.error : undefined;
  const loading = visible && accountIds.length > 0 && (snapshot.key !== scopeKey || snapshot.loading);
  const recent = [...chats].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 5);
  const knownAccounts = new Map(data?.accounts.map(account => [account.id, account.email]));
  const unavailable = data?.accounts.filter(account => account.status === 'unavailable') ?? [];
  const metricValues = [
    { label: 'Unread', name: 'Unread conversations', value: data?.counts.unreadConversations, prompt: dashboardPrompts.unread, description: 'Conversations with unread mail' },
    { label: 'Uncategorized unread', name: 'Uncategorized unread conversations', value: data?.counts.uncategorizedUnreadConversations, prompt: dashboardPrompts.uncategorized, description: 'Unread mail without a saved category' },
    { label: 'Needs a reply', name: 'Saved needs-reply conversations', value: data?.counts.needsReplyConversations, description: 'Saved needs-response categories; show the reply worklist' },
  ];
  const chooseTask = (prompt: string) => {
    if (taskLauncher.current) taskLauncher.current.open = false;
    onChoosePrompt(prompt);
  };

  return <section aria-label="Inbox overview" className={`assistant-dashboard min-w-0 ${compact ? 'p-3' : 'p-5'}`} aria-busy={loading}>
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 pb-5">
      <div className="min-w-0 space-y-1.5"><h2 className="text-xl font-semibold tracking-tight">Today in your inbox</h2>
        <p className="text-xs text-muted-foreground">Local data · No AI calls{data && ` · Updated ${dateLabel(data.generatedAt, { hour: 'numeric', minute: '2-digit' })}`}</p>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" aria-label="Refresh overview" title="Refresh local overview" disabled={loading || !visible || accountIds.length === 0} onClick={() => setRefresh(current => current + 1)} className={actionClass}><RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /><span className="sr-only">Refresh</span></button>
        <details ref={taskLauncher} className="relative" onKeyDown={event => {
          if (event.key !== 'Escape' || !taskLauncher.current?.open) return;
          event.preventDefault(); event.stopPropagation(); taskLauncher.current.open = false;
          taskLauncher.current.querySelector('summary')?.focus();
        }}>
          <summary className={`${actionClass} cursor-pointer list-none border border-border [&::-webkit-details-marker]:hidden`}><Plus aria-hidden="true" className="h-3.5 w-3.5" />Inbox tasks<ChevronDown aria-hidden="true" className="h-3 w-3" /></summary>
          <section aria-label="Guided inbox tasks" className="assistant-raised absolute right-0 z-20 mt-2 w-72 max-w-[calc(100cqw-1.5rem)] overflow-hidden rounded-lg border border-border bg-popover p-1.5 shadow-lg">
            <p className="px-2.5 py-2 text-xs text-muted-foreground">Prepare a request, then review and send.</p>
            {[
              { title: 'Review unread', prompt: dashboardPrompts.unread, Icon: MailCheck },
              { title: 'Check uncategorized', prompt: dashboardPrompts.uncategorized, Icon: ListFilter },
              { title: 'Find quotations', prompt: dashboardPrompts.quotations, Icon: Search },
              { title: 'Find meeting invitations', prompt: dashboardPrompts.invitations, Icon: CalendarDays },
            ].map(({ title, prompt, Icon }) => <button key={title} type="button" disabled={!accountIds.length} onClick={() => chooseTask(prompt)} className="flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"><Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />{title}</button>)}
          </section>
        </details>
      </div>
    </div>

    {accountIds.length === 0 ? <p className={emptyClass}>Choose at least one account to see your overview.</p> : <>
      {error && <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">{error}</div>}
      {loading && !data && <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Loading local overview…</p>}
      {data && <>
        {(unavailable.length > 0 || data.warnings.length > 0) && <details className="mb-4 rounded-md border border-border bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">{unavailable.length ? `${unavailable.length} of ${data.accounts.length} accounts unavailable` : 'Overview coverage and limits'}</summary>
          <ul className="mt-2 space-y-2 [overflow-wrap:anywhere]">{unavailable.map(account => <li key={account.id}>{account.email}: {account.error || 'Saved mail is unavailable for this account.'}</li>)}{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </details>}

        <div aria-label="Mailbox health" className="grid grid-cols-3 divide-x divide-border border-y border-border">
          {metricValues.map(({ label, name, value, prompt, description }) => <button key={name} type="button" aria-label={`${name}: ${amount(value)}`} title={description} onClick={() => prompt ? chooseTask(prompt) : replyHeading.current?.focus()} className="min-w-0 px-3 py-3 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
            <span className={`block font-semibold tabular-nums ${value === null || value === undefined ? 'text-xs' : 'text-xl'}`}>{amount(value)}</span>
            <span className="mt-1 block text-xs leading-4 text-muted-foreground">{label}</span>
          </button>)}
        </div>
        <p className="py-2.5 text-[11px] leading-4 text-muted-foreground">Selected accounts · Includes Sent and Archive · Excludes Spam, Trash and drafts</p>

        <div className={`assistant-dashboard-layout ${compact ? 'assistant-dashboard-layout-compact' : ''}`}>
          <div className="min-w-0">
          <section aria-label="Needs your reply" className="min-w-0">
            <div className="flex items-center justify-between gap-2 border-b border-border pb-3 pt-3">
              <div className="min-w-0 flex-1"><h3 ref={replyHeading} tabIndex={-1} className="rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary/40">Needs your reply</h3><p className="mt-1 text-xs text-muted-foreground">Saved needs-response categories{onReplyToSource ? ' · Reply all opens a draft' : ''}</p></div>
              <button type="button" onClick={() => chooseTask(dashboardPrompts.needsReply)} className={actionClass} title="Prepare a focused needs-reply search"><Search aria-hidden="true" className="h-3.5 w-3.5" /><span className="sr-only">Find what needs a reply</span></button>
            </div>
            {data.needsReply.items.length ? <ul className="divide-y divide-border/70">{data.needsReply.items.map(source => <li key={`${source.accountId}:${source.emailId}`} className="group flex min-w-0 items-center gap-1 py-0.5">
              <button type="button" aria-label={`Reply all: ${source.subject || '(No subject)'} (${source.accountEmail})`} title="Reply all" disabled={!onReplyToSource && !onNavigateToSource} onClick={() => (onReplyToSource ?? onNavigateToSource)?.(source)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md py-2 pl-1 pr-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default">
                <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 text-xs font-medium text-muted-foreground">{senderInitials(source.from)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-2"><span title={source.from} className="min-w-0 flex-1 truncate text-xs font-medium">{senderLabel(source.from)}</span><span className="shrink-0 text-[11px] text-muted-foreground">{shortDate(source.date * 1000)}</span></span>
                  <span title={source.subject || '(No subject)'} className="mt-0.5 block truncate text-sm font-medium">{source.subject || '(No subject)'}</span>
                  <span title={source.accountEmail} className="mt-0.5 block truncate text-[11px] text-muted-foreground">{source.accountEmail}</span>
                </span>
                <ReplyAll aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </button>
              <button type="button" aria-label={`Open email: ${source.subject || '(No subject)'} (${source.accountEmail})`} title="Open email" disabled={!onNavigateToSource} onClick={() => onNavigateToSource?.(source)} className={`${actionClass} px-2 text-muted-foreground`}><ExternalLink aria-hidden="true" className="h-4 w-4" /></button>
            </li>)}</ul> : <p className={emptyClass}>{data.needsReply.total === null ? 'Needs-reply mail could not be loaded.' : 'No conversations are currently categorized as needing a reply.'}</p>}
            {data.needsReply.truncated && <p className="border-t border-border/70 py-3 text-xs leading-5 text-muted-foreground">Showing a limited selection{data.needsReply.total !== null ? ` of ${amount(data.needsReply.total)} conversations` : ''}. Use the search above to check more.</p>}
          </section>

          <details className="mt-6 border-t border-border pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden"><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />Recent conversations<span className="ml-auto text-xs font-normal text-muted-foreground">{recent.length}</span></summary>
            <section aria-label="Recent conversations" className="pt-2"><div className="flex justify-end"><button type="button" onClick={onNewConversation} className={actionClass}><Plus aria-hidden="true" className="h-3 w-3" />New conversation</button></div>
              {recent.length ? <ul className="divide-y divide-border/70">{recent.map(chat => <li key={chat.id}><button type="button" aria-label={`Continue conversation: ${chat.title}`} onClick={() => onOpenConversation(chat.id)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-2.5 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                {chat.activeRun ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}<span className="min-w-0 flex-1"><span title={chat.title} className="block truncate text-xs font-medium">{chat.title}</span><span className="mt-1 block text-[11px] text-muted-foreground">{chat.activeRun ? 'Working in background' : `${chat.exchangeCount} saved ${chat.exchangeCount === 1 ? 'answer' : 'answers'}`}</span></span><span className="shrink-0 text-[11px] text-muted-foreground">{shortDate(chat.updatedAt)}</span>
              </button></li>)}</ul> : <p className="py-2 text-xs text-muted-foreground">Your saved conversations will appear here.</p>}
            </section>
          </details>
          <section aria-label="Current conversation usage" className="mt-4 space-y-2 border-t border-border pt-3">
            <p title={currentConversationTitle} className="truncate text-[11px] text-muted-foreground">Current conversation usage{currentConversationTitle ? ` · ${currentConversationTitle}` : ''}</p>
            {currentConversationUsage ? <AssistantUsage usage={currentConversationUsage} variant="conversation" compact /> : <p className="text-xs leading-5 text-muted-foreground">No usage recorded for the loaded conversation. Missing usage is not counted as zero.</p>}
            <p className="text-[11px] text-muted-foreground">Separate from selected-account mailbox totals.</p>
          </section>
          </div>

          <aside className="assistant-dashboard-agenda min-w-0 space-y-6" aria-label="Schedule and follow-ups">
          <Panel title="Upcoming local meetings" caption={`Next 7 days · Local calendars only${data.meetings.timeZone ? ` · ${data.meetings.timeZone}` : ''}`}>
            {data.meetings.status === 'unavailable' ? <p className={emptyClass}>Local calendar events are unavailable. Refresh to try again.</p> : data.meetings.items.length ? <ul className="divide-y divide-border/70">{data.meetings.items.map(event => <li key={`${event.eventId}:${event.occurrenceId ?? event.startMs}`}>
              <button type="button" aria-label={`Open calendar event: ${event.title || '(Untitled event)'}`} disabled={!onOpenCalendarEvent} onClick={() => onOpenCalendarEvent?.({ eventId: event.eventId, startMs: event.startMs, ...(event.occurrenceId ? { occurrenceId: event.occurrenceId } : {}) })} className="flex w-full min-w-0 items-start gap-3 rounded-md py-2.5 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default">
                <span aria-hidden="true" className="w-9 shrink-0 text-center"><span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{dateLabel(event.startMs, { weekday: 'short' }, data.meetings.timeZone)}</span><span className="mt-0.5 block text-lg font-medium leading-5">{dateLabel(event.startMs, { day: 'numeric' }, data.meetings.timeZone)}</span></span>
                <span className="min-w-0 flex-1 space-y-1"><span title={event.title || '(Untitled event)'} className="block truncate text-xs font-medium">{event.title || '(Untitled event)'}</span><span className="block text-xs text-muted-foreground">{event.allDay ? 'All day' : `${dateLabel(event.startMs, { hour: 'numeric', minute: '2-digit' }, data.meetings.timeZone)}–${dateLabel(event.endMs, { hour: 'numeric', minute: '2-digit' }, data.meetings.timeZone)}`}</span><span title={event.calendarName} className="block truncate text-[11px] text-muted-foreground">{event.calendarName}</span></span>
              </button>
            </li>)}</ul> : <p className="py-2 text-xs leading-5 text-muted-foreground">No upcoming local events in the next 7 days.</p>}
          </Panel>

          <div className="border-t border-border pt-4"><Panel title="Follow-ups due" caption="Reminders for sent messages">
            {data.followUps.items.length ? <ul className="divide-y divide-border/70">{data.followUps.items.map(item => <li key={`${item.accountId}:${item.id}`} className="flex min-w-0 items-start gap-2 py-2.5">
              <Clock3 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1">
              {item.source && onNavigateToSource ? <button type="button" aria-label={`Open follow-up: ${item.subject || '(No subject)'}`} title={item.subject || '(No subject)'} onClick={() => onNavigateToSource(item.source!)} className="block w-full truncate rounded-sm text-left text-xs font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{item.subject || '(No subject)'}</button> : <p title={item.subject || '(No subject)'} className="truncate text-xs font-medium">{item.subject || '(No subject)'}</p>}
              <p className="mt-1 text-[11px] text-muted-foreground">Due {dateLabel(item.dueAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
              {item.to && <p title={item.to} className="mt-1 truncate text-[11px] text-muted-foreground">To {item.to}</p>}<p title={knownAccounts.get(item.accountId)} className="mt-1 truncate text-[11px] text-muted-foreground">{knownAccounts.get(item.accountId) || 'Account unavailable'}</p>
              </div>
            </li>)}</ul> : <p className="py-2 text-xs leading-5 text-muted-foreground">{data.followUps.total === null ? 'Follow-up reminders could not be loaded.' : 'No follow-up reminders are due.'}</p>}
            {data.followUps.truncated && <p className="pt-2 text-xs leading-5 text-muted-foreground">This list is limited; more due reminders may remain.</p>}
          </Panel>
          </div>
          </aside>
        </div>
      </>}
    </>}
  </section>;
}
