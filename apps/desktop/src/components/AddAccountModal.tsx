import { useState } from 'react';

import { EmailSetupStep, type EmailSetupBusy } from './onboarding/EmailSetupStep';
import { SetupDialog } from './SetupDialog';

/** Add another mailbox with the same provider and connection flow as onboarding. */
export function AddAccountModal({ onClose }: { onClose: () => void }) {
  const [stage, setStage] = useState<'provider' | 'connection'>('provider');
  const [busy, setBusy] = useState<EmailSetupBusy>(null);
  // Native account activation has already started: closing cannot undo it.
  // OAuth remains cancelable through EmailSetupStep's unmount cleanup.
  const closeBlocked = busy === 'receiving' || busy === 'sending';

  return (
    <SetupDialog title="Add account" steps={['Provider', 'Connect']} activeStep={stage === 'provider' ? 0 : 1} onClose={onClose} closeDisabled={closeBlocked}>
      <EmailSetupStep active stage={stage} purpose="add-account" onStageChange={setStage} onBusyChange={setBusy} onConnected={onClose} />
    </SetupDialog>
  );
}
