import { ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { UnscannedWarningRequest, UnscannedWarningResponse } from '../../../electron/preload';

type WarningChoice = UnscannedWarningResponse['choice'];

const actionLabels: Record<UnscannedWarningRequest['action'], { verb: string; continueLabel: string }> = {
  view: { verb: 'View', continueLabel: 'View anyway' },
  open: { verb: 'Open', continueLabel: 'Open anyway' },
  download: { verb: 'Download', continueLabel: 'Download anyway' },
  calendar: { verb: 'Add', continueLabel: 'Add anyway' },
};

/** The trusted app owns this warning; attachment and extension frames cannot answer it. */
export function UnscannedAttachmentWarning() {
  const [pending, setPending] = useState<UnscannedWarningRequest[]>([]);
  const pendingRef = useRef(pending);
  const responding = useRef(new Set<string>());
  const activeRef = useRef(true);
  const api = window.electronAPI?.antivirus;
  pendingRef.current = pending;

  useEffect(() => {
    activeRef.current = true;
    if (!api?.onUnscannedWarning || !api.onUnscannedWarningClosed) return;
    let current = true;
    let recovering = true;
    const respondingIds = responding.current;
    const closedDuringRecovery = new Set<string>();
    const addRequest = (request: UnscannedWarningRequest) => {
      setPending((requests) => requests.some(({ id }) => id === request.id) ? requests : [...requests, request]);
    };
    const offWarning = api.onUnscannedWarning((request) => {
      addRequest(request);
    });
    const offClosed = api.onUnscannedWarningClosed((id) => {
      if (recovering) closedDuringRecovery.add(id);
      setPending((requests) => requests.filter((request) => request.id !== id));
    });
    // Subscribe before reading so a popup raised during renderer startup is
    // recovered without reviving one the host closed while the read was in flight.
    void api.getPendingUnscannedWarning?.().then((result) => {
      if (current && result.success && result.data && !closedDuringRecovery.has(result.data.id)) addRequest(result.data);
    }).catch(() => {}).finally(() => {
      recovering = false;
      closedDuringRecovery.clear();
    });
    return () => {
      current = false;
      activeRef.current = false;
      offWarning();
      offClosed();
      // A renderer closing must never leave an operation waiting for consent.
      for (const { id } of pendingRef.current) {
        if (!respondingIds.has(id)) {
          void api.respondUnscannedWarning({ id, choice: 'cancel', dontShowAgain: false }).catch(() => {});
        }
      }
    };
  }, [api]);

  const current = pending[0];
  if (!current || !api) return null;

  const respond = async (choice: WarningChoice, dontShowAgain: boolean) => {
    responding.current.add(current.id);
    try {
      const result = await api.respondUnscannedWarning({
        id: current.id, choice, dontShowAgain: choice === 'continue' && dontShowAgain,
      });
      if (result.success && activeRef.current) setPending((requests) => requests.filter(({ id }) => id !== current.id));
      return result.success;
    } finally {
      responding.current.delete(current.id);
    }
  };

  return <UnscannedWarningDialog key={current.id} request={current} respond={respond} />;
}

function UnscannedWarningDialog({ request, respond }: {
  request: UnscannedWarningRequest;
  respond(choice: WarningChoice, dontShowAgain: boolean): Promise<boolean>;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(true);
  const respondingRef = useRef(false);
  const labels = actionLabels[request.action];

  useEffect(() => {
    activeRef.current = true;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => { activeRef.current = false; previous?.focus(); };
  }, []);

  const choose = useCallback(async (choice: WarningChoice) => {
    if (respondingRef.current) return;
    respondingRef.current = true;
    setBusy(true);
    setError('');
    try {
      if (!await respond(choice, dontShowAgain) && activeRef.current) {
        setError('Could not record your choice. Try again.');
      }
    } catch {
      if (activeRef.current) setError('Could not record your choice. Try again.');
    } finally {
      respondingRef.current = false;
      if (activeRef.current) setBusy(false);
    }
  }, [dontShowAgain, respond]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Window capture precedes every document-level mail/viewer handler.
      // Keep browser button, Tab and copy defaults, while isolating the popup.
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        void choose('cancel');
      } else if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      } else if (!dialogRef.current?.contains(event.target as Node)) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [choose]);

  return (
    <div
      className="fixed inset-0 z-[310] flex items-center justify-center bg-black/50 p-4"
      onClick={() => { void choose('cancel'); }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unscanned-warning-title"
        aria-describedby="unscanned-warning-description"
        aria-busy={busy}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"><ShieldAlert size={22} aria-hidden="true" /></span>
          <h2 id="unscanned-warning-title" className="text-base font-semibold">{labels.verb} without antivirus scanning?</h2>
        </div>
        <div id="unscanned-warning-description" className="space-y-3 text-sm text-muted-foreground">
          <p><span className="font-medium text-foreground [overflow-wrap:anywhere]">{request.filename}</span> will not be checked for viruses.</p>
          <p>Harmful files can put your device and data at risk. Continue only if you trust the sender and this file.</p>
        </div>
        <div className="mt-4">
          <button
            type="button"
            role="checkbox"
            aria-checked={dontShowAgain}
            aria-describedby="unscanned-warning-preference-hint"
            disabled={busy}
            onClick={() => setDontShowAgain((remember) => !remember)}
            className="text-sm text-primary underline underline-offset-2 disabled:opacity-50"
          >
            {dontShowAgain && <span aria-hidden="true">✓ </span>}Don&apos;t show this message again
          </button>
          <p id="unscanned-warning-preference-hint" className="mt-1 text-xs text-muted-foreground">For this account while antivirus setup is missing. You can show warnings again in scanner setup.</p>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" disabled={busy} onClick={() => { void choose('cancel'); }} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Cancel</button>
          <button type="button" disabled={busy} onClick={() => { void choose('setup'); }} className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50">Set up antivirus</button>
          <button type="button" disabled={busy} onClick={() => { void choose('continue'); }} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{labels.continueLabel}</button>
        </div>
      </div>
    </div>
  );
}
