import {
  Sparkles,
  Tag,
  Play,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Download,
  Loader2,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { useEmailStore } from '../../store/email-store';
import { useConfirm } from '../ConfirmDialog';

import { AIProgressPanel } from './AIProgressPanel';
import { planBodyDownload, targetForChoice, DOWNLOAD_BATCH } from './body-download-plan';
import type { AICategoryCounts, CategoryDefinition } from './types';
import { ICON_MAP, COLOR_MAP } from './types';

export function AIBoxDashboard() {
  const {
    aiCategoryCountsLastUpdate,
    aiProcessing,
    setAIBoxActiveTab,
    processEmailsForAICategorization,
  } = useEmailStore();

  const { choose, confirmDialog } = useConfirm();
  const [download, setDownload] = useState<{
    active: boolean; target: number; downloaded: number; remaining: number;
  } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [categoryCounts, setCategoryCounts] = useState<AICategoryCounts>({});
  const [unprocessedCount, setUnprocessedCount] = useState<number>(0);
  const [categoryDefs, setCategoryDefs] = useState<CategoryDefinition[]>([]);
  const [breakdown, setBreakdown] = useState<{
    total: number;
    withBody: number;
    noBody: number;
    readSkipped: number;
    aiProcessed: number;
    eligibleNow: number;
    unreadWithBody: number;
    unreadNoBody: number;
    agentPending: number;
    agentDone: number;
  } | null>(null);

  // Load category definitions
  useEffect(() => {
    const loadDefs = async () => {
      try {
        const result = await window.electronAPI.ai.getCategoryDefinitions();
        if (result.success && result.data) {
          setCategoryDefs((result.data as CategoryDefinition[]).filter(d => d.isEnabled));
        }
      } catch (error) {
        console.error('Failed to load category definitions:', error);
      }
    };
    loadDefs();
  }, [aiCategoryCountsLastUpdate]);

  // Load category counts
  useEffect(() => {
    const loadCounts = async () => {
      try {
        const result = await window.electronAPI.ai.getCategoryCounts();
        if (result.success && result.data) {
          setCategoryCounts(result.data as AICategoryCounts);
        }
      } catch (error) {
        console.error('Failed to load AI category counts:', error);
      }
    };
    loadCounts();
    const interval = setInterval(loadCounts, 30000);
    return () => clearInterval(interval);
  }, [aiCategoryCountsLastUpdate]);

  // Load unprocessed count
  useEffect(() => {
    const loadUnprocessed = async () => {
      try {
        const result = await window.electronAPI.ai.getUnprocessedEmailCount();
        if (result.success && result.data !== undefined) {
          setUnprocessedCount(result.data);
        }
      } catch (error) {
        console.error('Failed to load unprocessed count:', error);
      }
    };
    loadUnprocessed();
    const interval = setInterval(loadUnprocessed, 30000);
    return () => clearInterval(interval);
  }, [aiCategoryCountsLastUpdate]);

  // Load the per-bucket processing breakdown — explains why "100%
  // complete" can coexist with thousands of synced emails.
  useEffect(() => {
    const loadBreakdown = async () => {
      try {
        const anyApi = window.electronAPI as any;
        const res = await anyApi.ai?.getProcessingBreakdown?.();
        if (res?.success && res.data) setBreakdown(res.data);
      } catch (error) {
        console.error('Failed to load AI processing breakdown:', error);
      }
    };
    loadBreakdown();
    const interval = setInterval(loadBreakdown, 30000);
    return () => clearInterval(interval);
  }, [aiCategoryCountsLastUpdate]);

  // Live progress of a manual body download, plus whatever run was already in
  // flight when this panel mounted (the user can navigate away and back).
  useEffect(() => {
    const api = window.electronAPI.emails;
    api.getBodyDownloadState?.().then((r) => {
      if (r?.success && r.data?.active) setDownload(r.data);
    }).catch(() => { /* best-effort */ });
    const off = api.onBodyDownloadProgress?.((state) => {
      setDownload(state.active ? state : null);
      // The run just finished — pull fresh counts so the rows the user was
      // watching actually move instead of waiting out the 30s poll.
      if (!state.active) useEmailStore.setState({ aiCategoryCountsLastUpdate: Date.now() });
    });
    return () => { off?.(); };
  }, []);

  const startBodyDownload = useCallback(async () => {
    const pending = breakdown?.unreadNoBody ?? 0;
    const plan = planBodyDownload(pending);
    if (plan.empty) return;
    setDownloadError(null);

    let target = plan.batch;
    if (plan.needsPrompt) {
      const choice = await choose({
        title: 'Download email bodies',
        message:
          `${plan.all.toLocaleString()} unread emails still need their body downloaded.\n\n`
          + `Downloading all of them is a long run against your mail server. `
          + `The AI automatically categorises only the newest ${DOWNLOAD_BATCH.toLocaleString()} `
          + `emails by date — older ones keep their body for search and wait for a `
          + `"Process More" run.`,
        confirmLabel: `Download ${plan.batch.toLocaleString()} first`,
        secondaryLabel: `Download all ${plan.all.toLocaleString()}`,
        cancelLabel: 'Cancel',
        destructive: false,
      });
      const chosen = targetForChoice(choice, plan);
      if (chosen === null) return;
      target = chosen;
    }

    const res = await window.electronAPI.emails.startBodyDownload?.(target);
    if (res?.success && res.data) setDownload(res.data);
    else setDownloadError(res?.error || 'Could not start the download.');
  }, [breakdown?.unreadNoBody, choose]);

  const totalCategorized = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
  const totalEmails = totalCategorized + unprocessedCount;
  const progressPercent = totalEmails > 0 ? Math.round((totalCategorized / totalEmails) * 100) : 0;

  return (
    <div className="p-4 space-y-4">
      {confirmDialog}
      {/* Live AI Processing Panel */}
      {aiProcessing && <AIProgressPanel />}

      {/* Stats bar — always visible */}
      {!aiProcessing && (
        <div className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-500" />
              <h3 className="text-sm font-semibold">AI Email Processing</h3>
            </div>
            <button
              onClick={() => processEmailsForAICategorization()}
              className="flex items-center gap-2 px-3 py-1.5 bg-purple-500 text-white rounded-lg text-sm font-medium hover:bg-purple-600 transition-colors"
            >
              <Play className="h-3.5 w-3.5" />
              {totalCategorized > 0 ? 'Process More' : 'Start Processing'}
            </button>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-muted rounded-full overflow-hidden mb-2">
            <div
              className="h-full bg-purple-500 transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          {/* Stats */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                {totalCategorized} processed
              </span>
              <span className="flex items-center gap-1">
                <CircleDashed className="h-3.5 w-3.5 text-amber-500" />
                {unprocessedCount} pending
              </span>
            </div>
            <span>
              {progressPercent}% categorised
              {(breakdown?.agentPending ?? 0) > 0 && (
                <span className="ml-2 text-blue-600 dark:text-blue-400">
                  · agent: {breakdown!.agentPending.toLocaleString()} to go
                </span>
              )}
            </span>
          </div>

          {/* Transparency breakdown — explains why "100% complete" can
              coexist with thousands of synced emails. The categorizer's
              eligible pool is much smaller than the mailbox because of
              the body-fetch backlog and the read-skip policy. */}
          {breakdown && (
            <div className="mt-4 pt-4 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Processing breakdown
                </h4>
                <span className="text-[10px] text-muted-foreground">
                  Why "100%" doesn't mean "all your emails"
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <BreakdownRow label="Total emails synced"             value={breakdown.total} />
                <BreakdownRow label="Bodies actually downloaded"      value={breakdown.withBody} />
                <BreakdownRow label="Bodies NOT downloaded yet"       value={breakdown.noBody} tone={breakdown.noBody > 0 ? 'warn' : undefined} />
                <BreakdownRow label="Read emails (skipped by policy)" value={breakdown.readSkipped} />
                {/* NOT a queue — it counts unread mail with a body whether or
                    not the AI has finished with it, so it does not fall as work
                    completes. Labelling it "eligible pool" made it contradict
                    the 100% bar directly above: 212 "remaining" next to "0
                    pending". "Waiting for the AI" is the row below. */}
                <BreakdownRow label="Unread, body downloaded"         value={breakdown.unreadWithBody} />
                <BreakdownRow label="Unread, body still missing"      value={breakdown.unreadNoBody} tone={breakdown.unreadNoBody > 0 ? 'warn' : undefined} />
                <BreakdownRow label="Finished by the AI"              value={breakdown.aiProcessed} />
                <BreakdownRow label="Waiting to be categorised"       value={breakdown.eligibleNow} tone={breakdown.eligibleNow > 0 ? 'info' : undefined} />
                <BreakdownRow label="Waiting for priority + actions"  value={breakdown.agentPending} tone={breakdown.agentPending > 0 ? 'info' : undefined} />
                <BreakdownRow label="Scored + actioned by the agent"  value={breakdown.agentDone} />
              </div>
              {breakdown.unreadNoBody > 0 && (
                <div className="mt-3 flex items-start justify-between gap-3">
                  <div className="text-[11px] text-muted-foreground">
                    {download?.active ? (
                      <>
                        Downloading bodies — {download.downloaded.toLocaleString()} of{' '}
                        {download.target.toLocaleString()} done. They become eligible for the AI
                        as each one lands.
                      </>
                    ) : (
                      <>
                        {breakdown.unreadNoBody.toLocaleString()} unread emails are waiting for
                        their bodies. Background prefetch picks them up slowly — download them now
                        to make them eligible for the AI.
                      </>
                    )}
                    {downloadError && (
                      <div className="mt-1 text-amber-600 dark:text-amber-400">{downloadError}</div>
                    )}
                  </div>
                  {download?.active ? (
                    <button
                      onClick={async () => {
                        const res = await window.electronAPI.emails.stopBodyDownload?.();
                        if (res?.success) setDownload(null);
                      }}
                      className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-muted/50 transition-colors"
                    >
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={startBodyDownload}
                      className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors"
                    >
                      <Download className="h-3 w-3" />
                      Download bodies
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Empty state — no emails categorized yet */}
      {totalCategorized === 0 && !aiProcessing && (
        <div className="text-center py-8 text-muted-foreground">
          <p className="text-sm">No categories yet. Click "Start Processing" above to categorize your latest emails.</p>
        </div>
      )}

      {/* Dynamic category cards */}
      {totalCategorized > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {categoryDefs.map((def) => {
            const Icon = ICON_MAP[def.icon] || Tag;
            const colorSet = COLOR_MAP[def.color] || COLOR_MAP.blue;
            const count = categoryCounts[def.slug] || 0;

            return (
              <button
                key={def.slug}
                onClick={() => setAIBoxActiveTab(def.slug)}
                className={`flex items-start gap-3 p-4 rounded-lg border text-left transition-colors hover:bg-accent/50 ${
                  count > 0 ? `${colorSet.bg} ${colorSet.border}` : 'bg-card border-border'
                }`}
              >
                <div className={`p-2 rounded-lg ${count > 0 ? colorSet.bg : 'bg-muted'}`}>
                  <Icon className={`h-5 w-5 ${count > 0 ? colorSet.text : 'text-muted-foreground'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{def.name}</span>
                    <span className={`text-lg font-bold ${count > 0 ? colorSet.text : 'text-muted-foreground'}`}>
                      {count}
                    </span>
                  </div>
                  {def.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{def.description}</p>
                  )}
                </div>
                {count > 0 && (
                  <ArrowRight className="h-4 w-4 text-muted-foreground mt-2 flex-shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BreakdownRow({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'info' }) {
  const valueClass =
    tone === 'warn' ? 'text-amber-600 dark:text-amber-400 font-medium' :
    tone === 'info' ? 'text-blue-600 dark:text-blue-400 font-medium' :
    'text-foreground';
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/30 last:border-b-0 sm:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${valueClass}`}>{value.toLocaleString()}</span>
    </div>
  );
}
