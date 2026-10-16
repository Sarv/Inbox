import type { CSSProperties } from 'react';

import { eventInterval, formatEventTime, isAllDayLike } from './calendar-dates';
import type { CalendarEvent } from './calendar-types';

/** What every event-drawing view needs from the screen. */
export interface EventViewProps {
  colorOf: (event: CalendarEvent) => string;
  selectedEventId: string | null;
  onSelectEvent: (event: CalendarEvent) => void;
}

/** The inline style that hands a calendar's colour to the stylesheet. */
export const calendarColorStyle = (color: string) => ({ '--cal-color': color }) as CSSProperties;

interface EventChipProps extends EventViewProps {
  event: CalendarEvent;
}

/** One event as a single line — a month cell, or the week view's all-day row. */
export function EventChip({ event, colorOf, selectedEventId, onSelectEvent }: EventChipProps) {
  const time = isAllDayLike(event) ? null : formatEventTime(eventInterval(event).start);
  return (
    <button
      type="button"
      className={`calv-chip${selectedEventId === event.id ? ' is-selected' : ''}`}
      style={calendarColorStyle(colorOf(event))}
      aria-label={time ? `${time} ${event.title}` : event.title}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onSelectEvent(event);
      }}
    >
      {time && <span className="calv-chip-time">{time}</span>}
      <span className="calv-chip-title">{event.title || '(No title)'}</span>
    </button>
  );
}
