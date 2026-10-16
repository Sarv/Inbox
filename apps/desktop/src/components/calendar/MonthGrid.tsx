import { isSameDay, isSameMonth } from 'date-fns';

import { eventsOnDay, monthGridDays } from './calendar-dates';
import type { CalendarEvent } from './calendar-types';
import { EventChip, type EventViewProps } from './EventChip';

/** Chips a month cell shows before collapsing the rest into "+N more". */
export const MONTH_CELL_MAX_CHIPS = 3;

interface MonthGridProps extends EventViewProps {
  anchor: Date;
  today: Date;
  events: readonly CalendarEvent[];
  /** Open one day in the day view (its date, or its "+N more"). */
  onOpenDay: (day: Date) => void;
}

/** A cell's chips and overflow: all of them if they fit, else one fewer plus "+N more". */
export function splitOverflow<T>(items: readonly T[], max: number): { shown: T[]; hidden: number } {
  if (items.length <= max) return { shown: [...items], hidden: 0 };
  const shown = items.slice(0, Math.max(max - 1, 0));
  return { shown, hidden: items.length - shown.length };
}

export function MonthGrid({ anchor, today, events, onOpenDay, ...eventProps }: MonthGridProps) {
  const days = monthGridDays(anchor);
  return (
    <div className="calv-month" role="grid" aria-label="Month">
      {days.slice(0, 7).map((day) => (
        <div key={`dow-${day.getDay()}`} className="cal-dow" role="columnheader">
          {new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}
        </div>
      ))}
      {days.map((day) => {
        const { shown, hidden } = splitOverflow(eventsOnDay(events, day), MONTH_CELL_MAX_CHIPS);
        const isToday = isSameDay(day, today);
        return (
          <div
            key={day.toISOString()}
            role="gridcell"
            className={`calv-month-cell${isSameMonth(day, anchor) ? '' : ' outside'}`}
          >
            <button
              type="button"
              className={`cal-day calv-date${isToday ? ' today' : ''}`}
              aria-label={day.toLocaleDateString(undefined, { dateStyle: 'full' })}
              aria-current={isToday ? 'date' : undefined}
              onClick={() => onOpenDay(day)}
            >
              {day.getDate()}
            </button>
            {shown.map((event) => <EventChip key={event.id} event={event} {...eventProps} />)}
            {hidden > 0 && (
              <button type="button" className="calv-more" onClick={() => onOpenDay(day)}>
                +{hidden} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
