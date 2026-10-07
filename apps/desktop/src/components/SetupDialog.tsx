import { Check, X } from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { trapDialogTab } from '../utils/modal-focus';

import { Tooltip } from './Tooltip';

interface SetupDialogProps {
  title: string;
  steps: readonly string[];
  activeStep: number;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
}

/** Shared onboarding-style shell for adding email and AI connections in Settings. */
export function SetupDialog({ title, steps, activeStep, onClose, closeDisabled = false, children }: SetupDialogProps) {
  const labelId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const heading = card.current?.querySelector<HTMLElement>('h1, h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    card.current?.scrollTo?.({ top: 0 });
  }, [activeStep]);

  const containKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!closeDisabled) onClose();
      return;
    }
    trapDialogTab(event, dialog.current);
  };

  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={labelId}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background/90 px-4 py-4 backdrop-blur-sm sm:py-6"
      onKeyDown={containKeyboard}
      onClick={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/10" />
      <div className="relative my-auto w-full max-w-2xl">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src="/icon.png" alt="" aria-hidden="true" className="h-10 w-10 rounded-xl" />
            <div><span className="text-xl font-semibold tracking-tight">Inbox</span><p id={labelId} className="text-sm text-muted-foreground">{title}</p></div>
          </div>
          <Tooltip content="Close setup" delayMs={40}>
            <button type="button" onClick={onClose} disabled={closeDisabled} aria-label="Close setup"
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50">
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </Tooltip>
        </div>
        <ol aria-label={`${title} progress`} className="mb-6 flex justify-center gap-4">
          {steps.map((label, step) => (
            <li key={label} aria-current={step === activeStep ? 'step' : undefined} className="flex min-w-0 flex-col items-center gap-1.5 text-center">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${step <= activeStep ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {step < activeStep ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : step + 1}
              </span>
              <span className={`text-xs ${step === activeStep ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{label}</span>
            </li>
          ))}
        </ol>
        <div ref={card} className="max-h-[calc(100dvh-180px)] overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-8 [&_h1:focus]:outline-none [&_h2:focus]:outline-none">
          {children}
        </div>
      </div>
    </div>
  );
}
