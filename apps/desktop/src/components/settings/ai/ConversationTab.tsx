import type { FirstSplitClearAllResult } from '@sarvinbox/core/first-split';
import { createLogger } from '@sarvinbox/core/logger';
import { Loader2, Trash2, MessageSquare } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';

import { syncBackgroundSplitToMain } from '../../../services/ai-features';
import type { AIProvider } from '../../../services/ai-service';
import { useEmailStore } from '../../../store/email-store';
import type { AIFeatureConfig } from '../types';
import { DEFAULT_AI_FEATURES, AI_FEATURES_KEY } from '../types';

const log = createLogger('ConversationTab');

/** How long a successful Clear Cache result stays on screen. A failure stays until the next click. */
const CLEAR_RESULT_MS = 3000;

interface ConversationTabProps {
  aiProviders: AIProvider[];
}

/** The outcome of Clear Cache, as shown beside the button. */
interface ClearOutcome {
  text: string;
  failed: boolean;
}

/**
 * What Clear Cache reports, from main's all-accounts answer. An account main
 * could not clear is NAMED (its address when this window knows it, else its
 * id) — never folded into the count, which would read as "that account had
 * nothing saved" while its splits are still there.
 */
export function clearCacheOutcome(
  response: { success: boolean; data?: FirstSplitClearAllResult; error?: string } | undefined,
  addressOf: (accountId: string) => string,
): ClearOutcome {
  if (!response?.success || !response.data) {
    return { text: `Could not clear the cache${response?.error ? `: ${response.error}` : '.'}`, failed: true };
  }
  // `splits`, not `cleared`: the table also holds the scheduler's bookkeeping
  // rows (`skipped` for every thread without quoted history, retries,
  // failures), which are gone too but were never splits.
  const { splits, failedAccounts } = response.data;
  const clearedText = `Cleared ${splits} saved split${splits === 1 ? '' : 's'}.`;
  if (failedAccounts.length === 0) return { text: clearedText, failed: false };
  const names = failedAccounts.map(addressOf).join(', ');
  return { text: `${clearedText} Could not clear ${names} — try again.`, failed: true };
}

export function ConversationTab({ aiProviders }: ConversationTabProps) {
  const accounts = useEmailStore((s) => s.accounts);
  const [feature, setFeature] = useState<AIFeatureConfig>(
    DEFAULT_AI_FEATURES.find(f => f.id === 'conversation-mode')!
  );
  const [autoFeature, setAutoFeature] = useState<AIFeatureConfig>(
    DEFAULT_AI_FEATURES.find(f => f.id === 'auto-chat-view')!
  );
  const [extractFeature, setExtractFeature] = useState<AIFeatureConfig>(
    DEFAULT_AI_FEATURES.find(f => f.id === 'auto-chat-extract')!
  );
  const [clearing, setClearing] = useState(false);
  const [clearResult, setClearResult] = useState<ClearOutcome | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending "hide the result" timer must not fire into an unmounted tab.
  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  // Load feature state on mount
  useEffect(() => {
    const stored = localStorage.getItem(AI_FEATURES_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const saved = parsed.find((f: AIFeatureConfig) => f.id === 'conversation-mode');
        if (saved) {
          const defaultFeature = DEFAULT_AI_FEATURES.find(f => f.id === 'conversation-mode')!;
          setFeature({
            ...defaultFeature,
            enabled: saved.enabled,
          });
        }
        const savedAuto = parsed.find((f: AIFeatureConfig) => f.id === 'auto-chat-view');
        if (savedAuto) {
          const defaultAuto = DEFAULT_AI_FEATURES.find(f => f.id === 'auto-chat-view')!;
          setAutoFeature({
            ...defaultAuto,
            enabled: savedAuto.enabled,
          });
        }
        const savedExtract = parsed.find((f: AIFeatureConfig) => f.id === 'auto-chat-extract');
        if (savedExtract) {
          const defaultExtract = DEFAULT_AI_FEATURES.find(f => f.id === 'auto-chat-extract')!;
          setExtractFeature({
            ...defaultExtract,
            enabled: savedExtract.enabled,
          });
        }
      } catch (e) {
        // The toggles fall back to their defaults; say why, once.
        log.warn(`Could not read the stored AI features: ${String(e)}`);
      }
    }
  }, []);

  const saveFeatureById = (id: string, updated: AIFeatureConfig) => {
    if (id === 'conversation-mode') setFeature(updated);
    else if (id === 'auto-chat-view') setAutoFeature(updated);
    else if (id === 'auto-chat-extract') setExtractFeature(updated);

    const stored = localStorage.getItem(AI_FEATURES_KEY);
    let features: AIFeatureConfig[] = DEFAULT_AI_FEATURES;
    if (stored) {
      try {
        features = JSON.parse(stored);
      } catch {}
    }
    const hasFeature = features.some(f => f.id === id);
    const merged = hasFeature
      ? features.map(f => f.id === id ? updated : f)
      : [...features, updated];
    localStorage.setItem(AI_FEATURES_KEY, JSON.stringify(merged));
    // Main's first-split scheduler scans and nominates only while the
    // background split is on (conversation mode AND 'Auto Chat Extract').
    void syncBackgroundSplitToMain();
  };

  const toggleFeature = () => {
    const updated = { ...feature, enabled: !feature.enabled };
    saveFeatureById('conversation-mode', updated);
    // If disabling conversation mode, also disable sub-features
    if (!updated.enabled) {
      if (autoFeature.enabled) saveFeatureById('auto-chat-view', { ...autoFeature, enabled: false });
      if (extractFeature.enabled) saveFeatureById('auto-chat-extract', { ...extractFeature, enabled: false });
    }
  };

  const toggleAutoFeature = () => {
    saveFeatureById('auto-chat-view', { ...autoFeature, enabled: !autoFeature.enabled });
  };

  const toggleExtractFeature = () => {
    saveFeatureById('auto-chat-extract', { ...extractFeature, enabled: !extractFeature.enabled });
  };

  const addressOf = (accountId: string): string =>
    accounts.find((account) => account.id === accountId)?.email || accountId;

  const handleClearCache = async () => {
    if (!confirm('Clear the saved AI splits in every account? Each looped-in conversation is split again the next time it needs it. This cannot be undone.')) {
      return;
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
    setClearing(true);
    setClearResult(null);
    let response: Parameters<typeof clearCacheOutcome>[0];
    try {
      response = await window.electronAPI.ai.clearAllFirstSplits();
    } catch (error) {
      response = { success: false, error: (error as Error)?.message };
    }
    const outcome = clearCacheOutcome(response, addressOf);
    // Main logs each account it could not clear; this line ties it to the click.
    if (outcome.failed) {
      log.warn(`Clear Cache incomplete: ${response?.data ? `${response.data.failedAccounts.length} account(s) not cleared` : response?.error ?? 'no answer'}`);
    }
    setClearResult(outcome);
    setClearing(false);
    // A failure stays on screen until the next click: it names what is still saved.
    if (!outcome.failed) {
      clearTimerRef.current = setTimeout(() => setClearResult(null), CLEAR_RESULT_MS);
    }
  };

  return (
    <div className="space-y-6">
      {/* Feature toggle card */}
      <div className={`rounded-lg border p-4 ${feature.enabled ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <MessageSquare className={`h-5 w-5 flex-shrink-0 ${feature.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                {feature.name}
                {feature.enabled && (
                  <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-600 dark:text-green-400 rounded-full">Active</span>
                )}
              </div>
              <div className="text-sm text-muted-foreground">{feature.description}</div>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              checked={feature.enabled}
              onChange={toggleFeature}
              className="sr-only peer"
              disabled={aiProviders.length === 0}
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
          </label>
        </div>
      </div>

      {/* Auto Chat View toggle */}
      {feature.enabled && (
        <div className={`rounded-lg border p-4 ${autoFeature.enabled ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <MessageSquare className={`h-5 w-5 flex-shrink-0 ${autoFeature.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="min-w-0">
                <div className="font-medium flex items-center gap-2">
                  {autoFeature.name}
                  {autoFeature.enabled && (
                    <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-600 dark:text-green-400 rounded-full">Active</span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">{autoFeature.description}</div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input
                type="checkbox"
                checked={autoFeature.enabled}
                onChange={toggleAutoFeature}
                className="sr-only peer"
                disabled={aiProviders.length === 0}
              />
              <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
      )}

      {/* Auto Chat Extract toggle */}
      {feature.enabled && (
        <div className={`rounded-lg border p-4 ${extractFeature.enabled ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <MessageSquare className={`h-5 w-5 flex-shrink-0 ${extractFeature.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
              <div className="min-w-0">
                <div className="font-medium flex items-center gap-2">
                  {extractFeature.name}
                  {extractFeature.enabled && (
                    <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-600 dark:text-green-400 rounded-full">Active</span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground">{extractFeature.description}</div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input
                type="checkbox"
                checked={extractFeature.enabled}
                onChange={toggleExtractFeature}
                className="sr-only peer"
                disabled={aiProviders.length === 0}
              />
              <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </div>
      )}

      {/* How it works */}
      <div>
        <h3 className="text-sm font-medium mb-2">How it works</h3>
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            Chat View shows a thread as a conversation, one bubble per email. When you are looped in
            partway through, the first email you received carries the earlier conversation as quoted
            text. The AI view splits that quoted history into separate messages, each with its sender
            and date. Every later email is shown exactly as in the standard view.
          </p>
          <p>
            AI reads only that first email. It runs by itself when the first email quotes two or more
            earlier messages and the thread is open in Chat View; one that quotes a single message gets a
            Process now button instead. The List view never uses AI, and drafts are never part of the
            conversation.
          </p>
          <p>
            The result is saved for each thread, in its own account, and reused until that first email
            changes. If the AI fails, or misses part of the history, that part is shown as in the standard
            view, so nothing is dropped.
          </p>
        </div>
      </div>

      {/* Cache management */}
      <div className="pt-2 border-t border-border">
        <div className="flex items-center gap-3">
          <button
            onClick={handleClearCache}
            disabled={clearing}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-muted hover:bg-accent rounded-md transition-colors disabled:opacity-50"
          >
            {clearing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Clear Cache
          </button>
          {clearResult && (
            <span
              role="status"
              className={`text-sm ${clearResult.failed ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {clearResult.text}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Remove the saved AI splits in every account. A conversation is split again the next time it
          is needed: in the background, or when you open it in Chat View. An email that quotes a single
          message waits for Process now.
        </p>
      </div>

      {aiProviders.length === 0 && (
        <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm">
          <div className="font-medium text-yellow-600 dark:text-yellow-400">No AI Provider Configured</div>
          <div className="text-muted-foreground mt-1">
            Add an AI provider in the Providers tab to enable conversation mode.
          </div>
        </div>
      )}
    </div>
  );
}
