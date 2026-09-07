import { AlertTriangle, X, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getAIHealth, subscribeAIHealth, type AIHealth } from '../services/ai-service';

/**
 * Inline banner shown when the AI provider has failed (bad key, unreachable,
 * persistent error). AI background loops pause while inactive; clicking "Fix"
 * opens AI provider settings where a passing Test reactivates AI (the test's
 * success calls reportAIHealthy, which flips this banner off).
 */
export function AIStatusBanner({ onFix }: { onFix: () => void }) {
  const [health, setHealth] = useState<AIHealth>(getAIHealth());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribeAIHealth((h) => {
    setHealth(h);
    if (h.healthy) setDismissed(false); // reset so a future failure shows again
  }), []);

  if (health.healthy || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-sm text-amber-800 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="flex-1 min-w-0 truncate">
        <span className="font-semibold">AI is inactive.</span>{' '}
        <span className="opacity-90">{health.reason}</span>{' '}
        <span className="opacity-70">AI features are paused until the provider is fixed.</span>
      </span>
      <button
        onClick={onFix}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 font-medium text-amber-900 dark:text-amber-200 transition-colors flex-shrink-0"
      >
        <Wrench className="h-3.5 w-3.5" />
        Fix
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-amber-500/20 transition-colors flex-shrink-0"
        title="Dismiss (AI stays inactive until fixed)"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
