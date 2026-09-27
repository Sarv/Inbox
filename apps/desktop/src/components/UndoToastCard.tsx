import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Percentage (100 → 0) of `durationMs` still left since the last change of
 * `resetKey`. Drives the countdown bar under an undo toast.
 */
export function useCountdownProgress(durationMs: number, resetKey: unknown): number {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    setProgress(100);
    if (resetKey == null) return;
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 100 - (elapsed / durationMs) * 100);
      setProgress(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [durationMs, resetKey]);

  return progress;
}

interface UndoToastCardProps {
  message: string;
  progress: number;
  onUndo: () => void;
}

/**
 * The shared "X happened — Undo" toast. Uses the theme's card surface (like
 * InAppNotification) rather than an inverted foreground/background, which
 * rendered as a white slab in dark mode.
 */
export function UndoToastCard({ message, progress, onUndo }: UndoToastCardProps) {
  return (
    <div className="bg-card text-card-foreground border border-border rounded-lg shadow-2xl overflow-hidden min-w-[300px]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-sm font-medium">{message}</span>
        <span className="text-xs text-muted-foreground ml-1">Press "u" to undo</span>
        <button
          onClick={onUndo}
          className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded transition-colors ml-auto"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      </div>
      <div className="h-0.5 bg-muted">
        <div
          className="h-full bg-primary transition-all duration-75 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
