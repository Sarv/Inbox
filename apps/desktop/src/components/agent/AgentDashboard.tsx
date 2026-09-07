import {
  Bot, RefreshCw, Inbox, PenLine, Activity, Brain, Users, Clock,
  Eye, Star, Archive, Trash2, Reply, Send, AlertTriangle, Tag, Mail,
  CheckCircle2, X, ChevronRight, Hourglass, ThumbsDown, Zap,
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';

import { Tooltip } from '../Tooltip';

// ========== IPC shapes (mirror agent-handlers.ts return statements) ==========

interface IpcResult<T> { success: boolean; data?: T; error?: string }

/** agent_decisions row (storage-node rowToDecision) */
interface DecisionRow {
  id: string; emailId: string; threadId: string | null; senderAddress: string | null;
  proposedAction: string; confidence: number; reasoning: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'auto' | 'expired' | 'overridden';
  userFeedback: string | null;
  proposedAt: number; resolvedAt: number | null;
  draftBody?: string; draftSubject?: string; draftReasoning?: string;
}

/**
 * user_feedback marker meaning "the agent actually SENT this reply via SMTP"
 * (auto-send enabled + confidence above threshold). Kept in lockstep with
 * REPLY_SENT_FEEDBACK in electron/services/unified-pipeline-service.ts.
 * Sent replies must not be listed under "Drafts ready" — there's no draft.
 */
const REPLY_SENT_FEEDBACK = 'reply-sent-by-agent';

/** agent:getProposals enriches pending decisions with email metadata */
interface ProposalRow extends DecisionRow { subject: string; fromName: string; fromAddress: string }

/** agent:getAgentActions enriches user_action_log rows the same way */
interface ActionEntry {
  id: string; emailId: string; actionType: string; source: string;
  /** 'auto-sent' on agent reply rows that were SMTP-sent (vs drafted) */
  actionValue: string | null;
  senderAddress: string | null; timestamp: number; subject: string; fromName: string;
}

interface ActionStats {
  totalActions: number; actionCounts: Record<string, number>;
  topSenders: { email: string; actionCount: number }[];
  avgActionsPerDay: number; mostActiveHour: number;
}

interface AccuracyMetrics { total: number; approved: number; rejected: number; accuracy: number }
interface SenderTiers { vip: string[]; noise: string[]; regular: string[] }
interface LearningSummary { totalActions: number; fromHistory: number; fromLive: number; uniqueSenders: number }
interface PipelineStats { totalEmails: number; agentPending: number; agentDone: number }
interface ReadinessRow { slug: string; name: string; totalActions: number; dominantAction: string | null; rate: number; ready: boolean }

/** Typed facade — some runtime-exposed methods are missing from the preload type surface. */
interface AgentIpc {
  getProposals(): Promise<IpcResult<ProposalRow[]>>;
  resolveProposal(id: string, approved: boolean, actualAction?: string, feedback?: string): Promise<IpcResult<unknown>>;
  getDecisionHistory(limit?: number, offset?: number): Promise<IpcResult<DecisionRow[]>>;
  getAccuracyMetrics(days?: number): Promise<IpcResult<AccuracyMetrics>>;
  getAgentActions(limit?: number): Promise<IpcResult<ActionEntry[]>>;
  undoAction(actionId: string): Promise<IpcResult<{ undone: string; emailId: string }>>;
  getActionStats(since?: number): Promise<IpcResult<ActionStats>>;
  getSenderTiers(): Promise<IpcResult<SenderTiers>>;
  getPeakHours(): Promise<IpcResult<number[]>>;
  getContactTypeCounts(): Promise<IpcResult<Record<string, number>>>;
  getLearningSummary(): Promise<IpcResult<LearningSummary>>;
  getPipelineStats(): Promise<IpcResult<PipelineStats>>;
  getCategoryReadiness(): Promise<IpcResult<ReadinessRow[]>>;
  onDraftReady(cb: (d: { emailId: string }) => void): () => void;
  onPipelineStats(cb: (d: { extractionPending?: number; agentPending?: number }) => void): () => void;
}

const agentIpc = (): AgentIpc => window.electronAPI.agent as unknown as AgentIpc;

// ========== Display maps ==========

const ACTION_ICONS: Record<string, typeof Mail> = {
  read: Eye, unread: Mail, reply: Reply, reply_all: Reply, forward: Send,
  archive: Archive, delete: Trash2, star: Star, unstar: Star,
  spam: AlertTriangle, important: Tag, unimportant: Tag, label_add: Tag, open: Eye,
};

const ACTION_LABELS: Record<string, string> = {
  read: 'Read', unread: 'Marked unread', reply: 'Replied', reply_all: 'Replied all',
  forward: 'Forwarded', archive: 'Archived', delete: 'Deleted', spam: 'Marked spam',
  star: 'Starred', unstar: 'Unstarred', important: 'Marked important',
  unimportant: 'Unmarked important', open: 'Opened', snooze: 'Snoozed',
};
// Agent phrasing differs where the agent's act isn't literally the user's act.
// Reply rows with actionValue 'auto-sent' are labelled separately in
// ActivitySection ("Drafted & sent reply") — these cover the drafted-only case.
const AGENT_LABEL_OVERRIDES: Record<string, string> = {
  read: 'Marked as read', reply: 'Saved draft reply', reply_all: 'Saved draft reply', spam: 'Moved to spam',
};

// Label strings kept in lockstep with Contacts.tsx CONTACT_TYPE_OPTIONS.
const CONTACT_TYPE_LABELS: Record<string, string> = {
  existing_customer: 'Customer', potential_customer: 'Prospect', churned_customer: 'Churned',
  colleague: 'Colleague', vendor: 'Vendor', personal: 'Personal', recruiter: 'Recruiter',
  newsletter: 'Newsletter', automated: 'Automated', unknown: 'Unknown',
};
const CONTACT_TYPE_ORDER = Object.keys(CONTACT_TYPE_LABELS);

const UNDOABLE_ACTIONS = ['read', 'star', 'archive', 'important'];

// ========== Helpers ==========

function timeAgo(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

function dayLabel(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function snippet(text: string | null | undefined, max = 130): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Agent on/off chip reads the same localStorage config AgentTab persists. */
function readAgentMode(): 'off' | 'suggest' | 'auto' {
  try {
    const raw = localStorage.getItem('sarvinbox-agent-config');
    if (!raw) return 'off';
    const cfg = JSON.parse(raw);
    if (cfg?.enabled !== true) return 'off';
    return (cfg.autoRead || cfg.autoTriage || cfg.autoReply) ? 'auto' : 'suggest';
  } catch { return 'off'; }
}

interface DraftReadyRow extends DecisionRow { subject: string; fromName: string }

interface DashboardData {
  proposals: ProposalRow[]; draftsReady: DraftReadyRow[]; actions: ActionEntry[];
  stats: ActionStats | null; tiers: SenderTiers | null; accuracy: AccuracyMetrics | null;
  peakHours: number[]; contactCounts: Record<string, number>;
  learning: LearningSummary | null; pipeline: PipelineStats | null; readiness: ReadinessRow[];
}

const EMPTY_DATA: DashboardData = {
  proposals: [], draftsReady: [], actions: [], stats: null, tiers: null,
  accuracy: null, peakHours: [], contactCounts: {}, learning: null, pipeline: null, readiness: [],
};

// ========== Main component ==========

export function AgentDashboard({ onNavigateToEmail, onNavigateToContacts }: {
  onNavigateToEmail?: (emailId: string) => void;
  onNavigateToContacts?: () => void;
}) {
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [agentMode, setAgentMode] = useState<'off' | 'suggest' | 'auto'>(readAgentMode);
  const mountedRef = useRef(true);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true); else setRefreshing(true);
    setAgentMode(readAgentMode());
    const api = agentIpc();
    try {
      const [proposals, history, accuracy, actions, stats, tiers, peak, contacts, learning, pipeline, readiness] =
        await Promise.allSettled([
          api.getProposals(), api.getDecisionHistory(100, 0), api.getAccuracyMetrics(30),
          api.getAgentActions(150), api.getActionStats(), api.getSenderTiers(), api.getPeakHours(),
          api.getContactTypeCounts(), api.getLearningSummary(), api.getPipelineStats(), api.getCategoryReadiness(),
        ]);

      const ok = <T,>(r: PromiseSettledResult<IpcResult<T>>): T | null =>
        r.status === 'fulfilled' && r.value?.success && r.value.data !== undefined ? r.value.data : null;

      const next: DashboardData = {
        proposals: ok(proposals) ?? [], draftsReady: [], actions: ok(actions) ?? [],
        stats: ok(stats), tiers: ok(tiers), accuracy: ok(accuracy),
        peakHours: ok(peak) ?? [], contactCounts: ok(contacts) ?? {},
        learning: ok(learning), pipeline: ok(pipeline), readiness: ok(readiness) ?? [],
      };

      // Drafts the pipeline already wrote to the Drafts folder (status flips
      // pending → auto once the IMAP save succeeds). Decision rows carry no
      // subject, so enrich the few we show from the emails table. Replies the
      // agent auto-SENT also carry status 'auto' + a draft body, but they're
      // not waiting in Drafts — exclude them (they show in Activity instead).
      const drafted = (ok(history) ?? [])
        .filter(d => d.status === 'auto' && !!d.draftBody?.trim() && d.userFeedback !== REPLY_SENT_FEEDBACK)
        .slice(0, 8);
      next.draftsReady = await Promise.all(drafted.map(async d => {
        let subject = '', fromName = '';
        try {
          const res = await window.electronAPI.emails.get(d.emailId);
          if (res.success && res.data) { subject = res.data.subject || ''; fromName = res.data.fromName || ''; }
        } catch { /* deleted email — sender address still renders */ }
        return { ...d, subject, fromName };
      }));

      const allFailed = [proposals, history, actions, stats, learning, pipeline]
        .every(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success));
      if (mountedRef.current) {
        setLoadError(allFailed);
        if (!allFailed) setData(next);
      }
    } catch {
      if (mountedRef.current) setLoadError(true);
    } finally {
      if (mountedRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load(true);
    // Auto-refresh when the pipeline announces a finished draft. Debounced —
    // drafts can land in quick bursts during a processing batch.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = agentIpc().onDraftReady(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => load(false), 800);
      });
    } catch { /* preload unavailable in tests */ }
    // Live backlog counters: refresh (debounced) whenever the pipeline reports
    // stats, so the pending/queue numbers stay current without a remount.
    let statsUnsub: (() => void) | undefined;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      statsUnsub = agentIpc().onPipelineStats(() => {
        if (statsTimer) clearTimeout(statsTimer);
        statsTimer = setTimeout(() => load(false), 800);
      });
    } catch { /* preload unavailable in tests */ }
    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
      if (statsTimer) clearTimeout(statsTimer);
      if (typeof unsubscribe === 'function') unsubscribe();
      if (typeof statsUnsub === 'function') statsUnsub();
    };
  }, [load]);

  const handleDismissProposal = async (id: string) => {
    // Same semantics as dismissing the inline AI draft (InlineReply):
    // rejected + 'dismissed' is the negative learning signal.
    const res = await agentIpc().resolveProposal(id, false, 'dismissed');
    if (res.success && mountedRef.current) {
      setData(prev => ({ ...prev, proposals: prev.proposals.filter(p => p.id !== id) }));
    }
  };

  const isFirstRun = (data.learning?.totalActions ?? 0) === 0 && data.proposals.length === 0 &&
    data.actions.length === 0 && (data.pipeline?.agentDone ?? 0) === 0;

  return (
    <div className="flex-1 h-full overflow-hidden bg-background">
      <div className="h-full flex flex-col">
        <Header agentMode={agentMode} learning={data.learning} refreshing={refreshing || loading} onRefresh={() => load(false)} />
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-6 py-6">
            {loading ? <DashboardSkeleton />
              : loadError ? <ErrorState onRetry={() => load(true)} />
              : isFirstRun ? <FirstRunState agentMode={agentMode} />
              : (
                <div className="space-y-6">
                  <StatRow data={data} />
                  <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
                    <div className="space-y-6 min-w-0">
                      <ReviewSection proposals={data.proposals} onOpen={onNavigateToEmail} onDismiss={handleDismissProposal} />
                      <DraftsSection drafts={data.draftsReady} onOpen={onNavigateToEmail} />
                      <ActivitySection actions={data.actions} onOpen={onNavigateToEmail} />
                    </div>
                    <InsightsColumn data={data} onNavigateToContacts={onNavigateToContacts} />
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ========== Header ==========

function Header({ agentMode, learning, refreshing, onRefresh }: {
  agentMode: 'off' | 'suggest' | 'auto'; learning: LearningSummary | null;
  refreshing: boolean; onRefresh: () => void;
}) {
  const chip = {
    off: { label: 'Off', cls: 'bg-muted text-muted-foreground' },
    suggest: { label: 'Suggest only', cls: 'bg-violet-500/10 text-violet-600 dark:text-violet-400' },
    auto: { label: 'Active', cls: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  }[agentMode];

  return (
    <div className="px-6 py-4 border-b border-border">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-violet-500/10 flex items-center justify-center flex-shrink-0">
            <Bot className="h-5 w-5 text-violet-600 dark:text-violet-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold leading-tight">Email Agent</h1>
              {/* Informational only — agent settings live in AI Settings */}
              <Tooltip maxWidth={260} content="Turn the agent on or off and tune autonomy in Settings → AI Settings → Email Agent.">
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium cursor-help ${chip.cls}`}>{chip.label}</span>
              </Tooltip>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {learning && learning.totalActions > 0
                ? `Learned from ${learning.totalActions.toLocaleString()} actions across ${learning.uniqueSenders.toLocaleString()} senders`
                : 'Watches how you handle email and learns to help'}
            </p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-60 flex-shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
    </div>
  );
}

// ========== Stat row ==========

function StatRow({ data }: { data: DashboardData }) {
  const agentActions = data.actions.filter(a => a.source === 'agent_auto' || a.source === 'agent_approved');
  const reviewed = data.accuracy?.total ?? 0;
  const disagree = reviewed > 0 ? Math.round(((data.accuracy?.rejected ?? 0) / reviewed) * 100) : null;
  const pending = data.pipeline?.agentPending ?? 0;

  const cards = [
    { icon: <Inbox className="h-4 w-4 text-blue-500" />, label: 'Emails analyzed', value: (data.pipeline?.agentDone ?? 0).toLocaleString(), sub: pending > 0 ? `${pending.toLocaleString()} in queue` : 'all caught up' },
    { icon: <Zap className="h-4 w-4 text-violet-500" />, label: 'Actions taken', value: agentActions.length.toLocaleString(), sub: 'auto + approved, recent' },
    { icon: <PenLine className="h-4 w-4 text-green-500" />, label: 'Drafts ready', value: data.draftsReady.length.toLocaleString(), sub: 'waiting in your Drafts' },
    { icon: <ThumbsDown className="h-4 w-4 text-orange-500" />, label: 'Disagreement rate', value: disagree === null ? '—' : `${disagree}%`, sub: reviewed > 0 ? `of ${reviewed} reviewed (30d)` : 'no reviewed decisions yet' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map(c => (
        <div key={c.label} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">{c.icon}{c.label}</div>
          <div className="text-2xl font-semibold leading-none">{c.value}</div>
          <div className="text-[11px] text-muted-foreground mt-1.5">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ========== Sections ==========

function SectionCard({ icon, title, count, children }: {
  icon: React.ReactNode; title: string; count?: number; children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        {icon}
        <h2 className="text-sm font-medium">{title}</h2>
        {count !== undefined && count > 0 && (
          <span className="text-[11px] px-1.5 py-0.5 bg-muted rounded-full text-muted-foreground tabular-nums">{count}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function ReviewSection({ proposals, onOpen, onDismiss }: {
  proposals: ProposalRow[]; onOpen?: (emailId: string) => void; onDismiss: (id: string) => void;
}) {
  return (
    <SectionCard icon={<Hourglass className="h-4 w-4 text-violet-500" />} title="Needs your review" count={proposals.length}>
      {proposals.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          Nothing waiting on you — finished drafts go straight to your Drafts folder; only replies the agent couldn't finish land here.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {proposals.slice(0, 10).map(p => (
            <div key={p.id} className="px-4 py-3 flex items-start gap-3 hover:bg-accent/30 transition-colors">
              <Reply className="h-4 w-4 text-violet-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{p.fromName || p.fromAddress || p.senderAddress || 'Unknown sender'}</span>
                  <span className="text-[11px] text-muted-foreground flex-shrink-0">{timeAgo(p.proposedAt)}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">{p.subject || '(no subject)'}</div>
                <div className="text-xs text-muted-foreground/80 mt-1">
                  {p.draftBody?.trim()
                    ? <>Suggested reply: <span className="italic">“{snippet(p.draftBody, 110)}”</span></>
                    : snippet(p.reasoning, 110) || 'Wants to reply — draft is being prepared'}
                  <span className="ml-1.5 text-violet-600 dark:text-violet-400">{Math.round(p.confidence * 100)}% confident</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {/* No executable approve path over IPC — opening the email
                    surfaces the draft inline, where Send approves it. */}
                <button
                  onClick={() => onOpen?.(p.emailId)}
                  className="text-xs px-2.5 py-1 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/20 transition-colors font-medium"
                >
                  {p.draftBody?.trim() ? 'Open draft' : 'Open'}
                </button>
                <Tooltip content="Dismiss — the agent learns you didn't want this">
                  <button
                    onClick={() => onDismiss(p.id)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function DraftsSection({ drafts, onOpen }: { drafts: DraftReadyRow[]; onOpen?: (emailId: string) => void }) {
  if (drafts.length === 0) return null;
  return (
    <SectionCard icon={<PenLine className="h-4 w-4 text-green-500" />} title="Drafts ready" count={drafts.length}>
      <div className="divide-y divide-border">
        {drafts.map(d => (
          <button
            key={d.id}
            onClick={() => onOpen?.(d.emailId)}
            className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-accent/30 transition-colors"
          >
            <Mail className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">{d.fromName || d.senderAddress || 'Unknown sender'}</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400 rounded-full flex-shrink-0">in Drafts</span>
                <span className="text-[11px] text-muted-foreground flex-shrink-0 ml-auto">{timeAgo(d.resolvedAt || d.proposedAt)}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate">{d.subject || '(no subject)'}</div>
              <div className="text-xs text-muted-foreground/80 italic mt-0.5 truncate">“{snippet(d.draftBody, 110)}”</div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground/50 mt-1 flex-shrink-0" />
          </button>
        ))}
      </div>
      <div className="px-4 py-2 border-t border-border text-[11px] text-muted-foreground">
        Open one to review and send — sending teaches the agent it got it right.
      </div>
    </SectionCard>
  );
}

function ActivitySection({ actions, onOpen }: { actions: ActionEntry[]; onOpen?: (emailId: string) => void }) {
  const [filter, setFilter] = useState<'agent' | 'all'>('agent');
  const [undoing, setUndoing] = useState<string | null>(null);
  const [undoneIds, setUndoneIds] = useState<Set<string>>(new Set());

  const isAgent = (a: ActionEntry) => a.source === 'agent_auto' || a.source === 'agent_approved';
  const visible = (filter === 'agent' ? actions.filter(isAgent) : actions).slice(0, 50);

  const handleUndo = async (id: string) => {
    setUndoing(id);
    try {
      const res = await agentIpc().undoAction(id);
      if (res.success) setUndoneIds(prev => new Set(prev).add(id));
    } catch { /* row simply stays actionable */ } finally {
      setUndoing(null);
    }
  };

  const groups: { day: string; entries: ActionEntry[] }[] = [];
  for (const a of visible) {
    const day = dayLabel(a.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(a);
    else groups.push({ day, entries: [a] });
  }

  return (
    <SectionCard icon={<Activity className="h-4 w-4 text-blue-500" />} title="Activity">
      <div className="px-4 pt-3 flex items-center gap-1">
        <FilterPill active={filter === 'agent'} onClick={() => setFilter('agent')} label="Agent" />
        <FilterPill active={filter === 'all'} onClick={() => setFilter('all')} label="Everything" />
      </div>
      {visible.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {filter === 'agent'
            ? 'The agent hasn’t taken any actions yet. When it marks something read, archives noise, or drafts a reply, it shows up here.'
            : 'No activity recorded yet.'}
        </div>
      ) : (
        <div className="px-2 pb-2 pt-1">
          {groups.map(g => (
            <div key={g.day}>
              <div className="text-[11px] font-medium text-muted-foreground px-2 pt-3 pb-1">{g.day}</div>
              {g.entries.map(a => {
                const agent = isAgent(a);
                // Agent replies come in two flavours: drafted (waits in your
                // Drafts) vs auto-sent (actionValue 'auto-sent', SMTP-sent).
                const isAutoSentReply = agent
                  && (a.actionType === 'reply' || a.actionType === 'reply_all')
                  && a.actionValue === 'auto-sent';
                const Icon = isAutoSentReply ? Send : (ACTION_ICONS[a.actionType] || Mail);
                const undone = undoneIds.has(a.id);
                const canUndo = agent && !undone && UNDOABLE_ACTIONS.includes(a.actionType);
                const label = isAutoSentReply
                  ? 'Drafted & sent reply'
                  : (agent && AGENT_LABEL_OVERRIDES[a.actionType]) || ACTION_LABELS[a.actionType] || a.actionType;
                return (
                  <div
                    key={a.id}
                    onClick={() => onOpen?.(a.emailId)}
                    className={`flex items-center gap-3 px-2 py-2 rounded-lg cursor-pointer transition-colors ${undone ? 'opacity-40' : 'hover:bg-accent/30'}`}
                  >
                    <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${agent ? 'text-violet-500' : 'text-muted-foreground'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs">
                        <span className="font-medium">{label}</span>
                        <span className="text-muted-foreground"> · {a.fromName || a.senderAddress || 'unknown'}</span>
                        {agent && (
                          <span className="ml-1.5 text-[10px] px-1.5 py-px bg-violet-500/10 text-violet-600 dark:text-violet-400 rounded-full">Agent</span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">{a.subject || a.senderAddress || ''}</div>
                    </div>
                    {undone && <span className="text-[10px] text-muted-foreground flex-shrink-0">Undone</span>}
                    {canUndo && (
                      <button
                        onClick={e => { e.stopPropagation(); handleUndo(a.id); }}
                        disabled={undoing === a.id}
                        className="text-[11px] px-2 py-0.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 flex-shrink-0"
                      >
                        {undoing === a.id ? '…' : 'Undo'}
                      </button>
                    )}
                    <span className="text-[11px] text-muted-foreground flex-shrink-0 tabular-nums">
                      {new Date(a.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function FilterPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-full transition-colors ${active ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:bg-accent'}`}
    >
      {label}
    </button>
  );
}

// ========== Insights column ==========

function InsightsColumn({ data, onNavigateToContacts }: { data: DashboardData; onNavigateToContacts?: () => void }) {
  return (
    <div className="space-y-4">
      <ReadinessCard rows={data.readiness} />
      <TopSendersCard stats={data.stats} />
      <SenderTiersCard tiers={data.tiers} />
      <ContactsCard counts={data.contactCounts} onNavigateToContacts={onNavigateToContacts} />
      <PeakHoursCard peakHours={data.peakHours} />
    </div>
  );
}

function InsightCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">{icon}<h3 className="text-xs font-medium">{title}</h3></div>
      {children}
    </div>
  );
}

function ReadinessCard({ rows }: { rows: ReadinessRow[] }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => Number(b.ready) - Number(a.ready) || b.totalActions - a.totalActions);
  return (
    <InsightCard icon={<Brain className="h-3.5 w-3.5 text-violet-500" />} title="Automation readiness">
      <p className="text-[11px] text-muted-foreground mb-2">
        A category can auto-act once your own handling of it is consistent (5+ samples, 85%+ one action).
      </p>
      <div className="space-y-1.5">
        {sorted.slice(0, 6).map(r => (
          <div key={r.slug} className="flex items-center gap-2 text-xs">
            <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${r.ready ? 'bg-green-500' : r.totalActions > 0 ? 'bg-amber-500' : 'bg-muted-foreground/30'}`} />
            <span className="truncate flex-1">{r.name}</span>
            <span className="text-muted-foreground text-[11px] flex-shrink-0">
              {r.ready ? `${r.dominantAction} ${Math.round(r.rate * 100)}%`
                : r.totalActions > 0 ? `learning (${r.totalActions})` : 'no signal'}
            </span>
          </div>
        ))}
      </div>
    </InsightCard>
  );
}

function TopSendersCard({ stats }: { stats: ActionStats | null }) {
  const senders = stats?.topSenders?.slice(0, 6) ?? [];
  if (senders.length === 0) return null;
  const max = senders[0].actionCount || 1;
  return (
    <InsightCard icon={<Mail className="h-3.5 w-3.5 text-blue-500" />} title="Most interaction">
      <div className="space-y-2">
        {senders.map(s => (
          <div key={s.email} className="text-xs">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="truncate">{s.email}</span>
              <span className="text-muted-foreground tabular-nums flex-shrink-0">{s.actionCount}</span>
            </div>
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-blue-500/60 rounded-full" style={{ width: `${Math.max(4, Math.round((s.actionCount / max) * 100))}%` }} />
            </div>
          </div>
        ))}
      </div>
    </InsightCard>
  );
}

function SenderTiersCard({ tiers }: { tiers: SenderTiers | null }) {
  if (!tiers || (tiers.vip.length === 0 && tiers.noise.length === 0)) return null;
  const rows = [
    { label: 'VIP', hint: 'you consistently reply', senders: tiers.vip, tone: 'text-green-600 dark:text-green-400' },
    { label: 'Noise', hint: 'archived or deleted unread', senders: tiers.noise, tone: 'text-orange-600 dark:text-orange-400' },
  ];
  return (
    <InsightCard icon={<Star className="h-3.5 w-3.5 text-amber-500" />} title="Sender tiers">
      <div className="space-y-2.5">
        {rows.map(r => (
          <div key={r.label}>
            <div className="text-[11px] mb-1">
              <span className={`font-medium ${r.tone}`}>{r.label} ({r.senders.length})</span>
              <span className="text-muted-foreground"> — {r.hint}</span>
            </div>
            {r.senders.length === 0 ? (
              <div className="text-[11px] text-muted-foreground italic">none yet</div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {r.senders.slice(0, 4).map(e => (
                  <span key={e} className="text-[10px] px-1.5 py-0.5 bg-muted rounded-full truncate max-w-[120px]">{e}</span>
                ))}
                {r.senders.length > 4 && <span className="text-[10px] text-muted-foreground px-1 py-0.5">+{r.senders.length - 4}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </InsightCard>
  );
}

function ContactsCard({ counts, onNavigateToContacts }: { counts: Record<string, number>; onNavigateToContacts?: () => void }) {
  const entries = CONTACT_TYPE_ORDER.map(t => ({ type: t, count: counts[t] || 0 })).filter(e => e.count > 0);
  if (entries.length === 0) return null;
  return (
    <InsightCard icon={<Users className="h-3.5 w-3.5 text-cyan-500" />} title="Contacts by type">
      <div className="flex flex-wrap gap-1.5 mb-3">
        {entries.map(e => (
          <span key={e.type} className="text-[11px] px-2 py-0.5 bg-muted rounded-full">
            {CONTACT_TYPE_LABELS[e.type]} <span className="text-muted-foreground tabular-nums">{e.count}</span>
          </span>
        ))}
      </div>
      <button
        onClick={onNavigateToContacts}
        className="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:underline"
      >
        Browse and edit in Contacts <ChevronRight className="h-3 w-3" />
      </button>
    </InsightCard>
  );
}

function PeakHoursCard({ peakHours }: { peakHours: number[] }) {
  if (peakHours.length === 0) return null;
  const fmt = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
  return (
    <InsightCard icon={<Clock className="h-3.5 w-3.5 text-muted-foreground" />} title="Your active hours">
      <div className="flex items-end gap-px h-10 mb-1">
        {Array.from({ length: 24 }, (_, h) => {
          const rank = peakHours.indexOf(h); // -1 if not a peak hour
          return (
            <div key={h} className="flex-1 flex flex-col justify-end">
              <div
                className={`w-full rounded-sm ${rank === -1 ? 'bg-muted' : 'bg-violet-500/70'}`}
                style={{ height: `${rank === -1 ? 18 : 100 - rank * 14}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground"><span>12am</span><span>12pm</span><span>11pm</span></div>
      <p className="text-[11px] text-muted-foreground mt-2">Most active around {peakHours.slice(0, 2).map(fmt).join(' and ')}.</p>
    </InsightCard>
  );
}

// ========== Loading / error / empty states ==========

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-24 rounded-xl bg-muted/50" />)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6">
        <div className="space-y-6">
          <div className="h-40 rounded-xl bg-muted/50" />
          <div className="h-64 rounded-xl bg-muted/40" />
        </div>
        <div className="space-y-4">
          <div className="h-36 rounded-xl bg-muted/40" />
          <div className="h-44 rounded-xl bg-muted/30" />
        </div>
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500 mb-3" />
      <div className="text-sm font-medium">Couldn't load agent data</div>
      <p className="text-xs text-muted-foreground mt-1 max-w-sm">
        The agent database didn't respond. This usually resolves once the app finishes starting up.
      </p>
      <button
        onClick={onRetry}
        className="mt-4 flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
      >
        <RefreshCw className="h-3.5 w-3.5" /> Try again
      </button>
    </div>
  );
}

function FirstRunState({ agentMode }: { agentMode: 'off' | 'suggest' | 'auto' }) {
  const steps = [
    { icon: <Eye className="h-4 w-4 text-blue-500" />, title: 'Observes', text: 'Every read, reply, archive and delete — plus your existing email history — becomes a learning signal.' },
    { icon: <Brain className="h-4 w-4 text-violet-500" />, title: 'Learns', text: 'It builds per-sender and per-category patterns: who you always answer, what you archive on sight.' },
    { icon: <Zap className="h-4 w-4 text-green-500" />, title: 'Acts', text: 'It drafts replies into your Drafts folder and, once a pattern is solid, can mark noise read or archive it for you.' },
  ];
  return (
    <div className="max-w-2xl mx-auto py-12">
      <div className="flex flex-col items-center text-center mb-8">
        <div className="h-14 w-14 rounded-2xl bg-violet-500/10 flex items-center justify-center mb-4">
          <Bot className="h-7 w-7 text-violet-600 dark:text-violet-400" />
        </div>
        <h2 className="text-lg font-semibold">Your email agent is getting set up</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-md">
          Nothing to show yet — it starts learning as soon as your mailbox syncs and you use your email.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {steps.map(s => (
          <div key={s.title} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-1.5">{s.icon}<span className="text-sm font-medium">{s.title}</span></div>
            <p className="text-xs text-muted-foreground leading-relaxed">{s.text}</p>
          </div>
        ))}
      </div>
      {agentMode === 'off' && (
        <p className="text-xs text-muted-foreground text-center mt-6">
          AI Assist is currently off — enable it in Settings → AI Settings → Email Agent to let the agent categorize, score, and draft.
        </p>
      )}
    </div>
  );
}
