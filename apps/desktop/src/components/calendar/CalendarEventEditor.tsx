import { CalendarDays, Loader2, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { requestConfirm } from '../../store/confirm-service';
import type { LocalCalendar, LocalCalendarEventInput, LocalCalendarOccurrence, LocalCalendarPreferences, LocalCalendarRecurrence } from '../../types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, startOfLocalDate, wallClockToInstant } from '../../utils/local-calendar';
import { trapDialogTab } from '../../utils/modal-focus';

import { buttonClass, inputClass } from './calendar-view';

interface CalendarEventEditorProps {
  calendars: LocalCalendar[];
  preferences: LocalCalendarPreferences;
  date: string;
  /** Wall-clock minutes in the selected calendar time zone for a new event. */
  startMinute?: number;
  /** Used only when creating an event from the all-day row. */
  initialAllDay?: boolean;
  occurrence?: LocalCalendarOccurrence;
  onClose: () => void;
  onSaved: () => void;
}

export function CalendarEventEditor({ calendars, preferences, date, startMinute, initialAllDay = false, occurrence, onClose, onSaved }: CalendarEventEditorProps) {
  const event = occurrence?.event;
  const timeZoneSeed = event?.timeZone ?? preferences.timeZone;
  const defaultCalendar = calendars.find(calendar => calendar.isDefault) ?? calendars[0];
  const [title, setTitle] = useState(event?.title ?? '');
  const [calendarId, setCalendarId] = useState(event?.calendarId ?? defaultCalendar?.id ?? '');
  const [timeZone, setTimeZone] = useState(timeZoneSeed);
  const [allDay, setAllDay] = useState(event?.allDay ?? initialAllDay);
  const initialMinute = typeof startMinute === 'number' && Number.isInteger(startMinute) && startMinute >= 0 && startMinute < 1440 ? startMinute : 540;
  const wallTime = (minute: number) => `${addLocalDays(date, Math.floor(minute / 1440))}T${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const [start, setStart] = useState(occurrence ? instantToWallClock(occurrence.startMs, timeZoneSeed) : wallTime(initialMinute));
  const [end, setEnd] = useState(occurrence ? instantToWallClock(occurrence.endMs, timeZoneSeed) : wallTime(initialMinute + 60));
  const [startDate, setStartDate] = useState(occurrence ? dateInTimeZone(occurrence.startMs, timeZoneSeed) : date);
  const [endDate, setEndDate] = useState(occurrence ? addLocalDays(dateInTimeZone(occurrence.endMs, timeZoneSeed), event?.allDay ? -1 : 0) : date);
  const [description, setDescription] = useState(event?.description ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [busy, setBusy] = useState(event?.busy ?? true);
  const [status, setStatus] = useState(event?.status ?? 'confirmed');
  const [reminder, setReminder] = useState(event?.reminderMinutes?.toString() ?? 'none');
  const [frequency, setFrequency] = useState<LocalCalendarRecurrence['frequency'] | 'none'>(event?.recurrence?.frequency ?? 'none');
  const [interval, setInterval] = useState(event?.recurrence?.interval ?? 1);
  const [until, setUntil] = useState(event?.recurrence?.until ?? '');
  const [weekDays, setWeekDays] = useState(event?.recurrence?.weekDays ?? [new Date(`${startDate}T12:00:00Z`).getUTCDay()]);
  const [scope, setScope] = useState<'occurrence' | 'series'>(event?.recurrence || event?.parentEventId ? 'occurrence' : 'series');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    alive.current = true;
    const returnFocus = opener.current;
    return () => { alive.current = false; if (returnFocus?.isConnected) returnFocus.focus(); };
  }, []);
  useEffect(() => { if (saving) dialog.current?.focus(); }, [saving]);
  // Parent unmounts this drawer after a save; synchronous ownership prevents
  // another submit while the bridge is settling.
  const pending = useRef(false);
  const recurring = !!event?.recurrence || !!event?.parentEventId;
  const switchScope = (value: 'occurrence' | 'series') => {
    try {
      if (event && occurrence) {
        const startMs = value === 'series' ? event.startMs : occurrence.startMs;
        const endMs = value === 'series' ? event.endMs : occurrence.endMs;
        // Compute every date before changing scope so an incomplete time zone
        // cannot leave a series edit using the occurrence's dates.
        const nextStart = instantToWallClock(startMs, timeZone);
        const nextEnd = instantToWallClock(endMs, timeZone);
        const nextStartDate = value === 'series' && event.startDate ? event.startDate : dateInTimeZone(startMs, timeZone);
        const exclusiveEnd = value === 'series' && event.endDate ? event.endDate : dateInTimeZone(endMs, timeZone);
        const nextEndDate = event.allDay ? addLocalDays(exclusiveEnd, -1) : exclusiveEnd;
        setStart(nextStart); setEnd(nextEnd); setStartDate(nextStartDate); setEndDate(nextEndDate);
      }
      setScope(value); setError(null);
    } catch {
      setError('Enter a valid time zone before changing which events to edit.');
    }
  };
  const close = () => { if (!pending.current) { alive.current = false; onClose(); } };
  const save = async (submit: FormEvent) => {
    submit.preventDefault();
    if (pending.current || !title.trim() || !calendarId) return;
    pending.current = true; setSaving(true); setError(null);
    try {
      const originalStartMs = scope === 'series' ? event?.startMs : occurrence?.startMs;
      const originalEndMs = scope === 'series' ? event?.endMs : occurrence?.endMs;
      const unchangedStart = event && originalStartMs !== undefined && timeZone === event.timeZone && start === instantToWallClock(originalStartMs, timeZone);
      const unchangedEnd = event && originalEndMs !== undefined && timeZone === event.timeZone && end === instantToWallClock(originalEndMs, timeZone);
      const startMs = allDay ? startOfLocalDate(startDate, timeZone) : unchangedStart ? originalStartMs! : wallClockToInstant(start, timeZone);
      const endMs = allDay ? startOfLocalDate(addLocalDays(endDate, 1), timeZone) : unchangedEnd ? originalEndMs! : wallClockToInstant(end, timeZone);
      if (endMs <= startMs) throw new Error('The event end must be after its start.');
      const input: LocalCalendarEventInput = {
        ...(event ? { id: event.parentEventId ?? occurrence!.eventId, scope, ...(scope === 'occurrence' ? { occurrenceStartMs: event.originalStartMs ?? occurrence!.startMs } : {}) } : {}),
        calendarId, title: title.trim(), description, location, startMs, endMs, timeZone, allDay, busy, status,
        reminderMinutes: reminder === 'none' ? null : Number(reminder),
        ...(allDay ? { startDate, endDate: addLocalDays(endDate, 1) } : {}),
        ...(frequency !== 'none' && (!event || scope === 'series') ? { recurrence: { frequency, interval, ...(frequency === 'weekly' ? { weekDays } : {}), ...(until ? { until } : {}), ...(event?.recurrence?.count && !until ? { count: event.recurrence.count } : {}) } } : {}),
      };
      const result = await window.electronAPI.calendar.saveEvent(input);
      if (!result.success) throw new Error(result.error);
      if (alive.current) onSaved();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not save the event.'); }
    finally { pending.current = false; if (alive.current) setSaving(false); }
  };
  const remove = async () => {
    if (!event || pending.current) return;
    const confirmed = await requestConfirm({ title: 'Delete event', message: recurring && scope === 'series' ? 'Delete this entire recurring series?' : 'Delete this event occurrence?', confirmLabel: 'Delete event', destructive: true });
    if (!confirmed || !alive.current || pending.current) return;
    pending.current = true; setSaving(true); setError(null);
    try {
      const result = await window.electronAPI.calendar.deleteEvent({ id: event.parentEventId ?? occurrence!.eventId, scope, ...(scope === 'occurrence' ? { occurrenceStartMs: event.originalStartMs ?? occurrence!.startMs } : {}) });
      if (!result.success) throw new Error(result.error);
      if (alive.current) onSaved();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not delete the event.'); }
    finally { pending.current = false; if (alive.current) setSaving(false); }
  };
  const recurrenceUnit = frequency === 'weekly' ? 'weeks' : frequency === 'monthly' ? 'months' : 'days';
  return <div className="absolute inset-0 z-30 bg-black/10">
    <aside ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="calendar-event-heading" aria-describedby="calendar-event-summary" onKeyDown={key => { key.stopPropagation(); trapDialogTab(key, key.currentTarget); if (key.key === 'Escape') close(); }} className="absolute inset-y-0 right-0 flex w-full max-w-[30rem] flex-col border-l border-border bg-background shadow-xl outline-none">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-lg border border-border p-2 text-muted-foreground"><CalendarDays aria-hidden="true" className="h-4 w-4" /></span>
          <div><h2 id="calendar-event-heading" className="text-base font-semibold">{event ? 'Event details' : 'New event'}</h2><p id="calendar-event-summary" className="mt-0.5 text-xs text-muted-foreground">{event?.parentEventId ? 'Changes apply to this occurrence.' : recurring ? 'Choose whether to edit this event or its series.' : 'Add the time, details and reminder.'}</p></div>
        </div>
        <button type="button" disabled={saving} onClick={close} aria-label="Close event details" className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"><X aria-hidden="true" className="h-4 w-4" /></button>
      </header>
      <form onSubmit={submit => void save(submit)} aria-busy={saving} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            <label className="block space-y-1.5 text-xs font-medium">Title<input autoFocus aria-label="Event title" placeholder="Add an event title" value={title} maxLength={240} required onChange={change => setTitle(change.target.value)} className={`${inputClass} text-base`} /></label>
            <label className="block space-y-1.5 text-xs font-medium">Calendar<select aria-label="Event calendar" value={calendarId} onChange={change => setCalendarId(change.target.value)} className={inputClass}>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}</select></label>
            {recurring && <label className="block space-y-1.5 text-xs font-medium">Changes apply to<select aria-label="Event edit scope" value={scope} onChange={change => switchScope(change.target.value as 'occurrence' | 'series')} className={inputClass}><option value="occurrence">This occurrence</option>{!event?.parentEventId && <option value="series">Entire series</option>}</select></label>}
            <fieldset className="min-w-0 space-y-3 border-t border-border pt-4">
              <legend className="float-left mb-3 w-full text-xs font-semibold text-muted-foreground">Date and time</legend>
              <label className="flex clear-both items-center gap-2 text-sm"><input type="checkbox" checked={allDay} onChange={change => { const next = change.target.checked; if (next) { setStartDate(start.slice(0, 10)); setEndDate(end.slice(0, 10)); } else { setStart(`${startDate}T09:00`); setEnd(`${endDate}T10:00`); } setAllDay(next); }} />All day</label>
              <div className="space-y-3">
                <label className="block space-y-1.5 text-xs font-medium">Starts<input aria-label="Event start" type={allDay ? 'date' : 'datetime-local'} value={allDay ? startDate : start} onChange={change => allDay ? setStartDate(change.target.value) : setStart(change.target.value)} required className={inputClass} /></label>
                <label className="block space-y-1.5 text-xs font-medium">{allDay ? 'Last day' : 'Ends'}<input aria-label="Event end" aria-describedby={allDay ? 'calendar-event-all-day-help' : undefined} type={allDay ? 'date' : 'datetime-local'} value={allDay ? endDate : end} onChange={change => allDay ? setEndDate(change.target.value) : setEnd(change.target.value)} required className={inputClass} /></label>
              </div>
              {allDay && <p id="calendar-event-all-day-help" className="text-xs leading-5 text-muted-foreground">Includes every date from the start through the last day.</p>}
              <label className="block space-y-1.5 text-xs font-medium">Time zone<input aria-label="Event time zone" aria-describedby="calendar-event-time-zone-help" autoComplete="off" spellCheck={false} value={timeZone} onChange={change => setTimeZone(change.target.value)} className={inputClass} /></label>
              <p id="calendar-event-time-zone-help" className="text-xs leading-5 text-muted-foreground">Dates and times use this time zone, for example Asia/Kolkata.</p>
            </fieldset>
            <fieldset className="min-w-0 space-y-3 border-t border-border pt-4">
              <legend className="float-left mb-3 w-full text-xs font-semibold text-muted-foreground">Repeat and remind</legend>
              <div className="grid clear-both grid-cols-2 gap-3">
                <label className="space-y-1.5 text-xs font-medium">Repeat<select aria-label="Event recurrence" aria-describedby={recurring && scope === 'occurrence' ? 'calendar-event-repeat-help' : undefined} value={frequency} disabled={recurring && scope === 'occurrence'} onChange={change => setFrequency(change.target.value as typeof frequency)} className={inputClass}><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
                <label className="space-y-1.5 text-xs font-medium">Reminder<select aria-label="Event reminder" value={reminder} onChange={change => setReminder(change.target.value)} className={inputClass}><option value="none">None</option>{[0, 5, 10, 15, 30, 60, 1440].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? 'At start' : minutes === 1440 ? '1 day before' : minutes === 60 ? '1 hour before' : `${minutes} min before`}</option>)}</select></label>
              </div>
              {recurring && scope === 'occurrence' && <p id="calendar-event-repeat-help" className="text-xs leading-5 text-muted-foreground">The repeat schedule belongs to the entire series.</p>}
              {frequency !== 'none' && (!recurring || scope === 'series') && <fieldset className="min-w-0 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                <legend className="px-1 text-xs text-muted-foreground">Recurrence</legend>
                <label className="block space-y-1.5 text-xs font-medium">Repeat every ({recurrenceUnit})<input aria-label="Recurrence interval" type="number" min={1} max={365} value={interval} onChange={change => setInterval(Number(change.target.value))} className={inputClass} /></label>
                {frequency === 'weekly' && <fieldset><legend className="mb-2 text-xs font-medium">Repeat on</legend><div className="flex flex-wrap gap-2">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => <label key={day} className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs ${weekDays.includes(index) ? 'border-primary/40 bg-primary/5' : 'border-border'}`}><input type="checkbox" aria-label={`Repeat on ${day}`} checked={weekDays.includes(index)} onChange={change => setWeekDays(current => change.target.checked ? [...current, index] : current.filter(value => value !== index))} />{day}</label>)}</div></fieldset>}
                <label className="block space-y-1.5 text-xs font-medium">Repeat until (optional)<input aria-label="Recurrence until" type="date" value={until} onChange={change => setUntil(change.target.value)} className={inputClass} /></label>
              </fieldset>}
            </fieldset>
            <fieldset className="min-w-0 space-y-3 border-t border-border pt-4">
              <legend className="float-left mb-3 w-full text-xs font-semibold text-muted-foreground">Details</legend>
              <label className="block clear-both space-y-1.5 text-xs font-medium">Location<input aria-label="Event location" placeholder="Add a location or meeting link" value={location} maxLength={1000} onChange={change => setLocation(change.target.value)} className={inputClass} /></label>
              <label className="block space-y-1.5 text-xs font-medium">Description<textarea aria-label="Event description" placeholder="Add notes" value={description} maxLength={20000} rows={3} onChange={change => setDescription(change.target.value)} className={`${inputClass} resize-y`} /></label>
              <div className="grid grid-cols-2 items-end gap-3"><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" aria-describedby="calendar-event-busy-help" checked={busy} onChange={change => setBusy(change.target.checked)} />Show as busy</label><label className="space-y-1.5 text-xs font-medium">Status<select aria-label="Event status" value={status} onChange={change => setStatus(change.target.value as typeof status)} className={inputClass}><option value="confirmed">Confirmed</option><option value="tentative">Tentative</option><option value="cancelled">Cancelled</option></select></label></div>
              <p id="calendar-event-busy-help" className="text-xs leading-5 text-muted-foreground">Busy events block suggested meeting times when this calendar is included in availability.</p>
            </fieldset>
          </fieldset>
        </div>
        <footer className="shrink-0 space-y-3 border-t border-border bg-background px-5 py-4">
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">{event ? <button type="button" disabled={saving} onClick={() => void remove()} className="flex items-center gap-1.5 rounded-lg px-2 py-2 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-50"><Trash2 aria-hidden="true" className="h-4 w-4" />Delete event</button> : <span />}<div className="ml-auto flex gap-2"><button type="button" disabled={saving} onClick={close} className={buttonClass}>Cancel</button><button type="submit" disabled={saving || !calendars.length || !title.trim()} className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:opacity-50">{saving && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}Save event</button></div></div>
        </footer>
      </form>
    </aside>
  </div>;
}
