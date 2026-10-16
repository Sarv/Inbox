import { addMonths, isSameDay, isSameMonth, startOfMonth } from 'date-fns';
import { useEffect, useState } from 'react';

import { Tooltip } from '../Tooltip';

import { monthGridDays, shortWeekday, weekDays } from './calendar-dates';
import type { CalendarViewMode } from './calendar-types';

interface MiniMonthProps {
  /** The day the main view is on. */
  anchor: Date;
  view: CalendarViewMode;
  today: Date;
  onPick: (day: Date) => void;
}

/**
 * The rail's month picker — the design system's `.ds-calendar` markup. It
 * browses on its own (paging it does not move the main view) and follows the
 * main view when that moves to another month.
 */
export function MiniMonth({ anchor, view, today, onPick }: MiniMonthProps) {
  const [shownMonth, setShownMonth] = useState(() => startOfMonth(anchor));
  useEffect(() => setShownMonth(startOfMonth(anchor)), [anchor]);

  const days = monthGridDays(shownMonth);
  const visibleWeek = view === 'week' ? weekDays(anchor) : [];
  const dayClass = (day: Date) => [
    'cal-day',
    !isSameMonth(day, shownMonth) && 'outside',
    isSameDay(day, today) && 'today',
    isSameDay(day, anchor) && 'selected',
    !isSameDay(day, anchor) && visibleWeek.some((weekDay) => isSameDay(weekDay, day)) && 'in-range',
  ].filter(Boolean).join(' ');

  return (
    <div className="ds-calendar">
      <div className="cal-head">
        <div className="cal-title">
          {new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(shownMonth)}
        </div>
        <div className="cal-nav">
          <Tooltip content="Previous month" delayMs={40}>
            <button type="button" aria-label="Previous month" onClick={() => setShownMonth(addMonths(shownMonth, -1))}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
          </Tooltip>
          <Tooltip content="Next month" delayMs={40}>
            <button type="button" aria-label="Next month" onClick={() => setShownMonth(addMonths(shownMonth, 1))}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg>
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="cal-grid">
        {days.slice(0, 7).map((day) => <div key={`dow-${day.getDay()}`} className="cal-dow">{shortWeekday(day)}</div>)}
        {days.map((day) => (
          <button
            key={day.toISOString()}
            type="button"
            className={dayClass(day)}
            aria-label={day.toLocaleDateString(undefined, { dateStyle: 'full' })}
            aria-current={isSameDay(day, today) ? 'date' : undefined}
            onClick={() => onPick(day)}
          >
            {day.getDate()}
          </button>
        ))}
      </div>
    </div>
  );
}
