import { Loader2, Trash2, MessageSquare } from 'lucide-react';
import { useState, useEffect } from 'react';

import type { AIProvider } from '../../../services/ai-service';
import type { AIFeatureConfig } from '../types';
import { DEFAULT_AI_FEATURES, AI_FEATURES_KEY } from '../types';

interface ConversationTabProps {
  aiProviders: AIProvider[];
}

export function ConversationTab({ aiProviders }: ConversationTabProps) {
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
  const [clearResult, setClearResult] = useState<string | null>(null);

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
        console.error('Failed to parse AI features:', e);
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

  const handleClearCache = async () => {
    if (!confirm('Clear all cached conversation extractions? This cannot be undone.')) {
      return;
    }
    setClearing(true);
    setClearResult(null);
    try {
      const result = await window.electronAPI.ai.clearAllConversations();
      if (result.success) {
        setClearResult(`Cleared ${result.data || 0} cached conversation(s).`);
      } else {
        setClearResult('Failed to clear cache.');
      }
    } catch (error) {
      console.error('Failed to clear conversation cache:', error);
      setClearResult('Failed to clear cache.');
    } finally {
      setClearing(false);
      setTimeout(() => setClearResult(null), 3000);
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
            When you switch to Chat View on a multi-message thread, AI analyzes the email HTML to extract
            individual messages from quoted/forwarded content. This is especially useful when you're looped
            into a conversation mid-thread — the first email often contains the entire prior conversation
            as nested quotes.
          </p>
          <p>
            Extracted messages are cached per thread. When new emails arrive, only the new message is processed
            (incremental update), saving tokens and time.
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
            <span className="text-sm text-muted-foreground">{clearResult}</span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Clear all cached conversation extractions. Threads will be re-processed on next Chat View toggle.
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
