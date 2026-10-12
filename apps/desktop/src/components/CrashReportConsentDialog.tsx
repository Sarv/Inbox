import { useEffect, useRef, useState } from 'react';

import {
  CRASH_REPORT_DISCLOSURE,
  loadCrashReportChoice,
  saveCrashReportChoice,
  useCrashReportChoice,
} from '../services/crash-report-choice';
import { trapDialogTab } from '../utils/modal-focus';

/**
 * The one-time "Send crash reports to Sarv?" question (CASA L-8).
 *
 * Crash reporting is off until the user says yes, so it has to be asked. This
 * is self-hiding, like UpdateDialog: it renders nothing unless the MAIN
 * process reports the question as not yet answered (`unasked`) — so it shows
 * on the first launch, and once on the next launch for an install from before
 * reporting became opt-in — and only while onboarding is not on screen
 * (`suppressed`), so a new user meets it after setup, not on top of it.
 *
 * Both buttons record an answer in main. Escape or a click outside closes it
 * WITHOUT one: the question comes back on the next launch, and until then
 * nothing is sent. Neither answer is pre-focused, so Enter can't consent.
 */
export function CrashReportConsentDialog({ suppressed }: { suppressed: boolean }) {
  const choice = useCrashReportChoice();
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { void loadCrashReportChoice(); }, []);

  const open = choice === 'unasked' && !suppressed && !dismissed;

  // While open the dialog owns the keyboard (the mail list's shortcuts must not
  // act underneath it): Escape closes without an answer, Tab stays inside.
  useEffect(() => {
    if (!open) return;
    heading.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
      } else {
        trapDialogTab(event, dialog.current);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  const answer = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    const saved = await saveCrashReportChoice(enabled);
    setSaving(false);
    // On success main's answer is no longer `unasked` and the dialog closes by
    // itself; on failure it stays, so the answer is not silently lost.
    if (!saved) setError('Your answer could not be saved. Try again, or choose later in Settings → General.');
  };

  // Equal weight for both answers: this is a consent question, not a
  // call-to-action.
  const buttonClass =
    'px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap border border-border hover:bg-muted/50 transition-colors disabled:opacity-50 w-full sm:w-auto';

  // z-250 like UpdateDialog: above the app's overlays, below the z-300
  // confirmation dialog.
  return (
    <div
      ref={dialog}
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 p-4"
      onClick={() => setDismissed(true)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="crash-consent-title"
      aria-describedby="crash-consent-body"
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="crash-consent-title" ref={heading} tabIndex={-1} className="text-lg font-semibold mb-2 outline-none">
          Send crash reports to Sarv?
        </h3>
        <div id="crash-consent-body" className="text-sm text-muted-foreground space-y-2">
          <p>{CRASH_REPORT_DISCLOSURE}</p>
          <p>You can change this at any time in Settings → General.</p>
        </div>

        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          <button type="button" onClick={() => void answer(false)} disabled={saving} className={buttonClass}>
            Don’t send
          </button>
          <button type="button" onClick={() => void answer(true)} disabled={saving} className={buttonClass}>
            Send crash reports
          </button>
        </div>
      </div>
    </div>
  );
}
