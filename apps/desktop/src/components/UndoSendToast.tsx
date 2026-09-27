import { useEmailStore } from '../store/email-store';

import { UndoToastCard, useCountdownProgress } from './UndoToastCard';

export function UndoSendToast() {
  const pendingSend = useEmailStore(s => s.pendingSend);
  const undoSend = useEmailStore(s => s.undoSend);
  // Counts down the window this send was actually held for — see PendingSend.
  const progress = useCountdownProgress(pendingSend?.undoDelayMs ?? 0, pendingSend);

  if (!pendingSend) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[200]">
      <UndoToastCard message="Sending email..." progress={progress} onUndo={undoSend} />
    </div>
  );
}
