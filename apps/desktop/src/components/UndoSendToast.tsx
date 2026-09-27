import { useEmailStore } from '../store/email-store';

import { UndoToastCard, useCountdownProgress } from './UndoToastCard';

const TOAST_DURATION = 5000;

export function UndoSendToast() {
  const pendingSend = useEmailStore(s => s.pendingSend);
  const undoSend = useEmailStore(s => s.undoSend);
  const progress = useCountdownProgress(TOAST_DURATION, pendingSend);

  if (!pendingSend) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[200]">
      <UndoToastCard message="Sending email..." progress={progress} onUndo={undoSend} />
    </div>
  );
}
