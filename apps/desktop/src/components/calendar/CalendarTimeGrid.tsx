import { Repeat2 } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { LocalCalendar, LocalCalendarOccurrence } from '../../types/local-calendar';
import { dateInTimeZone } from '../../utils/local-calendar';

import { calendarDayTime, occurrenceOnDate, timedSegmentsForDate, wallMinute } from './calendar-layout';
import { dateLabel } from './calendar-view';

interface CalendarTimeGridProps {
  dates: string[];
  selectedDate: string;
  timeZone: string;
  calendars: Map<string, LocalCalendar>;
  occurrences: LocalCalendarOccurrence[];
  nowMs: number;
  onOpen: (occurrence: LocalCalendarOccurrence) => void;
  onCreate: (date: string, startMinute?: number, allDay?: boolean) => void;
  onDateSelect?: (date: string) => void;
}

export function CalendarTimeGrid({ dates, selectedDate, timeZone, calendars, occurrences, nowMs, onOpen, onCreate, onDateSelect }: CalendarTimeGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const slotButtons = useRef(new Map<string, HTMLButtonElement>());
  const [focusedSlots, setFocusedSlots] = useState<Record<string, number>>({});
  const firstDate = dates[0];
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 8 * 60; }, [firstDate, timeZone]);
  const today = dateInTimeZone(nowMs, timeZone);
  const moveSlotFocus = (event: KeyboardEvent<HTMLButtonElement>, dayIndex: number, halfHour: number) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const targetDay = Math.max(0, Math.min(dates.length - 1, dayIndex + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0)));
    const targetSlot = event.key === 'Home' ? 0 : event.key === 'End' ? 47 : Math.max(0, Math.min(47, halfHour + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0)));
    slotButtons.current.get(`${dates[targetDay]}:${targetSlot}`)?.focus();
  };
  return <div className="calendar-canvas-time-scroll" ref={scroller}>
    <div className="calendar-canvas-time" style={{ '--calendar-days': dates.length } as CSSProperties}>
      <div className="calendar-canvas-time-heading">
        <div className="calendar-canvas-time-corner">{timeZone === 'UTC' ? 'UTC' : new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: 'short' }).formatToParts(nowMs).find(part => part.type === 'timeZoneName')?.value}</div>
        {dates.map(day => <div key={day} className={`calendar-canvas-day-heading ${day === selectedDate ? 'is-selected' : ''}`}>
          <button type="button" onClick={() => onDateSelect?.(day)} aria-label={`Show day ${day}`} aria-current={day === today ? 'date' : undefined}>
            <span>{dateLabel(day, { weekday: 'short' })}</span><strong className={day === today ? 'is-today' : ''}>{Number(day.slice(-2))}</strong>
          </button>
        </div>)}
      </div>
      <div className="calendar-canvas-all-day">
        <span className="calendar-canvas-all-day-label">All day</span>
        {dates.map(day => <div className="calendar-canvas-all-day-cell" key={day}>
          {occurrences.filter(item => item.event.allDay && occurrenceOnDate(item, day, timeZone)).map(item => {
            const calendar = calendars.get(item.event.calendarId)!;
            return <button type="button" key={item.occurrenceId} className="calendar-canvas-event-strip is-all-day" style={{ '--event-color': calendar.color } as CSSProperties} onClick={() => onOpen(item)} aria-label={`Open event: ${item.event.title} (${calendar.name})`} title={item.event.title}>{item.event.title || '(Untitled event)'}</button>;
          })}
          <button type="button" className="calendar-canvas-all-day-create" onClick={() => onCreate(day, undefined, true)} aria-label={`Create event on ${day}`}>+</button>
        </div>)}
      </div>
      <div className="calendar-canvas-time-body">
        <div className="calendar-canvas-hours" aria-hidden="true">{Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * 60 }}>{hour === 0 ? '00:00' : `${String(hour).padStart(2, '0')}:00`}</span>)}</div>
        {dates.map((day, dayIndex) => <section key={day} className={`calendar-canvas-time-day ${day === today ? 'is-current-day' : ''}`} aria-label={dateLabel(day, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}>
          <div className="calendar-canvas-slot-grid">{Array.from({ length: 48 }, (_, halfHour) => <button key={halfHour} ref={element => { const key = `${day}:${halfHour}`; if (element) slotButtons.current.set(key, element); else slotButtons.current.delete(key); }} type="button" className="calendar-canvas-slot" tabIndex={(focusedSlots[day] ?? 18) === halfHour ? 0 : -1} onFocus={() => setFocusedSlots(current => current[day] === halfHour ? current : { ...current, [day]: halfHour })} onKeyDown={event => moveSlotFocus(event, dayIndex, halfHour)} onClick={() => onCreate(day, halfHour * 30)} aria-label={`Create event on ${day} at ${String(Math.floor(halfHour / 2)).padStart(2, '0')}:${halfHour % 2 ? '30' : '00'}`} />)}</div>
          {timedSegmentsForDate(occurrences, day, timeZone).map(segment => {
            const item = segment.occurrence;
            const calendar = calendars.get(item.event.calendarId)!;
            const label = calendarDayTime(item, day, timeZone);
            const top = Math.min(segment.startMinute, 1440 - 28);
            const height = Math.min(1440 - top, Math.max(28, segment.endMinute - top));
            return <button key={item.occurrenceId} type="button" className={`calendar-canvas-timed-event ${item.event.status === 'cancelled' ? 'is-cancelled' : ''} ${height < 48 ? 'is-short' : ''}`} style={{ '--event-color': calendar.color, top, height, left: `calc(${segment.column / segment.columns * 100}% + 2px)`, width: `calc(${100 / segment.columns}% - 5px)` } as CSSProperties} onClick={() => onOpen(item)} aria-label={`Open event: ${item.event.title} (${calendar.name})`} title={`${item.event.title}\n${label.tooltip}${item.event.location ? `\n${item.event.location}` : ''}`}>
              <strong>{segment.continuesBefore && '← '}{item.event.title || '(Untitled event)'}{segment.continuesAfter && ' →'}{item.event.recurrence && <Repeat2 aria-label="Recurring event" />}</strong>
              <span>{label.rangeLabel}</span>
              {height >= 72 && item.event.location && <span>{item.event.location}</span>}
            </button>;
          })}
          {day === today && <div className="calendar-canvas-now" aria-label="Current time" style={{ top: wallMinute(nowMs, timeZone) }}><span /></div>}
        </section>)}
      </div>
    </div>
  </div>;
}
