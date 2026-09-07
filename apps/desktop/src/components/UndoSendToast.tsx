import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useEmailStore } from '../store/email-store';

const TOAST_DURATION = 5000;

export function UndoSendToast() {
  const pendingSend = useEmailStore(s => s.pendingSend);
  const undoSend = useEmailStore(s => s.undoSend);
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    if (!pendingSend) {
      setProgress(100);
      return;
    }

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
  }, [pendingSend]);

  if (!pendingSend) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[200] bg-foreground text-background rounded-lg shadow-2xl overflow-hidden min-w-[300px]">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="text-sm font-medium">Sending email...</span>
        <span className="text-xs opacity-60 ml-1">Press "u" to undo</span>
        <button
          onClick={undoSend}
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
