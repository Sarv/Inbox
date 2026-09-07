import { Send } from 'lucide-react';

import { SmtpConfigForm } from '../SmtpConfigForm';

interface SMTPStepProps {
  onNext: () => void;
  onBack: () => void;
}

/** Onboarding step 3: SMTP (sending). OPTIONAL — you can skip and set it up
 *  later; until then mail queues in the Outbox and compose/reply show a banner. */
export function SMTPStep({ onNext, onBack }: SMTPStepProps) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Send className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">Set Up Sending</h2>
          <p className="text-sm text-muted-foreground">
            Enter your SMTP details to send mail. We prefilled a guess from your login — verify, or skip and set it up later.
          </p>
        </div>
      </div>
      <SmtpConfigForm onVerified={onNext} onBack={onBack} submitLabel="Verify & Continue" />
      <button
        type="button"
        onClick={onNext}
        className="w-full mt-3 text-sm text-muted-foreground hover:text-foreground py-1"
      >
        Skip for now — I'll set up sending later
      </button>
    </div>
  );
}
