import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { addLocalDays } from '../../utils/local-calendar';

import { dateLabel, monthDates, moveDate } from './calendar-view';

export function CalendarMiniMonth({ date, today, onSelect }: { date: string; today: string; onSelect: (date: string) => void }) {
  const [month, setMonth] = useState(`${date.slice(0, 7)}-01`);
  const container = useRef<HTMLElement>(null);
  const focusSelection = useRef(false);
  useEffect(() => setMonth(`${date.slice(0, 7)}-01`), [date]);
  useEffect(() => {
    if (!focusSelection.current) return;
    const selected = container.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (selected) { selected.focus(); focusSelection.current = false; }
  }, [date, month]);
  const dates = monthDates(month);
  const selectWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (offset === undefined) return;
    event.preventDefault(); event.stopPropagation();
    focusSelection.current = true;
    onSelect(addLocalDays(day, offset));
  };
  return <section ref={container} className="calendar-mini" aria-label="Date navigator">
    <div className="calendar-mini-heading"><h2>{dateLabel(month, { month: 'long', year: 'numeric' })}</h2><div className="calendar-mini-nav"><button type="button" aria-label="Previous month in date navigator" onClick={() => setMonth(current => moveDate('month', current, -1))}><ChevronLeft size={15} /></button><button type="button" aria-label="Next month in date navigator" onClick={() => setMonth(current => moveDate('month', current, 1))}><ChevronRight size={15} /></button></div></div>
    <div className="calendar-mini-weekdays" aria-hidden="true">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={index}>{day}</span>)}</div>
    <div className="calendar-mini-grid">{dates.map(day => <button key={day} type="button" tabIndex={day === (dates.includes(date) ? date : month) ? 0 : -1} aria-label={`Choose ${dateLabel(day, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`} aria-current={day === today ? 'date' : undefined} aria-pressed={day === date} className={`${day.slice(0, 7) !== month.slice(0, 7) ? 'is-outside' : ''} ${day === today ? 'is-today' : ''} ${day === date ? 'is-selected' : ''}`} onClick={() => onSelect(day)} onKeyDown={event => selectWithKeyboard(event, day)}>{Number(day.slice(8))}</button>)}</div>
  </section>;
}
