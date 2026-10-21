import { Repeat2, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { LocalCalendar, LocalCalendarOccurrence } from '../../types/local-calendar';
import { dateInTimeZone } from '../../utils/local-calendar';
import { trapDialogTab } from '../../utils/modal-focus';

import { calendarDayTime, calendarMonthDates, occurrenceOnDate } from './calendar-layout';
import { dateLabel, viewDates, type CalendarView } from './calendar-view';
import { CalendarTimeGrid } from './CalendarTimeGrid';

import './calendar-views.css';

export interface CalendarViewsProps {
  view: CalendarView;
  date: string;
  timeZone: string;
  calendars: LocalCalendar[];
  occurrences: LocalCalendarOccurrence[];
  onOpen: (occurrence: LocalCalendarOccurrence) => void;
  onCreate: (date: string, startMinute?: number, allDay?: boolean) => void;
  onDateSelect?: (date: string) => void;
  nowMs?: number;
}

interface EventListProps {
  entries: LocalCalendarOccurrence[];
  calendars: Map<string, LocalCalendar>;
  timeZone: string;
  day: string;
  onOpen: CalendarViewsProps['onOpen'];
}

function EventList({ entries, calendars, timeZone, day, onOpen }: EventListProps) {
  return <div className="calendar-canvas-event-list">{entries.map(item => {
    const calendar = calendars.get(item.event.calendarId)!;
    const label = calendarDayTime(item, day, timeZone);
    return <button type="button" key={item.occurrenceId} onClick={() => onOpen(item)} aria-label={`Open event: ${item.event.title} (${calendar.name})`} title={`${item.event.title}\n${label.tooltip}`} className={`calendar-canvas-list-event ${item.event.status === 'cancelled' ? 'is-cancelled' : ''}`} style={{ '--event-color': calendar.color } as CSSProperties}>
      <span className="calendar-canvas-list-time">{label.startLabel}{!item.event.allDay && <small>{label.endLabel}</small>}</span>
      <span className="calendar-canvas-list-details"><strong>{item.event.title || '(Untitled event)'}{item.event.recurrence && <Repeat2 aria-label="Recurring event" />}</strong><small>{calendar.name}{item.event.location ? ` · ${item.event.location}` : ''}{!item.event.busy ? ' · Free' : ''}{item.event.status !== 'confirmed' ? ` · ${item.event.status}` : ''}</small>{(label.continuesBefore || label.continuesAfter) && <small>{label.continuesBefore ? 'Continues from previous day' : 'Continues into next day'}{label.continuesBefore && label.continuesAfter ? ' · Continues into next day' : ''}</small>}</span>
    </button>;
  })}</div>;
}

function MonthCalendar({ date, timeZone, calendars, entries, nowMs, onOpen, onCreate, onDateSelect }: Omit<CalendarViewsProps, 'view' | 'occurrences' | 'calendars'> & { calendars: Map<string, LocalCalendar>; entries: LocalCalendarOccurrence[]; nowMs: number }) {
  const dates = calendarMonthDates(date);
  const weeks = dates.length / 7;
  const frame = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(3);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const today = dateInTimeZone(nowMs, timeZone);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) setCapacity(Math.max(1, Math.min(6, Math.floor(((element.clientHeight - 30) / weeks - 58) / 24))));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, [weeks]);
  useEffect(() => { setExpandedDay(null); }, [date, timeZone]);
  useEffect(() => {
    if (!expandedDay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [expandedDay]);
  const forDay = (day: string) => entries.filter(item => occurrenceOnDate(item, day, timeZone));
  return <div className="calendar-canvas-month-frame" ref={frame}>
    <div className="calendar-canvas-weekdays">{dates.slice(0, 7).map(day => <span key={day}>{dateLabel(day, { weekday: 'short' })}</span>)}</div>
    <div className="calendar-canvas-month-grid" style={{ gridTemplateRows: `repeat(${weeks}, minmax(0, 1fr))`, minHeight: weeks * 86 }}>
      {dates.map(day => {
        const dayEntries = forDay(day);
        return <section key={day} aria-label={dateLabel(day, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} className={`calendar-canvas-month-day ${day.slice(0, 7) !== date.slice(0, 7) ? 'is-outside-month' : ''} ${day === date ? 'is-selected' : ''}`}>
          <div className="calendar-canvas-month-date"><button type="button" className={day === today ? 'is-today' : ''} aria-label={`Show day ${day}`} aria-current={day === today ? 'date' : undefined} onClick={() => onDateSelect?.(day)}>{Number(day.slice(-2))}</button><button type="button" className="calendar-canvas-month-create" onClick={() => onCreate(day)} aria-label={`Create event on ${day}`}>+</button></div>
          <div className="calendar-canvas-month-events">{dayEntries.slice(0, capacity).map(item => {
            const calendar = calendars.get(item.event.calendarId)!;
            const label = calendarDayTime(item, day, timeZone);
            return <button key={item.occurrenceId} type="button" onClick={() => onOpen(item)} aria-label={`Open event: ${item.event.title} (${calendar.name})`} title={`${item.event.title}\n${label.tooltip}`} className={`calendar-canvas-event-strip ${item.event.allDay ? 'is-all-day' : ''} ${item.event.status === 'cancelled' ? 'is-cancelled' : ''}`} style={{ '--event-color': calendar.color } as CSSProperties}>
              {!item.event.allDay && <span className="calendar-canvas-event-dot" />}<span className="calendar-canvas-event-name">{item.event.title || '(Untitled event)'}</span>{!item.event.allDay && <span className="calendar-canvas-event-time">{label.monthLabel}</span>}
            </button>;
          })}</div>
          {dayEntries.length > capacity && <button type="button" className="calendar-canvas-more" aria-label={`Show all ${dayEntries.length} events on ${day}`} onClick={() => setExpandedDay(day)}>+{dayEntries.length - capacity} more</button>}
        </section>;
      })}
    </div>
    {expandedDay && <div className="calendar-canvas-day-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setExpandedDay(null); }}>
      <div role="dialog" aria-modal="true" aria-label={`Events on ${expandedDay}`} className="calendar-canvas-day-dialog" ref={dialog} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpandedDay(null); } else trapDialogTab(event, dialog.current); }}>
        <header><h3>{dateLabel(expandedDay, { weekday: 'long', month: 'long', day: 'numeric' })}</h3><button type="button" aria-label="Close day events" onClick={() => setExpandedDay(null)}><X size={18} /></button></header>
        <div className="calendar-canvas-day-dialog-content"><EventList entries={forDay(expandedDay)} calendars={calendars} timeZone={timeZone} day={expandedDay} onOpen={item => { setExpandedDay(null); onOpen(item); }} /></div>
        <footer><button type="button" onClick={() => { const day = expandedDay; setExpandedDay(null); onCreate(day); }}>Create event</button>{onDateSelect && <button type="button" onClick={() => { const day = expandedDay; setExpandedDay(null); onDateSelect(day); }}>Open day</button>}</footer>
      </div>
    </div>}
  </div>;
}

export function CalendarViews({ view, date, timeZone, calendars, occurrences, onOpen, onCreate, onDateSelect, nowMs }: CalendarViewsProps) {
  const [clock, setClock] = useState(Date.now);
  useEffect(() => { if (nowMs !== undefined) return; const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer); }, [nowMs]);
  const now = nowMs ?? clock;
  const dates = viewDates(view, date);
  const visible = new Map(calendars.filter(calendar => calendar.visible).map(calendar => [calendar.id, calendar]));
  const entries = occurrences.filter(item => visible.has(item.event.calendarId)).sort((a, b) => Number(b.event.allDay) - Number(a.event.allDay) || a.startMs - b.startMs || a.occurrenceId.localeCompare(b.occurrenceId));
  const forDay = (day: string) => entries.filter(item => occurrenceOnDate(item, day, timeZone));
  return <div aria-label={`${view.charAt(0).toUpperCase()}${view.slice(1)} view`} className={`calendar-canvas calendar-canvas-${view}`}>
    {view === 'month' ? <MonthCalendar date={date} timeZone={timeZone} calendars={visible} entries={entries} nowMs={now} onOpen={onOpen} onCreate={onCreate} onDateSelect={onDateSelect} />
      : view === 'day' || view === 'week' ? <CalendarTimeGrid dates={dates} selectedDate={date} timeZone={timeZone} calendars={visible} occurrences={entries} nowMs={now} onOpen={onOpen} onCreate={onCreate} onDateSelect={onDateSelect} />
        : <div className="calendar-canvas-agenda">{dates.some(day => forDay(day).length) ? dates.filter(day => forDay(day).length).map(day => <section key={day} className="calendar-canvas-agenda-day"><button type="button" className="calendar-canvas-agenda-date" onClick={() => onDateSelect?.(day)}><strong>{Number(day.slice(-2))}</strong><span>{dateLabel(day, { weekday: 'short', month: 'short' })}</span></button><EventList entries={forDay(day)} calendars={visible} timeZone={timeZone} day={day} onOpen={onOpen} /></section>) : <div className="calendar-canvas-empty"><p>No events in the next 30 days.</p><button type="button" onClick={() => onCreate(date)}>Create an event</button></div>}</div>}
  </div>;
}
