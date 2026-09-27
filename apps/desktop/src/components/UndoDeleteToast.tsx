import { useCallback } from 'react';

import { useEmailStore } from '../store/email-store';
import type { PendingDelete } from '../store/types';

import { UndoToastCard, useCountdownProgress } from './UndoToastCard';

const TOAST_DURATION = 5000;

function SingleDeleteToast({ entry, onUndo }: { entry: PendingDelete; onUndo: (emailId: string) => void }) {
  const progress = useCountdownProgress(TOAST_DURATION, entry.emailId);

  return (
    <UndoToastCard message="Email deleted" progress={progress} onUndo={() => onUndo(entry.emailId)} />
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
