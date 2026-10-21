import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Loader2, Menu, Plus, Settings2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { LocalCalendar, LocalCalendarOccurrence, LocalCalendarOpenEvent, LocalCalendarPreferences, LocalCalendarRange, LocalCalendarSnapshot } from '../../types/local-calendar';
import { dateInTimeZone } from '../../utils/local-calendar';
import { trapDialogTab } from '../../utils/modal-focus';

import { dateLabel, moveDate, viewDates, viewRange, type CalendarView } from './calendar-view';
import { CalendarEventEditor } from './CalendarEventEditor';
import { CalendarMiniMonth } from './CalendarMiniMonth';
import { CalendarSettings, type CalendarSettingsSection } from './CalendarSettings';
import { CalendarViews } from './CalendarViews';
import './calendar.css';

interface CalendarProps { initialEvent?: LocalCalendarOpenEvent | null; onEventOpened?: (event: LocalCalendarOpenEvent) => void }
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const defaultPreferences = (timeZone: string): LocalCalendarPreferences => ({ timeZone, workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0, slotIntervalMinutes: 15 });

export function Calendar({ initialEvent, onEventOpened }: CalendarProps) {
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [date, setDate] = useState(() => dateInTimeZone(Date.now(), browserTimeZone()));
  const [view, setView] = useState<CalendarView>('month');
  const [snapshot, setSnapshot] = useState<LocalCalendarSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 980);
  const [eventEditor, setEventEditor] = useState<{ date: string; startMinute?: number; allDay?: boolean; occurrence?: LocalCalendarOccurrence } | null>(null);
  const [snapshotRange, setSnapshotRange] = useState<LocalCalendarRange | null>(null);
  const [settings, setSettings] = useState<{ section: CalendarSettingsSection; calendar?: LocalCalendar } | null>(null);
  const [calendarBusy, setCalendarBusy] = useState<string | null>(null);
  const [pendingEvent, setPendingEvent] = useState<LocalCalendarOpenEvent | null>(initialEvent ?? null);
  const [eventLinkError, setEventLinkError] = useState<string | null>(null);
  const generation = useRef(0);
  const firstSnapshot = useRef(true);
  const mounted = useRef(false);
  const loadedRange = useRef('');
  const container = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => { setSidebarOpen(false); sidebarToggle.current?.focus(); }, []);
  const range = viewRange(view, date, timeZone);
  const rangeKey = `${range.startMs}:${range.endMs}`;
  const preferences = snapshot?.preferences ?? defaultPreferences(timeZone);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setNarrow((element.getBoundingClientRect().width || window.innerWidth) < 980);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => { if (narrow && sidebarOpen) sidebar.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [narrow, sidebarOpen]);

  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true); setError(null);
    try {
      const api = window.electronAPI?.calendar;
      if (!api) throw new Error('Calendar is unavailable. Restart the app after updating.');
      const result = await api.snapshot({ startMs: range.startMs, endMs: range.endMs });
      if (!mounted.current || version !== generation.current) return;
      if (!result.success) throw new Error(result.error);
      setSnapshot(result.data); setSnapshotRange({ startMs: range.startMs, endMs: range.endMs }); loadedRange.current = `${range.startMs}:${range.endMs}`;
      setTimeZone(result.data.preferences.timeZone);
      if (firstSnapshot.current) { firstSnapshot.current = false; setDate(dateInTimeZone(initialEvent?.startMs ?? Date.now(), result.data.preferences.timeZone)); }
    } catch (cause) { if (mounted.current && version === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load the calendar.'); }
    finally { if (mounted.current && version === generation.current) setLoading(false); }
  }, [range.startMs, range.endMs, initialEvent?.startMs]);

  useEffect(() => {
    mounted.current = true; void load();
    const unsubscribe = window.electronAPI?.calendar?.onChanged(() => void load());
    return () => {
      mounted.current = false;
      // This ref invalidates async requests; it never refers to a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      unsubscribe?.();
    };
  }, [load]);
  useEffect(() => {
    const unsubscribe = window.electronAPI?.calendar?.onOpenEvent(event => { setPendingEvent(event); setEventEditor(null); setEventLinkError(null); setDate(dateInTimeZone(event.startMs, timeZone)); });
    return () => unsubscribe?.();
  }, [timeZone]);
  useEffect(() => {
    if (initialEvent) { setPendingEvent(initialEvent); setEventEditor(null); setEventLinkError(null); setDate(dateInTimeZone(initialEvent.startMs, timeZone)); }
  }, [initialEvent, timeZone]);
  useEffect(() => {
    if (!pendingEvent || loading || !snapshot || loadedRange.current !== rangeKey) return;
    const occurrence = snapshot.occurrences.find(item => (item.eventId === pendingEvent.eventId || item.event.id === pendingEvent.eventId || item.event.parentEventId === pendingEvent.eventId)
      && item.startMs === pendingEvent.startMs && (!pendingEvent.occurrenceId || item.occurrenceId === pendingEvent.occurrenceId));
    if (occurrence) {
      const eventDate = dateInTimeZone(occurrence.startMs, occurrence.event.allDay ? occurrence.event.timeZone : timeZone);
      setDate(eventDate); setEventEditor({ date: eventDate, occurrence }); setPendingEvent(null); onEventOpened?.(pendingEvent);
    } else { setEventLinkError('This event is no longer available.'); setPendingEvent(null); onEventOpened?.(pendingEvent); }
  }, [pendingEvent, loading, snapshot, rangeKey, timeZone, onEventOpened]);

  const saved = () => { setEventEditor(null); setSettings(null); void load(); };
  const toggleCalendar = async (calendar: LocalCalendar, visible: boolean) => {
    if (calendarBusy) return;
    setCalendarBusy(calendar.id); setError(null);
    try {
      const result = await window.electronAPI.calendar.saveCalendar({ id: calendar.id, name: calendar.name, color: calendar.color, visible, blocksAvailability: calendar.blocksAvailability, isDefault: calendar.isDefault });
      if (!result.success) throw new Error(result.error);
      if (mounted.current) await load();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not change calendar visibility.'); }
    finally { if (mounted.current) setCalendarBusy(null); }
  };
  const createEvent = (day: string, startMinute?: number, allDay?: boolean) => { setEventEditor({ date: day, startMinute, allDay }); setSidebarOpen(false); };
  const calendars = snapshot?.calendars ?? [];
  const today = dateInTimeZone(Date.now(), timeZone);
  const hasCanvas = !!snapshot && !!snapshotRange && snapshotRange.startMs <= range.startMs && snapshotRange.endMs >= range.endMs;
  const title = (() => {
    if (view === 'day') return dateLabel(date, { month: 'long', day: 'numeric', year: 'numeric' });
    if (view === 'week') {
      const days = viewDates('week', date);
      const first = days[0]!; const last = days[6]!;
      // Available in the supported Electron/Node runtimes; this project's
      // older Intl type library does not declare formatRange yet.
      const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) as Intl.DateTimeFormat & { formatRange(start: Date, end: Date): string };
      return format.formatRange(new Date(`${first}T12:00:00Z`), new Date(`${last}T12:00:00Z`));
    }
    return dateLabel(date, { month: 'long', year: 'numeric' });
  })();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || eventEditor || settings) return;
      const target = event.target;
      if (target instanceof Element && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || (target !== document.body && !container.current?.contains(target)))) return;
      const views: Record<string, CalendarView> = { d: 'day', w: 'week', m: 'month', a: 'agenda' };
      const key = event.key.toLowerCase();
      if (views[key]) { event.preventDefault(); setView(views[key]); }
      else if (key === 't') { event.preventDefault(); setDate(dateInTimeZone(Date.now(), timeZone)); }
      else if (key === 'n' && !loading && calendars.length) { event.preventDefault(); setEventEditor({ date }); setSidebarOpen(false); }
      else if (key === 'arrowleft' || key === 'arrowright') { event.preventDefault(); setDate(current => moveDate(view, current, key === 'arrowleft' ? -1 : 1)); }
      else if (key === 'escape') closeSidebar();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [view, date, timeZone, eventEditor, settings, loading, calendars.length, closeSidebar]);
  return <section ref={container} aria-label="Calendar" className="calendar-workspace relative flex h-full min-h-0 w-full min-w-0 overflow-hidden">
    {narrow && sidebarOpen && <button type="button" tabIndex={-1} aria-label="Close calendar navigation" className="calendar-mobile-backdrop" onClick={closeSidebar} />}
    <nav ref={sidebar} aria-label="Local calendars" role={narrow && sidebarOpen ? 'dialog' : undefined} aria-modal={narrow && sidebarOpen ? true : undefined} onKeyDown={event => { if (!narrow || !sidebarOpen) return; trapDialogTab(event, event.currentTarget); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSidebar(); } }} className={`calendar-sidebar shrink-0 ${narrow ? sidebarOpen ? 'absolute inset-y-0 left-0 z-20 flex shadow-xl' : 'hidden' : 'flex'}`}>
      <div className="calendar-sidebar-heading"><span><CalendarDays size={20} strokeWidth={1.7} />Calendar</span>{narrow && <button type="button" aria-label="Close calendar sidebar" onClick={closeSidebar} className="calendar-icon-button"><X size={17} /></button>}</div>
      <button type="button" disabled={loading || !calendars.length} onClick={() => createEvent(date)} title="New event (N)" className="calendar-new-event"><Plus size={18} />New event</button>
      <div className="calendar-sidebar-scroll">
        <CalendarMiniMonth date={date} today={today} onSelect={setDate} />
        <div className="calendar-calendars"><div className="calendar-calendar-heading"><h2>My calendars</h2><button type="button" aria-label="Create local calendar" onClick={() => setSettings({ section: 'calendar' })} disabled={loading} className="calendar-icon-button"><Plus size={15} /></button></div>
          {calendars.map(calendar => <div key={calendar.id} className="calendar-calendar-row"><input type="checkbox" aria-label={`Show calendar: ${calendar.name}`} checked={calendar.visible} disabled={!!calendarBusy} onChange={change => void toggleCalendar(calendar, change.target.checked)} style={{ accentColor: calendar.color }} /><span className="calendar-calendar-name"><span>{calendar.name}{calendar.isDefault && <span title="Default calendar" className="ml-1 text-[10px] text-muted-foreground">· Default</span>}</span><span>{calendar.blocksAvailability ? 'Checks availability' : 'Display only'}</span></span><button type="button" aria-label={`Manage calendar: ${calendar.name}`} onClick={() => setSettings({ section: 'calendar', calendar })} className="calendar-icon-button"><Settings2 size={13} /></button></div>)}
          {!loading && !calendars.length && <p className="calendar-sidebar-empty">Create a local calendar to add events.</p>}
        </div>
      </div>
      <footer className="calendar-sidebar-footer"><button type="button" disabled={loading} onClick={() => setSettings({ section: 'preferences' })}><Settings2 size={14} />Working hours & preferences</button><button type="button" disabled={loading || !calendars.length} onClick={() => setSettings({ section: 'transfer' })}><Upload size={14} />Import / export .ics</button><p>Local calendars only. Your events stay in Inbox.</p></footer>
    </nav>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="calendar-toolbar">
        {narrow && <button ref={sidebarToggle} type="button" aria-label="Show calendar sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(open => !open)} className="calendar-icon-button"><Menu size={19} /></button>}
        <div className="calendar-toolbar-title"><h1>{title}</h1><button type="button" onClick={() => setSettings({ section: 'preferences' })} title="Change calendar time zone"><Clock3 size={11} />{timeZone}</button></div>
        <div className="calendar-period-nav"><button type="button" onClick={() => setDate(today)} title="Go to today (T)" className="calendar-today-button">Today</button><button type="button" aria-label="Previous calendar period" title="Previous period (←)" onClick={() => setDate(current => moveDate(view, current, -1))} className="calendar-icon-button"><ChevronLeft size={18} /></button><button type="button" aria-label="Next calendar period" title="Next period (→)" onClick={() => setDate(current => moveDate(view, current, 1))} className="calendar-icon-button"><ChevronRight size={18} /></button></div>
        <div role="group" aria-label="Calendar view" className="calendar-view-switch">{(['day', 'week', 'month', 'agenda'] as const).map(mode => <button key={mode} type="button" aria-pressed={view === mode} title={`${mode.charAt(0).toUpperCase()}${mode.slice(1)} view (${mode.charAt(0).toUpperCase()})`} onClick={() => setView(mode)}>{mode.charAt(0).toUpperCase()}{mode.slice(1)}</button>)}</div>
        <input type="date" aria-label="Calendar date" title="Jump to date" value={date} onChange={change => { if (change.target.value) setDate(change.target.value); }} className="calendar-date-control" />
        {narrow && <button type="button" disabled={loading || !calendars.length} onClick={() => createEvent(date)} title="New event (N)" aria-label="New event" className="calendar-icon-button"><Plus size={19} /></button>}
      </header>
      {eventLinkError && <p role="status" className="shrink-0 border-b border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">{eventLinkError}</p>}
      {error && <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"><p>{error}</p><button type="button" onClick={() => void load()} className="font-medium underline">Try again</button></div>}
      <div className="relative min-h-0 flex-1" aria-busy={loading}>
        {loading && hasCanvas && <div role="status" aria-label="Updating calendar" className="calendar-updating" />}
        {loading && !hasCanvas ? <p role="status" className="calendar-loading"><Loader2 size={16} className="animate-spin" />Loading calendar…</p> : !error && snapshot ? <CalendarViews view={view} date={date} timeZone={timeZone} calendars={calendars} occurrences={snapshot.occurrences} onOpen={occurrence => setEventEditor({ date: dateInTimeZone(occurrence.startMs, timeZone), occurrence })} onCreate={createEvent} onDateSelect={day => { setDate(day); setView('day'); }} /> : null}
      </div>
    </div>
    {eventEditor && <CalendarEventEditor key={eventEditor.occurrence?.occurrenceId ?? `new:${eventEditor.date}:${eventEditor.startMinute ?? 'default'}:${!!eventEditor.allDay}`} calendars={calendars} preferences={preferences} date={eventEditor.date} startMinute={eventEditor.startMinute} initialAllDay={eventEditor.allDay} occurrence={eventEditor.occurrence} onClose={() => setEventEditor(null)} onSaved={saved} />}
    {settings && <CalendarSettings key={`${settings.section}:${settings.calendar?.id ?? 'new'}`} section={settings.section} calendar={settings.calendar} calendars={calendars} preferences={preferences} onClose={() => setSettings(null)} onSaved={saved} />}
  </section>;
}
