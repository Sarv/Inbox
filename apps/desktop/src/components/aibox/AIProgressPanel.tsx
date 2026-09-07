import {
  Loader2,
  Square,
  Ban,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  RotateCw,
  Zap,
  Tag,
} from 'lucide-react';
import { useState, useEffect } from 'react';

import { useEmailStore } from '../../store/email-store';

import { ICON_MAP, COLOR_MAP } from './types';
import type { CategoryDefinition } from './types';

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}m ${secs}s`;
}

function formatRate(current: number, startTime: number): string {
  const elapsedMin = (Date.now() - startTime) / 60000;
  if (elapsedMin < 0.1 || current === 0) return '';
  const rate = Math.round(current / elapsedMin);
  return `${rate}/min`;
}

function formatETA(current: number, total: number, startTime: number): string {
  if (current === 0 || current >= total) return '';
  const elapsedMs = Date.now() - startTime;
  const msPerItem = elapsedMs / current;
  const remainingSec = Math.ceil(((total - current) * msPerItem) / 1000);
  if (remainingSec < 60) return `~${remainingSec}s left`;
  return `~${Math.ceil(remainingSec / 60)}m left`;
}

function CategoryIcon({ icon, color, className }: { icon?: string; color?: string; className?: string }) {
  const iconClass = className || 'h-3 w-3';
  const Icon = icon ? (ICON_MAP[icon] || Tag) : Tag;
  const colorSet = color ? (COLOR_MAP[color] || COLOR_MAP.blue) : COLOR_MAP.blue;
  return <Icon className={`${iconClass} ${colorSet.text}`} />;
}

interface AIProgressPanelProps {
  compact?: boolean;
}

export function AIProgressPanel({ compact = false }: AIProgressPanelProps) {
  const { aiProcessing, aiProcessingProgress, stopAIProcessing } = useEmailStore();
  const [expanded, setExpanded] = useState(false);
  const [categoryDefs, setCategoryDefs] = useState<CategoryDefinition[]>([]);

  useEffect(() => {
    const loadDefs = async () => {
      try {
        const result = await window.electronAPI.ai.getCategoryDefinitions();
        if (result.success && result.data) {
          setCategoryDefs((result.data as CategoryDefinition[]).filter(d => d.isEnabled));
        }
      } catch { /* ignore */ }
    };
    loadDefs();
  }, []);

  if (!aiProcessing || !aiProcessingProgress) {
    return null;
  }

  const progress = aiProcessingProgress;
  const isCheckingEmails = progress.total === 0;
  const percentage = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
  const elapsed = formatElapsed(progress.startTime);
  const rate = formatRate(progress.current, progress.startTime);
  const eta = formatETA(progress.current, progress.total, progress.startTime);
  const totalCategorized = Object.values(progress.categorized).reduce((a, b) => a + b, 0);

  if (compact) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-500/10 rounded-lg">
        <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
        <div className="flex flex-col">
          <span className="text-sm text-purple-600 dark:text-purple-400">
            {isCheckingEmails ? 'Checking...' : `${progress.current}/${progress.total} (${percentage}%)`}
          </span>
          <span className="text-xs text-muted-foreground">
            {isCheckingEmails ? 'Looking for unprocessed emails' : `${elapsed}${rate ? ` · ${rate}` : ''}${eta ? ` · ${eta}` : ''}`}
          </span>
        </div>
        <button
          onClick={stopAIProcessing}
          className="p-1 hover:bg-red-500/20 rounded text-red-500"
          title="Stop AI processing"
        >
          <Square className="h-3 w-3 fill-current" />
        </button>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-lg shadow-sm overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-purple-500/10 cursor-pointer"
        onClick={() => !isCheckingEmails && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
          <div>
            <div className="font-medium text-sm flex items-center gap-2">
              AI Processing
              {progress.mode === 'realtime' && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-green-500/15 text-green-600 dark:text-green-400">
                  <Zap className="h-3 w-3" /> Realtime
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {isCheckingEmails ? 'Looking for unprocessed emails...' : `Batch ${progress.currentBatch} · ${elapsed} elapsed${rate ? ` · ${rate}` : ''}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {!isCheckingEmails && (
            <div className="text-right">
              <div className="font-medium text-sm">{percentage}%</div>
              <div className="text-xs text-muted-foreground">{eta || 'calculating...'}</div>
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); stopAIProcessing(); }}
            className="p-2 hover:bg-red-500/20 rounded text-red-500"
            title="Stop processing"
          >
            <Square className="h-4 w-4 fill-current" />
          </button>
          {!isCheckingEmails && (expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />)}
        </div>
      </div>

      {/* Progress bar */}
      {!isCheckingEmails && (
        <div className="h-1.5 bg-muted">
          <div
            className="h-full bg-purple-500 transition-all duration-300"
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}

      {/* Stats bar */}
      <div className="px-4 py-2.5 border-b border-border">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {isCheckingEmails
              ? 'Checking for emails to process...'
              : `${progress.current} of ${progress.total} emails processed`}
          </span>
          <div className="flex items-center gap-3">
            {progress.retried > 0 && (
              <span className="text-amber-500 flex items-center gap-1 text-xs">
                <RotateCw className="h-3 w-3" />
                {progress.retried} retried
              </span>
            )}
            {progress.failed > 0 && (
              <span className="text-red-500 flex items-center gap-1 text-xs">
                <AlertTriangle className="h-3 w-3" />
                {progress.failed} failed
              </span>
            )}
          </div>
        </div>
        {/* Inline category counts — always visible */}
        {!isCheckingEmails && (
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground">
              {totalCategorized} categorized
            </span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">
              {progress.current - totalCategorized - (progress.categorized.spam || 0)} uncategorized
            </span>
            {(progress.categorized.spam || 0) > 0 && (
              <>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs text-red-500 flex items-center gap-1">
                  <Ban className="h-3 w-3" />
                  {progress.categorized.spam} spam
                </span>
              </>
            )}
            {progress.queueSize > 0 && (
              <>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground">
                  {progress.queueSize} pending
                </span>
              </>
            )}
            {categoryDefs.map((def) => {
              const count = progress.categorized[def.slug] || 0;
              if (count === 0) return null;
              return (
                <span key={def.slug} className="text-xs flex items-center gap-1">
                  <CategoryIcon icon={def.icon} color={def.color} className="h-3 w-3" />
                  {count}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <>
          {/* Category breakdown */}
          <div className="px-4 py-3 border-b border-border">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Category Breakdown ({totalCategorized} total)
            </div>
            <div className="grid grid-cols-4 gap-2">
              {progress.categorized.spam > 0 && (
                <div className="flex items-center gap-1.5 text-sm">
                  <Ban className="h-3.5 w-3.5 text-red-500" />
                  <span>{progress.categorized.spam} spam</span>
                </div>
              )}
              {categoryDefs.map((def) => {
                const count = progress.categorized[def.slug] || 0;
                if (count === 0) return null;
                return (
                  <div key={def.slug} className="flex items-center gap-1.5 text-sm">
                    <CategoryIcon icon={def.icon} color={def.color} className="h-3.5 w-3.5" />
                    <span>{count} {def.name.toLowerCase()}</span>
                  </div>
                );
              })}
              {totalCategorized === 0 && (
                <div className="text-sm text-muted-foreground col-span-4">
                  Processing...
                </div>
              )}
            </div>
          </div>

          {/* Recent activity */}
          {progress.recentActivity.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Recent Activity
              </div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {progress.recentActivity.map((activity, index) => (
                  <div
                    key={`${activity.emailId}-${index}`}
                    className="flex items-start gap-2 text-sm py-1"
                  >
                    <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{activity.subject}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="truncate">{activity.fromAddress}</span>
                        <span className="flex items-center gap-1">
                          {activity.categories.map(cat => {
                            const def = categoryDefs.find(d => d.slug === cat);
                            return (
                              <span key={cat} className="flex items-center gap-0.5">
                                <CategoryIcon icon={def?.icon} color={def?.color} className="h-3 w-3" />
                              </span>
                            );
                          })}
                        </span>
                        <span className="text-xs opacity-60">
                          {Math.round(activity.confidence * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error display */}
          {progress.lastError && (
            <div className="px-4 py-2 bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
              <AlertTriangle className="h-4 w-4 inline mr-2" />
              {progress.lastError}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function AIProgressInline() {
  return <AIProgressPanel compact />;
}
