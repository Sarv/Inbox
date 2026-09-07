import { Undo2 } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';

import { useEmailStore } from '../store/email-store';
import type { PendingDelete } from '../store/types';

const TOAST_DURATION = 5000;

function SingleDeleteToast({ entry, onUndo }: { entry: PendingDelete; onUndo: (emailId: string) => void }) {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    setProgress(100);
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 100 - (elapsed / TOAST_DURATION) * 100);
      setProgress(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [entry.emailId]);

  return (
    <div className="bg-foreground text-background rounded-lg shadow-2xl overflow-hidden min-w-[300px]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-sm font-medium">Email deleted</span>
        <span className="text-xs opacity-60 ml-1">Press "u" to undo</span>
        <button
          onClick={() => onUndo(entry.emailId)}
          className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium bg-background/20 hover:bg-background/30 rounded transition-colors ml-auto"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
      </div>
      <div className="h-0.5 bg-background/10">
        <div
          className="h-full bg-primary transition-all duration-75 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

export function UndoDeleteToast() {
  const pendingDeletes = useEmailStore(s => s.pendingDeletes);
  const undoDelete = useEmailStore(s => s.undoDelete);

  const handleUndo = useCallback((emailId: string) => {
    undoDelete(emailId);
  }, [undoDelete]);

  if (pendingDeletes.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[200] flex flex-col-reverse gap-2">
      {pendingDeletes.map(entry => (
        <SingleDeleteToast key={entry.emailId} entry={entry} onUndo={handleUndo} />
      ))}
    </div>
  );
}
