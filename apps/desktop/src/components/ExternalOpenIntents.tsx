import { CalendarDays, Copy, Loader2, Mail, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ExternalOpenIntent } from '../types/default-apps';
import type { LocalCalendar } from '../types/local-calendar';
import { trapDialogTab } from '../utils/modal-focus';

export type ExternalComposeSeed = Omit<Extract<ExternalOpenIntent, { kind: 'compose' }>, 'id' | 'kind'>;
export interface ExternalOpenIntentsProps {
  suppressed?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Return false when an existing unsaved draft should remain untouched. */
  onCompose: (seed: ExternalComposeSeed) => boolean | Promise<boolean>;
}

/** Consumes OS open requests only after the user-facing handoff succeeds. */
export function ExternalOpenIntents({ suppressed = false, onCompose, onOpenChange }: ExternalOpenIntentsProps) {
  const api = window.electronAPI?.defaultApps;
  const calendarApi = window.electronAPI?.calendar;
  const [intent, setIntent] = useState<ExternalOpenIntent | null>(null);
  const [calendars, setCalendars] = useState<LocalCalendar[]>([]);
  const [calendarId, setCalendarId] = useState('');
  const [calendarOwner, setCalendarOwner] = useState<string | null>(null);
  const [loadingCalendars, setLoadingCalendars] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState<{ count: number; calendarName: string } | null>(null);
  const [composeReady, setComposeReady] = useState(false);
  const [composeDeclined, setComposeDeclined] = useState(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);
  const currentId = useRef(intent?.id);
  currentId.current = intent?.id;
  const pendingFor = useRef<string | null>(null);
  const attemptedCompose = useRef<string | null>(null);
  const acceptedCompose = useRef<string | null>(null);
  const composeCallback = useRef(onCompose);
  composeCallback.current = onCompose;
  const refreshPending = useRef<() => Promise<void>>(async () => {});
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const openChange = useRef(onOpenChange); openChange.current = onOpenChange;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!api?.getPendingOpen || !api.onPendingOpen) return;
    let alive = true; let generation = 0;
    const read = async () => {
      const current = ++generation;
      try {
        const result = await api.getPendingOpen();
        if (!alive || current !== generation || !result.success) return;
        setIntent(previous => previous?.id === result.data?.id ? previous : result.data);
      } catch { /* A pending request remains in main until it can be read. */ }
    };
    refreshPending.current = read;
    const unsubscribe = api.onPendingOpen(() => { void read(); });
    void read();
    return () => { alive = false; generation += 1; unsubscribe(); refreshPending.current = async () => {}; };
  }, [api]);

  useEffect(() => {
    setBusy(false); setError(''); setImported(null); setComposeReady(false); setComposeDeclined(false); setCopied(false);
  }, [intent?.id]);

  useEffect(() => {
    if (intent?.kind !== 'calendar-import') return;
    const id = intent.id;
    let alive = true;
    setCalendars([]); setCalendarId(''); setCalendarOwner(null); setLoadingCalendars(true);
    void (async () => {
      try {
        if (!calendarApi?.snapshot) throw new Error('Local calendars are unavailable in this version of Inbox.');
        const startMs = Date.now();
        const result = await calendarApi.snapshot({ startMs, endMs: startMs + 86_400_000 });
        if (!alive || currentId.current !== id) return;
        if (!result.success) throw new Error(result.error);
        const local = result.data.calendars.filter(calendar => calendar.provider === 'local');
        setCalendars(local); setCalendarId((local.find(calendar => calendar.isDefault) ?? local[0])?.id ?? ''); setCalendarOwner(id);
        if (!local.length) setError('Create a local calendar in Calendar before importing this file.');
      } catch (failure) {
        if (alive && currentId.current === id) setError(failure instanceof Error ? failure.message : 'Local calendars could not be loaded.');
      } finally { if (alive && currentId.current === id) setLoadingCalendars(false); }
    })();
    return () => { alive = false; };
  }, [intent?.id, intent?.kind, calendarApi]);

  const acknowledge = useCallback(async (id: string) => {
    if (!api) throw new Error('The system-open request could not be acknowledged.');
    const result = await api.acknowledgeOpen(id);
    if (!result.success) throw new Error(result.error || 'The system-open request could not be acknowledged.');
    if (!mounted.current || currentId.current !== id) return;
    setIntent(null);
    await refreshPending.current();
  }, [api]);

  const deliverCompose = useCallback(async (value: Extract<ExternalOpenIntent, { kind: 'compose' }>) => {
    const id = value.id;
    if (pendingFor.current === id) return;
    pendingFor.current = id; attemptedCompose.current = id; setBusy(true); setError(''); setComposeReady(false); setComposeDeclined(false);
    try {
      if (acceptedCompose.current !== id) {
        const accepted = await composeCallback.current({ to: value.to, cc: value.cc, bcc: value.bcc, subject: value.subject, body: value.body });
        if (!mounted.current || currentId.current !== id) return;
        if (!accepted) { setComposeDeclined(true); setComposeReady(true); return; }
        acceptedCompose.current = id;
      }
      await acknowledge(id);
    } catch (failure) {
      if (mounted.current && currentId.current === id) { setError(failure instanceof Error ? failure.message : 'This email link could not be opened.'); setComposeReady(true); }
    } finally {
      if (pendingFor.current === id) pendingFor.current = null;
      if (mounted.current && currentId.current === id) setBusy(false);
    }
  }, [acknowledge]);

  useEffect(() => {
    if (intent?.kind === 'compose' && !suppressed && attemptedCompose.current !== intent.id) void deliverCompose(intent);
  }, [intent, suppressed, deliverCompose]);

  const close = async () => {
    if (!intent || pendingFor.current === intent.id) return;
    const id = intent.id; pendingFor.current = id; setBusy(true); setError('');
    try { await acknowledge(id); }
    catch (failure) { if (mounted.current && currentId.current === id) setError(failure instanceof Error ? failure.message : 'This request could not be closed.'); }
    finally { if (pendingFor.current === id) pendingFor.current = null; if (mounted.current && currentId.current === id) setBusy(false); }
  };
  const closeRef = useRef(close); closeRef.current = close;
  const open = !!intent && !suppressed && (intent.kind !== 'compose' || composeReady);
  useEffect(() => { openChange.current?.(open); }, [open]);
  useEffect(() => () => { openChange.current?.(false); }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    heading.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); void closeRef.current(); }
      else trapDialogTab(event, dialog.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);

  if (!open || !intent) return null;
  const importEvents = async () => {
    if (intent.kind !== 'calendar-import' || !calendarApi || !calendarId || calendarOwner !== intent.id || imported || pendingFor.current === intent.id) return;
    const id = intent.id; pendingFor.current = id; setBusy(true); setError('');
    try {
      if (!calendarApi.importFileIcs) throw new Error('Calendar file import is unavailable. Update Inbox and try again.');
      const result = await calendarApi.importFileIcs({ calendarId, text: intent.text });
      if (!mounted.current || currentId.current !== id) return;
      if (!result.success) throw new Error(result.error);
      setImported({ count: result.data.imported, calendarName: calendars.find(calendar => calendar.id === calendarId)?.name ?? 'the selected calendar' });
    } catch (failure) { if (mounted.current && currentId.current === id) setError(failure instanceof Error ? failure.message : 'This calendar file could not be imported.'); }
    finally { if (pendingFor.current === id) pendingFor.current = null; if (mounted.current && currentId.current === id) setBusy(false); }
  };
  const copyLink = async () => {
    if (intent.kind !== 'calendar-link') return;
    try { await navigator.clipboard.writeText(intent.url); if (mounted.current && currentId.current === intent.id) { setCopied(true); setError(''); } }
    catch { if (mounted.current && currentId.current === intent.id) setError('The link could not be copied. Select and copy it from the field.'); }
  };
  const title = intent.kind === 'calendar-import' ? 'Import calendar file' : intent.kind === 'calendar-link' ? 'Calendar subscription link' : 'Email link ready';
  const buttonClass = 'rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/50 disabled:opacity-50';
  return <div role="dialog" aria-modal="true" aria-labelledby="external-open-title" className="fixed inset-0 z-[245] flex items-center justify-center bg-black/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget) void close(); }}>
    <div ref={dialog} className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-6 text-foreground shadow-xl">
      <header className="flex items-start justify-between gap-4"><h2 id="external-open-title" ref={heading} tabIndex={-1} className="flex items-center gap-2 text-lg font-semibold outline-none">{intent.kind === 'compose' ? <Mail size={19} /> : <CalendarDays size={19} />}{title}</h2><button type="button" disabled={busy} onClick={() => void close()} aria-label="Close system-open request" className="rounded p-1 text-muted-foreground hover:bg-muted/50 disabled:opacity-50"><X size={18} /></button></header>
      {intent.kind === 'calendar-import' ? <div className="mt-4 space-y-4 text-sm"><p className="break-words font-medium">{intent.filename}</p>{imported ? <p role="status">{imported.count} {imported.count === 1 ? 'event imported' : 'events imported'} into {imported.calendarName}.</p> : <><p className="leading-6 text-muted-foreground">Choose a local calendar for these events. Importing adds events to Inbox; it does not connect or sync another calendar.</p><p className="leading-6 text-muted-foreground">Import a local copy. This does not send a meeting response.</p>{loadingCalendars ? <p role="status" className="flex items-center gap-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" />Loading local calendars…</p> : <label className="block text-sm">Calendar<select aria-label="Import into local calendar" value={calendarId} onChange={event => setCalendarId(event.target.value)} disabled={busy || !calendars.length} className="mt-2 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm [color-scheme:light] dark:[color-scheme:dark]">{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>}</>}</div>
        : intent.kind === 'calendar-link' ? <div className="mt-4 space-y-4 text-sm"><p className="leading-6 text-muted-foreground">Calendar subscriptions are not supported in this local-calendar phase. This link has not been fetched or added. You can import an .ics file into a local calendar instead.</p><textarea aria-label="Calendar subscription URL" readOnly value={intent.url} rows={3} className="block w-full resize-none rounded-md border border-border bg-muted/30 p-3 text-xs leading-5" /><button type="button" onClick={() => void copyLink()} className={`${buttonClass} flex items-center gap-2`}><Copy size={14} />{copied ? 'Copied' : 'Copy link'}</button></div>
          : <p className="mt-4 text-sm leading-6 text-muted-foreground">{acceptedCompose.current === intent.id ? 'The email draft is open. Inbox could not clear this system-open request yet; retry to acknowledge it without creating another draft.' : composeDeclined ? 'Your current draft has been kept. Open this email link when you are ready to start its draft.' : 'This email link is waiting to open. Retry when you are ready.'}</p>}
      {error && <p role="alert" className="mt-4 text-sm leading-5 text-destructive">{error}</p>}
      <footer className="mt-6 flex flex-wrap justify-end gap-2"><button type="button" disabled={busy} onClick={() => void close()} className={buttonClass}>{imported ? 'Done' : intent.kind === 'calendar-import' ? 'Cancel' : 'Close'}</button>{intent.kind === 'calendar-import' && !imported && <button type="button" disabled={busy || loadingCalendars || calendarOwner !== intent.id || !calendarId} onClick={() => void importEvents()} className={`${buttonClass} border-transparent bg-foreground text-background hover:bg-foreground/90`}>{busy ? 'Working…' : 'Import events'}</button>}{intent.kind === 'compose' && <button type="button" disabled={busy} onClick={() => void deliverCompose(intent)} className={buttonClass}>{acceptedCompose.current === intent.id ? 'Retry acknowledgement' : 'Open email draft'}</button>}</footer>
    </div>
  </div>;
}
