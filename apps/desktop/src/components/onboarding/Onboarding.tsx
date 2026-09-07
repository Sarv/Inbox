import { useState, useCallback } from 'react';

import { IMAPStep } from './IMAPStep';
import { SarvSignInStep } from './SarvSignInStep';
import { ShortcutTrainingStep } from './ShortcutTrainingStep';
import { SMTPStep } from './SMTPStep';

interface OnboardingProps {
  onComplete: () => void;
}

// Onboarding is Sarv-first: user authenticates via Sarv OAuth, which
// populates their profile and provisions a default LLM provider from their
// Sarv wallet. Then they connect email (Gmail OAuth or manual IMAP), then
// learn shortcuts. No separate AI-provider or profile step — both come
// from the Sarv sign-in.
const STEPS = ['Sign in with Sarv', 'Connect Email', 'Sending', 'Shortcuts'];
const TOTAL_STEPS = STEPS.length;

export function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState(1);
  const [syncStarted, setSyncStarted] = useState(false);

  const handleNext = useCallback((opts?: { mailboxConnected?: boolean }) => {
    // "Login with Sarv" connected the Sarv mailbox over OAuth during step 1
    // (IMAP + auto-derived SMTP), so Connect Email + Sending are already done —
    // jump straight to Shortcuts. Mark sync as started (addAccount kicked one
    // off) so the final step's back-guard treats it as irreversible.
    if (step === 1 && opts?.mailboxConnected) {
      setSyncStarted(true);
      setStep(TOTAL_STEPS);
      return;
    }
    if (step < TOTAL_STEPS) {
      setStep(step + 1);
    } else {
      localStorage.setItem('sarvinbox-onboarding-complete', 'true');
      onComplete();
    }
  }, [step, onComplete]);

  const handleBack = useCallback(() => {
    // Final step with sync running is irreversible — don't let the user
    // unwind it mid-sync.
    if (step > 1 && !(step === TOTAL_STEPS && syncStarted)) {
      setStep(step - 1);
    }
  }, [step, syncStarted]);

  const handleSyncStarted = useCallback(() => {
    setSyncStarted(true);
  }, []);

  const renderStep = () => {
    switch (step) {
      case 1:
        return <SarvSignInStep onNext={handleNext} />;
      case 2:
        return <IMAPStep onNext={handleNext} onBack={handleBack} onSyncStarted={handleSyncStarted} />;
      case 3:
        return <SMTPStep onNext={handleNext} onBack={handleBack} />;
      case 4:
        return <ShortcutTrainingStep onNext={handleNext} />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col items-center justify-center">
      {/* Backdrop gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/10" />

      {/* Step indicator */}
      <div className="relative z-10 flex items-center gap-2 mb-8">
        {STEPS.map((label, i) => {
          const stepNum = i + 1;
          const isActive = stepNum === step;
          const isDone = stepNum < step;
          return (
            <div key={label} className="flex items-center gap-2">
              {i > 0 && (
                <div className={`w-8 h-0.5 ${isDone ? 'bg-primary' : 'bg-border'} transition-colors`} />
              )}
              <div className="flex items-center gap-2">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-primary text-primary-foreground scale-110'
                      : isDone
                        ? 'bg-primary/80 text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {isDone ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    stepNum
                  )}
                </div>
                <span className={`text-sm hidden sm:block ${isActive ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div className="relative z-10 w-full max-w-lg px-4">
        <div className="bg-card border border-border rounded-xl shadow-2xl p-8 transition-all">
          {renderStep()}
        </div>
      </div>
    </div>
  );
}
